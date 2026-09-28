import { freshAccessToken } from './oauth-setup.mjs';
import { getFixedDescriptions, saveFixedDescriptions } from './description-settings.mjs';

const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;
const categoryCache = new Map();

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}
function isLocal(request) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress || '');
}
function safeApiError(platform, status, payload = {}) {
  const reason = payload?.error?.errors?.[0]?.reason || payload?.error?.status || '';
  if (platform === 'youtube' && ['quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded'].includes(reason)) {
    return 'YouTube APIの利用枠に達しました。非公式APIでは回避せず、YouTube Studioで手動設定してください。';
  }
  if (status === 401 || status === 403) return platform + 'の認証または更新権限が不足しています。接続設定から再連携してください。';
  if (status === 429) return platform + 'のAPI利用制限です。時間をおいて再試行してください。';
  return platform + 'の公式APIが更新を拒否しました (HTTP ' + status + ')。入力内容と配信枠を確認してください。';
}
async function upstreamJson(platform, response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(safeApiError(platform, response.status, payload));
  return payload;
}
function splitTags(value) {
  if (Array.isArray(value)) return [...new Set(value.map(tag => String(tag).trim()).filter(Boolean))];
  return [...new Set(String(value || '').split(/[,\n\r]/).map(tag => tag.trim()).filter(Boolean))];
}
function validateTwitchTags(tags) {
  if (tags.length > 10 || tags.some(tag => tag.length > 25 || /[\s\p{P}\p{S}]/u.test(tag))) {
    throw new Error('Twitchタグは空白・記号なしで、1個25文字以内、最大10個です。');
  }
}
function tokenHeaders(token) {
  return { Authorization: 'Bearer ' + token.trim(), 'Content-Type': 'application/json' };
}
async function getTwitchChannel(token) {
  const response = await fetch('https://api.twitch.tv/helix/users', {
    headers: { Authorization: 'Bearer ' + token.trim(), 'Client-Id': process.env.TWITCH_CLIENT_ID },
    signal: AbortSignal.timeout(12000),
  });
  const user = (await upstreamJson('Twitch', response)).data?.[0];
  if (!user?.id) throw new Error('Twitchアカウントを取得できません。再連携してください。');
  return user;
}
async function getPlatformMetadata(platform) {
  if (platform === 'youtube') {
    if (!process.env.YOUTUBE_BROADCAST_ID) throw new Error('YouTube Studioの配信枠を先に選択してください。');
    const token = await freshAccessToken('youtube');
    const query = new URLSearchParams({ part: 'snippet', id: process.env.YOUTUBE_BROADCAST_ID.trim() });
    const response = await fetch('https://www.googleapis.com/youtube/v3/videos?' + query, {
      headers: { Authorization: 'Bearer ' + token.trim() }, signal: AbortSignal.timeout(12000),
    });
    const item = (await upstreamJson('YouTube', response)).items?.[0];
    if (!item) throw new Error('選択中のYouTube配信動画が見つかりません。YouTube Studioで配信枠を選び直してください。');
    return { title: item.snippet?.title || '', description: item.snippet?.description || '', categoryId: item.snippet?.categoryId || '', tags: item.snippet?.tags || [] };
  }
  if (platform === 'twitch') {
    if (!process.env.TWITCH_CLIENT_ID) throw new Error('TwitchのClient IDが設定されていません。');
    const token = await freshAccessToken('twitch');
    const user = await getTwitchChannel(token);
    const query = new URLSearchParams({ broadcaster_id: process.env.TWITCH_BROADCASTER_ID || user.id });
    const response = await fetch('https://api.twitch.tv/helix/channels?' + query, {
      headers: { Authorization: 'Bearer ' + token.trim(), 'Client-Id': process.env.TWITCH_CLIENT_ID },
      signal: AbortSignal.timeout(12000),
    });
    const channel = (await upstreamJson('Twitch', response)).data?.[0];
    if (!channel) throw new Error('Twitchチャンネル情報を取得できませんでした。');
    return { title: channel.title || '', description: user.description || '', categoryId: channel.game_id || '', categoryName: channel.game_name || '', tags: channel.tags || [] };
  }
  if (platform === 'kick') {
    const token = await freshAccessToken('kick');
    const response = await fetch('https://api.kick.com/public/v1/channels', {
      headers: { Authorization: 'Bearer ' + token.trim() }, signal: AbortSignal.timeout(12000),
    });
    const channel = (await upstreamJson('Kick', response)).data?.[0];
    if (!channel) throw new Error('Kickチャンネル情報を取得できませんでした。');
    return { title: channel.stream_title || '', description: channel.channel_description || '', categoryId: String(channel.category?.id || ''), categoryName: channel.category?.name || '', tags: channel.custom_tags || channel.stream?.custom_tags || [] };
  }
  throw new Error('対応していない配信先です。');
}
async function findCategories(platform, query) {
  const normalized = String(query || '').trim();
  const cacheKey = platform === 'youtube' ? 'youtube:all' : platform + ':' + normalized.toLocaleLowerCase();
  const saved = categoryCache.get(cacheKey);
  if (saved && Date.now() - saved.at < 6 * 60 * 60 * 1000) return platform === 'youtube' && normalized ? saved.value.filter(item => item.name.toLocaleLowerCase().includes(normalized.toLocaleLowerCase())) : saved.value;
  let value;
  if (platform === 'youtube') {
    const token = await freshAccessToken('youtube');
    const params = new URLSearchParams({ part: 'snippet', regionCode: 'JP' });
    const response = await fetch('https://www.googleapis.com/youtube/v3/videoCategories?' + params, {
      headers: { Authorization: 'Bearer ' + token.trim() }, signal: AbortSignal.timeout(12000),
    });
    const items = (await upstreamJson('YouTube', response)).items || [];
    value = items.filter(item => item.snippet?.assignable)
      .map(item => ({ id: item.id, name: item.snippet.title }));
  } else if (platform === 'twitch') {
    if (!normalized) return [];
    const token = await freshAccessToken('twitch');
    if (!process.env.TWITCH_CLIENT_ID) throw new Error('TwitchのClient IDが設定されていません。');
    const params = new URLSearchParams({ query: normalized, first: '25' });
    const response = await fetch('https://api.twitch.tv/helix/search/categories?' + params, {
      headers: { Authorization: 'Bearer ' + token.trim(), 'Client-Id': process.env.TWITCH_CLIENT_ID },
      signal: AbortSignal.timeout(12000),
    });
    value = ((await upstreamJson('Twitch', response)).data || []).map(item => ({ id: item.id, name: item.name }));
  } else if (platform === 'kick') {
    if (normalized.length < 3) return [];
    const token = await freshAccessToken('kick');
    const params = new URLSearchParams({ name: normalized, limit: '25' });
    const response = await fetch('https://api.kick.com/public/v2/categories?' + params, {
      headers: { Authorization: 'Bearer ' + token.trim() }, signal: AbortSignal.timeout(12000),
    });
    value = ((await upstreamJson('Kick', response)).data || []).map(item => ({ id: String(item.id), name: item.name }));
  } else {
    throw new Error('対応していない配信先です。');
  }
  categoryCache.set(cacheKey, { at: Date.now(), value });
  return platform === 'youtube' && normalized ? value.filter(item => item.name.toLocaleLowerCase().includes(normalized.toLocaleLowerCase())) : value;
}
async function updateMetadata(platform, input) {
  if (platform === 'youtube') {
    const id = process.env.YOUTUBE_BROADCAST_ID?.trim();
    if (!id) throw new Error('YouTube Studioの配信枠を先に選択してください。');
    const requestedTitle = String(input.title || '').trim();
    const requestedDescription = input.description === undefined ? undefined : String(input.description);
    const categoryId = String(input.categoryId || '').trim();
    const requestedTags = Array.isArray(input.tags) ? splitTags(input.tags) : undefined;
    if (requestedTitle.length > 100) throw new Error('YouTubeタイトルは100文字以内です。');
    if (requestedDescription !== undefined && Buffer.byteLength(requestedDescription, 'utf8') > 5000) throw new Error('YouTube説明は5000バイト以内です。');
    if (requestedTags && requestedTags.join(',').length > 500) throw new Error('YouTubeタグの合計は500文字以内にしてください。');
    const token = (await freshAccessToken('youtube')).trim();
    const getQuery = new URLSearchParams({ part: 'snippet', id });
    const getResponse = await fetch('https://www.googleapis.com/youtube/v3/videos?' + getQuery, {
      headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(12000),
    });
    const current = (await upstreamJson('YouTube', getResponse)).items?.[0];
    if (!current) throw new Error('選択中のYouTube配信動画が見つかりません。');
    const existing = current.snippet || {};
    const title = requestedTitle || existing.title || '';
    if (!title) throw new Error('YouTubeタイトルを入力してください（100文字以内）。');
    const snippet = {
      title,
      description: requestedDescription === undefined ? (existing.description || '') : requestedDescription,
      categoryId: categoryId || existing.categoryId || '22',
      tags: requestedTags === undefined ? (existing.tags || []) : requestedTags,
      ...(existing.defaultLanguage ? { defaultLanguage: existing.defaultLanguage } : {}),
    };
    const query = new URLSearchParams({ part: 'snippet' });
    const update = await fetch('https://www.googleapis.com/youtube/v3/videos?' + query, {
      method: 'PUT', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, snippet }), signal: AbortSignal.timeout(20000),
    });
    await upstreamJson('YouTube', update);
    return { ok: true, detail: 'YouTubeのタイトル・説明・カテゴリー・タグを更新しました（公式API）' };
  }
  if (platform === 'twitch') {
    if (!process.env.TWITCH_CLIENT_ID) throw new Error('TwitchのClient IDが設定されていません。');
    const token = (await freshAccessToken('twitch')).trim();
    const user = await getTwitchChannel(token);
    const body = {};
    const title = String(input.title || '').trim();
    const categoryId = String(input.categoryId || '').trim();
    const tags = splitTags(input.tags);
    if (title) {
      if (title.length > 140) throw new Error('Twitchタイトルは140文字以内です。');
      body.title = title;
    }
    if (categoryId) body.game_id = categoryId;
    if (Array.isArray(input.tags)) { validateTwitchTags(tags); body.tags = tags; }
    if (!Object.keys(body).length) throw new Error('変更したい項目を入力してください。');
    const query = new URLSearchParams({ broadcaster_id: process.env.TWITCH_BROADCASTER_ID || user.id });
    const response = await fetch('https://api.twitch.tv/helix/channels?' + query, {
      method: 'PATCH', headers: { Authorization: 'Bearer ' + token, 'Client-Id': process.env.TWITCH_CLIENT_ID, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(12000),
    });
    await upstreamJson('Twitch', response);
    return { ok: true, detail: 'Twitchのタイトル・カテゴリー・タグを更新しました（公式API）' };
  }
  if (platform === 'kick') {
    const token = (await freshAccessToken('kick')).trim();
    const body = {};
    const title = String(input.title || '').trim();
    const categoryId = String(input.categoryId || '').trim();
    const tags = splitTags(input.tags);
    if (title) {
      if (title.length > 200) throw new Error('Kickタイトルは200文字以内です。');
      body.stream_title = title;
    }
    if (categoryId) {
      if (!/^\d+$/.test(categoryId)) throw new Error('Kickカテゴリーを候補から選択してください。');
      body.category_id = Number(categoryId);
    }
    if (Array.isArray(input.tags)) {
      if (tags.length > 10 || tags.some(tag => tag.length > 100)) throw new Error('Kickのカスタムタグは最大10個です。');
      body.custom_tags = tags;
    }
    if (!Object.keys(body).length) throw new Error('変更したい項目を入力してください。');
    const response = await fetch('https://api.kick.com/public/v1/channels', {
      method: 'PATCH', headers: tokenHeaders(token), body: JSON.stringify(body), signal: AbortSignal.timeout(12000),
    });
    await upstreamJson('Kick', response);
    return { ok: true, detail: 'Kickのタイトル・カテゴリー・カスタムタグを更新しました（公式API）' };
  }
  throw new Error('対応していない配信先です。');
}
async function readImageBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_THUMBNAIL_BYTES) throw new Error('画像は2MB以下にしてください。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function setYouTubeThumbnail(request) {
  if (!process.env.YOUTUBE_BROADCAST_ID?.trim()) throw new Error('YouTube Studioの配信枠を先に選択してください。');
  const mime = String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!['image/jpeg', 'image/png'].includes(mime)) throw new Error('YouTube用サムネイルはJPGまたはPNGを選択してください。');
  const image = await readImageBody(request);
  const validJpeg = mime === 'image/jpeg' && image.length > 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff;
  const validPng = mime === 'image/png' && image.length > 8 && image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (!validJpeg && !validPng) throw new Error('画像ファイルを読み取れません。JPGまたはPNGを選び直してください。');
  const token = (await freshAccessToken('youtube')).trim();
  const query = new URLSearchParams({ videoId: process.env.YOUTUBE_BROADCAST_ID.trim(), uploadType: 'media' });
  const response = await fetch('https://www.googleapis.com/upload/youtube/v3/thumbnails/set?' + query, {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': mime }, body: image,
    signal: AbortSignal.timeout(30000),
  });
  await upstreamJson('YouTube', response);
  return { ok: true, detail: 'YouTubeのサムネイルを更新しました（公式API）' };
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('入力が長すぎます。');
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

async function captureCurrentYouTubeDescription() {
  const id = process.env.YOUTUBE_BROADCAST_ID?.trim();
  if (!id) throw new Error('YouTube Studioで配信枠を先に選択してください。');
  const token = (await freshAccessToken('youtube')).trim();
  const query = new URLSearchParams({ part: 'snippet', id });
  const response = await fetch('https://www.googleapis.com/youtube/v3/videos?' + query, {
    headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(12000),
  });
  const item = (await upstreamJson('YouTube', response)).items?.[0];
  if (!item) throw new Error('選択中のYouTube配信枠が見つかりません。');
  const descriptions = await getFixedDescriptions();
  await saveFixedDescriptions({ ...descriptions, youtube: item.snippet?.description || '' });
  return { ok: true, detail: '現在のYouTube説明を、このPCの次回配信向け固定文として保存しました。既存の配信枠は変更していません。' };
}

async function updateTwitchProfileDescription(description) {
  if ([...description].length > 300) throw new Error('Twitchのチャンネル説明は300文字以内です。');
  if (!process.env.TWITCH_CLIENT_ID) throw new Error('TwitchのClient IDが設定されていません。');
  const token = (await freshAccessToken('twitch')).trim();
  const query = new URLSearchParams({ description });
  const response = await fetch('https://api.twitch.tv/helix/users?' + query, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + token, 'Client-Id': process.env.TWITCH_CLIENT_ID },
    signal: AbortSignal.timeout(12000),
  });
  await upstreamJson('Twitch', response);
  const descriptions = await getFixedDescriptions();
  await saveFixedDescriptions({ ...descriptions, twitch: description });
  return { ok: true, detail: 'Twitchチャンネル説明を公式APIで更新しました。' };
}

export async function handleMetadata(request, response, url) {
  const metadataMatch = url.pathname.match(/^\/api\/metadata\/(youtube|twitch|kick)$/);
  const categoriesMatch = url.pathname.match(/^\/api\/metadata\/categories\/(youtube|twitch|kick)$/);
  const thumbnailMatch = url.pathname === '/api/metadata/youtube/thumbnail';
  const descriptionsMatch = url.pathname === '/api/metadata/descriptions';
  const pinYouTubeMatch = url.pathname === '/api/metadata/youtube/fix-current-description';
  const twitchDescriptionMatch = url.pathname === '/api/metadata/twitch/description';
  if (!metadataMatch && !categoriesMatch && !thumbnailMatch && !descriptionsMatch && !pinYouTubeMatch && !twitchDescriptionMatch) return false;
  if (!isLocal(request)) { sendJson(response, 403, { ok: false, error: 'この操作はこのPC上からのみ実行できます。' }); return true; }
  try {
    if (descriptionsMatch && request.method === 'GET') {
      sendJson(response, 200, { ok: true, descriptions: await getFixedDescriptions() }); return true;
    }
    if (descriptionsMatch && request.method === 'POST') {
      const input = await readJson(request);
      const descriptions = await saveFixedDescriptions(input);
      sendJson(response, 200, { ok: true, descriptions, detail: '固定説明をこのPCに保存しました。' }); return true;
    }
    if (pinYouTubeMatch && request.method === 'POST') {
      sendJson(response, 200, await captureCurrentYouTubeDescription()); return true;
    }
    if (twitchDescriptionMatch && request.method === 'POST') {
      const input = await readJson(request);
      sendJson(response, 200, await updateTwitchProfileDescription(String(input.description || ''))); return true;
    }
    if (categoriesMatch && request.method === 'GET') {
      const categories = await findCategories(categoriesMatch[1], url.searchParams.get('q') || '');
      sendJson(response, 200, { ok: true, categories }); return true;
    }
    if (metadataMatch && request.method === 'GET') {
      const metadata = await getPlatformMetadata(metadataMatch[1]);
      sendJson(response, 200, { ok: true, metadata }); return true;
    }
    if (metadataMatch && request.method === 'POST') {
      const input = await readJson(request);
      const result = await updateMetadata(metadataMatch[1], input);
      sendJson(response, 200, result); return true;
    }
    if (thumbnailMatch && request.method === 'POST') {
      const result = await setYouTubeThumbnail(request);
      sendJson(response, 200, result); return true;
    }
    sendJson(response, 405, { ok: false, error: 'この操作は許可されていません。' }); return true;
  } catch (error) {
    sendJson(response, 400, { ok: false, error: error.message || '設定を更新できませんでした。' });
    return true;
  }
}
