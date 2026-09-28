import { freshAccessToken } from './oauth-setup.mjs';

let kickUserId = '';

export function emptyAudience() {
  return {
    twitch: { live: false, viewers: null, startedAt: null, status: process.env.TWITCH_ACCESS_TOKEN ? 'offline' : 'unconfigured' },
    kick: { live: false, viewers: null, startedAt: null, status: process.env.KICK_ACCESS_TOKEN ? 'offline' : 'unconfigured' },
    tiktok: { live: false, viewers: null, startedAt: null, status: process.env.TIKTOK_USERNAME ? 'offline' : 'unconfigured' },
    youtube: { live: false, viewers: null, startedAt: null, status: process.env.YOUTUBE_ACCESS_TOKEN ? 'offline' : 'unconfigured' },
  };
}

async function jsonOrThrow(response) {
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error('upstream error');
  return value;
}

async function twitchStats() {
  if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_BROADCASTER_ID) return { live: false, viewers: null, startedAt: null, status: 'unconfigured' };
  const token = (await freshAccessToken('twitch')).replace(/^oauth:/i, '').trim();
  const query = new URLSearchParams({ user_id: process.env.TWITCH_BROADCASTER_ID.trim() });
  const data = await jsonOrThrow(await fetch('https://api.twitch.tv/helix/streams?' + query, {
    headers: { Authorization: 'Bearer ' + token, 'Client-Id': process.env.TWITCH_CLIENT_ID }, signal: AbortSignal.timeout(12000),
  }));
  const stream = data.data?.[0];
  return stream
    ? { live: true, viewers: Number.isFinite(Number(stream.viewer_count)) ? Number(stream.viewer_count) : null, startedAt: stream.started_at || null, status: 'live' }
    : { live: false, viewers: null, startedAt: null, status: 'offline' };
}

async function kickStats() {
  if (!process.env.KICK_ACCESS_TOKEN) return { live: false, viewers: null, startedAt: null, status: 'unconfigured' };
  const token = (await freshAccessToken('kick')).trim();
  if (!kickUserId) {
    const channelData = await jsonOrThrow(await fetch('https://api.kick.com/public/v1/channels', {
      headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(12000),
    }));
    kickUserId = String(channelData.data?.[0]?.broadcaster_user_id || '');
  }
  if (!kickUserId) return { live: false, viewers: null, startedAt: null, status: 'error' };
  const query = new URLSearchParams({ user_id: kickUserId });
  const data = await jsonOrThrow(await fetch('https://api.kick.com/public/v1/users/livestreams?' + query, {
    headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(12000),
  }));
  const stream = data.data?.[0];
  return stream
    ? { live: true, viewers: Number.isFinite(Number(stream.viewer_count)) ? Number(stream.viewer_count) : null, startedAt: stream.started_at || null, status: 'live' }
    : { live: false, viewers: null, startedAt: null, status: 'offline' };
}

async function youtubeStats() {
  if (!process.env.YOUTUBE_ACCESS_TOKEN || !process.env.YOUTUBE_BROADCAST_ID) return { live: false, viewers: null, startedAt: null, status: 'unconfigured' };
  const token = (await freshAccessToken('youtube')).trim();
  const query = new URLSearchParams({ part: 'liveStreamingDetails', id: process.env.YOUTUBE_BROADCAST_ID.trim() });
  const data = await jsonOrThrow(await fetch('https://www.googleapis.com/youtube/v3/videos?' + query, {
    headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(12000),
  }));
  const item = data.items?.[0];
  const details = item?.liveStreamingDetails;
  if (!details?.actualStartTime || details.actualEndTime) return { live: false, viewers: null, startedAt: null, status: 'offline' };
  const viewers = details.concurrentViewers === undefined ? null : Number(details.concurrentViewers);
  return { live: true, viewers: Number.isFinite(viewers) ? viewers : null, startedAt: details.actualStartTime, status: 'live' };
}

export async function refreshAudience(previous = emptyAudience()) {
  const result = { ...previous };
  const jobs = [
    ['twitch', twitchStats], ['kick', kickStats], ['youtube', youtubeStats],
  ];
  await Promise.all(jobs.map(async ([platform, fetchStats]) => {
    try {
      result[platform] = { ...await fetchStats(), updatedAt: new Date().toISOString() };
    } catch {
      result[platform] = { live: false, viewers: null, startedAt: null, status: 'error', updatedAt: new Date().toISOString() };
    }
  }));
  result.tiktok = previous?.tiktok || emptyAudience().tiktok;
  return result;
}
