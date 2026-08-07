import { Router } from 'express';
import multer from 'multer';
import { dashboardSummary, logQueueAction } from '../models/audit.model.js';
import * as Queue from '../models/queue.model.js';
import { getDisplayData, getMultiDisplayData, getRoomListDisplayData } from '../models/display.model.js';
import { checkQueue } from '../models/check.model.js';
import * as Media from '../models/media.model.js';
import * as Audio from '../models/audio.model.js';
import * as LocationConfig from '../models/location-config.model.js';
import { requireAdmin, requireAuth } from '../middleware/auth.middleware.js';
import { rateLimit } from '../security.js';
import { wsHub } from '../wsHub.js';

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
queueRouter.get('/display-devices/display', rateLimit({ keyPrefix: 'display-device-display', windowMs: 60_000, max: 180 }), async (req, res, next) => {
  try {
    const device = await LocationConfig.resolveDisplayDevice(String(req.query.token || ''), req.ip);
    if (!device) return res.status(404).json({ ok: false, error: 'Display device not found' });
    const roomIds = (device.room_ids || []).map(Number).filter(Boolean);
    if (device.device_type === 'single') {
      return res.json(await getDisplayData(String(device.location_id), String(roomIds[0] || ''), ''));
    }
    if (device.device_type === 'room-list') {
      return res.json(await getRoomListDisplayData([...new Set<number>(roomIds)], Number(device.settings?.queue_limit || 6)));
    }
    res.json(await getMultiDisplayData([...new Set<number>(roomIds)]));
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

queueRouter.use(['/media', '/media/*', '/location-configs', '/location-configs/*', '/audio-files', '/audio-files/*', '/display-devices/*'], requireAdmin);
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
queueRouter.get('/audio-files', async (_req, res, next) => {
  try { res.json(ok(await Audio.listAudioFiles())); } catch (e) { next(e); }
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
    res.json(ok(await Audio.addAudioFile({ tempPath: req.file.path, originalName: req.file.originalname, key: req.body.key, label: req.body.label, ext: detected.ext })));
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
queueRouter.post('/display-devices/:deviceId/rotate-token', async (req, res, next) => {
  try { res.json(ok(await LocationConfig.rotateDisplayDeviceToken(req.params.deviceId))); } catch (e) { next(e); }
});
queueRouter.delete('/display-devices/:deviceId', async (req, res, next) => {
  try { res.json(ok(await LocationConfig.deleteDisplayDevice(req.params.deviceId))); } catch (e) { next(e); }
});
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
    logQueueAction({ action: 'call', slotId: String(req.body.slot_id), detail: result.detail, room: result.room, user: req.session.user, ip: req.ip }).catch(err => console.warn('Queue call log failed:', err));
    wsHub.broadcastQueueChanged({
      action: 'call',
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
    const result = await Queue.logQueueCall({ slotId: slot, roomId: String(req.body.room_id ?? found?.opd_qs_room_id ?? ''), status: 'W' });
    logQueueAction({ action: 'hold', slotId: slot, detail: result.detail, room: result.room, user: req.session.user, ip: req.ip }).catch(err => console.warn('Queue hold log failed:', err));
    wsHub.broadcastQueueChanged({ action: 'hold', slotId: slot, roomId: req.body.room_id ?? found?.opd_qs_room_id, locationId: result.room?.opd_qs_location_id });
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
