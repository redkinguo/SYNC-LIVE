import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto';
import { handleOAuthSetup, freshAccessToken, saveEnv } from './oauth-setup.mjs';
import { prepareYouTubeBroadcast, advanceYouTubeBroadcast } from './youtube-broadcast.mjs';
import { handleMetadata } from './metadata-api.mjs';
import { emptyAudience, refreshAudience as refreshPlatformAudience } from './live-stats.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
loadDotEnv(join(ROOT, '.env'));
const HOST = process.env.LIVEBRIDGE_HOST || '127.0.0.1';
const PORT = Number(process.env.LIVEBRIDGE_PORT || 4317);
const LIVE_MODE = (process.env.LIVEBRIDGE_MODE || 'demo').toLowerCase() === 'live';

const platformIds = new Set(['twitch', 'kick', 'tiktok', 'youtube']);
const MULTI_STREAM_PLATFORMS = ['twitch', 'kick', 'youtube'];
const connected = { twitch: false, kick: false, tiktok: false, youtube: false };
const messages = [];
const eventClients = new Set();
const active = new Map();
const processedKickIds = new Set();
let kickPublicKey;
let kickWebhookSubscribedUrl = '';
let streamProcess;
let obsClient;
let autoArmRelay = false;
let tiktokPrivateProcess;
let tiktokPrivateStopPromise;
let tiktokStreamlabsRoomId = '';
let tiktokStreamlabsCallbackServer;
let tiktokStreamlabsAuthTimer;
let streamStatus = { running: false, detail: '停止中', destinations: 0, outputs: {}, startedAt: null };
let audience = emptyAudience();
let audiencePollBusy = false;
let audiencePollForThisStream = false;
let tiktokConnection;
let tiktokConnectPromise;
let tiktokReconnectTimer;
let tiktokStatsTimer;
let tiktokReconnectEnabled = false;

function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || match[1] in process.env) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

function emit(type, data) {
  const packet = `data: ${JSON.stringify({ type, data })}\n\n`;
  for (const client of eventClients) client.write(packet);
}

function setConnected(platform, value, detail = '') {
  connected[platform] = value;
  emit('connection', { platform, connected: value, detail });
}

function setStreamStatus(running, detail, destinations = running ? streamStatus.destinations : 0, outputs = streamStatus.outputs) {
  streamStatus = { running, detail, destinations, outputs, startedAt: running ? streamStatus.startedAt : null };
  if (!running) {
    audiencePollForThisStream = false;
    audience = emptyAudience();
    emit('audience', audience);
  }
  emit('stream', streamStatus);
}

async function refreshAudienceStats() {
  if (audiencePollBusy || !streamStatus.running || !Object.values(streamStatus.outputs).some(output => output.status === 'sending')) return;
  audiencePollBusy = true;
  try {
    audience = await refreshPlatformAudience(audience);
    emit('audience', audience);
  } finally {
    audiencePollBusy = false;
  }
}
setInterval(() => { void refreshAudienceStats(); }, 60_000);

function setOutputHealth(platform, status, detail) {
  const current = streamStatus.outputs[platform];
  if (current?.status === status && current?.detail === detail) return;
  setStreamStatus(streamStatus.running, streamStatus.detail, streamStatus.destinations, {
    ...streamStatus.outputs,
    [platform]: { status, detail },
  });
  if (status === 'sending' && streamStatus.running) {
    if (platform === 'tiktok' && tiktokReconnectEnabled && !active.has('tiktok')) {
      void connectTikTok().catch(() => {});
    }
    if (!streamStatus.startedAt) {
      streamStatus = { ...streamStatus, startedAt: new Date().toISOString() };
      emit('stream', streamStatus);
    }
    if (!audiencePollForThisStream) {
      audiencePollForThisStream = true;
      void refreshAudienceStats();
    }
  }
}

function finishOutputHealth(status, detail) {
  return Object.fromEntries(Object.entries(streamStatus.outputs).map(([platform, output]) => [
    platform,
    output.status === 'failed' ? output : { status, detail },
  ]));
}

function escapeTeeUrl(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll('[', '\\[').replaceAll(']', '\\]');
}

async function getObsClient() {
  if (obsClient) return obsClient;
  const address = process.env.OBS_WS_URL?.trim();
  const password = process.env.OBS_WS_PASSWORD;
  if (!address || !password) return undefined;
  const { default: OBSWebSocket } = await import('obs-websocket-js');
  const client = new OBSWebSocket();
  await client.connect(address, password);
  obsClient = client;
  client.on('ConnectionClosed', () => { if (obsClient === client) obsClient = undefined; });
  return client;
}

function tikTokPrivateEnabled() {
  return !tikTokLiveStudioEnabled() && (process.env.TIKTOK_PRIVATE_API_ENABLED || 'false').toLowerCase() === 'true';
}

function tikTokLiveStudioEnabled() {
  return (process.env.TIKTOK_VIDEO_PROVIDER || '').toLowerCase() === 'live-studio';
}

function tikTokStreamlabsEnabled() {
  return (process.env.TIKTOK_VIDEO_PROVIDER || '').toLowerCase() === 'streamlabs'
    && !!process.env.TIKTOK_STREAMLABS_TOKEN?.trim();
}

function createStreamlabsPkce() {
  const verifier = randomBytes(64).toString('hex');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function beginTikTokStreamlabsConnect() {
  if (streamProcess) return { ok: false, error: '配信を停止してからStreamlabs連携を設定してください' };
  if (process.env.TIKTOK_STREAMLABS_TOKEN?.trim()) {
    await saveEnv({ TIKTOK_VIDEO_PROVIDER: 'streamlabs', TIKTOK_PRIVATE_API_ENABLED: 'false' });
    return { ok: true, connected: true };
  }
  if (tiktokStreamlabsCallbackServer) return { ok: true, authUrl: tiktokStreamlabsAuthUrl };

  const { verifier, challenge } = createStreamlabsPkce();
  let authUrl = '';
  const callback = createServer(async (request, response) => {
    const callbackUrl = new URL(request.url || '/', 'http://127.0.0.1');
    const code = callbackUrl.searchParams.get('code') || '';
    if (callbackUrl.searchParams.get('success') !== 'true' || !code) {
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end('<meta charset="utf-8"><p>認証を完了できませんでした。SYNC LIVEに戻ってもう一度お試しください。</p>');
      return;
    }
    try {
      const params = new URLSearchParams({ code_verifier: verifier, code });
      const tokenResponse = await fetch(`https://streamlabs.com/api/v5/slobs/auth/data?${params}`, {
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 StreamlabsDesktop/1.20.4 Chrome/122.0.6261.156 Safari/537.36',
          accept: '*/*',
          'accept-language': 'en-US',
        },
        signal: AbortSignal.timeout(20000),
      });
      const tokenPayload = await tokenResponse.json().catch(() => null);
      const token = tokenPayload?.data?.oauth_token;
      if (!tokenResponse.ok || tokenPayload?.success !== true || typeof token !== 'string' || !token.trim()) {
        throw new Error('認証に失敗しました');
      }
      await saveEnv({ TIKTOK_STREAMLABS_TOKEN: token, TIKTOK_VIDEO_PROVIDER: 'streamlabs', TIKTOK_PRIVATE_API_ENABLED: 'false' });
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end('<meta charset="utf-8"><p>Streamlabs連携が完了しました。このタブを閉じてSYNC LIVEに戻ってください。</p>');
    } catch {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end('<meta charset="utf-8"><p>連携を完了できませんでした。SYNC LIVEに戻り、もう一度お試しください。</p>');
    } finally {
      clearTimeout(tiktokStreamlabsAuthTimer);
      tiktokStreamlabsAuthTimer = undefined;
      tiktokStreamlabsAuthUrl = '';
      const serverToClose = tiktokStreamlabsCallbackServer;
      tiktokStreamlabsCallbackServer = undefined;
      serverToClose?.close();
    }
  });
  tiktokStreamlabsCallbackServer = callback;
  callback.once('error', () => {
    clearTimeout(tiktokStreamlabsAuthTimer);
    tiktokStreamlabsAuthTimer = undefined;
    tiktokStreamlabsCallbackServer = undefined;
  });
  await new Promise((resolve, reject) => {
    callback.once('listening', resolve);
    callback.once('error', reject);
    callback.listen(0, '127.0.0.1');
  });
  const address = callback.address();
  if (!address || typeof address === 'string') {
    callback.close();
    tiktokStreamlabsCallbackServer = undefined;
    return { ok: false, error: 'Streamlabs認証の準備に失敗しました' };
  }
  authUrl = `https://streamlabs.com/slobs/login?skip_splash=true&external=electron&tiktok&force_verify&origin=slobs&port=${address.port}&code_challenge=${encodeURIComponent(challenge)}&code_flow=true`;
  tiktokStreamlabsAuthUrl = authUrl;
  tiktokStreamlabsAuthTimer = setTimeout(() => {
    const serverToClose = tiktokStreamlabsCallbackServer;
    tiktokStreamlabsCallbackServer = undefined;
    tiktokStreamlabsAuthUrl = '';
    serverToClose?.close();
  }, 5 * 60 * 1000);
  tiktokStreamlabsAuthTimer.unref?.();
  return { ok: true, authUrl };
}

let tiktokStreamlabsAuthUrl = '';

async function streamlabsApi(path, init = {}) {
  const token = process.env.TIKTOK_STREAMLABS_TOKEN?.trim();
  if (!token) throw new Error('Streamlabs連携が必要です');
  const response = await fetch(`https://streamlabs.com/api/v5/slobs/tiktok/${path}`, {
    ...init,
    headers: { ...(init.headers || {}), authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Streamlabs API エラー (HTTP ${response.status})`);
  return payload;
}

async function startTikTokStreamlabsRoom(title) {
  if (!title?.trim()) return { ok: false, error: 'TikTok LIVE枠の作成には共通タイトルが必要です' };
  if (tiktokStreamlabsRoomId) return { ok: false, error: 'TikTok LIVE枠はすでに作成されています' };
  try {
    const info = await streamlabsApi('info');
    if (!info?.can_be_live) return { ok: false, error: 'Streamlabs側でTikTok LIVE利用資格が必要です。StreamlabsのTikTok LIVEアクセスを確認してください' };
    const form = new FormData();
    form.append('title', title.trim().slice(0, 100));
    form.append('device_platform', 'win32');
    form.append('category', '');
    form.append('audience_type', '0');
    const result = await streamlabsApi('stream/start', { method: 'POST', body: form });
    const rtmp = String(result?.rtmp || '').trim().replace(/\/+$/, '');
    const streamKey = String(result?.key || '').trim().replace(/^\/+/, '');
    const id = String(result?.id || '').trim();
    if (id) tiktokStreamlabsRoomId = id;
    let parsed;
    try { parsed = new URL(rtmp); } catch {}
    if (!parsed || !['rtmp:', 'rtmps:'].includes(parsed.protocol) || !parsed.hostname || !streamKey || !id || /[\r\n]/.test(streamKey)) {
      if (id) await stopTikTokStreamlabsRoom();
      return { ok: false, error: 'StreamlabsからTikTok配信先を取得できませんでした。LIVE利用資格を確認してください' };
    }
    return { ok: true, ingestUrl: `${rtmp}/${streamKey}`, detail: 'Streamlabs経由でTikTok配信先を準備しました' };
  } catch (error) {
    return { ok: false, error: error.message || 'Streamlabs経由のTikTok設定に失敗しました' };
  }
}

async function stopTikTokStreamlabsRoom() {
  const id = tiktokStreamlabsRoomId;
  if (!id) return { ok: true, stopped: false };
  tiktokStreamlabsRoomId = '';
  try {
    const response = await fetch(`https://streamlabs.com/api/v5/slobs/tiktok/stream/${encodeURIComponent(id)}/end`, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.TIKTOK_STREAMLABS_TOKEN || ''}` },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) return { ok: false, stopped: false, error: 'TikTok LIVE枠の終了を確認できませんでした' };
    return { ok: true, stopped: true };
  } catch {
    return { ok: false, stopped: false, error: 'TikTok LIVE枠の終了を確認できませんでした' };
  }
}

function killTikTokWorkerTree(child) {
  if (process.platform === 'win32' && child?.pid) {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.unref();
    return;
  }
  child?.kill('SIGTERM');
}

async function startTikTokPrivateRoom(title) {
  if (!title?.trim()) return { ok: false, error: 'TikTok の枠作成には共通タイトルが必要です' };
  if (tiktokPrivateProcess) return { ok: false, error: 'TikTok LIVE枠はすでに作成されています' };
  const python = process.env.TIKTOK_PYTHON?.trim() || 'python';
  const generatorDir = process.env.TIKTOK_PRIVATE_API_DIR?.trim();
  const cookiePath = process.env.TIKTOK_COOKIE_JSON?.trim();
  const workerPath = process.env.TIKTOK_WORKER_SCRIPT?.trim() || join(ROOT, 'tiktok-private-worker.py');
  let signerKey = process.env.TIKTOK_SIGNER_API_KEY?.trim();
  if (!signerKey && generatorDir) {
    try {
      const generatorConfig = JSON.parse(readFileSync(join(generatorDir, 'config.json'), 'utf8'));
      signerKey = String(generatorConfig.rapidapi_key || '').trim();
    } catch {}
  }
  if (!generatorDir || !cookiePath || !signerKey) return { ok: false, error: 'TIKTOK_PRIVATE_API_DIR / TIKTOK_COOKIE_JSON / TIKTOK_SIGNER_API_KEY を .env に設定してください' };
  if (!existsSync(join(generatorDir, 'TiktokStreamKeyGenerator.py'))) return { ok: false, error: 'TIKTOK_PRIVATE_API_DIR に TiktokStreamKeyGenerator.py が見つかりません' };
  if (!existsSync(cookiePath)) return { ok: false, error: 'TIKTOK_COOKIE_JSON のファイルが見つかりません' };

  if (!existsSync(workerPath)) return { ok: false, error: 'TikTok worker script が見つかりません' };
  const env = {
    ...process.env,
    TIKTOK_PRIVATE_API_DIR: generatorDir,
    TIKTOK_COOKIE_JSON: cookiePath,
    TIKTOK_SIGNER_API_KEY: signerKey,
    TIKTOK_PRIVATE_RUNTIME_DIR: process.env.TIKTOK_PRIVATE_RUNTIME_DIR?.trim() || join(ROOT, '.runtime'),
  };
  const child = spawn(python, [workerPath], {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore'],
    env,
  });
  tiktokPrivateProcess = child;
  const lines = createInterface({ input: child.stdout });
  child.stdin.on('error', () => {});
  let ready = false;
  let settled = false;
  let workerErrorMessage = '';
  let timer;
  const startup = new Promise((resolve, reject) => {
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    timer = setTimeout(() => finish(new Error('TikTok の枠作成がタイムアウトしました')), 90000);
    child.once('error', error => finish(error));
    child.once('close', code => {
      if (!ready) finish(new Error(workerErrorMessage || (code === 1 ? 'TikTok の枠作成に失敗しました。設定と起動ログを確認してください' : `TikTok API worker が終了しました (${code ?? 'signal'})`)));
      if (tiktokPrivateProcess === child) {
        tiktokPrivateProcess = undefined;
        if (streamProcess) {
          setOutputHealth('tiktok', 'failed', 'TikTokの送信プロキシが停止しました');
          setStreamStatus(true, `TikTok API worker が終了しました (${code ?? 'signal'})`, Math.max(0, streamStatus.destinations - 1));
        }
      }
    });
    lines.on('line', line => {
      let packet;
      try { packet = JSON.parse(line); } catch { return; }
      if (packet.type === 'ready') {
        ready = true;
        finish(null, { ok: true, ingestUrl: packet.ingestUrl, detail: packet.detail || 'TikTok LIVE枠を作成しました' });
      } else if (packet.type === 'error') {
        workerErrorMessage = packet.error || 'TikTok API worker がエラーを返しました';
      } else if (packet.type === 'status' && streamProcess) {
        setStreamStatus(true, packet.detail || streamStatus.detail, streamStatus.destinations);
      } else if (packet.type === 'warning' && streamProcess) {
        setStreamStatus(true, `TikTok 接続警告: ${packet.detail || '状態を確認してください'}`, streamStatus.destinations);
      }
    });
  });
  child.stdin.write(`${JSON.stringify({ title: title.trim().slice(0, 100) })}\n`);
  try { return await startup; }
  catch (error) {
    if (tiktokPrivateProcess === child) {
      killTikTokWorkerTree(child);
      tiktokPrivateProcess = undefined;
    }
    return { ok: false, error: error.message };
  }
}

async function stopTikTokPrivateRoom() {
  if (tiktokPrivateStopPromise) return tiktokPrivateStopPromise;
  const child = tiktokPrivateProcess;
  if (!child) return { ok: true, stopped: false };
  tiktokPrivateStopPromise = new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (tiktokPrivateProcess === child) tiktokPrivateProcess = undefined;
      resolve({ ok: true, stopped: true });
    };
    const timer = setTimeout(() => { killTikTokWorkerTree(child); finish(); }, 60000);
    child.once('close', finish);
    try { child.stdin.write('{"action":"stop"}\n'); }
    catch { killTikTokWorkerTree(child); finish(); }
  }).finally(() => { tiktokPrivateStopPromise = undefined; });
  return tiktokPrivateStopPromise;
}

async function updatePlatformTitles(title, tiktokPrivateCreated = false, onlyPlatforms = null) {
  const results = [];
  const run = async (name, configured, action) => {
    if (onlyPlatforms && !onlyPlatforms.includes(name)) return;
    if (!configured) { results.push({ platform: name, ok: false, skipped: true, detail: '認証情報未設定' }); return; }
    try { await action(); results.push({ platform: name, ok: true, detail: 'タイトル更新済み' }); }
    catch (error) { results.push({ platform: name, ok: false, detail: error.message }); }
  };
  await run('twitch', !!(process.env.TWITCH_ACCESS_TOKEN && process.env.TWITCH_CLIENT_ID && process.env.TWITCH_BROADCASTER_ID), async () => {
    const token = await freshAccessToken('twitch');
    const response = await fetch(`https://api.twitch.tv/helix/channels?broadcaster_id=${encodeURIComponent(process.env.TWITCH_BROADCASTER_ID)}`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${token.replace(/^oauth:/i, '').trim()}`, 'Client-Id': process.env.TWITCH_CLIENT_ID, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title.slice(0, 100) }),
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error(`Twitch API HTTP ${response.status}: ${(await response.text()).slice(0, 240)}`);
  });
  await run('kick', !!process.env.KICK_ACCESS_TOKEN, async () => {
    const token = await freshAccessToken('kick');
    const response = await fetch('https://api.kick.com/public/v1/channels', {
      method: 'PATCH', headers: { Authorization: `Bearer ${token.trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ stream_title: title.slice(0, 100) }),
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error(`Kick API HTTP ${response.status}: ${(await response.text()).slice(0, 240)}`);
  });
  await run('youtube', !!(process.env.YOUTUBE_ACCESS_TOKEN && process.env.YOUTUBE_BROADCAST_ID), async () => {
    const token = (await freshAccessToken('youtube')).trim();
    const id = process.env.YOUTUBE_BROADCAST_ID.trim();
    const query = new URLSearchParams({ part: 'snippet,contentDetails', id });
    const get = await fetch(`https://www.googleapis.com/youtube/v3/liveBroadcasts?${query}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(12000) });
    const current = await get.json();
    if (!get.ok) throw new Error(`YouTube API HTTP ${get.status}: ${current.error?.message || 'broadcast 読み取り失敗'}`);
    const broadcast = current.items?.[0];
    if (!broadcast) throw new Error('YOUTUBE_BROADCAST_ID の配信が見つかりません');
    const snippet = broadcast.snippet || {};
    const details = broadcast.contentDetails || {};
    if (snippet.title === title.slice(0, 100) && details.latencyPreference === 'ultraLow') return;
    const monitorStream = details.monitorStream;
    if (!snippet.scheduledStartTime || !monitorStream || typeof monitorStream.enableMonitorStream !== 'boolean' || monitorStream.broadcastStreamDelayMs == null) {
      throw new Error('この YouTube 配信は API 更新に必要な設定を取得できません。ライブ配信を事前作成して YOUTUBE_BROADCAST_ID を設定してください');
    }
    const body = {
      id,
      snippet: {
        title: title.slice(0, 100), scheduledStartTime: snippet.scheduledStartTime,
        ...(snippet.description !== undefined ? { description: snippet.description } : {}),
        ...(snippet.categoryId !== undefined ? { categoryId: snippet.categoryId } : {}),
        ...(snippet.scheduledEndTime !== undefined ? { scheduledEndTime: snippet.scheduledEndTime } : {}),
      },
      contentDetails: {
        monitorStream,
        ...(details.latencyPreference ? { latencyPreference: details.latencyPreference } : {}),
        ...Object.fromEntries(['enableAutoStart','enableAutoStop','enableClosedCaptions','enableDvr','enableEmbed','recordFromStart'].filter(key => details[key] !== undefined).map(key => [key, details[key]])),
      },
    };
    const put = await fetch('https://www.googleapis.com/youtube/v3/liveBroadcasts?part=snippet,contentDetails', {
      method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(12000),
    });
    if (!put.ok) { const failure = await put.json(); throw new Error(`YouTube API HTTP ${put.status}: ${failure.error?.message || 'タイトル更新失敗'}`); }
  });
  if (!onlyPlatforms || onlyPlatforms.includes('tiktok')) results.push(tiktokPrivateCreated
    ? { platform: 'tiktok', ok: true, detail: '指定タイトルでLIVE枠を作成済み' }
    : { platform: 'tiktok', ok: false, skipped: true, detail: tikTokLiveStudioEnabled() ? 'TikTokのタイトルはLIVE Studioで設定してください' : 'TikTok非公式枠APIが未設定です。TIKTOK_PRIVATE_API_ENABLED=true を設定してください' });
  return results;
}

async function startStreamRelay(title, { startObs = true, onlyPlatforms = null, autoArm = false } = {}) {
  if (!LIVE_MODE) return { ok: false, error: '配信リレーは LIVE モードで設定してください' };
  if (streamProcess) return { ok: true, running: true, detail: streamStatus.detail };
  const selected = onlyPlatforms ? [...new Set(onlyPlatforms.filter(id => MULTI_STREAM_PLATFORMS.includes(id)))] : null;
  if (onlyPlatforms && !selected.length) return { ok: false, error: '配信先を選んでください' };
  const allTargets = [
    ['twitch', process.env.RTMP_TWITCH],
    ['kick', process.env.RTMP_KICK],
    ['youtube', process.env.RTMP_YOUTUBE],
  ];
  const targets = selected ? allTargets.filter(([id]) => selected.includes(id)) : allTargets;
  const missing = targets.filter(([, value]) => !value?.trim()).map(([id]) => id);
  const requireAll = (process.env.LIVEBRIDGE_REQUIRE_ALL_DESTINATIONS || 'false').toLowerCase() === 'true';
  if (selected && missing.length) return { ok: false, error: `選択した配信先のRTMP URLが未設定です: ${missing.join(', ')}` };
  if (!selected && requireAll && missing.length) return { ok: false, error: `配信先 RTMP URL が未設定です: ${missing.join(', ')}` };
  const configured = targets.filter(([, value]) => value?.trim());
  if (!configured.length) return { ok: false, error: 'YouTube・Twitch・KickのRTMP設定を確認してください' };
  const invalid = configured.filter(([, value]) => !/^rtmps?:\/\//i.test(value.trim())).map(([id]) => id);
  if (invalid.length) return { ok: false, error: `RTMP または RTMPS URL が必要です: ${invalid.join(', ')}` };
  let youtubeBroadcast;
  let youtubeWarning = '';
  if ((!selected || selected.includes('youtube')) && process.env.RTMP_YOUTUBE?.trim()) {
    try {
      youtubeBroadcast = await prepareYouTubeBroadcast(title.trim(), process.env.RTMP_YOUTUBE, { createIfMissing: !autoArm });
      if (!youtubeBroadcast && !autoArm) throw new Error('YouTube OAuth連携が必要です');
      if (!youtubeBroadcast && autoArm) youtubeWarning = 'YouTube配信枠を確認できません。Studio側の配信枠・自動開始設定を確認してください';
      if (active.has('youtube')) stopProvider('youtube');
    } catch (error) {
      if (autoArm) {
        youtubeWarning = ['quotaExceeded', 'dailyLimitExceeded'].includes(error.code)
          ? 'YouTube APIの利用枠を確認できず、映像送信後の自動公開を確認できません。Studio側の状態を確認してください'
          : 'YouTube配信枠を自動確認できません。Studio側の配信枠・自動開始設定を確認してください';
      } else if (['quotaExceeded', 'dailyLimitExceeded'].includes(error.code)) {
        youtubeWarning = 'YouTube API枠超過。映像は送信しますが、今回はYouTube Studioで公開開始してください';
      } else {
        return { ok: false, error: `YouTube配信枠の準備に失敗しました: ${error.message}` };
      }
    }
  }
  const input = process.env.OBS_INGEST_URL || 'rtmp://127.0.0.1:1935/live/stream';
  const teeTargets = configured.map(([, value]) => `[f=flv:onfail=ignore]${escapeTeeUrl(value.trim())}`).join('|');
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  const args = ['-hide_banner', '-loglevel', 'info', '-listen', '1', '-i', input, '-map', '0', '-c', 'copy', '-f', 'tee', teeTargets];
  const initialOutputs = Object.fromEntries(configured.map(([platform]) => [platform, { status: 'waiting', detail: 'OBS映像の入力待ち' }]));
  const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  streamProcess = child;
  setStreamStatus(false, 'OBS の映像入力を待機中', configured.length, initialOutputs);
  child.once('spawn', () => setStreamStatus(true, `OBS 入力待機中 · ${configured.length} 配信先`, configured.length, initialOutputs));
  let stderrBuffer = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', chunk => {
    stderrBuffer += chunk;
    const lines = stderrBuffer.split(/\r\n|\r|\n/);
    stderrBuffer = lines.pop() || '';
    for (const line of lines) {
      const failure = line.match(/Slave muxer #(\d+) failed/i);
      if (failure) {
        const target = configured[Number(failure[1])];
        if (target) setOutputHealth(target[0], 'failed', 'RTMP接続に失敗しました。配信キー・URL・ネットワークを確認してください');
      }
      if (/All tee outputs failed/i.test(line)) {
        for (const [platform] of configured) setOutputHealth(platform, 'failed', 'すべての配信先へのRTMP送信に失敗しました');
      }
      if (/frame\s*=\s*\d+/i.test(line)) {
        for (const [platform] of configured) {
          if (streamStatus.outputs[platform]?.status === 'waiting') setOutputHealth(platform, 'sending', 'FFmpegからRTMP送信中');
        }
      }
    }
  });
  child.once('error', error => {
    streamProcess = undefined;
    const detail = error.code === 'ENOENT' ? 'FFmpeg が見つかりません。FFMPEG_PATH を設定してください' : `FFmpeg 起動失敗: ${error.message}`;
    const failedOutputs = Object.fromEntries(configured.map(([platform]) => [platform, { status: 'failed', detail: '配信リレーを起動できませんでした' }]));
    setStreamStatus(false, detail, 0, failedOutputs);
  });
  child.once('close', code => {
    if (streamProcess === child) streamProcess = undefined;
    const outputs = finishOutputHealth(code === 0 ? 'stopped' : 'failed', code === 0 ? '停止中' : '配信リレーが異常終了しました');
    setStreamStatus(false, code === 0 ? '停止中' : `FFmpeg 終了 (${code ?? 'signal'})`, 0, outputs);
    if (autoArmRelay && code === 0) {
      setTimeout(() => {
        if (!autoArmRelay || streamProcess) return;
        void startStreamRelay('', { startObs: false, onlyPlatforms: MULTI_STREAM_PLATFORMS, autoArm: true }).then(result => {
          if (!result.ok) { autoArmRelay = false; setStreamStatus(false, `OBS配信待機を再開できません: ${result.error}`, 0, {}); }
        }).catch(() => { autoArmRelay = false; setStreamStatus(false, 'OBS配信待機を再開できません', 0, {}); });
      }, 1200);
    }
  });
  const spawnReady = new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  try { await spawnReady; }
  catch (error) { return { ok: false, error: error.code === 'ENOENT' ? 'FFmpeg が見つかりません。FFMPEG_PATH を設定してください' : `FFmpeg 起動失敗: ${error.message}` }; }
  const titleResults = title?.trim() ? await updatePlatformTitles(title.trim(), false, selected) : [];
  let obsStarted = false;
  let obsDetail = startObs ? 'OBS WebSocket 未設定。OBS で配信開始を押してください' : 'OBSの「配信開始」を押してください';
  if (startObs && process.env.OBS_WS_URL?.trim() && process.env.OBS_WS_PASSWORD) {
    try {
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (streamProcess !== child) throw new Error('配信リレーが起動できませんでした');
      const client = await getObsClient();
      await client.call('StartStream');
      obsStarted = true;
      obsDetail = 'OBS も配信開始しました';
    } catch (error) { obsDetail = `OBS 自動開始失敗: ${error.message}`; }
  }
  const titleSummary = titleResults.map(item => `${item.platform}:${item.ok ? 'OK' : item.skipped ? '手動' : '要確認'}`).join(' / ');
  const detail = `${obsDetail}${titleSummary ? ` · タイトル ${titleSummary}` : ''}${youtubeWarning ? ` · ${youtubeWarning}` : ''}`;
  setStreamStatus(true, detail, configured.length);
  if (youtubeBroadcast) void watchYouTubeBroadcast(child, youtubeBroadcast);
  // Chat reception must not depend on FFmpeg's progress/status detection.
  if ((!selected || selected.includes('youtube')) && (process.env.YOUTUBE_CHANNEL_ID || process.env.YOUTUBE_BROADCAST_ID)) {
    void connectYouTube().catch(error => setConnected('youtube', false, error.message));
  }
  return { ok: true, running: true, detail, titles: titleResults, obsStarted };
}

async function watchYouTubeBroadcast(child, broadcast) {
  let failures = 0;
  let watchStartedAt;
  const requestedTransitions = new Set();
  while (streamProcess === child) {
    if (streamStatus.outputs.youtube?.status !== 'sending') {
      await new Promise(resolve => setTimeout(resolve, 5000));
      continue;
    }
    watchStartedAt ??= Date.now();
    if (Date.now() - watchStartedAt >= 5 * 60 * 1000) {
      setOutputHealth('youtube', 'failed', 'YouTubeの公開開始を5分以内に確認できませんでした。YouTube Studioで状態を確認してください');
      return;
    }
    if (!active.has('youtube')) {
      void connectYouTube().catch(error => setConnected('youtube', false, error.message));
    }
    try {
      const state = await advanceYouTubeBroadcast(broadcast.id, broadcast.streamId, requestedTransitions);
      if (state === 'live') {
        setOutputHealth('youtube', 'sending', 'YouTubeで公開中');
        return;
      }
      failures = 0;
    } catch (error) {
      if (['quotaExceeded', 'dailyLimitExceeded'].includes(error.code)) {
        setOutputHealth('youtube', 'failed', 'YouTube API利用枠を超過しました。Studioで公開開始してください');
        return;
      }
      if (++failures >= 24) {
        setOutputHealth('youtube', 'failed', `YouTube公開開始失敗: ${error.message}`);
        return;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}

async function stopStreamRelay() {
  autoArmRelay = false;
  if (active.has('youtube')) stopProvider('youtube');
  let obsDetail = '';
  if (obsClient) {
    try { await obsClient.call('StopStream'); obsDetail = 'OBS 停止済み · '; }
    catch (error) { obsDetail = `OBS 停止失敗: ${error.message} · `; }
  }
  if (!streamProcess) {
    const tikTokStopped = tiktokPrivateProcess ? await stopTikTokPrivateRoom() : undefined;
    const streamlabsStopped = tiktokStreamlabsRoomId ? await stopTikTokStreamlabsRoom() : undefined;
    setStreamStatus(false, '停止中', 0, finishOutputHealth('stopped', '停止中'));
    return { ok: true, running: false, detail: tikTokStopped?.stopped || streamlabsStopped?.stopped ? 'TikTok LIVEを終了しました' : '停止中' };
  }
  const child = streamProcess;
  streamProcess = undefined;
  child.kill('SIGTERM');
  setStreamStatus(false, '停止処理中', 0, finishOutputHealth('stopping', '停止処理中'));
  const tikTokStopped = tiktokPrivateProcess ? await stopTikTokPrivateRoom() : undefined;
  const streamlabsStopped = tiktokStreamlabsRoomId ? await stopTikTokStreamlabsRoom() : undefined;
  return { ok: true, running: false, detail: `${obsDetail}${tikTokStopped?.stopped || streamlabsStopped?.stopped ? 'TikTok LIVE終了済み' : '配信リレー停止処理中'}` };
}

function publish(message) {
  if (!message?.text || !message?.user || !platformIds.has(message.platform)) return;
  const normalized = {
    id: message.id || `${message.platform}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    platform: message.platform,
    user: String(message.user).slice(0, 120),
    text: String(message.text).slice(0, 2000),
    time: message.time || new Date().toLocaleTimeString('ja-JP', { hour12: false }),
    createdAt: message.createdAt || new Date().toISOString(),
  };
  messages.unshift(normalized);
  if (messages.length > 500) messages.length = 500;
  emit('message', normalized);
}

function stopProvider(platform) {
  if (platform === 'tiktok') {
    tiktokReconnectEnabled = false;
    clearTimeout(tiktokReconnectTimer);
    tiktokReconnectTimer = undefined;
    clearTimeout(tiktokStatsTimer);
    tiktokStatsTimer = undefined;
    tiktokConnection = undefined;
    setTikTokAudience({ live: false, viewers: null, status: process.env.TIKTOK_USERNAME ? 'offline' : 'unconfigured' });
  }
  const provider = active.get(platform);
  if (!provider) { setConnected(platform, false); return; }
  try { provider.stop?.(); } catch {}
  active.delete(platform);
  setConnected(platform, false);
}

function parseTwitchLine(line) {
  if (line.startsWith('PING ')) return { pong: line.replace(/^PING/, 'PONG') };
  const match = line.match(/^(?:@([^ ]+) )?:([^! ]+)!.* PRIVMSG #[^ ]+ :(.*)$/);
  if (!match) return {};
  const tagText = match[1] || '';
  const tags = Object.fromEntries(tagText.split(';').map(entry => {
    const [key, ...rest] = entry.split('=');
    return [key, rest.join('=')];
  }));
  return { message: { platform: 'twitch', user: tags['display-name'] || match[2], text: match[3], id: tags.id } };
}

async function connectTwitch(handle) {
  const token = (await freshAccessToken('twitch'))?.replace(/^oauth:/i, '').trim();
  const nick = process.env.TWITCH_USERNAME?.trim().toLowerCase();
  const channel = (handle || process.env.TWITCH_CHANNEL || '').trim().replace(/^#/, '').toLowerCase();
  if (!token || !nick || !channel) throw new Error('TWITCH_ACCESS_TOKEN / TWITCH_USERNAME を .env に設定し、接続設定にチャンネル名を入力してください');
  if (typeof WebSocket === 'undefined') throw new Error('この Node.js には WebSocket がありません。Node.js 20 以降で実行してください');
  const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
  let opened = false;
  let buffer = '';
  const timeout = setTimeout(() => { if (!opened) ws.close(); }, 12000);
  ws.addEventListener('open', () => {
    opened = true; clearTimeout(timeout);
    ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
    ws.send(`PASS oauth:${token}`);
    ws.send(`NICK ${nick}`);
    ws.send(`JOIN #${channel}`);
    setConnected('twitch', true, `#${channel}`);
  });
  ws.addEventListener('message', event => {
    buffer += typeof event.data === 'string' ? event.data : '';
    const lines = buffer.split('\r\n'); buffer = lines.pop() || '';
    for (const line of lines) {
      const result = parseTwitchLine(line);
      if (result.pong) ws.send(result.pong);
      if (result.message) publish(result.message);
      if (line.includes('Login authentication failed')) { ws.close(); setConnected('twitch', false, 'OAuth 認証に失敗しました'); }
    }
  });
  ws.addEventListener('close', () => { clearTimeout(timeout); setConnected('twitch', false, '切断'); });
  ws.addEventListener('error', () => { setConnected('twitch', false, 'WebSocket エラー'); });
  active.set('twitch', { stop: () => ws.close() });
}

async function connectYouTube() {
  if (active.has('youtube')) return { ok: true, connected: true };
  const liveId = process.env.YOUTUBE_BROADCAST_ID?.trim();
  const channelId = process.env.YOUTUBE_CHANNEL_ID?.trim();
  if (!channelId && !liveId) throw new Error('YouTubeのチャンネルIDまたは配信枠IDが設定されていません');

  const { LiveChat } = await import('youtube-chat');
  const state = { stopped: false, current: undefined, retryTimer: undefined, retryMs: 5000, seenIds: new Set() };
  const genericError = error => error?.response?.status
    ? `YouTubeコメント取得エラー (HTTP ${error.response.status})`
    : 'YouTubeコメント取得中にエラーが発生しました';
  const scheduleRetry = () => {
    if (state.stopped || state.retryTimer) return;
    setConnected('youtube', false, 'YouTubeコメントを再接続しています');
    state.retryTimer = setTimeout(() => {
      state.retryTimer = undefined;
      void start().catch(() => scheduleRetry());
    }, state.retryMs);
    state.retryTimer.unref?.();
    state.retryMs = Math.min(60000, state.retryMs * 2);
  };
  const start = async () => {
    if (state.stopped) return;
    const chat = new LiveChat(channelId ? { channelId } : { liveId }, 2000);
    state.current = chat;
    chat.on('start', () => {
      if (state.current !== chat || state.stopped) return;
      state.retryMs = 5000;
      setConnected('youtube', true, 'YouTubeコメント受信中 · 非公式接続');
    });
    chat.on('chat', item => {
      if (state.current !== chat || state.stopped) return;
      if (item?.id && state.seenIds.has(item.id)) return;
      if (item?.id) {
        state.seenIds.add(item.id);
        if (state.seenIds.size > 2000) state.seenIds.delete(state.seenIds.values().next().value);
      }
      const text = (item?.message || []).map(part => typeof part === 'string' ? part : (part?.text || part?.emojiText || '')).join('');
      if (!text) return;
      setConnected('youtube', true, 'YouTubeコメント受信中 · 非公式接続');
      publish({
        platform: 'youtube',
        id: item.id,
        user: item.author?.name || 'YouTube user',
        text,
        createdAt: item.timestamp instanceof Date && !Number.isNaN(item.timestamp.getTime()) ? item.timestamp.toISOString() : undefined,
      });
    });
    chat.on('error', error => {
      if (state.current !== chat || state.stopped) return;
      setConnected('youtube', false, genericError(error));
      state.current = undefined;
      chat.stop();
      scheduleRetry();
    });
    chat.on('end', () => {
      if (state.current !== chat || state.stopped) return;
      state.current = undefined;
      scheduleRetry();
    });
    const started = await chat.start();
    if (state.stopped || state.current !== chat) { chat.stop(); return; }
    if (!started) {
      state.current = undefined;
      scheduleRetry();
    }
  };
  active.set('youtube', { stop: () => {
    state.stopped = true;
    clearTimeout(state.retryTimer);
    state.retryTimer = undefined;
    state.current?.stop();
    state.current = undefined;
  } });
  await start();
  return { ok: true, connected: connected.youtube };
}

function tiktokStartedAt(roomInfo) {
  const raw = Number(roomInfo?.create_time ?? roomInfo?.room_info?.create_time ?? roomInfo?.data?.create_time ?? roomInfo?.data?.room_info?.create_time);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const date = new Date(raw > 1e12 ? raw : raw * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function tiktokRoomViewerCount(roomInfo) {
  const countKeys = new Set(['user_count', 'userCount', 'viewer_count', 'viewerCount', 'online_user_count', 'onlineUserCount']);
  const find = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 8) return null;
    for (const [key, child] of Object.entries(value)) {
      if (countKeys.has(key) && (typeof child === 'number' || (typeof child === 'string' && /^\d+$/.test(child)))) {
        const count = Number(child);
        if (Number.isFinite(count) && count >= 0) return count;
      }
      if (child && typeof child === 'object') {
        const nested = find(child, depth + 1);
        if (nested !== null) return nested;
      }
    }
    return null;
  };
  return find(roomInfo);
}

function setTikTokAudience({ live, viewers = null, startedAt = null, status }) {
  audience = {
    ...audience,
    tiktok: { live, viewers, startedAt, status, updatedAt: new Date().toISOString() },
  };
  emit('audience', audience);
}

function scheduleTikTokReconnect(username) {
  if (!tiktokReconnectEnabled || tiktokReconnectTimer || active.has('tiktok')) return;
  tiktokReconnectTimer = setTimeout(() => {
    tiktokReconnectTimer = undefined;
    void connectTikTok(username).catch(() => {});
  }, 60_000);
  tiktokReconnectTimer.unref?.();
}

function scheduleTikTokRoomInfoRefresh(connection) {
  clearTimeout(tiktokStatsTimer);
  tiktokStatsTimer = setTimeout(async () => {
    tiktokStatsTimer = undefined;
    if (tiktokConnection !== connection || !connection.isConnected) return;
    try {
      const roomInfo = await connection.fetchRoomInfo();
      if (tiktokConnection !== connection) return;
      const viewers = tiktokRoomViewerCount(roomInfo);
      const startedAt = tiktokStartedAt(roomInfo) || audience.tiktok?.startedAt || null;
      if (roomInfo?.data?.status === 4) {
        setTikTokAudience({ live: false, viewers: null, status: 'offline' });
      } else if (viewers !== null) {
        setTikTokAudience({ live: true, viewers, startedAt, status: 'live' });
      } else if (!audience.tiktok?.live) {
        setTikTokAudience({ live: false, viewers: null, startedAt, status: 'waiting' });
      }
    } catch {}
    scheduleTikTokRoomInfoRefresh(connection);
  }, 60_000);
  tiktokStatsTimer.unref?.();
}

async function connectTikTok(handle) {
  const username = (handle || process.env.TIKTOK_USERNAME || '').trim().replace(/^@/, '');
  if (!username) throw new Error('接続設定で TikTok ユーザー名を設定してください');
  tiktokReconnectEnabled = true;
  clearTimeout(tiktokReconnectTimer);
  tiktokReconnectTimer = undefined;
  if (active.has('tiktok')) return { ok: true, connected: true };
  if (tiktokConnectPromise) return tiktokConnectPromise;

  const attempt = (async () => {
    let connection;
    try {
      const { TikTokLiveConnection, WebcastEvent } = await import('tiktok-live-connector');
      const options = process.env.TIKTOK_SIGN_API_KEY ? { signApiKey: process.env.TIKTOK_SIGN_API_KEY } : {};
      connection = new TikTokLiveConnection(username, options);
      tiktokConnection = connection;
      let streamEnded = false;
      connection.on(WebcastEvent.CHAT, data => publish({
        platform: 'tiktok', user: data.user?.nickname || data.user?.uniqueId || 'TikTok user', text: data.comment,
        id: data.msgId, createdAt: data.createTime ? new Date(Number(data.createTime) * 1000).toISOString() : undefined,
      }));
      connection.on(WebcastEvent.ROOM_USER, data => {
        if (tiktokConnection !== connection || streamEnded) return;
        const viewers = Number(data?.viewerCount);
        if (Number.isFinite(viewers) && viewers >= 0) {
          setTikTokAudience({
            live: true,
            viewers,
            startedAt: tiktokStartedAt(connection.roomInfo) || audience.tiktok?.startedAt || null,
            status: 'live',
          });
        }
      });
      connection.on(WebcastEvent.STREAM_END, () => {
        if (tiktokConnection !== connection) return;
        streamEnded = true;
        clearTimeout(tiktokStatsTimer);
        tiktokStatsTimer = undefined;
        setTikTokAudience({ live: false, viewers: null, status: 'offline' });
        setConnected('tiktok', false, 'TikTok LIVE終了 · 再接続待機中');
      });
      connection.on('disconnected', () => {
        if (tiktokConnection !== connection) return;
        clearTimeout(tiktokStatsTimer);
        tiktokStatsTimer = undefined;
        tiktokConnection = undefined;
        if (active.get('tiktok')?.connection === connection) active.delete('tiktok');
        if (audience.tiktok?.live) setTikTokAudience({ live: false, viewers: null, status: 'reconnecting' });
        setConnected('tiktok', false, 'TikTokコメント・同接を再接続しています');
        scheduleTikTokReconnect(username);
      });
      connection.on('error', () => {
        if (tiktokConnection !== connection) return;
        clearTimeout(tiktokStatsTimer);
        tiktokStatsTimer = undefined;
        setTikTokAudience({ live: false, viewers: null, status: 'reconnecting' });
        setConnected('tiktok', false, 'TikTokコメント・同接を再接続しています');
        try { connection.disconnect?.(); } catch {}
        if (active.get('tiktok')?.connection === connection) active.delete('tiktok');
        tiktokConnection = undefined;
        scheduleTikTokReconnect(username);
      });
      await connection.connect();
      if (!tiktokReconnectEnabled || tiktokConnection !== connection) {
        connection.disconnect?.();
        return { ok: false, connected: false };
      }
      active.set('tiktok', { connection, stop: () => connection.disconnect?.() });
      const startedAt = tiktokStartedAt(connection.roomInfo);
      const viewers = tiktokRoomViewerCount(connection.roomInfo);
      setTikTokAudience({ live: viewers !== null, viewers, startedAt, status: viewers === null ? 'waiting' : 'live' });
      scheduleTikTokRoomInfoRefresh(connection);
      setConnected('tiktok', true, `@${username} · 非公式 API`);
      return { ok: true, connected: true };
    } catch (error) {
      if (tiktokConnection === connection) tiktokConnection = undefined;
      if (active.get('tiktok')?.connection === connection) active.delete('tiktok');
      try { connection?.disconnect?.(); } catch {}
      setTikTokAudience({ live: false, viewers: null, status: 'reconnecting' });
      setConnected('tiktok', false, 'TikTokコメント・同接を再接続しています');
      scheduleTikTokReconnect(username);
      throw error;
    }
  })();
  tiktokConnectPromise = attempt;
  try { return await attempt; }
  finally { if (tiktokConnectPromise === attempt) tiktokConnectPromise = undefined; }
}

async function ensureKickChatSubscription() {
  const base = process.env.KICK_WEBHOOK_PUBLIC_URL?.trim();
  if (!base) throw new Error('Kick は公式 EventSub Webhook で受信します。.env に公開 HTTPS URL を設定してください');
  let publicUrl;
  try { publicUrl = new URL(base); } catch { throw new Error('KICK_WEBHOOK_PUBLIC_URL がURL形式ではありません'); }
  if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash) {
    throw new Error('KICK_WEBHOOK_PUBLIC_URL には認証情報やパスを含まない公開 HTTPS URL を設定してください');
  }
  const token = await freshAccessToken('kick');
  if (!token) throw new Error('Kick公式連携が必要です');
  const headers = { Authorization: `Bearer ${token.trim()}`, 'Content-Type': 'application/json' };
  const listResponse = await fetch('https://api.kick.com/public/v1/events/subscriptions', { headers });
  if (!listResponse.ok) throw new Error(`Kickのコメント購読状況を取得できません (HTTP ${listResponse.status})`);
  const listed = await listResponse.json();
  const subscriptions = Array.isArray(listed.data) ? listed.data : [];
  const chatSubscriptions = subscriptions.filter(item => item.event === 'chat.message.sent' && item.method === 'webhook');
  const webhookUrl = publicUrl.toString().replace(/\/$/, '');
  const refreshSubscription = kickWebhookSubscribedUrl !== webhookUrl;
  if (refreshSubscription && chatSubscriptions.length) {
    const ids = chatSubscriptions.map(item => item.id).filter(Boolean);
    if (ids.length !== chatSubscriptions.length) throw new Error('Kickの古いコメント購読を特定できません');
    const deleteUrl = new URL('https://api.kick.com/public/v1/events/subscriptions');
    for (const id of ids) deleteUrl.searchParams.append('id', id);
    const deleted = await fetch(deleteUrl, { method: 'DELETE', headers });
    if (!deleted.ok) throw new Error(`Kickの古いコメント購読を更新できません (HTTP ${deleted.status})`);
  }
  if (refreshSubscription || !chatSubscriptions.length) {
    const response = await fetch('https://api.kick.com/public/v1/events/subscriptions', {
      method: 'POST', headers,
      body: JSON.stringify({ method: 'webhook', events: [{ name: 'chat.message.sent', version: 1 }] }),
    });
    const result = await response.json().catch(() => ({}));
    const created = Array.isArray(result.data) ? result.data : [];
    if (!response.ok || created.some(item => item.error) || !created.some(item => item.name === 'chat.message.sent' && !item.error)) {
      throw new Error(`Kickのコメント購読を作成できません (HTTP ${response.status})`);
    }
  }
  kickWebhookSubscribedUrl = webhookUrl;
  return webhookUrl;
}

async function connectPlatform(platform, handle) {
  if (!LIVE_MODE) {
    setConnected(platform, true, 'デモ接続');
    return { ok: true, mode: 'demo', connected: true };
  }
  if (active.has(platform)) { stopProvider(platform); return { ok: true, connected: false }; }
  if (platform === 'twitch') await connectTwitch(handle);
  else if (platform === 'youtube') {
    if (!streamStatus.running) throw new Error('YouTubeコメントは配信開始後に自動接続します');
    await connectYouTube();
  }
  else if (platform === 'tiktok') await connectTikTok(handle);
  else if (platform === 'kick') {
    const webhookBase = await ensureKickChatSubscription();
    setConnected('kick', true, `Webhook 待機中: ${webhookBase}/webhooks/kick`);
    return { ok: true, mode: 'live', connected: true, detail: 'Kick EventSub Webhook を待機中' };
  }
  return { ok: true, mode: 'live', connected: Boolean(connected[platform]) };
}

async function readRawBody(request, limit = 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > limit) throw new Error('Request body too large'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

async function getKickPublicKey() {
  if (kickPublicKey) return kickPublicKey;
  const response = await fetch('https://api.kick.com/public/v1/public-key');
  if (!response.ok) throw new Error(`Kick public key API HTTP ${response.status}`);
  const result = await response.json();
  const raw = result.data?.public_key || result.public_key || result.data?.publicKey || result.publicKey;
  if (!raw) throw new Error('Kick public key が見つかりません');
  kickPublicKey = createPublicKey(raw.includes('BEGIN PUBLIC KEY') ? raw : `-----BEGIN PUBLIC KEY-----\n${raw}\n-----END PUBLIC KEY-----`);
  return kickPublicKey;
}

async function handleKickWebhook(request, response) {
  const body = await readRawBody(request);
  const messageId = request.headers['kick-event-message-id'];
  const timestamp = request.headers['kick-event-message-timestamp'];
  const signature = request.headers['kick-event-signature'];
  const eventType = request.headers['kick-event-type'];
  if (!messageId || !timestamp || !signature) { response.writeHead(401).end('Missing Kick signature headers'); return; }
  const key = await getKickPublicKey();
  const signed = Buffer.from(`${messageId}.${timestamp}.${body.toString('utf8')}`);
  const isValid = verifySignature('RSA-SHA256', signed, key, Buffer.from(signature, 'base64'));
  if (!isValid) { response.writeHead(401).end('Invalid signature'); return; }
  if (processedKickIds.has(messageId)) { response.writeHead(200).end('Duplicate'); return; }
  processedKickIds.add(messageId); if (processedKickIds.size > 5000) processedKickIds.delete(processedKickIds.values().next().value);
  const payload = JSON.parse(body.toString('utf8'));
  if (eventType === 'chat.message.sent') {
    const sender = payload.sender || {};
    publish({ platform: 'kick', user: sender.username || 'Kick user', text: payload.content, id: messageId, createdAt: payload.created_at || timestamp });
    setConnected('kick', true, 'Webhook 受信中');
  }
  response.writeHead(200, { 'content-type': 'text/plain' }).end('OK');
}

async function readJson(request) {
  const raw = await readRawBody(request, 64 * 1024);
  return raw.length ? JSON.parse(raw.toString('utf8')) : {};
}

const contentTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8' };

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (await handleOAuthSetup(request, response, url, async platform => {
      if (platform === 'twitch' || platform === 'youtube') {
        if (active.has(platform)) stopProvider(platform);
        if (platform === 'twitch' || (platform === 'youtube' && streamStatus.running && (process.env.YOUTUBE_CHANNEL_ID || process.env.YOUTUBE_BROADCAST_ID))) await connectPlatform(platform);
      }
    })) return;
    if (await handleMetadata(request, response, url)) return;
    if (request.method === 'GET' && url.pathname === '/api/state') {
      const readiness = {
        twitch: { chat: !!(process.env.TWITCH_ACCESS_TOKEN && process.env.TWITCH_USERNAME && process.env.TWITCH_CHANNEL), title: !!(process.env.TWITCH_ACCESS_TOKEN && process.env.TWITCH_CLIENT_ID && process.env.TWITCH_BROADCASTER_ID), stream: !!process.env.RTMP_TWITCH?.trim() },
        kick: { chat: !!(process.env.KICK_WEBHOOK_PUBLIC_URL && process.env.KICK_ACCESS_TOKEN), title: !!process.env.KICK_ACCESS_TOKEN, stream: !!process.env.RTMP_KICK?.trim() },
        tiktok: { chat: !!process.env.TIKTOK_USERNAME, video: !tikTokLiveStudioEnabled() && !!(process.env.RTMP_TIKTOK || tikTokPrivateEnabled() || tikTokStreamlabsEnabled()), externalVideo: tikTokLiveStudioEnabled(), stream: !!process.env.RTMP_TIKTOK?.trim() },
        youtube: { chat: !!(process.env.YOUTUBE_CHANNEL_ID || process.env.YOUTUBE_BROADCAST_ID), title: !!(process.env.YOUTUBE_ACCESS_TOKEN && process.env.YOUTUBE_BROADCAST_ID), stream: !!process.env.RTMP_YOUTUBE?.trim() },
      };
      const tiktokVideoProvider = tikTokLiveStudioEnabled() ? 'live-studio' : tikTokStreamlabsEnabled() ? 'streamlabs' : tikTokPrivateEnabled() ? 'rapidapi' : process.env.RTMP_TIKTOK ? 'rtmp' : 'none';
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ mode: LIVE_MODE ? 'live' : 'demo', connected, messages, stream: streamStatus, audience, readiness, obsIngestUrl: process.env.OBS_INGEST_URL || 'rtmp://127.0.0.1:1935/live/stream', tiktokPrivateEnabled: tikTokPrivateEnabled(), tiktokVideoProvider })); return;
    }
    if (request.method === 'POST' && url.pathname === '/api/settings/tiktok-streamlabs/connect') {
      const remote = request.socket.remoteAddress || '';
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
        response.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ ok: false, error: 'この操作はこのPC上からのみ実行できます' })); return;
      }
      const result = await beginTikTokStreamlabsConnect();
      response.writeHead(result.ok ? 200 : 409, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(result)); return;
    }
    if (request.method === 'POST' && url.pathname === '/api/settings/tiktok-rtmp') {
      if (streamProcess) { response.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: '配信を停止してから設定してください' })); return; }
      const body = await readJson(request);
      const serverUrl = String(body.serverUrl || '').trim().replace(/\/+$/, '');
      const streamKey = String(body.streamKey || '').trim().replace(/^\/+/, '');
      let parsed;
      try { parsed = new URL(serverUrl); } catch {}
      if (!parsed || !['rtmp:', 'rtmps:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash || !streamKey || /[\r\n]/.test(streamKey)) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'TikTokのRTMP URLとストリームキーを確認してください' })); return;
      }
      try {
        await saveEnv({ RTMP_TIKTOK: `${serverUrl}/${streamKey}`, TIKTOK_VIDEO_PROVIDER: 'rtmp', TIKTOK_PRIVATE_API_ENABLED: 'false' });
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, configured: true }));
      } catch {
        response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: '設定を保存できませんでした' }));
      }
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/demo/comment') {
      if (LIVE_MODE) { response.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'デモモードのみ使えます' })); return; }
      const body = await readJson(request);
      if (!platformIds.has(body.platform)) { response.writeHead(400).end('Invalid platform'); return; }
      publish({ platform: body.platform, user: body.user || 'demo_viewer', text: body.text || 'テストコメント' });
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true })); return;
    }
    if (request.method === 'POST' && url.pathname === '/api/manual/comment') {
      if (!LIVE_MODE) { response.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'ライブ接続モードで使用してください' })); return; }
      const body = await readJson(request);
      const platform = String(body.platform || '');
      const text = String(body.text || '').trim().slice(0, 2000);
      if (!platformIds.has(platform) || !text) { response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: '表示先とコメントを入力してください' })); return; }
      publish({ platform, user: '手動入力', text });
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true })); return;
    }
    if (request.method === 'GET' && url.pathname === '/api/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      response.write(`data: ${JSON.stringify({ type: 'state', data: { connected, messages, stream: streamStatus, audience } })}\n\n`);
      eventClients.add(response);
      const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), 20000);
      response.on('close', () => { clearInterval(heartbeat); eventClients.delete(response); });
      return;
    }
    const connectMatch = url.pathname.match(/^\/api\/(connect|disconnect)\/(twitch|kick|tiktok|youtube)$/);
    if (request.method === 'POST' && connectMatch) {
      const [, action, platform] = connectMatch;
      if (action === 'disconnect') { stopProvider(platform); response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, connected: false })); return; }
      const body = await readJson(request);
      try {
        const result = await connectPlatform(platform, body.handle);
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
      } catch (error) {
        setConnected(platform, false, error.message);
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: error.message }));
      }
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/stream/start') {
      const body = await readJson(request);
      const onlyPlatforms = Array.isArray(body.platforms) ? body.platforms : null;
      const result = await startStreamRelay(body.title || '', { onlyPlatforms });
      response.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json' }).end(JSON.stringify(result)); return;
    }
    if (request.method === 'POST' && url.pathname === '/api/stream/prepare') {
      const body = await readJson(request);
      const result = await startStreamRelay(body.title || '', { startObs: false });
      response.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json' }).end(JSON.stringify(result)); return;
    }
    if (request.method === 'POST' && url.pathname === '/api/titles/sync') {
      if (!LIVE_MODE) { response.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'ライブモードで使用してください' })); return; }
      const body = await readJson(request);
      const title = String(body.title || '').trim().slice(0, 100);
      if (!title) { response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: '共通配信タイトルを入力してください' })); return; }
      const results = (await updatePlatformTitles(title)).filter(item => ['twitch', 'kick', 'youtube'].includes(item.platform));
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: results.every(item => item.ok), results })); return;
    }
    if (request.method === 'POST' && url.pathname === '/api/stream/stop') {
      const result = await stopStreamRelay();
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result)); return;
    }
    if (request.method === 'POST' && url.pathname === '/webhooks/kick') { await handleKickWebhook(request, response); return; }
    if (request.method === 'GET' && url.pathname === '/health') { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, mode: LIVE_MODE ? 'live' : 'demo' })); return; }

    if (!['/', '/index.html', '/metadata', '/metadata.html', '/overlay', '/overlay.html', '/chat', '/chat.html'].includes(url.pathname)) { response.writeHead(404).end('Not found'); return; }
    const file = join(ROOT, ['/metadata','/metadata.html'].includes(url.pathname) ? 'metadata-settings.html' : ['/overlay','/overlay.html'].includes(url.pathname) ? 'overlay.html' : ['/chat','/chat.html'].includes(url.pathname) ? 'chat-view.html' : 'index.html');
    const content = await readFile(file);
    response.writeHead(200, { 'content-type': contentTypes[extname(file)] || 'application/octet-stream' }).end(content);
  } catch (error) {
    if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false, error: error.message || 'Internal error' }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`SYNC LIVE running in ${LIVE_MODE ? 'LIVE' : 'DEMO'} mode at http://${HOST}:${PORT}`);
  if (LIVE_MODE) console.log('Secrets are read from .env and held in this process memory only.');
  if (LIVE_MODE) {
    const ready = [
      ['twitch', !!(process.env.TWITCH_ACCESS_TOKEN && process.env.TWITCH_USERNAME && process.env.TWITCH_CHANNEL)],
      ['kick', !!process.env.KICK_WEBHOOK_PUBLIC_URL],
      ['tiktok', !!process.env.TIKTOK_USERNAME],
    ];
    for (const [platform, configured] of ready) {
      if (configured) void connectPlatform(platform).catch(error => setConnected(platform, false, error.message));
    }
    autoArmRelay = true;
    setTimeout(() => {
      if (!autoArmRelay || streamProcess) return;
      void startStreamRelay('', { startObs: false, onlyPlatforms: MULTI_STREAM_PLATFORMS, autoArm: true }).then(result => {
        if (!result.ok) {
          autoArmRelay = false;
          setStreamStatus(false, `OBS配信待機を開始できません: ${result.error}`, 0, {});
          return;
        }
      }).catch(() => {
        autoArmRelay = false;
        setStreamStatus(false, 'OBS配信待機を開始できません。RTMP設定を確認してください', 0, {});
      });
    }, 300);
  }
});

process.on('SIGINT', () => { for (const platform of active.keys()) stopProvider(platform); server.close(() => process.exit(0)); });
