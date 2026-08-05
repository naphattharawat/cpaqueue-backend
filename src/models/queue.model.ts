import { cpaDb, hospitalDb } from '../db.js';

export async function getLocations() {
  return hospitalDb('opd_qs_location')
    .select('opd_qs_location_id', 'opd_qs_location_name')
    .orderBy('opd_qs_location_name', 'asc');
}

export async function getDoctors(locationId: string) {
  const scheduled = await hospitalDb('opd_qs_slot as a')
    .distinct('d.code', 'd.name', { room_name: 'b.opd_qs_room_name' }, { room_number: 'b.opd_qs_room_number' })
    .join('opd_qs_room as b', 'a.opd_qs_room_id', 'b.opd_qs_room_id')
    .join('doctor as d', 'a.doctor_code', 'd.code')
    .where('b.opd_qs_location_id', locationId)
    .where('a.schedule_date', today())
    .orderBy('b.opd_qs_room_number', 'asc')
    .orderBy('d.name', 'asc');
  if (scheduled.length) return scheduled;
  return hospitalDb('opd_qs_room as r')
    .distinct('d.code', 'd.name', { room_name: 'r.opd_qs_room_name' }, { room_number: 'r.opd_qs_room_number' })
    .join('doctor as d', function joinDoctor() {
      this.on('r.doctor_code', '=', 'd.code').orOn('r.doctor_in_room', '=', 'd.code');
    })
    .where('r.opd_qs_location_id', locationId)
    .orderBy('r.opd_qs_room_number', 'asc')
    .orderBy('d.name', 'asc');
}

export async function getRooms(locationId: string) {
  return hospitalDb('opd_qs_room')
    .select('opd_qs_room_id', 'opd_qs_room_name', 'opd_qs_room_number')
    .where('opd_qs_location_id', locationId)
    .orderBy('opd_qs_room_number', 'asc')
    .orderBy('opd_qs_room_name', 'asc');
}

export async function getDoctorRoom(doctorCode: string) {
  const scheduled = await hospitalDb('opd_qs_slot as s')
    .select('r.opd_qs_room_id', 'r.opd_qs_room_name', 'r.opd_qs_room_number', 'l.opd_qs_location_name')
    .join('opd_qs_room as r', 's.opd_qs_room_id', 'r.opd_qs_room_id')
    .leftJoin('opd_qs_location as l', 'r.opd_qs_location_id', 'l.opd_qs_location_id')
    .where('s.doctor_code', doctorCode)
    .where('s.schedule_date', today())
    .first();
  if (scheduled) return scheduled;
  return hospitalDb('opd_qs_room as r')
    .select('r.opd_qs_room_id', 'r.opd_qs_room_name', 'r.opd_qs_room_number', 'l.opd_qs_location_name')
    .leftJoin('opd_qs_location as l', 'r.opd_qs_location_id', 'l.opd_qs_location_id')
    .where('r.doctor_code', doctorCode)
    .orWhere('r.doctor_in_room', doctorCode)
    .first();
}

export async function getDoctorRooms(doctorCodes: string[]) {
  const scheduled = await hospitalDb('opd_qs_slot')
    .distinct('opd_qs_room_id')
    .whereIn('doctor_code', doctorCodes)
    .where('schedule_date', today());
  if (scheduled.length) return scheduled.map((r: any) => r.opd_qs_room_id);
  const fallback = await hospitalDb('opd_qs_room')
    .distinct('opd_qs_room_id')
    .whereIn('doctor_code', doctorCodes)
    .orWhereIn('doctor_in_room', doctorCodes);
  return fallback.map((r: any) => r.opd_qs_room_id);
}

export async function getQueues(locationId: string, doctorCodes: string[] = []) {
  const query = hospitalDb('opd_qs_slot as a')
    .select(
      'a.opd_qs_slot_id',
      'a.schedule_date',
      { location_name: 'c.opd_qs_location_name' },
      { room_name: 'b.opd_qs_room_name' },
      { room_number: 'b.opd_qs_room_number' },
      { code: 'a.doctor_code' },
      { doctor_name: 'd.name' },
      'a.queue_slot_number',
      'o.oqueue',
      'e.opd_queue_slot_type_name',
      'a.start_time',
      'o.hn',
      'a.vn',
      'p.fname',
      'p.lname',
      'a.call_status',
      'a.call_opd_qs_room_id',
      { opd_qs_room_id: 'b.opd_qs_room_id' },
    )
    .leftJoin('opd_qs_room as b', 'a.opd_qs_room_id', 'b.opd_qs_room_id')
    .leftJoin('opd_qs_location as c', 'b.opd_qs_location_id', 'c.opd_qs_location_id')
    .leftJoin('doctor as d', 'a.doctor_code', 'd.code')
    .leftJoin('ovst as o', 'a.vn', 'o.vn')
    .leftJoin('patient as p', 'o.hn', 'p.hn')
    .leftJoin('opd_queue_slot_type as e', 'a.opd_queue_slot_type_id', 'e.opd_queue_slot_type_id')
    .where('b.opd_qs_location_id', locationId)
    .where('a.schedule_date', today())
    .where('b.room_active', 'Y')
    .orderBy('a.queue_slot_number_int', 'asc')
    .orderBy('a.start_time', 'asc');
  if (doctorCodes.length) query.whereIn('a.doctor_code', doctorCodes);

  const rows = await query;
  if (!rows.length) return rows;
  const calls = await cpaDb('opd_qs_call')
    .select('slot_id', 'call_status', 'room_id', 'call_datetime')
    .whereIn('slot_id', rows.map((q: any) => String(q.opd_qs_slot_id)));
  const callMap = new Map(calls.map((c: any) => [String(c.slot_id), c]));
  return rows.map((q: any) => {
    const call = callMap.get(String(q.opd_qs_slot_id));
    return {
      ...q,
      patient_name: patientName(q),
      call_status: call?.call_status ?? 'Y',
      opd_qs_room_id: call?.room_id ?? q.opd_qs_room_id,
      call_datetime: call?.call_datetime ?? null,
    };
  });
}

export async function logQueueCall(input: { slotId: string; roomId: string; status: 'N' | 'W' }) {
  const d = await hospitalDb('opd_qs_slot as a')
    .select('a.queue_slot_number', 'o.oqueue', 'o.hn', 'a.vn', 'p.fname', 'p.lname', { doctor_name: 'd.name' }, 'a.call_opd_qs_room_id', 'a.opd_qs_room_id')
    .leftJoin('ovst as o', 'a.vn', 'o.vn')
    .leftJoin('patient as p', 'o.hn', 'p.hn')
    .leftJoin('doctor as d', 'a.doctor_code', 'd.code')
    .where('a.opd_qs_slot_id', input.slotId)
    .first();
  const r = await hospitalDb('opd_qs_room as r')
    .select('r.opd_qs_room_id', 'r.opd_qs_room_name', 'r.opd_qs_room_number', 'r.opd_qs_location_id', 'l.opd_qs_location_name')
    .leftJoin('opd_qs_location as l', 'r.opd_qs_location_id', 'l.opd_qs_location_id')
    .where('r.opd_qs_room_id', input.roomId)
    .first();
  if (!d || !r) return { detail: d, room: r };
  await cpaDb('opd_qs_call').where({ slot_id: String(input.slotId) }).delete();
  await cpaDb('opd_qs_call').insert({
    slot_id: String(input.slotId),
    hn: d.hn,
    vn: d.vn,
    queue_no: d.queue_slot_number,
    patient_name: patientName(d),
    location_id: r.opd_qs_location_id,
    room_id: input.roomId,
    room_name: r.opd_qs_room_name,
    call_status: input.status,
    call_datetime: new Date(),
  });
  return { detail: { ...d, patient_name: patientName(d) }, room: r };
}

export async function cancelQueue(slotId: string) {
  await cpaDb('opd_qs_call').where({ slot_id: String(slotId) }).delete();
}

function patientName(row: any) {
  const name = `${row?.fname || ''} ${row?.lname || ''}`.trim();
  return name ? `คุณ${name}` : '';
}

function today() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}
