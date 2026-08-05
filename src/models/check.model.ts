import { cpaDb, hospitalDb } from '../db.js';

export async function checkQueue(query: string) {
  if (!query.trim()) return { status: 'error', message: 'กรุณากรอกหมายเลขคิว' };
  const target = await hospitalDb('opd_qs_slot as a')
    .select('a.opd_qs_slot_id', 'a.queue_slot_number', 'o.oqueue', 'a.opd_qs_room_id', 'r.opd_qs_room_name', 'r.opd_qs_room_number', 'p.fname', 'p.lname')
    .leftJoin('opd_qs_room as r', 'a.opd_qs_room_id', 'r.opd_qs_room_id')
    .leftJoin('ovst as o', 'a.vn', 'o.vn')
    .leftJoin('patient as p', 'o.hn', 'p.hn')
    .where('a.schedule_date', today())
    .where('o.oqueue', query)
    .first();
  if (!target) return { status: 'not_found', message: 'ไม่พบคิว' };

  let callStatus = 'Y';
  let roomName = target.opd_qs_room_name || 'ห้องตรวจ';
  const callLog = await cpaDb('opd_qs_call')
    .select('call_status', 'room_name')
    .where({ slot_id: target.opd_qs_slot_id })
    .first();
  if (callLog) {
    callStatus = callLog.call_status;
    roomName = callLog.room_name || roomName;
    if (callStatus === 'N') {
      const latest = await cpaDb('opd_qs_call')
        .select('slot_id')
        .where({ room_id: target.opd_qs_room_id, call_status: 'N' })
        .whereBetween('call_datetime', todayRange())
        .orderBy('call_datetime', 'desc')
        .first();
      if (latest && String(latest.slot_id) !== String(target.opd_qs_slot_id)) callStatus = 'F';
    }
  }

  let remaining = 0;
  if (callStatus === 'Y') {
    const slots = await hospitalDb('opd_qs_slot')
      .select('opd_qs_slot_id')
      .where('schedule_date', today())
      .where('opd_qs_room_id', target.opd_qs_room_id)
      .orderBy('queue_slot_number_int', 'asc')
      .orderBy('start_time', 'asc');
    const calls = await cpaDb('opd_qs_call')
      .select('slot_id', 'call_status')
      .where('room_id', target.opd_qs_room_id)
      .whereBetween('call_datetime', todayRange());
    const statusMap = new Map(calls.map((c: any) => [String(c.slot_id), c.call_status]));
    const waiting = slots.filter((s: any) => (statusMap.get(String(s.opd_qs_slot_id)) ?? 'Y') === 'Y').map((s: any) => String(s.opd_qs_slot_id));
    remaining = Math.max(0, waiting.indexOf(String(target.opd_qs_slot_id)));
  }

  return {
    status: 'success',
    data: {
      queue_no: target.queue_slot_number,
      oqueue: target.oqueue,
      patient_name: maskPatientName(patientName(target)),
      room_name: roomName,
      call_status: callStatus,
      remaining,
    },
  };
}

function maskPatientName(fullName: string) {
  if (!fullName) return '---';
  const parts = fullName.trim().split(/\s+/);
  const first = parts[0] ?? '';
  const last = parts[1] ?? '';
  return `${first.slice(0, 2)}xx${last ? ` ${last.slice(0, 3)}xxx` : ''}`;
}

function patientName(row: any) {
  const name = `${row?.fname || ''} ${row?.lname || ''}`.trim();
  return name ? `คุณ${name}` : '';
}

function today() {
  return new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function todayRange(): [Date, Date] {
  const day = today();
  return [new Date(`${day}T00:00:00`), new Date(`${day}T23:59:59`)];
}
