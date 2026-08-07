import { cpaDb, hospitalDb } from '../db.js';

export async function getDisplayData(locationId: string, roomId = '', doctorCode = '') {
  const rooms = await hospitalDb('opd_qs_room')
    .select('opd_qs_room_id', 'opd_qs_room_name', 'opd_qs_room_number', 'current_queue')
    .where({ opd_qs_location_id: locationId, room_active: 'Y' })
    .orderBy('display_order', 'asc')
    .orderBy('opd_qs_room_name', 'asc');

  let roomInfo: any = null;
  let roomDoctorCode = '';
  if (roomId) {
    roomInfo = await hospitalDb('opd_qs_room as r')
      .select('r.opd_qs_room_name', 'r.opd_qs_room_number', 'r.doctor_code', { doctor_name: 'd.name' }, 'c.opd_qs_location_name')
      .leftJoin('doctor as d', 'd.code', 'r.doctor_code')
      .leftJoin('opd_qs_location as c', 'r.opd_qs_location_id', 'c.opd_qs_location_id')
      .where('r.opd_qs_room_id', roomId)
      .first();
    if (roomInfo) roomInfo.display_location_name = `ห้องตรวจเบอร์ ${roomInfo.opd_qs_room_number || ''}`.trim();
    roomDoctorCode = doctorCode || roomInfo?.doctor_code || '';
  }

  const activeLogs = roomId ? await cpaDb('opd_qs_call')
    .select('call_id', 'slot_id', 'call_datetime')
    .where({ room_id: roomId, call_status: 'N' })
    .whereBetween('call_datetime', todayRange())
    .orderBy('call_datetime', 'desc')
    .limit(10) : [];
  const activeList = await slotDetails(activeLogs.slice().reverse().map((l: any) => l.slot_id), activeLogs.slice().reverse());
  const active = activeList.at(-1) ?? null;

  const holdLogs = roomId ? await cpaDb('opd_qs_call')
    .select('slot_id', 'queue_no', 'patient_name')
    .where({ room_id: roomId, call_status: 'W' })
    .whereBetween('call_datetime', todayRange())
    .orderBy('call_datetime', 'desc') : [];
  const holdDetails = await slotDetails(holdLogs.map((h: any) => h.slot_id), []);
  const holdMap = new Map(holdDetails.map((h: any) => [String(h.opd_qs_slot_id), h]));
  const hold_queues = holdLogs.map((h: any) => ({ slot_id: h.slot_id, queue_slot_number: holdMap.get(String(h.slot_id))?.queue_slot_number ?? h.queue_no, oqueue: holdMap.get(String(h.slot_id))?.oqueue ?? null, patient_name: h.patient_name }));

  const callLogs = roomId ? await cpaDb('opd_qs_call')
    .select('slot_id', 'call_status')
    .where('room_id', roomId)
    .whereBetween('call_datetime', todayRange()) : [];
  const excluded = new Set(callLogs.filter((l: any) => ['N', 'W'].includes(l.call_status)).map((l: any) => String(l.slot_id)));
  const called = callLogs.filter((l: any) => l.call_status === 'N').length;

  const slotQuery = hospitalDb('opd_qs_slot as a')
    .select('a.opd_qs_slot_id', 'a.queue_slot_number', 'o.oqueue', 'a.start_time', 'p.pname', 'p.fname', 'p.lname')
    .leftJoin('ovst as o', 'a.vn', 'o.vn')
    .leftJoin('patient as p', 'o.hn', 'p.hn')
    .where('a.schedule_date', today())
    .orderBy('a.queue_slot_number_int', 'asc')
    .orderBy('a.start_time', 'asc');
  if (doctorCode && roomId) slotQuery.where('a.doctor_code', doctorCode).where('a.opd_qs_room_id', roomId);
  else if (roomDoctorCode) slotQuery.where('a.doctor_code', roomDoctorCode);
  else if (roomId) slotQuery.where('a.opd_qs_room_id', roomId);
  else {
    const roomIds = rooms.map((r: any) => r.opd_qs_room_id);
    if (roomIds.length) slotQuery.whereIn('a.opd_qs_room_id', roomIds);
  }
  const allSlots = (await slotQuery).map(withPatientName);
  const waitingSlots = allSlots.filter((s: any) => !excluded.has(String(s.opd_qs_slot_id)));
  return { status: 'success', active, active_list: activeList, hold_queues, next_queues: waitingSlots.slice(0, 5), remaining_count: Math.max(0, waitingSlots.length - 5), rooms, room_info: roomInfo, waiting: waitingSlots.length, called, call_repeat_count: await callRepeatCount(locationId) };
}

async function slotDetails(slotIds: string[], logs: any[]) {
  if (!slotIds.length) return [];
  const rows = await hospitalDb('opd_qs_slot as a')
    .select('a.opd_qs_slot_id', 'a.queue_slot_number', 'o.oqueue', 'a.start_time', 'p.pname', 'p.fname', 'p.lname')
    .leftJoin('ovst as o', 'a.vn', 'o.vn')
    .leftJoin('patient as p', 'o.hn', 'p.hn')
    .whereIn('a.opd_qs_slot_id', slotIds.map(Number));
  const map = new Map(rows.map((r: any) => [String(r.opd_qs_slot_id), withPatientName(r)]));
  return slotIds.map((id, i) => {
    const row = map.get(String(id));
    return row ? { ...(row as object), call_id: logs[i]?.call_id, call_datetime: logs[i]?.call_datetime } : null;
  }).filter(Boolean);
}

export async function getMultiDisplayData(roomIds: number[]) {
  if (!roomIds.length) return { status: 'success', rooms_data: [], called_list: [] };
  const allCalls = await cpaDb('opd_qs_call')
    .select('call_id', 'slot_id', 'room_id', 'call_status', 'queue_no', 'call_datetime', 'hn', 'patient_name')
    .whereBetween('call_datetime', todayRange())
    .orderBy('call_datetime', 'desc');

  const activeByRoom = new Map<string, any>();
  const excludedSlotIds = new Set<string>();
  let latestActiveRoomId = '';
  for (const call of allCalls) {
    const rid = String(call.room_id);
    const sid = String(call.slot_id);
    if (call.call_status === 'N' && !activeByRoom.has(rid)) {
      activeByRoom.set(rid, call);
      if (!latestActiveRoomId) latestActiveRoomId = rid;
    }
    if (['N', 'W'].includes(call.call_status)) excludedSlotIds.add(sid);
  }

  const roomsInfo = await hospitalDb('opd_qs_room as r')
    .select('r.opd_qs_room_id', 'r.opd_qs_room_name', 'r.opd_qs_room_number', 'r.opd_qs_location_id', 'r.doctor_code', { doctor_name: 'd.name' }, { location_name: 'l.opd_qs_location_name' })
    .leftJoin('doctor as d', 'r.doctor_code', 'd.code')
    .leftJoin('opd_qs_location as l', 'r.opd_qs_location_id', 'l.opd_qs_location_id')
    .whereIn('r.opd_qs_room_id', roomIds);
  const roomMap = new Map(roomsInfo.map((r: any) => [String(r.opd_qs_room_id), r]));

  const roomsData: any[] = [];
  for (const roomId of roomIds) {
    const roomInfo = roomMap.get(String(roomId));
    if (!roomInfo) continue;
    const activeLog = activeByRoom.get(String(roomId));
    const active = activeLog ? (await slotDetails([activeLog.slot_id], [activeLog])).at(0) ?? null : null;
    const docToday = (await hospitalDb('opd_qs_slot').distinct('doctor_code').where('opd_qs_room_id', roomId).where('schedule_date', today()).first())?.doctor_code;
    const slotQuery = hospitalDb('opd_qs_slot as a')
      .select('a.opd_qs_slot_id', 'a.queue_slot_number', 'o.oqueue', 'a.start_time', 'p.pname', 'p.fname', 'p.lname')
      .leftJoin('ovst as o', 'a.vn', 'o.vn')
      .leftJoin('patient as p', 'o.hn', 'p.hn')
      .where('a.schedule_date', today())
      .where('a.opd_qs_room_id', roomId)
      .orderBy('a.queue_slot_number_int', 'asc')
      .orderBy('a.start_time', 'asc');
    if (docToday) slotQuery.where('a.doctor_code', docToday);
    const allSlots = (await slotQuery).map(withPatientName);

    roomsData.push({
      room_id: roomId,
      room_name: roomInfo.opd_qs_room_name,
      room_number: roomInfo.opd_qs_room_number,
      location_name: roomInfo.location_name,
      doctor_name: roomInfo.doctor_name,
      active,
      is_latest: latestActiveRoomId === String(roomId),
      next_queues: allSlots.filter((s: any) => !excludedSlotIds.has(String(s.opd_qs_slot_id))).slice(0, 5),
    });
  }

  roomsData.sort((a, b) => Number(String(a.room_number || a.room_id).replace(/\D/g, '')) - Number(String(b.room_number || b.room_id).replace(/\D/g, '')));
  const roomNumMap = new Map(roomsData.map(r => [String(r.room_id), r.room_number]));
  const calledRaw = allCalls.filter(c => roomIds.includes(Number(c.room_id)) && c.call_status === 'W').slice(0, 20);
  const calledDetails = await slotDetails(calledRaw.map(c => c.slot_id), []);
  const oqueueMap = new Map(calledDetails.map((d: any) => [String(d.opd_qs_slot_id), d.oqueue]));
  const called_list = calledRaw.map(c => ({
    queue_no: c.queue_no,
    oqueue: oqueueMap.get(String(c.slot_id)) ?? null,
    room_id: c.room_id,
    room_number: roomNumMap.get(String(c.room_id)) ?? '',
    patient_name: c.patient_name,
    hn: c.hn,
  }));

  const locationId = roomsInfo[0]?.opd_qs_location_id || '';
  return { status: 'success', rooms_data: roomsData, called_list, call_repeat_count: await callRepeatCount(locationId) };
}

export async function getRoomListDisplayData(roomIds: number[], limit = 6) {
  const safeLimit = Math.min(12, Math.max(1, Math.round(Number(limit) || 6)));
  if (!roomIds.length) return { status: 'success', rooms_data: [], limit: safeLimit };

  const roomsInfo = await hospitalDb('opd_qs_room as r')
    .select('r.opd_qs_room_id', 'r.opd_qs_room_name', 'r.opd_qs_room_number', 'r.opd_qs_location_id', { location_name: 'l.opd_qs_location_name' })
    .leftJoin('opd_qs_location as l', 'r.opd_qs_location_id', 'l.opd_qs_location_id')
    .whereIn('r.opd_qs_room_id', roomIds)
    .orderBy('r.opd_qs_room_number', 'asc')
    .orderBy('r.opd_qs_room_name', 'asc');
  const roomMap = new Map(roomsInfo.map((r: any) => [String(r.opd_qs_room_id), r]));

  const calls = await cpaDb('queue_call_logs')
    .select('log_id', 'slot_id', 'room_id', 'queue_no', 'oqueue', 'logged_at', 'hn', 'patient_name', 'room_number', 'room_name')
    .whereIn('room_id', roomIds.map(String))
    .where('action', 'call')
    .whereBetween('logged_at', todayRange())
    .orderBy('logged_at', 'desc')
    .orderBy('log_id', 'desc');

  const callsByRoom = new Map<string, any[]>();
  for (const call of calls) {
    const key = String(call.room_id);
    const list = callsByRoom.get(key) || [];
    if (list.length < safeLimit) list.push(call);
    callsByRoom.set(key, list);
  }

  const detailMap = new Map<string, any>();
  const slotIds = [...new Set(calls.map((c: any) => String(c.slot_id)))];
  for (const detail of await slotDetails(slotIds, []) as any[]) {
    detailMap.set(String(detail.opd_qs_slot_id), detail);
  }

  const roomsData = roomIds.map(roomId => {
    const room = roomMap.get(String(roomId));
    if (!room) return null;
    const queues = (callsByRoom.get(String(roomId)) || []).map(call => {
      const detail = detailMap.get(String(call.slot_id));
      return {
        ...detail,
        slot_id: call.slot_id,
        call_id: call.log_id,
        call_datetime: call.logged_at,
        queue_no: detail?.queue_slot_number || call.queue_no,
        oqueue: detail?.oqueue || call.oqueue,
        hn: call.hn,
        patient_name: detail?.patient_name || call.patient_name || '',
      };
    });
    return {
      room_id: roomId,
      room_name: room.opd_qs_room_name,
      room_number: room.opd_qs_room_number,
      location_id: room.opd_qs_location_id,
      location_name: room.location_name,
      queues,
    };
  }).filter(Boolean);

  const locationId = roomsInfo[0]?.opd_qs_location_id || '';
  return { status: 'success', rooms_data: roomsData, limit: safeLimit, location_id: locationId };
}

function withPatientName(row: any) {
  const prefix = row.pname || 'คุณ';
  const name = `${row.fname || ''} ${row.lname || ''}`.trim();
  return { ...row, patient_name: name ? `${prefix}${name}` : '' };
}

function today() {
  return new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function todayRange(): [Date, Date] {
  const day = today();
  return [new Date(`${day}T00:00:00`), new Date(`${day}T23:59:59`)];
}

async function callRepeatCount(locationId: string | number) {
  if (!locationId) return 1;
  const row = await cpaDb('service_location_config')
    .select('*')
    .where({ location_id: String(locationId) })
    .first();
  const n = Math.round(Number(row?.call_repeat_count || 1));
  return Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : 1;
}
