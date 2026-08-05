import 'dotenv/config';
import crypto from 'crypto';
import { cpaDb, hospitalDb } from '../src/db.js';

async function main() {
  const locations = await hospitalDb('opd_qs_location')
    .select('opd_qs_location_id', 'opd_qs_location_name')
    .orderBy('opd_qs_location_name', 'asc');

  for (const location of locations) {
    const locationId = String(location.opd_qs_location_id);
    const locationName = String(location.opd_qs_location_name || locationId);
    await cpaDb('service_location_config').insert({
      location_id: locationId,
      display_name: locationName,
      tts_provider: 'recorded',
      recorded_room_type: 'doctor_room',
      voice_rate: 1,
      default_room_ids: '',
      settings_json: JSON.stringify({ google_room_label: 'ห้องตรวจ' }),
    }).onConflict('location_id').ignore();

    const device = await cpaDb('display_devices').select('device_id').where({ location_id: locationId }).first();
    if (device) continue;

    const rooms = await hospitalDb('opd_qs_room')
      .select('opd_qs_room_id')
      .where('opd_qs_location_id', locationId)
      .orderBy('opd_qs_room_number', 'asc')
      .orderBy('opd_qs_room_name', 'asc');
    const roomIds = rooms.map((room: any) => String(room.opd_qs_room_id)).join(',');
    const tokenHash = crypto.createHash('sha256').update(`dq_${crypto.randomBytes(32).toString('hex')}`).digest('hex');
    await cpaDb('display_devices').insert({
      device_name: `จอรวม ${locationName}`,
      device_type: 'multi',
      location_id: locationId,
      room_ids: roomIds,
      token_hash: tokenHash,
      allowed_ips: '',
      active: 1,
      settings_json: JSON.stringify({}),
    });
  }

  console.log(`Seeded display devices for ${locations.length} locations.`);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
