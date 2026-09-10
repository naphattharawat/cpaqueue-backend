import { Router } from 'express';
import { cpaDb } from '../db.js';

export const ttsRouter = Router();

type TtsProvider = 'google' | 'recorded';

const provider = (): TtsProvider => (process.env.TTS_PROVIDER === 'recorded' ? 'recorded' : 'google');
const audioBaseUrl = () => process.env.RECORDED_AUDIO_BASE_URL || '/assets/audio';
const audioExt = () => (process.env.RECORDED_AUDIO_EXT || 'mp3').replace(/^\./, '');
const defaultRoomType = () => process.env.TTS_ROOM_TYPE_DEFAULT || 'doctor_room';
const recordedSuffixToken = () => process.env.RECORDED_AUDIO_SUFFIX_TOKEN || 'ka';

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
    if (!queue) return res.status(400).send('No queue provided');

    const text = buildCallText(queue, roomType, room, roomLabel);
    if (activeProvider === 'recorded') {
      return res.json({
        provider: 'recorded',
        text,
        voice_rate: voiceRate,
        number_mode: numberMode,
        files: buildRecordedFiles(queue, roomType, room, numberMode),
      });
    }

    await streamGoogleTts(text, res, voiceRate);
  } catch (e) { next(e); }
});

ttsRouter.get('/', async (req, res, next) => {
  try {
    const text = String(req.query.text ?? '').trim().slice(0, 500);
    if (!text) return res.status(400).send('No text provided');
    await streamGoogleTts(text, res);
  } catch (e) { next(e); }
});

function buildCallText(queue: string, roomType: string, room: string, roomLabelOverride = '') {
  const qSpelled = queue.split('').join(' ');
  const roomLabel = roomLabelOverride || roomTypeText[roomType] || roomTypeText.doctor_room;
  return `${roomTypeText.please} ${qSpelled} ${roomLabel}${room ? ` ${room}` : ''} ค่ะ`;
}

function buildRecordedFiles(queue: string, roomType: string, room: string, numberMode: 'digits' | 'number') {
  const suffix = recordedSuffixToken();
  const tokens = ['please', ...splitAudioTokens(queue, numberMode), roomType, ...splitAudioTokens(room, numberMode), suffix === 'silent' ? '' : suffix];
  return tokens.filter(Boolean).map(token => audioUrl(token));
}

function splitAudioTokens(value: string, mode: 'digits' | 'number') {
  const compact = value.replace(/\s+/g, '');
  if (mode === 'digits') return compact.split('').filter(Boolean).map(token => token.toLowerCase());
  return (compact.match(/\d+|[^\d]/g) || []).flatMap(token => /^\d+$/.test(token) ? thaiNumberTokens(token) : [token.toLowerCase()]);
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

async function streamGoogleTts(text: string, res: any, voiceRate = 1) {
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=th&q=${encodeURIComponent(text.slice(0, 500))}`;
  const upstream = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://translate.google.com/' } });
  if (!upstream.ok) return res.status(502).send('TTS service unavailable');
  const buffer = Buffer.from(await upstream.arrayBuffer());
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Voice-Rate', String(voiceRate));
  res.send(buffer);
}

async function getLocationVoiceConfig(locationId: string) {
  const row = await cpaDb('service_location_config')
    .select('tts_provider', 'recorded_room_type', 'voice_rate', 'settings_json')
    .where({ location_id: locationId })
    .first();
  if (!row) return null;
  const settings = parseSettings(row.settings_json);
  return {
    ...row,
    google_room_label: settings.google_room_label || '',
    recorded_number_mode: normalizeNumberMode(settings.recorded_number_mode),
  };
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
