import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = join(ROOT, 'data');
const SETTINGS_FILE = join(DATA_DIR, 'stream-descriptions.json');
const emptySettings = () => ({ youtube: '', twitch: '', kick: '' });

export async function getFixedDescriptions() {
  try {
    const value = JSON.parse(await readFile(SETTINGS_FILE, 'utf8'));
    return Object.fromEntries(['youtube', 'twitch', 'kick'].map(platform => [
      platform,
      typeof value?.[platform] === 'string' ? value[platform] : '',
    ]));
  } catch {
    return emptySettings();
  }
}

export async function saveFixedDescriptions(value) {
  const normalized = Object.fromEntries(['youtube', 'twitch', 'kick'].map(platform => [
    platform,
    typeof value?.[platform] === 'string' ? value[platform] : '',
  ]));
  if (Buffer.byteLength(normalized.youtube, 'utf8') > 5000) throw new Error('YouTube の固定説明は5000バイト以内にしてください。');
  if ([...normalized.twitch].length > 300) throw new Error('Twitch のチャンネル説明は300文字以内にしてください。');
  if ([...normalized.kick].length > 5000) throw new Error('Kick の固定説明は5000文字以内にしてください。');
  await mkdir(DATA_DIR, { recursive: true });
  const temporary = `${SETTINGS_FILE}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(normalized, null, 2), 'utf8');
  await rename(temporary, SETTINGS_FILE);
  return normalized;
}
