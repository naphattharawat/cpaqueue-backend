import { Router } from 'express';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { cpaDb } from '../db.js';

export const ttsRouter = Router();

type TtsProvider = 'google' | 'recorded';

const provider = (): TtsProvider => (process.env.TTS_PROVIDER === 'recorded' ? 'recorded' : 'google');
const audioBaseUrl = () => process.env.RECORDED_AUDIO_BASE_URL || '/assets/audio';
const audioExt = () => (process.env.RECORDED_AUDIO_EXT || 'mp3').replace(/^\./, '');
const defaultRoomType = () => process.env.TTS_ROOM_TYPE_DEFAULT || 'doctor_room';
const recordedSuffixToken = () => process.env.RECORDED_AUDIO_SUFFIX_TOKEN || 'ka';
const assetsDir = process.env.ASSETS_DIR ? path.resolve(process.env.ASSETS_DIR) : path.resolve(process.cwd(), '../assets');
const generatedRoot = path.join(assetsDir, 'audio', 'generated', 'google');
const numberSequenceJobs = new Map<string, Promise<string>>();
const numberPrewarmJobs = new Map<string, NumberPrewarmState>();
const DIGIT_PREWARM_TOTAL = 9999;
type NumberMode = 'digits' | 'number';
type NumberPrewarmState = {
  scope: 'global';
  mode: NumberMode;
  running: boolean;
  stopRequested: boolean;
  total: number;
  completed: number;
  generated: number;
  skipped: number;
  failed: number;
  current: number;
  started_at: string;
  finished_at: string;
  last_error: string;
};
const generatedTokenText: Record<string, string> = {
  please: 'เชิญหมายเลข', ka: 'ค่ะ',
  '0': 'ศูนย์', '1': 'หนึ่ง', '2': 'สอง', '3': 'สาม', '4': 'สี่',
  '5': 'ห้า', '6': 'หก', '7': 'เจ็ด', '8': 'แปด', '9': 'เก้า',
  '10': 'สิบ', '11': 'เอ็ด', '20': 'ยี่สิบ', '100': 'ร้อย', '1000': 'พัน', '10000': 'หมื่น',
};

const roomTypeText: Record<string, string> = {
  cashier: 'ที่ห้องการเงิน',
  channel: 'ที่ช่องบริการ',
  couter: 'ที่เค้าเตอร์',
  counter: 'ที่เค้าเตอร์',
  doctor_room: 'ห้องตรวจ',
  'interview-point': 'จุดซักประวัติ',
  'interview-table': 'โต๊ะซักประวัติ',
  number: 'หมายเลข',
  'pay-cashier': 'ช่องจ่ายเงิน',
  'pay-drug': 'ช่องจ่ายยา',
  please: 'เชิญ หมายเลข',
  'receive-drug': 'ช่องรับยา',
  'screen-point': 'จุดคัดกรอง',
  'screen-table': 'โต๊ะคัดกรอง',
  table: 'โต๊ะ',
  silent: '',
};

ttsRouter.get('/mode', (_req, res) => {
  res.json({
    provider: provider(),
    audio_base_url: audioBaseUrl(),
    audio_ext: audioExt(),
    default_room_type: defaultRoomType(),
  });
});

ttsRouter.get('/call', async (req, res, next) => {
  try {
    const queue = String(req.query.queue ?? '').trim().slice(0, 30);
    const room = String(req.query.room ?? '').trim().slice(0, 30);
    const locationId = String(req.query.location_id ?? '').trim();
    const config = locationId ? await getLocationVoiceConfig(locationId) : null;
    const providerOverride = String(req.query.provider ?? '').trim();
    const activeProvider = providerOverride === 'recorded' || providerOverride === 'google'
      ? providerOverride
      : config?.tts_provider === 'recorded' ? 'recorded' : provider();
    const roomType = String(req.query.room_type ?? config?.recorded_room_type ?? defaultRoomType()).trim() || defaultRoomType();
    const roomLabel = String(req.query.room_label ?? config?.google_room_label ?? '').trim();
    const voiceRate = normalizeVoiceRate(req.query.voice_rate ?? config?.voice_rate ?? 1);
    const numberMode = normalizeNumberMode(req.query.number_mode ?? config?.recorded_number_mode);
    const repeatCount = normalizeRepeatCount(req.query.repeat_count ?? config?.call_repeat_count ?? 1);
    const googlePlaybackMode = req.query.playback_mode === 'generated' || req.query.playback_mode === 'online'
      ? req.query.playback_mode
      : config?.google_playback_mode || 'online';
    if (!queue) return res.status(400).send('No queue provided');

    const text = buildCallText(queue, roomType, room, roomLabel, numberMode, repeatCount);
    if (activeProvider === 'recorded') {
      return res.json({
        provider: 'recorded',
        text,
        voice_rate: voiceRate,
        number_mode: numberMode,
        files: buildRecordedFiles(queue, roomType, room, numberMode, repeatCount),
      });
    }

    if (googlePlaybackMode === 'generated' && locationId) {
      try {
        const files = await buildGeneratedFiles(locationId, queue, room, numberMode, repeatCount);
        if (await filesExist(files)) {
          return res.json({ provider: 'google-generated', text, voice_rate: voiceRate, number_mode: numberMode, files });
        }
      } catch (error) {
        console.warn(`Unable to cache number-sequence audio for location ${locationId}:`, error);
      }
    }
    try {
      await streamGoogleTts(text, res, voiceRate);
    } catch (error) {
      const fallbackRoomType = String(config?.recorded_room_type || defaultRoomType());
      const fallbackFiles = buildRecordedFiles(queue, fallbackRoomType, room, numberMode, repeatCount);
      if (await filesExist(fallbackFiles)) {
        return res.json({ provider: 'recorded-fallback', text, voice_rate: voiceRate, number_mode: numberMode, files: fallbackFiles });
      }
      throw error;
    }
  } catch (e) { next(e); }
});

ttsRouter.get('/', async (req, res, next) => {
  try {
    const text = String(req.query.text ?? '').trim().slice(0, 500);
    if (!text) return res.status(400).send('No text provided');
    await streamGoogleTts(text, res);
  } catch (e) { next(e); }
});

function buildCallText(queue: string, roomType: string, room: string, roomLabelOverride = '', numberMode: 'digits' | 'number' = 'digits', repeatCount = 1) {
  const qSpelled = ttsNumberText(queue, numberMode);
  const repeatedQueue = Array(repeatCount).fill(qSpelled).join(', ');
  const roomSpelled = ttsNumberText(room, numberMode);
  const roomLabel = roomLabelOverride || roomTypeText[roomType] || roomTypeText.doctor_room;
  return `${roomTypeText.please} ${repeatedQueue} ${roomLabel}${roomSpelled ? ` ${roomSpelled}` : ''} ค่ะ`;
}

function ttsNumberText(value: string, mode: 'digits' | 'number') {
  const compact = String(value || '').replace(/\s+/g, '');
  if (mode === 'number') return compact;
  return compact.split('').join(' ');
}

function buildRecordedFiles(queue: string, roomType: string, room: string, numberMode: 'digits' | 'number', repeatCount = 1) {
  const suffix = recordedSuffixToken();
  const queueTokens = splitAudioTokens(queue, numberMode);
  const tokens = ['please', ...repeatAudioTokens(queueTokens, repeatCount), roomType, ...splitAudioTokens(room, numberMode), suffix === 'silent' ? '' : suffix];
  return tokens.filter(Boolean).map(token => audioUrl(token));
}

function splitAudioTokens(value: string, mode: 'digits' | 'number') {
  const compact = value.replace(/\s+/g, '');
  if (mode === 'digits') return compact.split('').filter(Boolean).map(token => token.toLowerCase());
  return (compact.match(/\d+|[^\d]/g) || []).flatMap(token => /^\d+$/.test(token) ? thaiNumberTokens(token) : [token.toLowerCase()]);
}

function repeatAudioTokens(tokens: string[], repeatCount: number) {
  const repeated: string[] = [];
  for (let index = 0; index < repeatCount; index += 1) {
    repeated.push(...tokens);
    if (index < repeatCount - 1) repeated.push('silent');
  }
  return repeated;
}

function thaiNumberTokens(value: string) {
  const normalized = value.replace(/^0+(?=\d)/, '');
  if (!normalized || normalized === '0') return ['0'];
  if (normalized.length > 5) return value.split('');
  const number = Number(normalized);
  const tokens: string[] = [];
  const places = [10000, 1000, 100, 10, 1];
  let remaining = number;
  for (const place of places) {
    const digit = Math.floor(remaining / place);
    remaining %= place;
    if (!digit) continue;
    if (place === 10) {
      if (digit === 1) tokens.push('10');
      else if (digit === 2) tokens.push('20');
      else tokens.push(String(digit), '10');
    } else if (place === 1) {
      tokens.push(digit === 1 && number >= 10 ? '11' : String(digit));
    } else {
      tokens.push(String(digit), String(place));
    }
  }
  return tokens;
}

function audioUrl(token: string) {
  return `${audioBaseUrl()}/${encodeURIComponent(token)}.${audioExt()}`;
}

function generatedLocationKey(locationId: string) {
  return `location-${String(locationId).replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

function generatedUrl(locationId: string, token: string) {
  return `/assets/audio/generated/google/${generatedLocationKey(locationId)}/${encodeURIComponent(token)}.mp3`;
}

async function buildGeneratedFiles(locationId: string, queue: string, room: string, numberMode: 'digits' | 'number', repeatCount = 1) {
  const queueFiles = [await ensureGeneratedNumberSequence(queue, numberMode)];
  const repeatedQueueFiles: string[] = [];
  for (let index = 0; index < repeatCount; index += 1) {
    repeatedQueueFiles.push(...queueFiles);
    if (index < repeatCount - 1) repeatedQueueFiles.push(audioUrl('silent'));
  }
  return [
    generatedUrl(locationId, 'please'),
    ...repeatedQueueFiles,
    generatedUrl(locationId, 'destination'),
    ...splitAudioTokens(room, numberMode).map(token => generatedUrl(locationId, token)),
    generatedUrl(locationId, 'ka'),
  ];
}

async function ensureGeneratedNumberSequence(queue: string, mode: NumberMode) {
  const compact = String(queue || '').replace(/\s+/g, '');
  const fileName = /^\d{1,4}$/.test(compact)
    ? `n-${compact}.mp3`
    : `q-${crypto.createHash('sha256').update(compact).digest('hex')}.mp3`;
  const folder = numberModeFolder(mode);
  const relativeUrl = `/assets/audio/generated/google/shared/${folder}/${fileName}`;
  const target = path.join(generatedRoot, 'shared', folder, fileName);
  if (await fs.stat(target).then(stat => stat.isFile()).catch(() => false)) return relativeUrl;

  const jobKey = `${mode}:${fileName}`;
  let job = numberSequenceJobs.get(jobKey);
  if (!job) {
    job = (async () => {
      await fs.mkdir(path.dirname(target), { recursive: true });
      const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
      try {
        await fs.writeFile(temp, await fetchGoogleTts(ttsNumberText(compact, mode)));
        await fs.rename(temp, target);
      } finally {
        await fs.rm(temp, { force: true }).catch(() => undefined);
      }
      return relativeUrl;
    })().finally(() => numberSequenceJobs.delete(jobKey));
    numberSequenceJobs.set(jobKey, job);
  }
  return job;
}

export async function googleDigitPrewarmStatus(_locationId: string, mode: NumberMode = 'digits') {
  const jobKey = prewarmJobKey(mode);
  const active = numberPrewarmJobs.get(jobKey);
  if (active) return { ...active };
  const completed = await countGeneratedNumberSequences(mode);
  return {
    scope: 'global',
    mode,
    running: false,
    stopRequested: false,
    total: DIGIT_PREWARM_TOTAL,
    completed,
    generated: 0,
    skipped: completed,
    failed: 0,
    current: 0,
    started_at: '',
    finished_at: '',
    last_error: '',
  };
}

export async function startGoogleDigitPrewarm(_locationId: string, mode: NumberMode = 'digits') {
  const jobKey = prewarmJobKey(mode);
  const existing = numberPrewarmJobs.get(jobKey);
  if (existing?.running) return { ...existing };
  const completed = await countGeneratedNumberSequences(mode);
  const state: NumberPrewarmState = {
    scope: 'global',
    mode,
    running: true,
    stopRequested: false,
    total: DIGIT_PREWARM_TOTAL,
    completed,
    generated: 0,
    skipped: completed,
    failed: 0,
    current: 0,
    started_at: new Date().toISOString(),
    finished_at: '',
    last_error: '',
  };
  numberPrewarmJobs.set(jobKey, state);
  void runDigitPrewarm(state);
  return { ...state };
}

export async function stopGoogleDigitPrewarm(locationId: string, mode: NumberMode = 'digits') {
  const state = numberPrewarmJobs.get(prewarmJobKey(mode));
  if (state) state.stopRequested = true;
  return googleDigitPrewarmStatus(locationId, mode);
}

async function runDigitPrewarm(state: NumberPrewarmState) {
  let consecutiveFailures = 0;
  try {
    for (let number = 1; number <= DIGIT_PREWARM_TOTAL; number += 1) {
      if (state.stopRequested) break;
      state.current = number;
      const target = numberSequencePath(String(number), state.mode);
      if (await fs.stat(target).then(stat => stat.isFile()).catch(() => false)) continue;
      try {
        await ensureGeneratedNumberSequence(String(number), state.mode);
        state.generated += 1;
        state.completed += 1;
        consecutiveFailures = 0;
        await delay(150);
      } catch (error) {
        state.failed += 1;
        consecutiveFailures += 1;
        state.last_error = error instanceof Error ? error.message : String(error);
        if (consecutiveFailures >= 10) break;
        await delay(5000);
      }
    }
  } finally {
    state.running = false;
    state.finished_at = new Date().toISOString();
    state.current = 0;
  }
}

function numberModeFolder(mode: NumberMode) {
  return mode === 'number' ? 'numbers' : 'digits';
}

function prewarmJobKey(mode: NumberMode) {
  return mode;
}

function numberSequencePath(queue: string, mode: NumberMode) {
  return path.join(generatedRoot, 'shared', numberModeFolder(mode), `n-${queue}.mp3`);
}

async function countGeneratedNumberSequences(mode: NumberMode) {
  const dir = path.join(generatedRoot, 'shared', numberModeFolder(mode));
  const files = await fs.readdir(dir).catch((): string[] => []);
  return files.filter(file => /^n-(?:[1-9]\d{0,3})\.mp3$/.test(file) && Number(file.slice(2, -4)) <= DIGIT_PREWARM_TOTAL).length;
}

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function filesExist(urls: string[]) {
  return (await Promise.all(urls.map(async url => {
    if (!url.startsWith('/assets/')) return false;
    const relative = decodeURIComponent(url.replace(/^\/assets\//, ''));
    return fs.stat(path.join(assetsDir, relative)).then(stat => stat.isFile()).catch(() => false);
  }))).every(Boolean);
}

export async function googleGeneratedStatus(locationId: string) {
  const config = await getLocationVoiceConfig(locationId);
  const dir = path.join(generatedRoot, generatedLocationKey(locationId));
  const files: string[] = await fs.readdir(dir).catch((): string[] => []);
  const requiredFiles = [...Object.keys(generatedTokenText), 'destination', ...'abcdefghijklmnopqrstuvwxyz'].map(token => `${token}.mp3`);
  return {
    mode: config?.google_playback_mode || 'online',
    generated_at: config?.google_generated_at || '',
    file_count: files.filter(file => file.endsWith('.mp3')).length,
    ready: requiredFiles.every(file => files.includes(file)),
  };
}

export async function generateGoogleAudio(locationId: string, roomLabel: string) {
  const dir = path.join(generatedRoot, generatedLocationKey(locationId));
  const tempDir = `${dir}.tmp-${Date.now()}`;
  await fs.mkdir(tempDir, { recursive: true });
  const tokens: Record<string, string> = { ...generatedTokenText, destination: roomLabel || 'ห้องตรวจ' };
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') tokens[letter.toLowerCase()] = letter;
  try {
    for (const [token, text] of Object.entries(tokens)) {
      await fs.writeFile(path.join(tempDir, `${token}.mp3`), await fetchGoogleTts(text));
    }
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rename(tempDir, dir);
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true });
    throw error;
  }
  const row = await cpaDb('service_location_config').select('settings_json').where({ location_id: locationId }).first();
  const settings = parseSettings(row?.settings_json);
  const generatedAt = new Date().toISOString();
  const settingsJson = JSON.stringify({
    ...settings,
    google_room_label: roomLabel || 'ห้องตรวจ',
    google_playback_mode: 'generated',
    google_generated_at: generatedAt,
  });
  await cpaDb('service_location_config').insert({ location_id: locationId, settings_json: settingsJson })
    .onConflict('location_id').merge({ settings_json: settingsJson });
  return { ...(await googleGeneratedStatus(locationId)), generated_at: generatedAt };
}

async function streamGoogleTts(text: string, res: any, voiceRate = 1) {
  const buffer = await fetchGoogleTts(text);
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Voice-Rate', String(voiceRate));
  res.send(buffer);
}

async function fetchGoogleTts(text: string) {
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=th&q=${encodeURIComponent(text.slice(0, 500))}`;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const upstream = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://translate.google.com/' } });
    if (upstream.ok) return Buffer.from(await upstream.arrayBuffer());
    if (attempt < 3 && (upstream.status === 429 || upstream.status >= 500)) {
      await new Promise(resolve => setTimeout(resolve, attempt * 500));
      continue;
    }
    throw Object.assign(new Error('TTS service unavailable'), { status: 502 });
  }
  throw Object.assign(new Error('TTS service unavailable'), { status: 502 });
}

async function getLocationVoiceConfig(locationId: string) {
  const row = await cpaDb('service_location_config')
    .select('tts_provider', 'recorded_room_type', 'voice_rate', 'call_repeat_count', 'settings_json')
    .where({ location_id: locationId })
    .first();
  if (!row) return null;
  const settings = parseSettings(row.settings_json);
  return {
    ...row,
    google_room_label: settings.google_room_label || '',
    google_playback_mode: settings.google_playback_mode === 'generated' ? 'generated' : 'online',
    google_generated_at: settings.google_generated_at || '',
    recorded_number_mode: normalizeNumberMode(settings.recorded_number_mode),
  };
}

function normalizeRepeatCount(value: any) {
  const count = Math.round(Number(value));
  return Number.isFinite(count) ? Math.min(5, Math.max(1, count)) : 1;
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

function normalizeNumberMode(value: any): 'digits' | 'number' {
  return value === 'number' ? 'number' : 'digits';
}
