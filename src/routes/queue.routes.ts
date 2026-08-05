import { Router } from 'express';
import multer from 'multer';
import * as Queue from '../models/queue.model.js';
import { getDisplayData, getMultiDisplayData } from '../models/display.model.js';
import { checkQueue } from '../models/check.model.js';
import * as Media from '../models/media.model.js';
import * as Audio from '../models/audio.model.js';
import * as LocationConfig from '../models/location-config.model.js';
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

queueRouter.get('/locations', async (_req, res, next) => { try { res.json(ok(await Queue.getLocations())); } catch (e) { next(e); } });
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
queueRouter.get('/check-queue', async (req, res, next) => {
  try { res.json(await checkQueue(String(req.query.q ?? ''))); } catch (e) { next(e); }
});
queueRouter.get('/media', async (req, res, next) => {
  try { res.json({ status: 'success', data: await Media.listMedia(String(req.query.location_id ?? ''), req.query.manage === '1') }); } catch (e) { next(e); }
});
queueRouter.get('/location-configs', async (_req, res, next) => {
  try { res.json(ok(await LocationConfig.listLocationConfigs())); } catch (e) { next(e); }
});
queueRouter.get('/location-configs/voice-types', (_req, res) => res.json(ok(LocationConfig.voiceTypes)));
queueRouter.get('/display-devices/resolve', async (req, res, next) => {
  try {
    const device = await LocationConfig.resolveDisplayDevice(String(req.query.token || ''), req.ip);
    if (!device) return res.status(404).json({ ok: false, error: 'Display device not found' });
    res.json(ok(device));
  } catch (e) { next(e); }
});
queueRouter.get('/display-devices/display', async (req, res, next) => {
  try {
    const device = await LocationConfig.resolveDisplayDevice(String(req.query.token || ''), req.ip);
    if (!device) return res.status(404).json({ ok: false, error: 'Display device not found' });
    const roomIds = (device.room_ids || []).map(Number).filter(Boolean);
    if (device.device_type === 'single') {
      return res.json(await getDisplayData(String(device.location_id), String(roomIds[0] || ''), ''));
    }
    res.json(await getMultiDisplayData([...new Set<number>(roomIds)]));
  } catch (e) { next(e); }
});
queueRouter.get('/audio-files', async (_req, res, next) => {
  try { res.json(ok(await Audio.listAudioFiles())); } catch (e) { next(e); }
});
queueRouter.post('/audio-files', audioUpload.single('audio_file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ status: 'error', message: 'Missing audio_file' });
    res.json(ok(await Audio.addAudioFile({ tempPath: req.file.path, originalName: req.file.originalname, key: req.body.key, label: req.body.label })));
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
    const ext = (req.file.originalname.split('.').pop() || 'png').toLowerCase();
    const finalName = `${req.file.filename}.${ext}`;
    const fs = await import('fs/promises');
    const path = await import('path');
    await fs.rename(req.file.path, path.join(Media.getUploadDir(), finalName));
    res.json({ status: 'success', data: await Media.addMedia({ file: finalName, label: req.body.label || req.file.originalname, duration: Math.max(3, Number(req.body.duration || 10)), enabled: req.body.enabled === 'false' ? 0 : 1 }) });
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
    wsHub.broadcastQueueChanged({ action: 'call', slotId: req.body.slot_id, roomId: req.body.room_id, locationId: result.room?.opd_qs_location_id });
    res.json({ status: 'success' });
  } catch (e) { next(e); }
});
queueRouter.post('/hold', async (req, res, next) => {
  try {
    const slot = String(req.body.slot_id);
    const rows = await Queue.getQueues(String(req.body.location_id ?? ''), []);
    const found: any = rows.find((q: any) => String(q.opd_qs_slot_id) === slot);
    const result = await Queue.logQueueCall({ slotId: slot, roomId: String(req.body.room_id ?? found?.opd_qs_room_id ?? ''), status: 'W' });
    wsHub.broadcastQueueChanged({ action: 'hold', slotId: slot, roomId: req.body.room_id ?? found?.opd_qs_room_id, locationId: result.room?.opd_qs_location_id });
    res.json({ status: 'success' });
  } catch (e) { next(e); }
});
queueRouter.post('/cancel', async (req, res, next) => {
  try {
    await Queue.cancelQueue(String(req.body.slot_id));
    wsHub.broadcastQueueChanged({ action: 'cancel', slotId: req.body.slot_id, roomId: req.body.room_id, locationId: req.body.location_id });
    res.json({ status: 'success' });
  } catch (e) { next(e); }
});
