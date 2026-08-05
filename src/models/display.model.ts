import { mysqlPool, pgPool } from '../db.js';

export async function getDisplayData(locationId: string, roomId = '', doctorCode = '') {
  const rooms = (await pgPool.query(
    `SELECT opd_qs_room_id, opd_qs_room_name, opd_qs_room_number, current_queue
     FROM opd_qs_room WHERE opd_qs_location_id = $1 AND room_active = 'Y'
     ORDER BY display_order ASC, opd_qs_room_name ASC`, [locationId])).rows;

  let roomInfo: any = null;
  let roomDoctorCode = '';
  if (roomId) {
    roomInfo = (await pgPool.query(`
      SELECT r.opd_qs_room_name, r.opd_qs_room_number, r.doctor_code, d.name AS doctor_name,
        c.opd_qs_location_name, CONCAT('ห้องตรวจเบอร์ ', r.opd_qs_room_number) AS display_location_name
      FROM opd_qs_room r
      LEFT JOIN doctor d ON d.code = COALESCE($2, r.doctor_code)
      LEFT JOIN opd_qs_location c ON r.opd_qs_location_id = c.opd_qs_location_id
      WHERE r.opd_qs_room_id = $1 LIMIT 1`, [roomId, doctorCode || null])).rows[0] ?? null;
    roomDoctorCode = doctorCode || roomInfo?.doctor_code || '';
  }

  const activeLogs = roomId ? (await mysqlPool.query(
    `SELECT call_id, slot_id, call_datetime FROM opd_qs_call
     WHERE room_id = ? AND call_status = 'N' AND DATE(call_datetime) = CURDATE()
     ORDER BY call_datetime DESC LIMIT 10`, [roomId]))[0] as any[] : [];
  const activeList = await slotDetails(activeLogs.reverse().map(l => l.slot_id), activeLogs);
  const active = activeList.at(-1) ?? null;

  const holdLogs = roomId ? (await mysqlPool.query(
    `SELECT slot_id, queue_no, patient_name FROM opd_qs_call
     WHERE room_id = ? AND call_status = 'W' AND DATE(call_datetime) = CURDATE()
     ORDER BY call_datetime DESC`, [roomId]))[0] as any[] : [];
  const holdDetails = await slotDetails(holdLogs.map(h => h.slot_id), []);
  const holdMap = new Map(holdDetails.map((h: any) => [String(h.opd_qs_slot_id), h]));
  const hold_queues = holdLogs.map(h => ({ slot_id: h.slot_id, queue_slot_number: holdMap.get(String(h.slot_id))?.queue_slot_number ?? h.queue_no, oqueue: holdMap.get(String(h.slot_id))?.oqueue ?? null, patient_name: h.patient_name }));

  const callLogs = roomId ? (await mysqlPool.query(`SELECT slot_id, call_status FROM opd_qs_call WHERE room_id = ? AND DATE(call_datetime) = CURDATE()`, [roomId]))[0] as any[] : [];
  const excluded = new Set(callLogs.filter(l => ['N', 'W'].includes(l.call_status)).map(l => String(l.slot_id)));
  const called = callLogs.filter(l => l.call_status === 'N').length;
  const params: unknown[] = [];
  let where = 'a.schedule_date = CURRENT_DATE';
  if (doctorCode && roomId) {
    params.push(doctorCode, roomId);
    where += ` AND a.doctor_code = $1 AND a.opd_qs_room_id = $2`;
  } else if (roomDoctorCode) {
    params.push(roomDoctorCode);
    where += ` AND a.doctor_code = $1`;
  } else if (roomId) {
    params.push(roomId);
    where += ` AND a.opd_qs_room_id = $1`;
  } else {
    params.push(locationId);
    where += ` AND a.opd_qs_room_id IN (SELECT opd_qs_room_id FROM opd_qs_room WHERE opd_qs_location_id = $1)`;
  }
  const allSlots = (await pgPool.query(`
    SELECT a.opd_qs_slot_id, a.queue_slot_number, o.oqueue, a.start_time, CONCAT('คุณ', p.fname, ' ', p.lname) AS patient_name
    FROM opd_qs_slot a
    LEFT JOIN ovst o ON a.vn = o.vn
    LEFT JOIN patient p ON o.hn = p.hn
    WHERE ${where}
    ORDER BY a.queue_slot_number_int ASC, a.start_time ASC`, params)).rows;
  const waitingSlots = allSlots.filter((s: any) => !excluded.has(String(s.opd_qs_slot_id)));
  return { status: 'success', active, active_list: activeList, hold_queues, next_queues: waitingSlots.slice(0, 5), remaining_count: Math.max(0, waitingSlots.length - 5), rooms, room_info: roomInfo, waiting: waitingSlots.length, called };
}

async function slotDetails(slotIds: string[], logs: any[]) {
  if (!slotIds.length) return [];
  const { rows } = await pgPool.query(`
    SELECT a.opd_qs_slot_id, a.queue_slot_number, o.oqueue, a.start_time, CONCAT(p.pname, p.fname, ' ', p.lname) AS patient_name
    FROM opd_qs_slot a
    LEFT JOIN ovst o ON a.vn = o.vn
    LEFT JOIN patient p ON o.hn = p.hn
    WHERE a.opd_qs_slot_id = ANY($1)`, [slotIds.map(Number)]);
  const map = new Map(rows.map((r: any) => [String(r.opd_qs_slot_id), r]));
  return slotIds.map((id, i) => {
    const row = map.get(String(id));
    return row ? { ...(row as object), call_id: logs[i]?.call_id, call_datetime: logs[i]?.call_datetime } : null;
  }).filter(Boolean);
}

export async function getMultiDisplayData(roomIds: number[]) {
  if (!roomIds.length) return { status: 'success', rooms_data: [], called_list: [] };
  const allCalls = (await mysqlPool.query(
    `SELECT call_id, slot_id, room_id, call_status, queue_no, call_datetime, hn, patient_name
     FROM opd_qs_call
     WHERE DATE(call_datetime) = CURDATE()
     ORDER BY call_datetime DESC`,
  ))[0] as any[];

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

  const roomsData: any[] = [];
  for (const roomId of roomIds) {
    const roomInfo = (await pgPool.query(`
      SELECT r.opd_qs_room_id, r.opd_qs_room_name, r.opd_qs_room_number, r.doctor_code,
        d.name AS doctor_name, l.opd_qs_location_name AS location_name
      FROM opd_qs_room r
      LEFT JOIN doctor d ON r.doctor_code = d.code
      LEFT JOIN opd_qs_location l ON r.opd_qs_location_id = l.opd_qs_location_id
      WHERE r.opd_qs_room_id = $1 LIMIT 1`, [roomId])).rows[0];
    if (!roomInfo) continue;

    const activeLog = activeByRoom.get(String(roomId));
    const active = activeLog ? (await slotDetails([activeLog.slot_id], [activeLog])).at(0) ?? null : null;

    const docToday = (await pgPool.query(
      `SELECT DISTINCT doctor_code FROM opd_qs_slot WHERE opd_qs_room_id = $1 AND schedule_date = CURRENT_DATE LIMIT 1`,
      [roomId],
    )).rows[0]?.doctor_code;
    const params: unknown[] = [roomId];
    const docSql = docToday ? 'AND a.doctor_code = $2' : '';
    if (docToday) params.push(docToday);
    const allSlots = (await pgPool.query(`
      SELECT a.opd_qs_slot_id, a.queue_slot_number, o.oqueue, a.start_time, CONCAT('คุณ', p.fname, ' ', p.lname) AS patient_name
      FROM opd_qs_slot a
      LEFT JOIN ovst o ON a.vn = o.vn
      LEFT JOIN patient p ON o.hn = p.hn
      WHERE a.schedule_date = CURRENT_DATE AND a.opd_qs_room_id = $1 ${docSql}
      ORDER BY a.queue_slot_number_int ASC, a.start_time ASC`, params)).rows;

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

  return { status: 'success', rooms_data: roomsData, called_list };
}
