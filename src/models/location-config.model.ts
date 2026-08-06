import crypto from 'crypto';
import { cpaDb, hospitalDb } from '../db.js';
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
  const locations = await hospitalDb('opd_qs_location')
    .select('opd_qs_location_id', 'opd_qs_location_name')
    .orderBy('opd_qs_location_name', 'asc');
  const configs = await cpaDb('service_location_config').select('*');
  const devices = await cpaDb('display_devices')
    .select('device_id', 'device_name', 'device_type', 'location_id', 'room_ids', 'allowed_ips', 'active', 'last_seen_at', 'last_seen_ip', 'created_at', 'updated_at')
    .orderBy('device_id', 'desc');
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
      call_repeat_count: normalizeCallRepeatCount(config.call_repeat_count),
      pooled_call_enabled: !!Number(config.pooled_call_enabled || 0),
      settings: parseSettings(config.settings_json),
      google_room_label: parseSettings(config.settings_json).google_room_label || 'ห้องตรวจ',
      default_room_ids: splitCsv(config.default_room_ids || ''),
      devices: devicesByLocation.get(id) || [],
    };
  });
}

export async function updateLocationConfig(locationId: string, body: any) {
  const recordedRoomType = await normalizeRecordedRoomType(body.recorded_room_type);
  const payload = {
    location_id: locationId,
    display_name: String(body.display_name || ''),
    tts_provider: body.tts_provider === 'recorded' ? 'recorded' : 'google',
    recorded_room_type: recordedRoomType,
    voice_rate: normalizeVoiceRate(body.voice_rate),
    call_repeat_count: normalizeCallRepeatCount(body.call_repeat_count),
    pooled_call_enabled: body.pooled_call_enabled ? 1 : 0,
    default_room_ids: Array.isArray(body.default_room_ids) ? body.default_room_ids.join(',') : String(body.default_room_ids || ''),
    settings_json: JSON.stringify({ ...(body.settings || {}), google_room_label: body.google_room_label || body.settings?.google_room_label || '' }),
  };
  await cpaDb('service_location_config').insert(payload).onConflict('location_id').merge(payload);
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
  const [deviceId] = await cpaDb('display_devices').insert({
    device_name: String(body.device_name || 'Display device'),
    device_type: body.device_type === 'single' ? 'single' : 'multi',
    location_id: locationId,
    room_ids: Array.isArray(body.room_ids) ? body.room_ids.join(',') : String(body.room_ids || ''),
    token_hash: tokenHash,
    allowed_ips: Array.isArray(body.allowed_ips) ? body.allowed_ips.join(',') : String(body.allowed_ips || ''),
    active: body.active === false ? 0 : 1,
    settings_json: JSON.stringify(body.settings || {}),
  });
  return { ...(await getDevice(deviceId)), setup_token: token };
}

export async function updateDisplayDevice(deviceId: string, body: any) {
  await cpaDb('display_devices').where({ device_id: deviceId }).update({
    device_name: String(body.device_name || 'Display device'),
    device_type: body.device_type === 'single' ? 'single' : 'multi',
    room_ids: Array.isArray(body.room_ids) ? body.room_ids.join(',') : String(body.room_ids || ''),
    allowed_ips: Array.isArray(body.allowed_ips) ? body.allowed_ips.join(',') : String(body.allowed_ips || ''),
    active: body.active === false ? 0 : 1,
    settings_json: JSON.stringify(body.settings || {}),
  });
  return getDevice(deviceId);
}

export async function rotateDisplayDeviceToken(deviceId: string) {
  const token = `dq_${crypto.randomBytes(32).toString('hex')}`;
  await cpaDb('display_devices').where({ device_id: deviceId }).update({ token_hash: hashToken(token) });
  return { ...(await getDevice(deviceId)), setup_token: token };
}

export async function deleteDisplayDevice(deviceId: string) {
  await cpaDb('display_devices').where({ device_id: deviceId }).delete();
  return { deleted: true };
}

export async function resolveDisplayDevice(token: string, ip = '') {
  const tokenHash = hashToken(token);
  const row = await cpaDb('display_devices')
    .select('device_id', 'device_name', 'device_type', 'location_id', 'room_ids', 'allowed_ips', 'active', 'last_seen_at', 'last_seen_ip', 'created_at', 'updated_at')
    .where({ token_hash: tokenHash })
    .first();
  if (!row || !row.active) return null;

  const device = normalizeDevice(row);
  // IP allow-list is intentionally disabled for now. Keep this block for future hardening.
  // if (device.allowed_ips.length && !device.allowed_ips.includes(normalizeIp(ip))) {
  //   const error: any = new Error('IP not allowed');
  //   error.status = 403;
  //   throw error;
  // }

  await cpaDb('display_devices').where({ device_id: device.device_id }).update({ last_seen_at: new Date(), last_seen_ip: normalizeIp(ip) });
  return device;
}

export function hashToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function getDevice(deviceId: string | number) {
  const row = await cpaDb('display_devices')
    .select('device_id', 'device_name', 'device_type', 'location_id', 'room_ids', 'allowed_ips', 'active', 'last_seen_at', 'last_seen_ip', 'created_at', 'updated_at')
    .where({ device_id: deviceId })
    .first();
  return row ? normalizeDevice(row) : null;
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

function normalizeCallRepeatCount(value: any) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 1;
  return Math.min(5, Math.max(1, n));
}
