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
const displayDeviceTypes = new Set(['single', 'dual', 'multi', 'multi2', 'room-list', 'room-grid']);
const overridableDeviceTypes = ['single', 'dual', 'multi', 'multi2', 'room-list', 'room-grid'];
const encryptedTokenSetting = '_display_token';
const runtimeStatusSetting = '_runtime_status';
const setupCodeHashSetting = '_setup_code_hash';
const setupCodeExpiresSetting = '_setup_code_expires_at';

export async function listLocationConfigs() {
  const locations = await hospitalDb('opd_qs_location')
    .select('opd_qs_location_id', 'opd_qs_location_name')
    .orderBy('opd_qs_location_name', 'asc');
  const configs = await cpaDb('service_location_config').select('*');
  const devices = await cpaDb('display_devices')
    .select('device_id', 'device_name', 'device_type', 'location_id', 'room_ids', 'allowed_ips', 'active', 'settings_json', 'last_seen_at', 'last_seen_ip', 'created_at', 'updated_at')
    .orderBy('device_id', 'desc');
  const deviceRoomIds = [...new Set(devices.flatMap((device: any) => splitCsv(device.room_ids || '')))].filter(Boolean);
  const latestCalls = deviceRoomIds.length
    ? await cpaDb('opd_qs_call')
      .select('room_id')
      .max('call_datetime as last_call_at')
      .whereIn('room_id', deviceRoomIds)
      .whereBetween('call_datetime', todayRange())
      .groupBy('room_id')
    : [];
  const latestCallByRoom = new Map(latestCalls.map((row: any) => [String(row.room_id), row.last_call_at]));
  const configByLocation = new Map(configs.map(row => [String(row.location_id), row]));
  const devicesByLocation = new Map<string, any[]>();
  for (const device of devices) {
    const key = String(device.location_id);
      const normalized = normalizeDevice(device, true);
      normalized.last_call_at = splitCsv(device.room_ids || '')
        .map(roomId => latestCallByRoom.get(String(roomId)))
        .filter(Boolean)
        .sort((a: any, b: any) => new Date(b).getTime() - new Date(a).getTime())[0] || null;
      devicesByLocation.set(key, [...(devicesByLocation.get(key) || []), normalized]);
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
      google_playback_mode: parseSettings(config.settings_json).google_playback_mode === 'generated' ? 'generated' : 'online',
      google_generated_at: parseSettings(config.settings_json).google_generated_at || '',
      recorded_room_label: parseSettings(config.settings_json).recorded_room_label || '',
      recorded_number_mode: normalizeRecordedNumberMode(parseSettings(config.settings_json).recorded_number_mode),
      queue_colors: normalizeQueueColors(parseSettings(config.settings_json).queue_colors),
      queue_font_weight: normalizeQueueFontWeight(parseSettings(config.settings_json).queue_font_weight),
      display_font_family: normalizeDisplayFontFamily(parseSettings(config.settings_json).display_font_family),
      type_overrides: normalizeTypeOverrides(parseSettings(config.settings_json).type_overrides),
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
    settings_json: JSON.stringify({
      ...(body.settings || {}),
      google_room_label: body.google_room_label || body.settings?.google_room_label || '',
      google_playback_mode: body.google_playback_mode === 'generated' ? 'generated' : 'online',
      google_generated_at: body.google_generated_at || body.settings?.google_generated_at || '',
      recorded_room_label: body.recorded_room_label || body.settings?.recorded_room_label || '',
      recorded_number_mode: normalizeRecordedNumberMode(body.recorded_number_mode || body.settings?.recorded_number_mode),
      queue_colors: normalizeQueueColors(body.queue_colors || body.settings?.queue_colors),
      queue_font_weight: normalizeQueueFontWeight(body.queue_font_weight || body.settings?.queue_font_weight),
      display_font_family: normalizeDisplayFontFamily(body.display_font_family || body.settings?.display_font_family),
      type_overrides: normalizeTypeOverrides(body.type_overrides || body.settings?.type_overrides),
    }),
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
  const deviceType = normalizeDeviceType(body.device_type);
  const [deviceId] = await cpaDb('display_devices').insert({
    device_name: String(body.device_name || 'Display device'),
    device_type: deviceType,
    location_id: locationId,
    room_ids: normalizeDeviceRoomIds(body.room_ids, deviceType),
    token_hash: tokenHash,
    allowed_ips: Array.isArray(body.allowed_ips) ? body.allowed_ips.join(',') : String(body.allowed_ips || ''),
    active: body.active === false ? 0 : 1,
    settings_json: JSON.stringify({ ...(body.settings || {}), remote_settings: normalizeRemoteSettings(body.settings?.remote_settings), [encryptedTokenSetting]: encryptToken(token) }),
  });
  return { ...(await getDevice(deviceId, true)), setup_token: token };
}

export async function updateDisplayDevice(deviceId: string, body: any) {
  const deviceType = normalizeDeviceType(body.device_type);
  const current = await cpaDb('display_devices').select('settings_json').where({ device_id: deviceId }).first();
  const currentSettings = parseSettings(current?.settings_json);
  await cpaDb('display_devices').where({ device_id: deviceId }).update({
    device_name: String(body.device_name || 'Display device'),
    device_type: deviceType,
    room_ids: normalizeDeviceRoomIds(body.room_ids, deviceType),
    allowed_ips: Array.isArray(body.allowed_ips) ? body.allowed_ips.join(',') : String(body.allowed_ips || ''),
    active: body.active === false ? 0 : 1,
    settings_json: JSON.stringify({
      ...(body.settings || {}),
      remote_settings: normalizeRemoteSettings(body.settings?.remote_settings),
      ...(currentSettings[encryptedTokenSetting] ? { [encryptedTokenSetting]: currentSettings[encryptedTokenSetting] } : {}),
    }),
  });
  return getDevice(deviceId, true);
}

export async function rotateDisplayDeviceToken(deviceId: string) {
  const token = `dq_${crypto.randomBytes(32).toString('hex')}`;
  const current = await cpaDb('display_devices').select('settings_json').where({ device_id: deviceId }).first();
  const settings = parseSettings(current?.settings_json);
  settings[encryptedTokenSetting] = encryptToken(token);
  await cpaDb('display_devices').where({ device_id: deviceId }).update({
    token_hash: hashToken(token),
    settings_json: JSON.stringify(settings),
  });
  return { ...(await getDevice(deviceId, true)), setup_token: token };
}

export async function deleteDisplayDevice(deviceId: string) {
  await cpaDb('display_devices').where({ device_id: deviceId }).delete();
  return { deleted: true };
}

export async function createDisplaySetupCode(deviceId: string | number) {
  const row = await cpaDb('display_devices').select('device_id', 'settings_json').where({ device_id: deviceId }).first();
  if (!row) return null;
  const code = String(crypto.randomInt(1000, 10000));
  const settings = parseSettings(row.settings_json);
  settings[setupCodeHashSetting] = hashToken(code);
  settings[setupCodeExpiresSetting] = Date.now() + 10 * 60 * 1000;
  await cpaDb('display_devices').where({ device_id: deviceId }).update({ settings_json: JSON.stringify(settings) });
  return { code, expires_at: new Date(settings[setupCodeExpiresSetting]).toISOString() };
}

export async function claimDisplaySetupCode(code: string) {
  const rows = await cpaDb('display_devices').select('device_id', 'settings_json', 'active').where({ active: 1 });
  const codeHash = hashToken(String(code || ''));
  for (const row of rows) {
    const settings = parseSettings(row.settings_json);
    if (settings[setupCodeHashSetting] !== codeHash || Number(settings[setupCodeExpiresSetting] || 0) < Date.now()) continue;
    const token = decryptToken(settings[encryptedTokenSetting]);
    delete settings[setupCodeHashSetting];
    delete settings[setupCodeExpiresSetting];
    await cpaDb('display_devices').where({ device_id: row.device_id }).update({ settings_json: JSON.stringify(settings) });
    return { device_id: row.device_id, token };
  }
  return null;
}

export async function resolveDisplayDevice(token: string, ip = '') {
  const tokenHash = hashToken(token);
  const row = await cpaDb('display_devices')
    .select('device_id', 'device_name', 'device_type', 'location_id', 'room_ids', 'allowed_ips', 'active', 'settings_json', 'last_seen_at', 'last_seen_ip', 'created_at', 'updated_at')
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

export async function getDisplayRuntime(token: string, ip = '') {
  const device = await resolveDisplayDevice(token, ip);
  if (!device) return null;
  return {
    device_id: device.device_id,
    remote_settings: normalizeRemoteSettings(device.settings?.remote_settings),
  };
}

export async function updateDisplayRuntimeStatus(token: string, body: any, ip = '') {
  const tokenHash = hashToken(token);
  const row = await cpaDb('display_devices').select('device_id', 'settings_json').where({ token_hash: tokenHash }).first();
  if (!row) return null;
  const settings = parseSettings(row.settings_json);
  settings[runtimeStatusSetting] = normalizeRuntimeStatus(body);
  await cpaDb('display_devices').where({ device_id: row.device_id }).update({
    settings_json: JSON.stringify(settings),
    last_seen_at: new Date(),
    last_seen_ip: normalizeIp(ip),
  });
  return settings[runtimeStatusSetting];
}

export function hashToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function getDevice(deviceId: string | number, exposeToken = false) {
  const row = await cpaDb('display_devices')
    .select('device_id', 'device_name', 'device_type', 'location_id', 'room_ids', 'allowed_ips', 'active', 'settings_json', 'last_seen_at', 'last_seen_ip', 'created_at', 'updated_at')
    .where({ device_id: deviceId })
    .first();
  return row ? normalizeDevice(row, exposeToken) : null;
}

function normalizeDevice(row: any, exposeToken = false) {
  const settings = parseSettings(row.settings_json);
  const encryptedToken = settings[encryptedTokenSetting];
  settings.runtime_status = normalizeRuntimeStatus(settings[runtimeStatusSetting]);
  delete settings[runtimeStatusSetting];
  delete settings[encryptedTokenSetting];
  return {
    ...row,
    active: !!row.active,
    room_ids: splitCsv(row.room_ids || ''),
    allowed_ips: splitCsv(row.allowed_ips || ''),
    settings_json: undefined,
    settings,
    ...(exposeToken && encryptedToken ? { setup_token: decryptToken(encryptedToken) } : {}),
  };
}

function tokenEncryptionKey() {
  return crypto.createHash('sha256').update(String(process.env.SESSION_SECRET || '')).digest();
}

function encryptToken(token: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', tokenEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(value => value.toString('base64url')).join('.');
}

function decryptToken(payload: string) {
  try {
    const [ivText, tagText, encryptedText] = String(payload).split('.');
    if (!ivText || !tagText || !encryptedText) return '';
    const decipher = crypto.createDecipheriv('aes-256-gcm', tokenEncryptionKey(), Buffer.from(ivText, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

export function normalizeDeviceType(value: any) {
  const type = String(value || '').trim();
  return displayDeviceTypes.has(type) ? type : 'multi';
}

function normalizeDeviceRoomIds(value: any, deviceType: string) {
  const roomIds = Array.isArray(value) ? value.map(String) : splitCsv(String(value || ''));
  const uniqueRoomIds = [...new Set(roomIds.map(item => item.trim()).filter(Boolean))];
  return uniqueRoomIds.join(',');
}

function splitCsv(value: string) {
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean);
}

function normalizeIp(ip: string) {
  return String(ip || '').replace(/^::ffff:/, '');
}

function todayRange(): [Date, Date] {
  const day = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  return [new Date(`${day}T00:00:00`), new Date(`${day}T23:59:59`)];
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

export function normalizeRemoteSettings(value: any) {
  const settings = value && typeof value === 'object' ? value : {};
  const screenIndex = Math.round(Number(settings.screen_index || 0));
  const updateUrl = String(settings.update_url || '').trim();
  return {
    enabled: settings.enabled === true,
    fullscreen: settings.fullscreen !== false,
    start_on_login: settings.start_on_login === true,
    screen_index: Number.isFinite(screenIndex) ? Math.min(16, Math.max(0, screenIndex)) : 0,
    update_version: String(settings.update_version || '').trim().slice(0, 40),
    update_mode: ['immediate', 'on_start', 'scheduled'].includes(String(settings.update_mode)) ? String(settings.update_mode) : 'immediate',
    update_time: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(settings.update_time || '')) ? String(settings.update_time) : '03:00',
    update_once: settings.update_once === true,
    update_url: /^https?:\/\//i.test(updateUrl) ? updateUrl.slice(0, 2000) : '',
  };
}

function normalizeRuntimeStatus(value: any) {
  const status = value && typeof value === 'object' ? value : {};
  const allowed = ['ready', 'up_to_date', 'waiting', 'downloading', 'installing', 'failed'];
  return {
    state: allowed.includes(String(status.state)) ? String(status.state) : 'ready',
    current_version: String(status.current_version || '').slice(0, 40),
    target_version: String(status.target_version || '').slice(0, 40),
    message: String(status.message || '').slice(0, 180),
    updated_at: String(status.updated_at || new Date().toISOString()).slice(0, 40),
  };
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

function normalizeRecordedNumberMode(value: any) {
  return value === 'number' ? 'number' : 'digits';
}

export function normalizeQueueColors(value: any) {
  const colors = value && typeof value === 'object' ? value : {};
  return {
    theme: normalizeColor(colors.theme, '#4899b2'),
    active_text: normalizeColor(colors.active_text, '#7c2d12'),
    active_border: normalizeColor(colors.active_border, '#f59e0b'),
    active_text_stroke: normalizeBackgroundColor(colors.active_text_stroke),
    active_pulse1: normalizeBackgroundColor(colors.active_pulse1),
    active_pulse2: normalizeBackgroundColor(colors.active_pulse2),
    previous_text: normalizeColor(colors.previous_text, '#7c2d12'),
    previous_border: normalizeColor(colors.previous_border, '#f59e0b'),
    previous_text_stroke: normalizeBackgroundColor(colors.previous_text_stroke),
    previous_bg: normalizeBackgroundColor(colors.previous_bg),
    called_text: normalizeColor(colors.called_text, '#64748b'),
    called_border: normalizeColor(colors.called_border, '#cbd5e1'),
    called_text_stroke: normalizeBackgroundColor(colors.called_text_stroke),
    called_bg: normalizeBackgroundColor(colors.called_bg),
    page_bg: normalizeBackgroundColor(colors.page_bg),
    text_stroke_width: normalizeTextStrokeWidth(colors.text_stroke_width),
  };
}

function normalizeColor(value: any, fallback: string) {
  const color = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : fallback;
}

function normalizeTextStrokeWidth(value: any) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(4, Math.max(0, Math.round(n * 2) / 2));
}

// Empty string means "no custom background configured" — the queue box keeps its current
// default background. Only a validated #rrggbb or rgba(...) value overrides it.
function normalizeBackgroundColor(value: any) {
  const color = String(value || '').trim();
  if (!color) return '';
  if (/^#[0-9a-f]{6}$/i.test(color)) return color.toLowerCase();
  const m = color.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(0|1|0?\.\d+)\s*)?\)$/i);
  if (!m) return '';
  const clamp255 = (n: string) => Math.min(255, Math.max(0, parseInt(n, 10)));
  const r = clamp255(m[1]);
  const g = clamp255(m[2]);
  const b = clamp255(m[3]);
  const a = m[4] !== undefined ? Math.min(1, Math.max(0, Number(m[4]))) : 1;
  return `rgba(${r},${g},${b},${a})`;
}

export function normalizeQueueFontWeight(value: any) {
  return ['400', '700', '900'].includes(String(value)) ? String(value) : '900';
}

export function normalizeDisplayFontFamily(value: any) {
  const key = String(value || '').trim();
  return ['kanit', 'anuphan', 'ibm-plex-sans-thai', 'noto-sans-thai', 'prompt', 'sarabun'].includes(key) ? key : 'kanit';
}

// Per-device-type color/font overrides for a location. A type with no entry here simply
// falls back to the location's own queue_colors/queue_font_weight/display_font_family —
// existing locations that have never set an override keep rendering exactly as before.
export function normalizeTypeOverrides(value: any) {
  const raw = value && typeof value === 'object' ? value : {};
  const result: Record<string, any> = {};
  for (const type of overridableDeviceTypes) {
    const entry = raw[type];
    if (entry && typeof entry === 'object') {
      result[type] = {
        queue_colors: normalizeQueueColors(entry.queue_colors),
        queue_font_weight: normalizeQueueFontWeight(entry.queue_font_weight),
        display_font_family: normalizeDisplayFontFamily(entry.display_font_family),
      };
    }
  }
  return result;
}
