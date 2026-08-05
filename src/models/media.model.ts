import { promises as fs } from 'fs';
import path from 'path';

const uploadDir = path.resolve(process.cwd(), '../uploads');
const indexPath = path.join(uploadDir, 'index.json');
const locationIndexPath = path.join(uploadDir, 'location-media.json');
const defaultMedia = {
  file: 'hospital_isometric.png',
  label: 'โรงพยาบาลเจ้าพระยาอภัยภูเบศร',
  duration: 10,
  enabled: 1,
  order: 0,
  default: true,
};

export async function listMedia(locationId = '', manage = false) {
  await fs.mkdir(uploadDir, { recursive: true });
  try {
    const data = JSON.parse(await fs.readFile(indexPath, 'utf8'));
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

export async function saveMedia(items: any[]) {
  await fs.mkdir(uploadDir, { recursive: true });
  await fs.writeFile(indexPath, JSON.stringify(items, null, 2), 'utf8');
}

async function readLocationMedia() {
  await fs.mkdir(uploadDir, { recursive: true });
  try {
    const data = JSON.parse(await fs.readFile(locationIndexPath, 'utf8'));
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
  const next = current.map(item => ({ ...item, ...(byFile.get(item.file) ?? {}) }));
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
  const next = current.filter(item => item.file !== safe);
  await saveMedia(next);
  const locationMedia = await readLocationMedia();
  for (const key of Object.keys(locationMedia)) {
    locationMedia[key] = locationMedia[key].filter(item => item !== safe);
  }
  await saveLocationMedia(locationMedia);
  await fs.rm(path.join(uploadDir, safe), { force: true });
  return next;
}
