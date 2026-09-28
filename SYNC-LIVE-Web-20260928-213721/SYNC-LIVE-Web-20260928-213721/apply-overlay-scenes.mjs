import { copyFile, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

const scenesDir = join(process.env.APPDATA, 'obs-studio', 'basic', 'scenes');
const file = join(scenesDir, 'SYNC_LIVE_コメント表示.json');
const backup = join(process.env.LOCALAPPDATA, 'SYNC LIVE', 'obs-scenes-before-overlay.json');
const data = JSON.parse(await readFile(file, 'utf8'));
const overlay = data.sources.find(source => source.name === 'SYNC LIVE 統合コメント');
const template = data.sources.find(source => source.name === 'kick')?.settings?.items?.find(item => item.name === overlay?.name);
if (!overlay || !template) throw new Error('OBS overlay source is missing.');
await copyFile(file, backup);
let changed = 0;
for (const scene of data.sources.filter(source => source.id === 'scene')) {
  const items = scene.settings?.items;
  if (!Array.isArray(items) || items.some(item => item.name === overlay.name)) continue;
  const nextId = Math.max(0, ...items.map(item => Number(item.id) || 0)) + 1;
  items.push({ ...structuredClone(template), id: nextId });
  changed += 1;
}
const temp = `${file}.tmp`;
await writeFile(temp, JSON.stringify(data, null, 2), 'utf8');
await rename(temp, file);
console.log(`Overlay added to ${changed} OBS scenes. Backup saved locally.`);
