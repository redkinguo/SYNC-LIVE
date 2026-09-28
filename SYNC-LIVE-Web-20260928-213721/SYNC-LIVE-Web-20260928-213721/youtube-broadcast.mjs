import { freshAccessToken, saveEnv } from './oauth-setup.mjs';
import { getFixedDescriptions } from './description-settings.mjs';

const BASE = 'https://www.googleapis.com/youtube/v3';

async function request(path, options = {}) {
  const token = await freshAccessToken('youtube');
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const reason = body.error?.errors?.[0]?.reason || '';
    const error = new Error(`YouTube API HTTP ${response.status} (${reason || path.split('?')[0]})`);
    error.code = reason;
    throw error;
  }
  return response.json();
}

async function targetStream(rtmpUrl) {
  let pageToken = '';
  do {
    const query = new URLSearchParams({ part: 'id,cdn', mine: 'true', maxResults: '50' });
    if (pageToken) query.set('pageToken', pageToken);
    const page = await request(`/liveStreams?${query}`);
    const stream = (page.items || []).find(item => {
      const ingest = item.cdn?.ingestionInfo;
      return ingest && `${ingest.ingestionAddress}/${ingest.streamName}` === rtmpUrl;
    });
    if (stream) return stream.id;
    pageToken = page.nextPageToken || '';
  } while (pageToken);
  throw new Error('YouTubeに保存済みの配信キーが見つかりません。YouTube連携とキーを確認してください');
}

export async function prepareYouTubeBroadcast(title, rtmpUrl, { createIfMissing = true } = {}) {
  if (!process.env.YOUTUBE_ACCESS_TOKEN || !rtmpUrl) return null;
  const streamId = await targetStream(rtmpUrl.trim());
  const selectedId = process.env.YOUTUBE_BROADCAST_ID?.trim();
  let broadcast;
  if (selectedId) {
    const current = await request(`/liveBroadcasts?${new URLSearchParams({ part: 'id,status,contentDetails,snippet', id: selectedId })}`);
    const item = current.items?.[0];
    if (item?.contentDetails?.boundStreamId === streamId && ['ready', 'testing', 'live'].includes(item.status?.lifeCycleStatus)) {
      if (item.status.privacyStatus !== 'public') throw new Error('選択中のYouTube配信枠が公開設定ではありません');
      broadcast = item;
      if (item.contentDetails?.latencyPreference !== 'ultraLow') {
        if (item.status.lifeCycleStatus !== 'ready') {
          throw new Error('選択中の配信枠はすでにテスト中または配信中のため、超低遅延に変更できません。配信枠を終了してから再作成してください');
        }
        const details = item.contentDetails || {};
        const contentDetails = {
          latencyPreference: 'ultraLow',
          ...(details.monitorStream ? { monitorStream: details.monitorStream } : {}),
          ...Object.fromEntries(['enableAutoStart','enableAutoStop','enableClosedCaptions','enableDvr','enableEmbed','recordFromStart'].filter(key => details[key] !== undefined).map(key => [key, details[key]])),
        };
        broadcast = await request('/liveBroadcasts?part=contentDetails', {
          method: 'PUT', body: JSON.stringify({ id: selectedId, contentDetails }),
        });
      }
    }
  }
  if (!broadcast) {
    if (!createIfMissing) return null;
    const fixedDescriptions = await getFixedDescriptions();
    const body = {
      snippet: {
        title: (title || 'SYNC LIVE').slice(0, 100),
        ...(fixedDescriptions.youtube ? { description: fixedDescriptions.youtube } : {}),
        scheduledStartTime: new Date(Date.now() + 60_000).toISOString(),
      },
      status: { privacyStatus: 'public' },
      contentDetails: { latencyPreference: 'ultraLow', enableAutoStart: true, enableAutoStop: true, monitorStream: { enableMonitorStream: false } },
    };
    broadcast = await request('/liveBroadcasts?part=snippet,status,contentDetails', { method: 'POST', body: JSON.stringify(body) });
    broadcast = await request(`/liveBroadcasts/bind?${new URLSearchParams({ part: 'id,status,contentDetails,snippet', id: broadcast.id, streamId })}`, { method: 'POST' });
  }
  await saveEnv({ YOUTUBE_BROADCAST_ID: broadcast.id });
  return { id: broadcast.id, streamId };
}

export async function advanceYouTubeBroadcast(id, streamId, requestedTransitions = new Set()) {
  const stream = await request(`/liveStreams?${new URLSearchParams({ part: 'status', id: streamId })}`);
  if (stream.items?.[0]?.status?.streamStatus !== 'active') return 'waiting';
  const result = await request(`/liveBroadcasts?${new URLSearchParams({ part: 'status,contentDetails', id })}`);
  const item = result.items?.[0];
  const status = item?.status?.lifeCycleStatus;
  if (status === 'live') return 'live';
  if (status === 'liveStarting' || status === 'testStarting') return 'waiting';
  if (status === 'ready' && item.contentDetails?.monitorStream?.enableMonitorStream) {
    if (!requestedTransitions.has('testing')) {
      await request(`/liveBroadcasts/transition?${new URLSearchParams({ part: 'status', id, broadcastStatus: 'testing' })}`, { method: 'POST' });
      requestedTransitions.add('testing');
    }
    return 'waiting';
  }
  if (status === 'ready' || status === 'testing') {
    if (!requestedTransitions.has('live')) {
      await request(`/liveBroadcasts/transition?${new URLSearchParams({ part: 'status', id, broadcastStatus: 'live' })}`, { method: 'POST' });
      requestedTransitions.add('live');
    }
    return 'waiting';
  }
  throw new Error(`YouTubeの配信枠を開始できません (${status || '不明'})`);
}
