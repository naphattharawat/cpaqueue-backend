import 'dotenv/config';
import crypto from 'crypto';
import pg from 'pg';
import mysql from 'mysql2/promise';

export const pgPool = new pg.Pool({
  host: process.env.PGHOST ?? '172.18.69.20',
  port: Number(process.env.PGPORT ?? 5432),
  database: process.env.PGDATABASE ?? 'cpahdb',
  user: process.env.PGUSER ?? 'iptscanview',
  password: process.env.PGPASSWORD ?? 'iptscanview',
});

export const mysqlPool = mysql.createPool({
  host: process.env.MYSQL_HOST ?? '172.18.2.2',
  database: process.env.MYSQL_DATABASE ?? 'cpa_queue',
  user: process.env.MYSQL_USER ?? 'admin',
  password: process.env.MYSQL_PASSWORD ?? 'Cpa10665DB',
  charset: 'utf8',
  waitForConnections: true,
  connectionLimit: 10,
});

export async function ensureQueueSchema() {
  await mysqlPool.query(`CREATE TABLE IF NOT EXISTS opd_qs_call (
    call_id INT AUTO_INCREMENT PRIMARY KEY,
    slot_id VARCHAR(50) NOT NULL,
    hn VARCHAR(50),
    vn VARCHAR(50),
    queue_no VARCHAR(20) NOT NULL,
    patient_name VARCHAR(255),
    location_id VARCHAR(20),
    room_id VARCHAR(20),
    room_name VARCHAR(100),
    call_status VARCHAR(2) DEFAULT 'Y',
    call_datetime DATETIME,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8`);

  await mysqlPool.query(`CREATE TABLE IF NOT EXISTS service_location_config (
    location_id VARCHAR(20) PRIMARY KEY,
    display_name VARCHAR(255),
    tts_provider VARCHAR(20) DEFAULT 'google',
    recorded_room_type VARCHAR(60) DEFAULT 'doctor_room',
    voice_rate DECIMAL(3,2) DEFAULT 1.00,
    default_room_ids TEXT,
    settings_json JSON NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8`);

  try {
    await mysqlPool.query(`ALTER TABLE service_location_config ADD COLUMN voice_rate DECIMAL(3,2) DEFAULT 1.00`);
  } catch (err: any) {
    if (err?.code !== 'ER_DUP_FIELDNAME') throw err;
  }

  try {
    await mysqlPool.query(`ALTER TABLE service_location_config DROP COLUMN default_display_type`);
  } catch (err: any) {
    if (err?.code !== 'ER_CANT_DROP_FIELD_OR_KEY') throw err;
  }

  await mysqlPool.query(`CREATE TABLE IF NOT EXISTS display_devices (
    device_id INT AUTO_INCREMENT PRIMARY KEY,
    device_name VARCHAR(120) NOT NULL,
    device_type VARCHAR(20) NOT NULL DEFAULT 'multi',
    location_id VARCHAR(20) NOT NULL,
    room_ids TEXT,
    token_hash VARCHAR(128) NOT NULL,
    allowed_ips TEXT NULL,
    active TINYINT(1) NOT NULL DEFAULT 1,
    last_seen_at DATETIME NULL,
    last_seen_ip VARCHAR(80) NULL,
    settings_json JSON NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_display_devices_location (location_id),
    UNIQUE KEY uq_display_devices_token_hash (token_hash)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8`);

  await seedDefaultLocationConfigsAndDevices();
}

async function seedDefaultLocationConfigsAndDevices() {
  const { rows: locations } = await pgPool.query(`
    SELECT opd_qs_location_id, opd_qs_location_name
    FROM opd_qs_location
    ORDER BY opd_qs_location_name ASC`);

  for (const location of locations) {
    const locationId = String(location.opd_qs_location_id);
    const locationName = String(location.opd_qs_location_name || locationId);
    await mysqlPool.query(`
      INSERT IGNORE INTO service_location_config
        (location_id, display_name, tts_provider, recorded_room_type, voice_rate, default_room_ids, settings_json)
      VALUES (?, ?, 'recorded', 'doctor_room', 1.00, '', JSON_OBJECT('google_room_label', 'ห้องตรวจ'))`,
      [locationId, locationName]);

    const [devices] = await mysqlPool.query<any[]>(
      `SELECT device_id FROM display_devices WHERE location_id = ? LIMIT 1`,
      [locationId]);
    if (devices.length) continue;

    const { rows: rooms } = await pgPool.query(`
      SELECT opd_qs_room_id
      FROM opd_qs_room
      WHERE opd_qs_location_id = $1
      ORDER BY CAST(NULLIF(regexp_replace(COALESCE(opd_qs_room_number, ''), '[^0-9]', '', 'g'), '') AS integer) ASC, opd_qs_room_name ASC`,
      [locationId]);
    const roomIds = rooms.map((room: any) => String(room.opd_qs_room_id)).join(',');
    const tokenHash = crypto.createHash('sha256').update(`dq_${crypto.randomBytes(32).toString('hex')}`).digest('hex');
    await mysqlPool.query(`
      INSERT INTO display_devices
        (device_name, device_type, location_id, room_ids, token_hash, allowed_ips, active, settings_json)
      VALUES (?, 'multi', ?, ?, ?, '', 1, JSON_OBJECT())`,
      [`จอรวม ${locationName}`, locationId, roomIds, tokenHash]);
  }
}
