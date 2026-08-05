import { mysqlPool, pgPool } from '../db.js';

export async function getLocations() {
  const { rows } = await pgPool.query('SELECT opd_qs_location_id, opd_qs_location_name FROM opd_qs_location ORDER BY opd_qs_location_name ASC');
  return rows;
}

export async function getDoctors(locationId: string) {
  const scheduled = await pgPool.query(`
    SELECT DISTINCT d.code, d.name, b.opd_qs_room_name AS room_name, b.opd_qs_room_number AS room_number,
      CAST(NULLIF(regexp_replace(COALESCE(b.opd_qs_room_number, ''), '[^0-9]', '', 'g'), '') AS integer) AS room_num_sort
    FROM opd_qs_slot a
    JOIN opd_qs_room b ON a.opd_qs_room_id = b.opd_qs_room_id
    JOIN doctor d ON a.doctor_code = d.code
    WHERE b.opd_qs_location_id = $1 AND a.schedule_date = CURRENT_DATE
    ORDER BY room_num_sort ASC, d.name ASC`, [locationId]);
  if (scheduled.rows.length) return scheduled.rows;
  const fallback = await pgPool.query(`
    SELECT DISTINCT d.code, d.name, r.opd_qs_room_name AS room_name, r.opd_qs_room_number AS room_number,
      CAST(NULLIF(regexp_replace(COALESCE(r.opd_qs_room_number, ''), '[^0-9]', '', 'g'), '') AS integer) AS room_num_sort
    FROM opd_qs_room r
    JOIN doctor d ON (r.doctor_code = d.code OR r.doctor_in_room = d.code)
    WHERE r.opd_qs_location_id = $1
    ORDER BY room_num_sort ASC, d.name ASC`, [locationId]);
  return fallback.rows;
}

export async function getRooms(locationId: string) {
  const { rows } = await pgPool.query(`
    SELECT opd_qs_room_id, opd_qs_room_name, opd_qs_room_number
    FROM opd_qs_room
    WHERE opd_qs_location_id = $1
    ORDER BY CAST(NULLIF(regexp_replace(COALESCE(opd_qs_room_number, ''), '[^0-9]', '', 'g'), '') AS integer) ASC, opd_qs_room_name ASC`, [locationId]);
  return rows;
}

export async function getDoctorRoom(doctorCode: string) {
  const scheduled = await pgPool.query(`
    SELECT r.opd_qs_room_id, r.opd_qs_room_name, r.opd_qs_room_number, l.opd_qs_location_name
    FROM opd_qs_slot s
    JOIN opd_qs_room r ON s.opd_qs_room_id = r.opd_qs_room_id
    LEFT JOIN opd_qs_location l ON r.opd_qs_location_id = l.opd_qs_location_id
    WHERE s.doctor_code = $1 AND s.schedule_date = CURRENT_DATE
    LIMIT 1`, [doctorCode]);
  if (scheduled.rows[0]) return scheduled.rows[0];
  const fallback = await pgPool.query(`
    SELECT r.opd_qs_room_id, r.opd_qs_room_name, r.opd_qs_room_number, l.opd_qs_location_name
    FROM opd_qs_room r
    LEFT JOIN opd_qs_location l ON r.opd_qs_location_id = l.opd_qs_location_id
    WHERE r.doctor_code = $1 OR r.doctor_in_room = $1
    LIMIT 1`, [doctorCode]);
  return fallback.rows[0] ?? null;
}

export async function getDoctorRooms(doctorCodes: string[]) {
  const scheduled = await pgPool.query(`SELECT DISTINCT opd_qs_room_id FROM opd_qs_slot WHERE doctor_code = ANY($1) AND schedule_date = CURRENT_DATE`, [doctorCodes]);
  if (scheduled.rows.length) return scheduled.rows.map((r: any) => r.opd_qs_room_id);
  const fallback = await pgPool.query(`SELECT DISTINCT opd_qs_room_id FROM opd_qs_room WHERE doctor_code = ANY($1) OR doctor_in_room = ANY($1)`, [doctorCodes]);
  return fallback.rows.map((r: any) => r.opd_qs_room_id);
}

export async function getQueues(locationId: string, doctorCodes: string[] = []) {
  const params: unknown[] = [locationId];
  let doctorSql = '';
  if (doctorCodes.length) {
    params.push(doctorCodes);
    doctorSql = `AND a.doctor_code = ANY($${params.length})`;
  }
  const { rows } = await pgPool.query(`
    SELECT a.opd_qs_slot_id, a.schedule_date, c.opd_qs_location_name AS location_name,
      b.opd_qs_room_name AS room_name, b.opd_qs_room_number AS room_number, a.doctor_code AS code,
      d.name AS doctor_name, a.queue_slot_number, o.oqueue, e.opd_queue_slot_type_name, a.start_time,
      o.hn, a.vn, CONCAT('คุณ', p.fname, ' ', p.lname) AS patient_name, a.call_status,
      a.call_opd_qs_room_id, b.opd_qs_room_id AS opd_qs_room_id
    FROM opd_qs_slot a
    LEFT JOIN opd_qs_room b ON a.opd_qs_room_id = b.opd_qs_room_id
    LEFT JOIN opd_qs_location c ON b.opd_qs_location_id = c.opd_qs_location_id
    LEFT JOIN doctor d ON a.doctor_code = d.code
    LEFT JOIN ovst o ON a.vn = o.vn
    LEFT JOIN patient p ON o.hn = p.hn
    LEFT JOIN opd_queue_slot_type e ON a.opd_queue_slot_type_id = e.opd_queue_slot_type_id
    WHERE b.opd_qs_location_id = $1 AND a.schedule_date = CURRENT_DATE AND b.room_active = 'Y' ${doctorSql}
    ORDER BY a.queue_slot_number_int ASC, a.start_time ASC`, params);

  if (!rows.length) return rows;
  const [calls] = await mysqlPool.query('SELECT slot_id, call_status, room_id, call_datetime FROM opd_qs_call WHERE slot_id IN (?)', [rows.map((q: any) => String(q.opd_qs_slot_id))]);
  const callMap = new Map((calls as any[]).map(c => [String(c.slot_id), c]));
  return rows.map((q: any) => {
    const call = callMap.get(String(q.opd_qs_slot_id));
    return {
      ...q,
      call_status: call?.call_status ?? q.call_status ?? 'Y',
      opd_qs_room_id: call?.room_id ?? q.opd_qs_room_id,
      call_datetime: call?.call_datetime ?? null,
    };
  });
}

export async function logQueueCall(input: { slotId: string; roomId: string; status: 'N' | 'W' }) {
  const detail = await pgPool.query(`
    SELECT a.queue_slot_number, o.oqueue, o.hn, a.vn, CONCAT('คุณ', p.fname, ' ', p.lname) AS patient_name,
      d.name AS doctor_name, a.call_opd_qs_room_id, a.opd_qs_room_id
    FROM opd_qs_slot a
    LEFT JOIN ovst o ON a.vn = o.vn
    LEFT JOIN patient p ON o.hn = p.hn
    LEFT JOIN doctor d ON a.doctor_code = d.code
    WHERE a.opd_qs_slot_id = $1 LIMIT 1`, [input.slotId]);
  const room = await pgPool.query(`
    SELECT r.opd_qs_room_name, r.opd_qs_location_id, l.opd_qs_location_name
    FROM opd_qs_room r
    LEFT JOIN opd_qs_location l ON r.opd_qs_location_id = l.opd_qs_location_id
    WHERE r.opd_qs_room_id = $1 LIMIT 1`, [input.roomId]);
  const d = detail.rows[0];
  const r = room.rows[0];
  if (!d || !r) return { detail: d, room: r };
  await mysqlPool.query('DELETE FROM opd_qs_call WHERE slot_id = ?', [String(input.slotId)]);
  await mysqlPool.query(
    `INSERT INTO opd_qs_call (slot_id, hn, vn, queue_no, patient_name, location_id, room_id, room_name, call_status, call_datetime)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [String(input.slotId), d.hn, d.vn, d.queue_slot_number, d.patient_name, r.opd_qs_location_id, input.roomId, r.opd_qs_room_name, input.status],
  );
  return { detail: d, room: r };
}

export async function cancelQueue(slotId: string) {
  await mysqlPool.query('DELETE FROM opd_qs_call WHERE slot_id = ?', [String(slotId)]);
}
