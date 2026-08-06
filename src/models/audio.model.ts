import { promises as fs } from 'fs';
import path from 'path';

const audioDir = path.resolve(process.cwd(), 'assets/audio');
const indexPath = path.join(audioDir, 'index.json');
const allowedExts = new Set(['mp3', 'wav', 'ogg']);

export function getAudioDir() {
  return audioDir;
}

export async function detectAudioFile(filePath: string) {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const b = buffer.subarray(0, bytesRead);
    if (b.length >= 3 && b.subarray(0, 3).toString('ascii') === 'ID3') return { ext: 'mp3', mime: 'audio/mpeg' };
    if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return { ext: 'mp3', mime: 'audio/mpeg' };
    if (b.length >= 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WAVE') return { ext: 'wav', mime: 'audio/wav' };
    if (b.length >= 4 && b.subarray(0, 4).toString('ascii') === 'OggS') return { ext: 'ogg', mime: 'audio/ogg' };
    return null;
  } finally {
    await handle.close();
  }
}

export async function listAudioFiles() {
  await fs.mkdir(audioDir, { recursive: true });
  const meta = await readIndex();
  const files = await fs.readdir(audioDir).catch(() => []);
  const audioFiles = files.filter(file => allowedExts.has(extOf(file)));
  return audioFiles.map(file => ({
    key: path.basename(file, path.extname(file)),
    file,
    label: meta[file]?.label || path.basename(file, path.extname(file)),
    uploaded: meta[file]?.uploaded || '',
    url: `/assets/audio/${file}`,
  })).sort((a, b) => String(a.label || a.key).localeCompare(String(b.label || b.key), 'en', { sensitivity: 'base' }));
}

export async function addAudioFile(input: { tempPath: string; originalName: string; key: string; label: string; ext?: string }) {
  await fs.mkdir(audioDir, { recursive: true });
  const ext = input.ext || extOf(input.originalName);
  if (!allowedExts.has(ext)) throw new Error('Unsupported audio type');
  const safeKey = safeAudioKey(input.key || path.basename(input.originalName, path.extname(input.originalName)));
  if (!safeKey) throw new Error('Missing audio key');
  const file = `${safeKey}.${ext}`;
  await fs.rename(input.tempPath, path.join(audioDir, file));
  const meta = await readIndex();
  meta[file] = { label: input.label || safeKey, uploaded: new Date().toISOString().slice(0, 19).replace('T', ' ') };
  await saveIndex(meta);
  return listAudioFiles();
}

export async function updateAudioFiles(items: any[]) {
  const current = await listAudioFiles();
  const allowed = new Set(current.map(item => item.file));
  const meta = await readIndex();
  for (const item of items) {
    if (allowed.has(item.file)) meta[item.file] = { ...(meta[item.file] || {}), label: String(item.label || item.key || '') };
  }
  await saveIndex(meta);
  return listAudioFiles();
}

export async function deleteAudioFile(file: string) {
  const safe = path.basename(file);
  await fs.rm(path.join(audioDir, safe), { force: true });
  const meta = await readIndex();
  delete meta[safe];
  await saveIndex(meta);
  return listAudioFiles();
}

async function readIndex() {
  await fs.mkdir(audioDir, { recursive: true });
  try {
    const data = JSON.parse(await fs.readFile(indexPath, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, any> : {};
  } catch {
    return {};
  }
}

async function saveIndex(data: Record<string, any>) {
  await fs.writeFile(indexPath, JSON.stringify(data, null, 2), 'utf8');
}

function extOf(file: string) {
  return path.extname(file).replace(/^\./, '').toLowerCase();
}

function safeAudioKey(key: string) {
  return String(key || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}
