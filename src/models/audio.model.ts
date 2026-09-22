import { promises as fs } from 'fs';
import path from 'path';

const assetsDir = process.env.ASSETS_DIR
  ? path.resolve(process.env.ASSETS_DIR)
  : path.resolve(process.cwd(), '../assets');
const audioDir = path.join(assetsDir, 'audio');
const indexPath = path.join(audioDir, 'index.json');
const allowedExts = new Set(['mp3', 'wav', 'ogg']);
const defaultDestinationKeys = new Set([
  'cashier', 'channel', 'couter', 'counter', 'doctor_room',
  'interview-point', 'interview-table', 'pay-cashier', 'pay-drug',
  'receive-drug', 'screen-point', 'screen-table', 'table',
]);

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

export async function listAudioFiles(destinationOnly = false) {
  await fs.mkdir(audioDir, { recursive: true });
  const meta = await readIndex();
  const files = await fs.readdir(audioDir).catch(() => []);
  const audioFiles = files.filter(file => allowedExts.has(extOf(file)));
  return audioFiles.map(file => {
    const key = path.basename(file, path.extname(file));
    const isSystem = isSystemAudioKey(key);
    return {
      key,
      file,
      label: meta[file]?.label || key,
      uploaded: meta[file]?.uploaded || '',
      is_system: isSystem,
      is_destination: !isSystem && typeof meta[file]?.is_destination === 'boolean'
        ? meta[file].is_destination
        : !isSystem && defaultDestinationKeys.has(key.toLowerCase()),
      url: `/assets/audio/${file}`,
    };
  }).filter(item => !destinationOnly || item.is_destination)
    .sort((a, b) => String(a.label || a.key).localeCompare(String(b.label || b.key), 'en', { sensitivity: 'base' }));
}

export async function addAudioFile(input: { tempPath: string; originalName: string; key: string; label: string; isDestination?: boolean; replaceSystem?: boolean; ext?: string }) {
  await fs.mkdir(audioDir, { recursive: true });
  const ext = input.ext || extOf(input.originalName);
  if (!allowedExts.has(ext)) throw new Error('Unsupported audio type');
  const safeKey = safeAudioKey(input.key || path.basename(input.originalName, path.extname(input.originalName)));
  if (!safeKey) throw new Error('Missing audio key');
  const file = `${safeKey}.${ext}`;
  const meta = await readIndex();
  const existingFiles = await fs.readdir(audioDir).catch(() => []);
  const previousFile = existingFiles.find(name => path.basename(name, path.extname(name)).toLowerCase() === safeKey);
  const previousMeta = previousFile ? meta[previousFile] : undefined;
  if (isSystemAudioKey(safeKey) && !input.replaceSystem) {
    await fs.rm(input.tempPath, { force: true });
    throw Object.assign(new Error('System audio must be replaced from its existing item'), { status: 400 });
  }
  if (isSystemAudioKey(safeKey) && previousFile && extOf(previousFile) !== ext) {
    await fs.rm(input.tempPath, { force: true });
    throw Object.assign(new Error(`System audio replacement must use .${extOf(previousFile)}`), { status: 400 });
  }
  await fs.copyFile(input.tempPath, path.join(audioDir, file));
  await fs.rm(input.tempPath, { force: true });
  if (previousFile && previousFile !== file) await fs.rm(path.join(audioDir, previousFile), { force: true });
  if (previousFile && previousFile !== file) delete meta[previousFile];
  const isSystem = isSystemAudioKey(safeKey);
  meta[file] = {
    ...(previousMeta || {}),
    label: input.label || previousMeta?.label || safeKey,
    is_destination: isSystem ? false : !!input.isDestination,
    uploaded: new Date().toISOString().slice(0, 19).replace('T', ' '),
  };
  await saveIndex(meta);
  return listAudioFiles();
}

export async function updateAudioFiles(items: any[]) {
  const current = await listAudioFiles();
  const allowed = new Set(current.map(item => item.file));
  const meta = await readIndex();
  for (const item of items) {
    if (allowed.has(item.file)) meta[item.file] = {
      ...(meta[item.file] || {}),
      label: String(item.label || item.key || ''),
      is_destination: isSystemAudioKey(item.key || path.basename(item.file, path.extname(item.file))) ? false : !!item.is_destination,
    };
  }
  await saveIndex(meta);
  return listAudioFiles();
}

export async function deleteAudioFile(file: string) {
  const safe = path.basename(file);
  if (isSystemAudioKey(path.basename(safe, path.extname(safe)))) throw Object.assign(new Error('System audio files cannot be deleted'), { status: 400 });
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
  return String(key || '').trim().toLowerCase().replace(/[^a-z0-9_\-\u0E00-\u0E7F]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function isSystemAudioKey(key: string) {
  const value = String(key || '').trim().toLowerCase();
  return /^(?:[0-9]|10|11|20|100|1000|10000)$/.test(value)
    || /^[a-z]$/.test(value)
    || /^[ก-ฮ]$/.test(value)
    || ['please', 'number', 'ka', 'silent'].includes(value);
}
