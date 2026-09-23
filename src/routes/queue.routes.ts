import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { dashboardSummary, logQueueAction } from '../models/audit.model.js';
import * as Queue from '../models/queue.model.js';
import { getDisplayData, getMultiDisplayData, getRoomListDisplayData } from '../models/display.model.js';
import { checkQueue } from '../models/check.model.js';
import * as Media from '../models/media.model.js';
import * as Audio from '../models/audio.model.js';
import * as LocationConfig from '../models/location-config.model.js';
import * as ColorDefaults from '../models/color-defaults.model.js';
import * as DisplayUpdate from '../models/display-update.model.js';
import { requireAdmin, requireAuth } from '../middleware/auth.middleware.js';
import { rateLimit } from '../security.js';
import { wsHub } from '../wsHub.js';
import { generateGoogleAudio, googleDigitPrewarmStatus, googleGeneratedStatus, startGoogleDigitPrewarm, stopGoogleDigitPrewarm } from './tts.routes.js';

export const queueRouter = Router();
const upload = multer({
  dest: Media.getUploadDir(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.mimetype)),
});
const audioUpload = multer({
  dest: Audio.getAudioDir(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, ['audio/mpeg', 'audio/wav', 'audio/wave', 'audio/x-wav', 'audio/ogg'].includes(file.mimetype)),
});
const updateUpload = multer({
  dest: DisplayUpdate.getDisplayUpdateDir(),
  limits: { fileSize: 300 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, path.extname(file.originalname).toLowerCase() === '.exe'),
});

const ok = (data: unknown) => ({ status: 'success', data });

queueRouter.get('/check-queue', rateLimit({ keyPrefix: 'check-queue', windowMs: 60_000, max: 60 }), async (req, res, next) => {
  try { res.json(await checkQueue(String(req.query.q ?? ''))); } catch (e) { next(e); }
});
queueRouter.get('/display-devices/resolve', rateLimit({ keyPrefix: 'display-device-resolve', windowMs: 60_000, max: 120 }), async (req, res, next) => {
  try {
    const device = await LocationConfig.resolveDisplayDevice(String(req.query.token || ''), req.ip);
    if (!device) return res.status(404).json({ ok: false, error: 'Display device not found' });
    res.json(ok(device));
  } catch (e) { next(e); }
});
queueRouter.get('/display-devices/runtime', rateLimit({ keyPrefix: 'display-device-runtime', windowMs: 60_000, max: 120 }), async (req, res, next) => {
  try {
    const runtime = await LocationConfig.getDisplayRuntime(String(req.query.token || ''), req.ip);
    if (!runtime) return res.status(404).json({ ok: false, error: 'Display device not found' });
    res.json(ok(runtime));
  } catch (e) { next(e); }
});
queueRouter.post('/display-devices/runtime/status', rateLimit({ keyPrefix: 'display-device-runtime-status', windowMs: 60_000, max: 120 }), async (req, res, next) => {
  try {
    const token = String(req.body?.token || req.query.token || '');
    const status = await LocationConfig.updateDisplayRuntimeStatus(token, req.body || {}, req.ip);
    if (!status) return res.status(404).json({ ok: false, error: 'Display device not found' });
    res.json(ok(status));
  } catch (e) { next(e); }
});
queueRouter.post('/display-devices/setup-code/claim', rateLimit({ keyPrefix: 'display-device-setup-claim', windowMs: 10 * 60_000, max: 12 }), async (req, res, next) => {
  try {
    const code = String(req.body?.code || '').trim();
    if (!/^\d{4}$/.test(code)) return res.status(400).json({ status: 'error', message: 'รหัสติดตั้งไม่ถูกต้อง' });
    const result = await LocationConfig.claimDisplaySetupCode(code);
    if (!result?.token) return res.status(404).json({ status: 'error', message: 'รหัสหมดอายุหรือถูกใช้ไปแล้ว' });
    res.json(ok(result));
  } catch (e) { next(e); }
});
queueRouter.get('/display-devices/display', rateLimit({ keyPrefix: 'display-device-display', windowMs: 60_000, max: 180 }), async (req, res, next) => {
  try {
    const device = await LocationConfig.resolveDisplayDevice(String(req.query.token || ''), req.ip);
    if (!device) return res.status(404).json({ ok: false, error: 'Display device not found' });
    res.json(await displayDataForDevice(device));
  } catch (e) { next(e); }
});
queueRouter.get('/media', async (req, res, next) => {
  try {
    if (req.query.manage === '1' && !req.session.user?.roles.includes('admin')) {
      return res.status(req.session.user ? 403 : 401).json({ status: 'error', message: req.session.user ? 'Forbidden' : 'Unauthorized' });
    }
    res.json({ status: 'success', data: await Media.listMedia(String(req.query.location_id ?? ''), req.query.manage === '1') });
  } catch (e) { next(e); }
});

queueRouter.use(['/media', '/media/*', '/location-configs', '/location-configs/*', '/audio-files', '/audio-files/*', '/display-devices/*', '/display-updates', '/queue-color-defaults'], requireAdmin);
queueRouter.use(requireAuth);

queueRouter.get('/locations', async (_req, res, next) => { try { res.json(ok(await Queue.getLocations())); } catch (e) { next(e); } });
queueRouter.get('/dashboard/summary', requireAdmin, async (_req, res, next) => { try { res.json(ok(await dashboardSummary())); } catch (e) { next(e); } });
queueRouter.get('/doctors', async (req, res, next) => { try { res.json(ok(await Queue.getDoctors(String(req.query.location_id ?? '')))); } catch (e) { next(e); } });
queueRouter.get('/rooms', async (req, res, next) => { try { res.json(ok(await Queue.getRooms(String(req.query.location_id ?? '')))); } catch (e) { next(e); } });
queueRouter.get('/doctor-room', async (req, res, next) => {
  try {
    const codes = String(req.query.doctor_codes ?? '');
    if (codes) return res.json(ok(await Queue.getDoctorRooms(codes.split(',').filter(Boolean))));
    res.json(ok(await Queue.getDoctorRoom(String(req.query.doctor_code ?? ''))));
  } catch (e) { next(e); }
});
queueRouter.get('/queues', async (req, res, next) => {
  try { res.json(ok(await Queue.getQueues(String(req.query.location_id ?? ''), String(req.query.doctor_code ?? '').split(',').filter(Boolean)))); } catch (e) { next(e); }
});
queueRouter.get('/display', async (req, res, next) => {
  try { res.json(await getDisplayData(String(req.query.location_id ?? ''), String(req.query.room_id ?? ''), String(req.query.doctor_code ?? ''))); } catch (e) { next(e); }
});
queueRouter.get('/display-multi', async (req, res, next) => {
  try { res.json(await getMultiDisplayData([...new Set(String(req.query.room_ids ?? '').split(',').map(Number).filter(Boolean))])); } catch (e) { next(e); }
});
queueRouter.get('/display-room-list', async (req, res, next) => {
  try { res.json(await getRoomListDisplayData([...new Set(String(req.query.room_ids ?? '').split(',').map(Number).filter(Boolean))], Number(req.query.limit || 6))); } catch (e) { next(e); }
});
queueRouter.get('/location-configs', async (_req, res, next) => {
  try { res.json(ok(await LocationConfig.listLocationConfigs())); } catch (e) { next(e); }
});
queueRouter.get('/location-configs/voice-types', (_req, res) => res.json(ok(LocationConfig.voiceTypes)));
queueRouter.get('/location-configs/:locationId/google-audio', async (req, res, next) => {
  try { res.json(ok(await googleGeneratedStatus(req.params.locationId))); } catch (e) { next(e); }
});
queueRouter.post('/location-configs/:locationId/google-audio/generate', async (req, res, next) => {
  try { res.json(ok(await generateGoogleAudio(req.params.locationId, String(req.body.room_label || 'ห้องตรวจ')))); } catch (e) { next(e); }
});
queueRouter.get('/location-configs/:locationId/google-audio/digits', async (req, res, next) => {
  try { res.json(ok(await googleDigitPrewarmStatus(req.params.locationId, req.query.mode === 'number' ? 'number' : 'digits'))); } catch (e) { next(e); }
});
queueRouter.post('/location-configs/:locationId/google-audio/digits/start', async (req, res, next) => {
  try { res.json(ok(await startGoogleDigitPrewarm(req.params.locationId, req.body.mode === 'number' ? 'number' : 'digits'))); } catch (e) { next(e); }
});
queueRouter.post('/location-configs/:locationId/google-audio/digits/stop', async (req, res, next) => {
  try { res.json(ok(await stopGoogleDigitPrewarm(req.params.locationId, req.body.mode === 'number' ? 'number' : 'digits'))); } catch (e) { next(e); }
});
queueRouter.get('/queue-color-defaults', async (_req, res, next) => {
  try { res.json(ok(await ColorDefaults.getQueueColorDefaults())); } catch (e) { next(e); }
});
queueRouter.put('/queue-color-defaults', async (req, res, next) => {
  try { res.json(ok(await ColorDefaults.updateQueueColorDefaults(req.body))); } catch (e) { next(e); }
});
queueRouter.get('/display-devices/:deviceId/preview', async (req, res, next) => {
  try {
    const device = await LocationConfig.getDevice(req.params.deviceId);
    if (!device) return res.status(404).json({ status: 'error', message: 'Display device not found' });
    res.json(ok(device));
  } catch (e) { next(e); }
});
queueRouter.get('/display-devices/:deviceId/preview-data', async (req, res, next) => {
  try {
    const device = await LocationConfig.getDevice(req.params.deviceId);
    if (!device) return res.status(404).json({ status: 'error', message: 'Display device not found' });
    res.json(await displayDataForDevice(device));
  } catch (e) { next(e); }
});
queueRouter.get('/display-devices/preview-sandbox', async (req, res, next) => {
  try {
    const deviceType = LocationConfig.normalizeDeviceType(req.query.device_type);
    const roomIds = String(req.query.room_ids || '').split(',').map(id => id.trim()).filter(Boolean);
    if (!roomIds.length) return res.status(400).json({ status: 'error', message: 'กรุณาเลือกห้องอย่างน้อย 1 ห้อง' });
    res.json(await displayDataForDevice({
      device_type: deviceType,
      room_ids: roomIds,
      settings: {
        queue_limit: Number(req.query.queue_limit || 6),
        show_multiple_queues: req.query.show_multiple_queues === '1',
      },
    }));
  } catch (e) { next(e); }
});
queueRouter.get('/audio-files', async (req, res, next) => {
  try { res.json(ok(await Audio.listAudioFiles(req.query.destination === '1'))); } catch (e) { next(e); }
});
queueRouter.get('/display-updates', async (req, res, next) => {
  try {
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const protocol = forwardedProto || req.protocol;
    const baseUrl = `${protocol}://${req.get('host')}/uploads/display-updates`;
    const installers = await DisplayUpdate.listDisplayInstallers();
    res.json(ok(installers.map(item => ({
      ...item,
      download_url: `${baseUrl}/${encodeURIComponent(item.filename)}`,
    }))));
  } catch (e) { next(e); }
});
queueRouter.post('/display-updates', updateUpload.single('installer'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ status: 'error', message: 'กรุณาเลือกไฟล์ installer .exe' });
    const saved = await DisplayUpdate.saveDisplayInstaller(req.file.path, String(req.body.version || ''));
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const protocol = forwardedProto || req.protocol;
    const downloadUrl = `${protocol}://${req.get('host')}/uploads/display-updates/${encodeURIComponent(saved.filename)}`;
    res.json(ok({ ...saved, download_url: downloadUrl }));
  } catch (e) {
    if (req.file?.path) await import('fs/promises').then(fs => fs.rm(req.file!.path, { force: true })).catch(() => undefined);
    next(e);
  }
});
queueRouter.post('/audio-files', audioUpload.single('audio_file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ status: 'error', message: 'Missing audio_file' });
    const detected = await Audio.detectAudioFile(req.file.path);
    if (!detected) {
      const fs = await import('fs/promises');
      await fs.rm(req.file.path, { force: true });
      return res.status(400).json({ status: 'error', message: 'Unsupported audio type' });
    }
    res.json(ok(await Audio.addAudioFile({
      tempPath: req.file.path,
      originalName: req.file.originalname,
      key: req.body.key,
      label: req.body.label,
      isDestination: req.body.is_destination === 'true' || req.body.is_destination === '1',
      replaceSystem: req.body.replace_system === 'true' || req.body.replace_system === '1',
      ext: detected.ext,
    })));
  } catch (e) { next(e); }
});
queueRouter.put('/audio-files', async (req, res, next) => {
  try { res.json(ok(await Audio.updateAudioFiles(req.body.items ?? []))); } catch (e) { next(e); }
});
queueRouter.delete('/audio-files/:file', async (req, res, next) => {
  try { res.json(ok(await Audio.deleteAudioFile(req.params.file))); } catch (e) { next(e); }
});
queueRouter.put('/location-configs/:locationId', async (req, res, next) => {
  try { res.json(ok(await LocationConfig.updateLocationConfig(req.params.locationId, req.body))); } catch (e) { next(e); }
});
queueRouter.post('/location-configs/:locationId/devices', async (req, res, next) => {
  try { res.json(ok(await LocationConfig.createDisplayDevice(req.params.locationId, req.body))); } catch (e) { next(e); }
});
queueRouter.put('/display-devices/:deviceId', async (req, res, next) => {
  try { res.json(ok(await LocationConfig.updateDisplayDevice(req.params.deviceId, req.body))); } catch (e) { next(e); }
});
queueRouter.post('/display-devices/:deviceId/setup-code', async (req, res, next) => {
  try {
    const result = await LocationConfig.createDisplaySetupCode(req.params.deviceId);
    if (!result) return res.status(404).json({ status: 'error', message: 'Display device not found' });
    res.json(ok(result));
  } catch (e) { next(e); }
});
queueRouter.post('/display-devices/:deviceId/rotate-token', async (req, res, next) => {
  try { res.json(ok(await LocationConfig.rotateDisplayDeviceToken(req.params.deviceId))); } catch (e) { next(e); }
});
queueRouter.delete('/display-devices/:deviceId', async (req, res, next) => {
  try { res.json(ok(await LocationConfig.deleteDisplayDevice(req.params.deviceId))); } catch (e) { next(e); }
});

async function displayDataForDevice(device: any) {
  const roomIds = [...new Set<number>((device.room_ids || []).map(Number).filter(Boolean))];
  if (device.device_type === 'room-list') {
    return getRoomListDisplayData(roomIds, Number(device.settings?.queue_limit || 6), device.device_type);
  }
  if (device.device_type === 'room-grid' && device.settings?.show_multiple_queues) {
    const [gridData, listData] = await Promise.all([
      getMultiDisplayData(roomIds, device.device_type),
      getRoomListDisplayData(roomIds, Number(device.settings?.queue_limit || 6), device.device_type),
    ]);
    const listByRoom = new Map((listData.rooms_data || []).map((room: any) => [String(room.room_id), room]));
    return {
      ...gridData,
      rooms_data: (gridData.rooms_data || []).map((room: any) => ({
        ...room,
        queues: (listByRoom.get(String(room.room_id)) as any)?.queues || [],
        next_queue_slot: (listByRoom.get(String(room.room_id)) as any)?.next_queue_slot || 0,
      })),
      limit: listData.limit,
    };
  }
  return getMultiDisplayData(roomIds, device.device_type);
}
queueRouter.post('/media', upload.single('media_file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ status: 'error', message: 'Missing media_file' });
    const fs = await import('fs/promises');
    const path = await import('path');
    const detected = await Media.detectImageFile(req.file.path);
    if (!detected) {
      await fs.rm(req.file.path, { force: true });
      return res.status(400).json({ status: 'error', message: 'Unsupported image type' });
    }
    const finalName = `${req.file.filename}.${detected.ext}`;
    await fs.rename(req.file.path, path.join(Media.getUploadDir(), finalName));
    res.json({ status: 'success', data: await Media.addMedia({ file: finalName, type: 'image', label: req.body.label || req.file.originalname, duration: Math.max(3, Number(req.body.duration || 10)), enabled: req.body.enabled === 'false' ? 0 : 1 }) });
  } catch (e) { next(e); }
});
queueRouter.post('/media/youtube', async (req, res, next) => {
  try {
    res.json({ status: 'success', data: await Media.addYoutubeMedia({ url: req.body.url, label: req.body.label, duration: Number(req.body.duration || 30), enabled: req.body.enabled !== false }) });
  } catch (e) { next(e); }
});
queueRouter.put('/media', async (req, res, next) => { try { res.json({ status: 'success', data: await Media.updateMedia(req.body.items ?? []) }); } catch (e) { next(e); } });
queueRouter.put('/media/location/:locationId', async (req, res, next) => {
  try { res.json({ status: 'success', data: await Media.setLocationMedia(req.params.locationId, req.body.files ?? []) }); } catch (e) { next(e); }
});
queueRouter.put('/media/:file/locations', async (req, res, next) => {
  try { res.json({ status: 'success', data: await Media.setMediaLocations(req.params.file, req.body.location_ids ?? []) }); } catch (e) { next(e); }
});
queueRouter.post('/media/:file/toggle', async (req, res, next) => { try { res.json({ status: 'success', data: await Media.toggleMedia(req.params.file) }); } catch (e) { next(e); } });
queueRouter.delete('/media/:file', async (req, res, next) => { try { res.json({ status: 'success', data: await Media.deleteMedia(req.params.file) }); } catch (e) { next(e); } });
queueRouter.post('/call', async (req, res, next) => {
  try {
    const result = await Queue.logQueueCall({ slotId: String(req.body.slot_id), roomId: String(req.body.room_id), status: 'N' });
    let auditCallId = '';
    try {
      auditCallId = await logQueueAction({ action: 'call', slotId: String(req.body.slot_id), detail: result.detail, room: result.room, user: req.session.user, ip: req.ip });
    } catch (err) {
      console.warn('Queue call log failed:', err);
    }
    wsHub.broadcastQueueChanged({
      action: 'call',
      callId: auditCallId || result.callId,
      activeCallId: result.callId,
      callDatetime: result.callDatetime.toISOString(),
      slotId: req.body.slot_id,
      roomId: req.body.room_id,
      locationId: result.room?.opd_qs_location_id,
      queueNo: result.detail?.queue_slot_number,
      oqueue: result.detail?.oqueue,
      roomNumber: result.room?.opd_qs_room_number,
    });
    res.json({ status: 'success' });
  } catch (e) { next(e); }
});
queueRouter.post('/hold', async (req, res, next) => {
  try {
    const slot = String(req.body.slot_id);
    const rows = await Queue.getQueues(String(req.body.location_id ?? ''), []);
    const found: any = rows.find((q: any) => String(q.opd_qs_slot_id) === slot);
    const current = await Queue.getCurrentQueueCall(slot);
    const roomId = String(current?.room_id ?? req.body.room_id ?? found?.opd_qs_room_id ?? '');
    if (!roomId) return res.status(400).json({ status: 'error', message: 'ไม่พบห้องที่เรียกคิวนี้' });
    const result = await Queue.logQueueCall({ slotId: slot, roomId, status: 'W' });
    logQueueAction({ action: 'hold', slotId: slot, detail: result.detail, room: result.room, user: req.session.user, ip: req.ip }).catch(err => console.warn('Queue hold log failed:', err));
    wsHub.broadcastQueueChanged({ action: 'hold', slotId: slot, roomId, locationId: result.room?.opd_qs_location_id });
    res.json({ status: 'success' });
  } catch (e) { next(e); }
});
queueRouter.post('/pharmacy', async (req, res, next) => {
  try {
    const slot = String(req.body.slot_id);
    const rows = await Queue.getQueues(String(req.body.location_id ?? ''), []);
    const found: any = rows.find((q: any) => String(q.opd_qs_slot_id) === slot);
    const current = await Queue.getCurrentQueueCall(slot);
    const roomId = String(current?.room_id ?? req.body.room_id ?? found?.opd_qs_room_id ?? '');
    if (!roomId) return res.status(400).json({ status: 'error', message: 'ไม่พบห้องที่เรียกคิวนี้' });
    const result = await Queue.logQueueCall({ slotId: slot, roomId, status: 'P' });
    logQueueAction({ action: 'pharmacy', slotId: slot, detail: result.detail, room: result.room, user: req.session.user, ip: req.ip }).catch(err => console.warn('Queue pharmacy log failed:', err));
    wsHub.broadcastQueueChanged({ action: 'pharmacy', slotId: slot, roomId, locationId: result.room?.opd_qs_location_id });
    res.json({ status: 'success' });
  } catch (e) { next(e); }
});
queueRouter.post('/resume', async (req, res, next) => {
  try {
    const slot = String(req.body.slot_id);
    const current = await Queue.getCurrentQueueCall(slot);
    if (!current || current.call_status !== 'P') {
      return res.status(409).json({ status: 'error', message: 'คิวนี้ไม่ได้อยู่ในสถานะพักคิว' });
    }
    const resumed = await Queue.cancelQueue(slot);
    const roomId = resumed?.room_id ?? req.body.room_id;
    const locationId = resumed?.location_id ?? req.body.location_id;
    logQueueAction({ action: 'resume', slotId: slot, room: { room_id: roomId }, user: req.session.user, ip: req.ip })
      .catch(err => console.warn('Queue resume log failed:', err));
    wsHub.broadcastQueueChanged({ action: 'resume', slotId: slot, roomId, locationId, queueNo: resumed?.queue_no });
    res.json({ status: 'success' });
  } catch (e) { next(e); }
});
queueRouter.post('/cancel', async (req, res, next) => {
  try {
    const canceled = await Queue.cancelQueue(String(req.body.slot_id));
    const roomId = canceled?.room_id ?? req.body.room_id;
    const locationId = canceled?.location_id ?? req.body.location_id;
    logQueueAction({ action: 'cancel', slotId: String(req.body.slot_id), room: { room_id: roomId }, user: req.session.user, ip: req.ip }).catch(err => console.warn('Queue cancel log failed:', err));
    wsHub.broadcastQueueChanged({ action: 'cancel', slotId: req.body.slot_id, roomId, locationId, queueNo: canceled?.queue_no });
    res.json({ status: 'success' });
  } catch (e) { next(e); }
});
