import crypto from 'crypto';
import { mysqlPool, pgPool } from '../db.js';
import { listAudioFiles } from './audio.model.js';

export const voiceTypes = [
  'cashier',
  'channel',
  'couter',
  'counter',
  'doctor_room',
  'interview-point',
  'interview-table',
  'number',
  'pay-cashier',
  'pay-drug',
  'please',
  'receive-drug',
  'screen-point',
  'screen-table',
  'table',
  'silent',
];

export async function listLocationConfigs() {
  const { rows: locations } = await pgPool.query(`
    SELECT opd_qs_location_id, opd_qs_location_name
    FROM opd_qs_location
    ORDER BY opd_qs_location_name ASC`);
  const [configs] = await mysqlPool.query<any[]>(`SELECT * FROM service_location_config`);
  const [devices] = await mysqlPool.query<any[]>(`
    SELECT device_id, device_name, device_type, location_id, room_ids, allowed_ips, active, last_seen_at, last_seen_ip, created_at, updated_at
    FROM display_devices
    ORDER BY device_id DESC`);
  const configByLocation = new Map(configs.map(row => [String(row.location_id), row]));
  const devicesByLocation = new Map<string, any[]>();
  for (const device of devices) {
    const key = String(device.location_id);
    devicesByLocation.set(key, [...(devicesByLocation.get(key) || []), normalizeDevice(device)]);
  }
  return locations.map((location: any) => {
    const id = String(location.opd_qs_location_id);
    const config = configByLocation.get(id) || {};
    return {
      location_id: id,
      location_name: location.opd_qs_location_name,
      display_name: config.display_name || location.opd_qs_location_name,
      tts_provider: config.tts_provider || 'google',
      recorded_room_type: config.recorded_room_type || 'doctor_room',
      voice_rate: Number(config.voice_rate || 1),
      settings: parseSettings(config.settings_json),
      google_room_label: parseSettings(config.settings_json).google_room_label || 'ห้องตรวจ',
      default_room_ids: splitCsv(config.default_room_ids || ''),
      devices: devicesByLocation.get(id) || [],
    };
  });
}

export async function updateLocationConfig(locationId: string, body: any) {
  const recordedRoomType = await normalizeRecordedRoomType(body.recorded_room_type);
  await mysqlPool.query(`
    INSERT INTO service_location_config
      (location_id, display_name, tts_provider, recorded_room_type, voice_rate, default_room_ids, settings_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      display_name = VALUES(display_name),
      tts_provider = VALUES(tts_provider),
      recorded_room_type = VALUES(recorded_room_type),
      voice_rate = VALUES(voice_rate),
      default_room_ids = VALUES(default_room_ids),
      settings_json = VALUES(settings_json)`,
    [
      locationId,
      String(body.display_name || ''),
      body.tts_provider === 'recorded' ? 'recorded' : 'google',
      recordedRoomType,
      normalizeVoiceRate(body.voice_rate),
      Array.isArray(body.default_room_ids) ? body.default_room_ids.join(',') : String(body.default_room_ids || ''),
      JSON.stringify({ ...(body.settings || {}), google_room_label: body.google_room_label || body.settings?.google_room_label || '' }),
    ]);
  return getLocationConfig(locationId);
}

async function normalizeRecordedRoomType(value: any) {
  const key = String(value || '').trim();
  if (voiceTypes.includes(key)) return key;
  const audioFiles = await listAudioFiles();
  return audioFiles.some(item => item.key === key) ? key : 'doctor_room';
}

export async function getLocationConfig(locationId: string) {
  return (await listLocationConfigs()).find(item => item.location_id === String(locationId)) || null;
}

export async function createDisplayDevice(locationId: string, body: any) {
  const token = `dq_${crypto.randomBytes(32).toString('hex')}`;
  const tokenHash = hashToken(token);
  const [result] = await mysqlPool.query<any>(`
    INSERT INTO display_devices
      (device_name, device_type, location_id, room_ids, token_hash, allowed_ips, active, settings_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      String(body.device_name || 'Display device'),
      body.device_type === 'single' ? 'single' : 'multi',
      locationId,
      Array.isArray(body.room_ids) ? body.room_ids.join(',') : String(body.room_ids || ''),
      tokenHash,
      Array.isArray(body.allowed_ips) ? body.allowed_ips.join(',') : String(body.allowed_ips || ''),
      body.active === false ? 0 : 1,
      JSON.stringify(body.settings || {}),
    ]);
  return { ...(await getDevice(result.insertId)), setup_token: token };
}

export async function updateDisplayDevice(deviceId: string, body: any) {
  await mysqlPool.query(`
    UPDATE display_devices SET
      device_name = ?,
      device_type = ?,
      room_ids = ?,
      allowed_ips = ?,
      active = ?,
      settings_json = ?
    WHERE device_id = ?`,
    [
      String(body.device_name || 'Display device'),
      body.device_type === 'single' ? 'single' : 'multi',
      Array.isArray(body.room_ids) ? body.room_ids.join(',') : String(body.room_ids || ''),
      Array.isArray(body.allowed_ips) ? body.allowed_ips.join(',') : String(body.allowed_ips || ''),
      body.active === false ? 0 : 1,
      JSON.stringify(body.settings || {}),
      deviceId,
    ]);
  return getDevice(deviceId);
}

export async function rotateDisplayDeviceToken(deviceId: string) {
  const token = `dq_${crypto.randomBytes(32).toString('hex')}`;
  await mysqlPool.query(`UPDATE display_devices SET token_hash = ? WHERE device_id = ?`, [hashToken(token), deviceId]);
  return { ...(await getDevice(deviceId)), setup_token: token };
}

export async function deleteDisplayDevice(deviceId: string) {
  await mysqlPool.query(`DELETE FROM display_devices WHERE device_id = ?`, [deviceId]);
  return { deleted: true };
}

export async function resolveDisplayDevice(token: string, ip = '') {
  const tokenHash = hashToken(token);
  const [rows] = await mysqlPool.query<any[]>(`
    SELECT device_id, device_name, device_type, location_id, room_ids, allowed_ips, active, last_seen_at, last_seen_ip, created_at, updated_at
    FROM display_devices
    WHERE token_hash = ?
    LIMIT 1`, [tokenHash]);
  if (!rows[0] || !rows[0].active) return null;

  const device = normalizeDevice(rows[0]);
  // IP allow-list is intentionally disabled for now. Keep this block for future hardening.
  // if (device.allowed_ips.length && !device.allowed_ips.includes(normalizeIp(ip))) {
  //   const error: any = new Error('IP not allowed');
  //   error.status = 403;
  //   throw error;
  // }

  await mysqlPool.query(`UPDATE display_devices SET last_seen_at = NOW(), last_seen_ip = ? WHERE device_id = ?`, [normalizeIp(ip), device.device_id]);
  return device;
}

export function hashToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function getDevice(deviceId: string | number) {
  const [rows] = await mysqlPool.query<any[]>(`
    SELECT device_id, device_name, device_type, location_id, room_ids, allowed_ips, active, last_seen_at, last_seen_ip, created_at, updated_at
    FROM display_devices WHERE device_id = ?`, [deviceId]);
  return rows[0] ? normalizeDevice(rows[0]) : null;
}

function normalizeDevice(row: any) {
  return {
    ...row,
    active: !!row.active,
    room_ids: splitCsv(row.room_ids || ''),
    allowed_ips: splitCsv(row.allowed_ips || ''),
  };
}

function splitCsv(value: string) {
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean);
}

function normalizeIp(ip: string) {
  return String(ip || '').replace(/^::ffff:/, '');
}

function parseSettings(value: any) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function normalizeVoiceRate(value: any) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(1.5, Math.max(0.7, n));
}
