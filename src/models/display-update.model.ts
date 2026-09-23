import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const updateDir = process.env.UPLOADS_DIR
  ? path.join(path.resolve(process.env.UPLOADS_DIR), 'display-updates')
  : path.resolve(__dirname, '../../uploads/display-updates');

export function getDisplayUpdateDir() {
  return updateDir;
}

export async function listDisplayInstallers() {
  await fs.mkdir(updateDir, { recursive: true });
  const entries = await fs.readdir(updateDir, { withFileTypes: true });
  const installers = await Promise.all(entries
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'))
    .map(async entry => {
      const stat = await fs.stat(path.join(updateDir, entry.name));
      const match = entry.name.match(/^cpaqueue-display-(.+)-[0-9a-f]{8}\.exe$/i);
      return {
        filename: entry.name,
        version: match?.[1] || '',
        size: stat.size,
        uploaded_at: stat.mtime.toISOString(),
      };
    }));
  return installers.sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at));
}

export async function saveDisplayInstaller(tempPath: string, version: string) {
  const safeVersion = String(version || '').trim().replace(/^v/i, '').replace(/[^0-9A-Za-z._-]/g, '_');
  if (!/^\d+\.\d+\.\d+/.test(safeVersion)) {
    const error: any = new Error('กรุณาระบุ version รูปแบบ 0.2.0');
    error.status = 400;
    throw error;
  }
  await fs.mkdir(updateDir, { recursive: true });
  const filename = `cpaqueue-display-${safeVersion}-${crypto.randomBytes(4).toString('hex')}.exe`;
  const target = path.join(updateDir, filename);
  await fs.rename(tempPath, target);
  return { version: safeVersion, filename };
}
