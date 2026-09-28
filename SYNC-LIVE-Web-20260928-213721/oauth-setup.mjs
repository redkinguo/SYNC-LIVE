import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const ENV_FILE = join(ROOT, '.env');
const pending = new Map();
const refreshing = new Map();
const providers = {
  twitch: {
    clientId: 'TWITCH_CLIENT_ID', clientSecret: 'TWITCH_CLIENT_SECRET',
    access: 'TWITCH_ACCESS_TOKEN', refresh: 'TWITCH_REFRESH_TOKEN', expires: 'TWITCH_TOKEN_EXPIRES_AT',
    authorize: 'https://id.twitch.tv/oauth2/authorize', token: 'https://id.twitch.tv/oauth2/token',
    scopes: 'chat:read channel:manage:broadcast',
  },
  youtube: {
    clientId: 'YOUTUBE_CLIENT_ID', clientSecret: 'YOUTUBE_CLIENT_SECRET',
    access: 'YOUTUBE_ACCESS_TOKEN', refresh: 'YOUTUBE_REFRESH_TOKEN', expires: 'YOUTUBE_TOKEN_EXPIRES_AT',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token',
    scopes: 'https://www.googleapis.com/auth/youtube.force-ssl',
  },
  kick: {
    clientId: 'KICK_CLIENT_ID', clientSecret: 'KICK_CLIENT_SECRET',
    access: 'KICK_ACCESS_TOKEN', refresh: 'KICK_REFRESH_TOKEN', expires: 'KICK_TOKEN_EXPIRES_AT',
    authorize: 'https://id.kick.com/oauth/authorize', token: 'https://id.kick.com/oauth/token',
    scopes: 'user:read channel:read channel:write events:subscribe',
  },
};

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

function localOrigin(request) {
  const port = Number(process.env.LIVEBRIDGE_PORT || 4317);
  const allowed = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  return allowed.has(request.headers.origin);
}

function localHost(request) {
  const port = Number(process.env.LIVEBRIDGE_PORT || 4317);
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`]).has(request.headers.host);
}

async function bodyJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16 * 1024) throw new Error('設定データが大きすぎます');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export async function saveEnv(values) {
  let contents = await readFile(ENV_FILE, 'utf8');
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error('Invalid setting name');
    const line = `${key}=${JSON.stringify(String(value))}`;
    const expression = new RegExp(`^${key}=.*$`, 'm');
    contents = expression.test(contents) ? contents.replace(expression, line) : `${contents.trimEnd()}\n${line}\n`;
    process.env[key] = String(value);
  }
  const temp = `${ENV_FILE}.oauth.tmp`;
  await writeFile(temp, contents, 'utf8');
  await rename(temp, ENV_FILE);
}

function callbackUrl(provider) {
  const port = Number(process.env.LIVEBRIDGE_PORT || 4317);
  return `http://localhost:${port}/oauth/callback/${provider}`;
}

export function oauthSetupStatus() {
  return Object.fromEntries(Object.entries(providers).map(([name, config]) => [name, {
    clientReady: !!(process.env[config.clientId] && process.env[config.clientSecret]),
    authorized: !!process.env[config.access],
    redirectUri: callbackUrl(name),
  }]));
}

async function exchangeToken(provider, fields) {
  const config = providers[provider];
  const response = await fetch(config.token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`${provider} の認証に失敗しました (HTTP ${response.status})`);
  const payload = await response.json();
  if (!payload.access_token) throw new Error(`${provider} のアクセストークンを取得できませんでした`);
  return payload;
}

async function saveToken(provider, token) {
  const config = providers[provider];
  const values = { [config.access]: token.access_token };
  if (token.refresh_token) values[config.refresh] = token.refresh_token;
  if (token.expires_in) values[config.expires] = Math.floor(Date.now() / 1000) + Number(token.expires_in);
  await saveEnv(values);
}

export async function freshAccessToken(provider) {
  const config = providers[provider];
  if (!config) throw new Error('Unknown provider');
  const current = process.env[config.access]?.trim();
  const expiry = Number(process.env[config.expires] || 0);
  if (!current || !expiry || Date.now() / 1000 < expiry - 90) return current;
  if (!process.env[config.refresh]) throw new Error(`${provider} の再認証が必要です`);
  if (!refreshing.has(provider)) {
    const task = (async () => {
      const token = await exchangeToken(provider, {
        grant_type: 'refresh_token',
        client_id: process.env[config.clientId],
        client_secret: process.env[config.clientSecret],
        refresh_token: process.env[config.refresh],
      });
      await saveToken(provider, token);
      return token.access_token;
    })().finally(() => refreshing.delete(provider));
    refreshing.set(provider, task);
  }
  return refreshing.get(provider);
}

async function identifyTwitch(token) {
  const response = await fetch('https://api.twitch.tv/helix/users', {
    headers: { Authorization: `Bearer ${token}`, 'Client-Id': process.env.TWITCH_CLIENT_ID },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`Twitchユーザー確認失敗 (HTTP ${response.status})`);
  const user = (await response.json()).data?.[0];
  if (!user?.id || !user?.login) throw new Error('Twitchユーザーを確認できませんでした');
  await saveEnv({ TWITCH_USERNAME: user.login, TWITCH_CHANNEL: user.login, TWITCH_BROADCASTER_ID: user.id });
}

async function availableYouTubeBroadcasts(token) {
  const items = [];
  for (const status of ['active', 'upcoming']) {
    const query = new URLSearchParams({ part: 'id,snippet,status', broadcastStatus: status, maxResults: '50' });
    const response = await fetch(`https://www.googleapis.com/youtube/v3/liveBroadcasts?${query}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error(`YouTube配信枠を取得できません (HTTP ${response.status})`);
    for (const item of (await response.json()).items || []) items.push({
      id: item.id, title: item.snippet?.title || '無題', status,
    });
  }
  return items;
}

async function discoverYouTubeBroadcast(token) {
  const items = await availableYouTubeBroadcasts(token);
  const active = items.filter(item => item.status === 'active');
  const chosen = active.length === 1 ? active[0] : !active.length && items.length === 1 ? items[0] : null;
  if (chosen) await saveEnv({ YOUTUBE_BROADCAST_ID: chosen.id });
}

function finish(response, provider, state) {
  response.writeHead(303, { location: `/oauth-setup?provider=${provider}&result=${state}`, 'cache-control': 'no-store' });
  response.end();
}

export async function handleOAuthSetup(request, response, url, onAuthorized) {
  if (!localHost(request)) { json(response, 403, { ok: false, error: 'ローカル接続のみ利用できます' }); return true; }
  if (request.method === 'GET' && url.pathname === '/oauth-setup') {
    const html = await readFile(join(ROOT, 'oauth-setup.html'));
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'" });
    response.end(html);
    return true;
  }
  if (request.method === 'GET' && url.pathname === '/oauth-setup.js') {
    const script = await readFile(join(ROOT, 'oauth-setup.js'));
    response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
    response.end(script);
    return true;
  }
  if (request.method === 'GET' && url.pathname === '/api/oauth/status') { json(response, 200, oauthSetupStatus()); return true; }
  if (request.method === 'POST' && /^\/api\/oauth\/client\/(twitch|kick|youtube)$/.test(url.pathname)) {
    if (!localOrigin(request)) { json(response, 403, { ok: false, error: 'この画面からのみ設定できます' }); return true; }
    const provider = url.pathname.split('/').pop();
    const config = providers[provider];
    const body = await bodyJson(request);
    const clientId = String(body.clientId || '').trim();
    const clientSecret = String(body.clientSecret || '').trim();
    if (!clientId || !clientSecret || clientId.length > 300 || clientSecret.length > 1000) { json(response, 400, { ok: false, error: 'クライアントIDとシークレットを入力してください' }); return true; }
    await saveEnv({ [config.clientId]: clientId, [config.clientSecret]: clientSecret });
    json(response, 200, { ok: true });
    return true;
  }
  if (request.method === 'GET' && /^\/oauth\/start\/(twitch|kick|youtube)$/.test(url.pathname)) {
    const provider = url.pathname.split('/').pop();
    const config = providers[provider];
    if (!process.env[config.clientId] || !process.env[config.clientSecret]) { finish(response, provider, 'client-missing'); return true; }
    const state = randomBytes(24).toString('hex');
    const verifier = randomBytes(48).toString('base64url');
    pending.set(state, { provider, verifier, createdAt: Date.now() });
    for (const [key, value] of pending) if (Date.now() - value.createdAt > 10 * 60 * 1000) pending.delete(key);
    const authorize = new URL(config.authorize);
    authorize.searchParams.set('client_id', process.env[config.clientId]);
    authorize.searchParams.set('redirect_uri', callbackUrl(provider));
    authorize.searchParams.set('response_type', 'code');
    const scopes = provider === 'twitch' && url.searchParams.get('include') === 'profile-description'
      ? `${config.scopes} user:edit`
      : config.scopes;
    authorize.searchParams.set('scope', scopes);
    authorize.searchParams.set('state', state);
    if (provider === 'youtube') { authorize.searchParams.set('access_type', 'offline'); authorize.searchParams.set('prompt', 'consent'); }
    if (provider === 'kick') {
      authorize.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
      authorize.searchParams.set('code_challenge_method', 'S256');
    }
    response.writeHead(302, { location: authorize.toString(), 'cache-control': 'no-store' });
    response.end();
    return true;
  }
  if (request.method === 'GET' && /^\/oauth\/callback\/(twitch|kick|youtube)$/.test(url.pathname)) {
    const provider = url.pathname.split('/').pop();
    const state = url.searchParams.get('state');
    const saved = pending.get(state);
    if (!saved || saved.provider !== provider || Date.now() - saved.createdAt > 10 * 60 * 1000) { finish(response, provider, 'invalid-state'); return true; }
    pending.delete(state);
    if (url.searchParams.has('error')) { finish(response, provider, 'denied'); return true; }
    const code = url.searchParams.get('code');
    if (!code) { finish(response, provider, 'missing-code'); return true; }
    try {
      const config = providers[provider];
      const fields = {
        grant_type: 'authorization_code', code,
        client_id: process.env[config.clientId], client_secret: process.env[config.clientSecret],
        redirect_uri: callbackUrl(provider),
      };
      if (provider === 'kick') fields.code_verifier = saved.verifier;
      const token = await exchangeToken(provider, fields);
      await saveToken(provider, token);
      if (provider === 'twitch') await identifyTwitch(token.access_token);
      if (provider === 'youtube') await discoverYouTubeBroadcast(token.access_token);
      if (onAuthorized) await onAuthorized(provider);
      finish(response, provider, 'connected');
    } catch {
      finish(response, provider, 'failed');
    }
    return true;
  }
  if (request.method === 'GET' && url.pathname === '/api/oauth/youtube/broadcasts') {
    const token = await freshAccessToken('youtube');
    if (!token) { json(response, 401, { ok: false, error: 'YouTube連携が必要です' }); return true; }
    json(response, 200, { ok: true, broadcasts: await availableYouTubeBroadcasts(token) });
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/api/oauth/youtube/broadcast') {
    if (!localOrigin(request)) { json(response, 403, { ok: false, error: 'この画面からのみ設定できます' }); return true; }
    const token = await freshAccessToken('youtube');
    if (!token) { json(response, 401, { ok: false, error: 'YouTube連携が必要です' }); return true; }
    const body = await bodyJson(request);
    const item = (await availableYouTubeBroadcasts(token)).find(broadcast => broadcast.id === body.id);
    if (!item) { json(response, 404, { ok: false, error: '配信枠が見つかりません' }); return true; }
    await saveEnv({ YOUTUBE_BROADCAST_ID: item.id });
    if (onAuthorized) await onAuthorized('youtube');
    json(response, 200, { ok: true });
    return true;
  }
  return false;
}
