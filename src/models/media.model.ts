import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';

const uploadDir = path.resolve(process.cwd(), '../uploads');
const indexPath = path.join(uploadDir, 'index.json');
const locationIndexPath = path.join(uploadDir, 'location-media.json');
const defaultMedia = {
  file: 'hospital_isometric.png',
  type: 'image',
  label: 'โรงพยาบาลเจ้าพระยาอภัยภูเบศร',
  duration: 10,
  enabled: 1,
  order: 0,
  default: true,
};

export async function listMedia(locationId = '', manage = false) {
  await fs.mkdir(uploadDir, { recursive: true });
  try {
    const data = JSON.parse(stripBom(await fs.readFile(indexPath, 'utf8')));
    const items = Array.isArray(data) ? data : [];
    if (manage) return withUsage(items);
    if (!locationId) return items;
    const selected = await getLocationFiles(locationId);
    if (!selected.size) return [defaultMedia];
    const selectedItems = items.filter(item => item.enabled && selected.has(item.file));
    return selectedItems.length ? selectedItems : [defaultMedia];
  } catch {
    return locationId && !manage ? [defaultMedia] : [];
  }
}

export function getUploadDir() {
  return uploadDir;
}

export async function addMedia(item: any) {
  const current = await listMedia();
  const next = [...current, { ...item, order: current.length + 1, uploaded: new Date().toISOString().slice(0, 19).replace('T', ' ') }];
  await saveMedia(next);
  return next;
}

export async function addYoutubeMedia(input: { url: string; label?: string; duration?: number; enabled?: boolean }) {
  const parsed = parseYoutubeUrl(input.url);
  if (!parsed) {
    const error = new Error('Invalid YouTube URL');
    (error as any).status = 400;
    throw error;
  }

  const current = await listMedia();
  const file = `youtube_${crypto.createHash('sha1').update(parsed.embedUrl).digest('hex').slice(0, 16)}`;
  const item = {
    file,
    type: 'youtube',
    source_url: input.url,
    embed_url: parsed.embedUrl,
    video_id: parsed.videoId,
    playlist_id: parsed.playlistId,
    label: input.label || (parsed.isLive ? 'YouTube Live' : 'YouTube Video'),
    duration: normalizeDuration(input.duration ?? (parsed.isLive ? 0 : 30)),
    enabled: input.enabled === false ? 0 : 1,
  };
  const next = current.some(media => media.file === file)
    ? current.map(media => media.file === file ? { ...media, ...item } : media)
    : [...current, { ...item, order: current.length + 1, uploaded: new Date().toISOString().slice(0, 19).replace('T', ' ') }];
  await saveMedia(next);
  return next;
}

export async function saveMedia(items: any[]) {
  await fs.mkdir(uploadDir, { recursive: true });
  await fs.writeFile(indexPath, JSON.stringify(items, null, 2), 'utf8');
}

async function readLocationMedia() {
  await fs.mkdir(uploadDir, { recursive: true });
  try {
    const data = JSON.parse(stripBom(await fs.readFile(locationIndexPath, 'utf8')));
    return data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, string[]> : {};
  } catch {
    return {};
  }
}

async function saveLocationMedia(data: Record<string, string[]>) {
  await fs.writeFile(locationIndexPath, JSON.stringify(data, null, 2), 'utf8');
}

export async function getLocationFiles(locationId: string) {
  const data = await readLocationMedia();
  return new Set((data[String(locationId)] || []).map(String));
}

async function withUsage(items: any[]) {
  const data = await readLocationMedia();
  return items.map(item => {
    const locationIds = Object.entries(data)
      .filter(([, files]) => files.includes(item.file))
      .map(([locationId]) => locationId);
    return { ...item, location_ids: locationIds, location_count: locationIds.length };
  });
}

export async function setLocationMedia(locationId: string, files: string[]) {
  const current = await listMedia();
  const allowed = new Set(current.map(item => item.file));
  const data = await readLocationMedia();
  data[String(locationId)] = [...new Set(files.map(file => path.basename(file)).filter(file => allowed.has(file)))];
  await saveLocationMedia(data);
  return listMedia(locationId, true);
}

export async function setMediaLocations(file: string, locationIds: string[]) {
  const safe = path.basename(file);
  const current = await listMedia();
  if (!current.some(item => item.file === safe)) return withUsage(current);
  const data = await readLocationMedia();
  const selected = new Set(locationIds.map(String).filter(Boolean));
  for (const locationId of Object.keys(data)) {
    data[locationId] = data[locationId].filter(item => item !== safe);
  }
  for (const locationId of selected) {
    data[locationId] = [...new Set([...(data[locationId] || []), safe])];
  }
  await saveLocationMedia(data);
  return withUsage(current);
}

export async function updateMedia(items: any[]) {
  const current = await listMedia();
  const byFile = new Map(items.map(i => [i.file, i]));
  const next = current.map(item => {
    const update = byFile.get(item.file) ?? {};
    return {
      ...item,
      label: update.label ?? item.label,
      duration: normalizeDuration(Object.prototype.hasOwnProperty.call(update, 'duration') ? update.duration : item.duration),
      enabled: update.enabled ?? item.enabled,
    };
  });
  await saveMedia(next);
  return next;
}

export async function toggleMedia(file: string) {
  const current = await listMedia();
  const next = current.map(item => item.file === file ? { ...item, enabled: item.enabled ? 0 : 1 } : item);
  await saveMedia(next);
  return next;
}

export async function deleteMedia(file: string) {
  const safe = path.basename(file);
  const current = await listMedia();
  const target = current.find(item => item.file === safe);
  const next = current.filter(item => item.file !== safe);
  await saveMedia(next);
  const locationMedia = await readLocationMedia();
  for (const key of Object.keys(locationMedia)) {
    locationMedia[key] = locationMedia[key].filter(item => item !== safe);
  }
  await saveLocationMedia(locationMedia);
  if (target?.type !== 'youtube') await fs.rm(path.join(uploadDir, safe), { force: true });
  return next;
}

function parseYoutubeUrl(value: string) {
  try {
    const url = new URL(String(value || '').trim());
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    let videoId = '';
    const playlistId = url.searchParams.get('list') || '';
    const isLive = url.pathname.includes('/live') || url.searchParams.get('live') === '1';

    if (host === 'youtu.be') {
      videoId = url.pathname.split('/').filter(Boolean)[0] || '';
    } else if (host.endsWith('youtube.com')) {
      if (url.pathname === '/watch') videoId = url.searchParams.get('v') || '';
      else if (url.pathname.startsWith('/embed/')) videoId = url.pathname.split('/')[2] || '';
      else if (url.pathname.startsWith('/live/')) videoId = url.pathname.split('/')[2] || '';
      else if (url.pathname.startsWith('/shorts/')) videoId = url.pathname.split('/')[2] || '';
    }

    if (!videoId && !playlistId) return null;
    const params = new URLSearchParams({
      autoplay: '1',
      mute: '1',
      controls: '0',
      rel: '0',
      modestbranding: '1',
      playsinline: '1',
      disablekb: '1',
      fs: '0',
      iv_load_policy: '3',
      cc_load_policy: '0',
    });

    if (playlistId && !videoId) {
      params.set('listType', 'playlist');
      params.set('list', playlistId);
      return { embedUrl: `https://www.youtube.com/embed/videoseries?${params.toString()}`, videoId, playlistId, isLive };
    }

    if (playlistId) params.set('list', playlistId);
    return { embedUrl: `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?${params.toString()}`, videoId, playlistId, isLive };
  } catch {
    return null;
  }
}

function stripBom(value: string) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function normalizeDuration(value: any) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 10;
  if (n <= 0) return 0;
  return Math.max(3, Math.round(n));
}
