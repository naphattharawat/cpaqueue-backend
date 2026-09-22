import { cpaDb } from '../db.js';
import { normalizeQueueColors, normalizeQueueFontWeight, normalizeDisplayFontFamily } from './location-config.model.js';

const TABLE = 'queue_color_defaults';
const ROW_ID = 1;

// Seeded from the colors that were hardcoded as the "reset to default" values before this
// became configurable — so turning this feature on doesn't change anything until an admin
// actually edits the system defaults.
const SEED = {
  queue_colors: {
    theme: '#4899b2',
    active_text: '#7c2d12',
    active_border: '#f59e0b',
    active_text_stroke: '',
    active_pulse1: '',
    active_pulse2: '',
    previous_text: '#7c2d12',
    previous_border: '#f59e0b',
    previous_text_stroke: '',
    previous_bg: '',
    called_text: '#64748b',
    called_border: '#cbd5e1',
    called_text_stroke: '',
    called_bg: '',
    page_bg: '',
    text_stroke_width: 1,
  },
  queue_font_weight: '900',
  display_font_family: 'kanit',
};

let ensured: Promise<void> | null = null;
function ensureTable() {
  if (!ensured) {
    ensured = cpaDb.schema.hasTable(TABLE).then(async (exists) => {
      if (!exists) {
        await cpaDb.schema.createTable(TABLE, (t) => {
          t.integer('id').primary();
          t.json('settings_json');
          t.timestamp('updated_at').defaultTo(cpaDb.fn.now()).notNullable();
        });
      }
    });
  }
  return ensured;
}

export async function getQueueColorDefaults() {
  await ensureTable();
  const row = await cpaDb(TABLE).where({ id: ROW_ID }).first();
  if (!row) return SEED;
  const saved = parseSettings(row.settings_json);
  return normalize(saved);
}

export async function updateQueueColorDefaults(body: any) {
  await ensureTable();
  const normalized = normalize(body);
  await cpaDb(TABLE)
    .insert({ id: ROW_ID, settings_json: JSON.stringify(normalized), updated_at: new Date() })
    .onConflict('id')
    .merge({ settings_json: JSON.stringify(normalized), updated_at: new Date() });
  return normalized;
}

function normalize(value: any) {
  return {
    queue_colors: normalizeQueueColors(value?.queue_colors),
    queue_font_weight: normalizeQueueFontWeight(value?.queue_font_weight),
    display_font_family: normalizeDisplayFontFamily(value?.display_font_family),
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
