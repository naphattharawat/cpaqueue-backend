import { cpaDb, hospitalDb } from '../db.js';

export async function checkQueue(query: string) {
  const cleanQuery = query.trim();
  if (!cleanQuery) return { status: 'error', message: 'กรุณากรอกหมายเลขคิว' };

  const matchedTargets = await targetQuery()
    .where('a.schedule_date', today())
    .andWhere(builder => {
      builder.where('o.oqueue', cleanQuery).orWhere('a.queue_slot_number', cleanQuery);
    });

  if (!matchedTargets.length) return { status: 'not_found', message: 'ไม่พบคิว' };

  const hns = [...new Set(matchedTargets.map((target: any) => String(target.hn || '')).filter(Boolean))];
  const targets = hns.length
    ? await targetQuery().where('a.schedule_date', today()).whereIn('o.hn', hns)
    : matchedTargets;
  const uniqueTargets = dedupeTargets(targets);

  const queues = [];
  for (const target of uniqueTargets) queues.push(await buildQueueResult(target));

  return {
    status: 'success',
    data: queues[0],
    queues,
  };
}

function targetQuery() {
  return hospitalDb('opd_qs_slot as a')
    .select(
      'a.opd_qs_slot_id',
      'a.queue_slot_number',
      'a.vn',
      'a.queue_datetime',
      'o.oqueue',
      'o.hn',
      'a.opd_qs_room_id',
      'r.opd_qs_room_name',
      'r.opd_qs_room_number',
      'r.opd_qs_location_id',
      'l.opd_qs_location_name',
      'p.fname',
      'p.lname',
    )
    .leftJoin('opd_qs_room as r', 'a.opd_qs_room_id', 'r.opd_qs_room_id')
    .leftJoin('opd_qs_location as l', 'r.opd_qs_location_id', 'l.opd_qs_location_id')
    .leftJoin('ovst as o', 'a.vn', 'o.vn')
    .leftJoin('patient as p', 'o.hn', 'p.hn')
    .orderBy('r.opd_qs_location_id', 'asc')
    .orderBy('r.opd_qs_room_number', 'asc')
    .orderBy('a.queue_slot_number_int', 'asc')
    .orderBy('a.start_time', 'asc')
    .whereNull('a.ref_key');
}

function dedupeTargets(targets: any[]) {
  const latestByLocation = new Map<string, any>();
  for (const target of targets) {
    const key = [target.hn || '', target.oqueue || target.queue_slot_number || '', target.opd_qs_location_id || target.opd_qs_room_id || ''].join('|');
    const current = latestByLocation.get(key);
    if (!current || queueTime(target) >= queueTime(current)) latestByLocation.set(key, target);
  }
  return [...latestByLocation.values()].sort((a, b) => {
    const locationSort = Number(a.opd_qs_location_id || 0) - Number(b.opd_qs_location_id || 0);
    if (locationSort) return locationSort;
    const roomSort = Number(a.opd_qs_room_number || a.opd_qs_room_id || 0) - Number(b.opd_qs_room_number || b.opd_qs_room_id || 0);
    if (roomSort) return roomSort;
    return Number(a.queue_slot_number_int || 0) - Number(b.queue_slot_number_int || 0);
  });
}

function queueTime(target: any) {
  return new Date(target.queue_datetime || 0).getTime();
}

async function buildQueueResult(target: any) {
  let callStatus = 'Y';
  let roomName = target.opd_qs_room_name || 'ห้องตรวจ';
  let roomNumber = target.opd_qs_room_number || '';
  let locationName = target.opd_qs_location_name || 'จุดบริการ';
  let locationId = target.opd_qs_location_id;

  const callLog = await latestCallLog(target);
  if (callLog) {
    callStatus = callLog.call_status;
    const calledRoom = await roomInfo(callLog.room_id);
    roomName = callLog.room_name || calledRoom?.opd_qs_room_name || roomName;
    roomNumber = calledRoom?.opd_qs_room_number || roomNumber;
    locationName = calledRoom?.opd_qs_location_name || locationName;
    locationId = calledRoom?.opd_qs_location_id || locationId;

    if (callStatus === 'N' && String(callLog.slot_id) === String(target.opd_qs_slot_id)) {
      const latest = await cpaDb('opd_qs_call')
        .select('slot_id')
        .where({ room_id: callLog.room_id || target.opd_qs_room_id, call_status: 'N' })
        .whereBetween('call_datetime', todayRange())
        .orderBy('call_datetime', 'desc')
        .first();
      if (latest && String(latest.slot_id) !== String(target.opd_qs_slot_id)) callStatus = 'F';
    }
  }

  let remaining = 0;
  if (callStatus === 'Y') {
    remaining = await remainingQueues(target);
  }

  return {
    queue_no: target.queue_slot_number,
    oqueue: target.oqueue,
    patient_name: maskPatientName(patientName(target)),
    location_name: locationName,
    room_name: roomName,
    room_number: roomNumber,
    destination_label: await destinationLabel(locationId),
    call_status: callStatus,
    remaining,
  };
}

function latestCallLog(target: any) {
  return cpaDb('opd_qs_call')
    .select('slot_id', 'queue_no', 'vn', 'hn', 'call_status', 'room_id', 'room_name', 'call_datetime')
    .whereBetween('call_datetime', todayRange())
    .andWhere(builder => {
      builder.where('slot_id', String(target.opd_qs_slot_id));
      if (target.queue_slot_number) builder.orWhere('queue_no', String(target.queue_slot_number));
      if (target.vn) builder.orWhere('vn', String(target.vn));
      if (target.hn) builder.orWhere('hn', String(target.hn));
    })
    .orderBy('call_datetime', 'desc')
    .first();
}

function roomInfo(roomId: string | number | null | undefined) {
  if (!roomId) return null;
  return hospitalDb('opd_qs_room as r')
    .select('r.opd_qs_room_name', 'r.opd_qs_room_number', 'r.opd_qs_location_id', 'l.opd_qs_location_name')
    .leftJoin('opd_qs_location as l', 'r.opd_qs_location_id', 'l.opd_qs_location_id')
    .where('r.opd_qs_room_id', roomId)
    .first();
}

async function destinationLabel(locationId: string | number | null | undefined) {
  if (!locationId) return 'ห้องตรวจ';
  const row = await cpaDb('service_location_config')
    .select('tts_provider', 'recorded_room_type', 'settings_json')
    .where({ location_id: String(locationId) })
    .first();
  const settings = parseSettings(row?.settings_json);
  if (row?.tts_provider !== 'recorded') return String(settings.google_room_label || 'ห้องตรวจ').trim() || 'ห้องตรวจ';
  if (settings.recorded_room_label) return String(settings.recorded_room_label).trim();
  const labels: Record<string, string> = {
    cashier: 'ห้องการเงิน', channel: 'ช่องบริการ', couter: 'เคาน์เตอร์', counter: 'เคาน์เตอร์',
    doctor_room: 'ห้องตรวจ', 'interview-point': 'จุดซักประวัติ', 'interview-table': 'โต๊ะซักประวัติ',
    number: 'หมายเลข', 'pay-cashier': 'ช่องจ่ายเงิน', 'pay-drug': 'ช่องจ่ายยา',
    'receive-drug': 'ช่องรับยา', 'screen-point': 'จุดคัดกรอง', 'screen-table': 'โต๊ะคัดกรอง', table: 'โต๊ะ',
  };
  const key = String(row?.recorded_room_type || 'doctor_room');
  return labels[key] || key.replace(/[-_]+/g, ' ');
}

function parseSettings(value: any) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
}

async function remainingQueues(target: any) {
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
  const waiting = slots
    .filter((s: any) => (statusMap.get(String(s.opd_qs_slot_id)) ?? 'Y') === 'Y')
    .map((s: any) => String(s.opd_qs_slot_id));
  return Math.max(0, waiting.indexOf(String(target.opd_qs_slot_id)));
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
