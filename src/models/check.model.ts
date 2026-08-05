import { mysqlPool, pgPool } from '../db.js';

export async function checkQueue(query: string) {
  if (!query.trim()) return { status: 'error', message: 'กรุณากรอกหมายเลขคิว' };
  const target = (await pgPool.query(`
    SELECT a.opd_qs_slot_id, a.queue_slot_number, o.oqueue, a.opd_qs_room_id,
      r.opd_qs_room_name, r.opd_qs_room_number, CONCAT('คุณ', p.fname, ' ', p.lname) AS patient_name
    FROM opd_qs_slot a
    LEFT JOIN opd_qs_room r ON a.opd_qs_room_id = r.opd_qs_room_id
    LEFT JOIN ovst o ON a.vn = o.vn
    LEFT JOIN patient p ON o.hn = p.hn
    WHERE a.schedule_date = CURRENT_DATE AND CAST(o.oqueue AS VARCHAR) = CAST($1 AS VARCHAR)
    LIMIT 1`, [query])).rows[0];
  if (!target) return { status: 'not_found', message: 'ไม่พบคิว' };

  let callStatus = 'Y';
  let roomName = target.opd_qs_room_name || 'ห้องตรวจ';
  const callLog = ((await mysqlPool.query('SELECT call_status, room_name FROM opd_qs_call WHERE slot_id = ? LIMIT 1', [target.opd_qs_slot_id]))[0] as any[])[0];
  if (callLog) {
    callStatus = callLog.call_status;
    roomName = callLog.room_name || roomName;
    if (callStatus === 'N') {
      const latest = ((await mysqlPool.query(
        `SELECT slot_id FROM opd_qs_call WHERE room_id = ? AND call_status = 'N' AND DATE(call_datetime) = CURDATE() ORDER BY call_datetime DESC LIMIT 1`,
        [target.opd_qs_room_id],
      ))[0] as any[])[0];
      if (latest && String(latest.slot_id) !== String(target.opd_qs_slot_id)) callStatus = 'F';
    }
  }

  let remaining = 0;
  if (callStatus === 'Y') {
    const slots = (await pgPool.query(
      `SELECT opd_qs_slot_id FROM opd_qs_slot WHERE schedule_date = CURRENT_DATE AND opd_qs_room_id = $1 ORDER BY queue_slot_number_int ASC, start_time ASC`,
      [target.opd_qs_room_id],
    )).rows;
    const calls = (await mysqlPool.query(
      `SELECT slot_id, call_status FROM opd_qs_call WHERE room_id = ? AND DATE(call_datetime) = CURDATE()`,
      [target.opd_qs_room_id],
    ))[0] as any[];
    const statusMap = new Map(calls.map(c => [String(c.slot_id), c.call_status]));
    const waiting = slots.filter((s: any) => (statusMap.get(String(s.opd_qs_slot_id)) ?? 'Y') === 'Y').map((s: any) => String(s.opd_qs_slot_id));
    remaining = Math.max(0, waiting.indexOf(String(target.opd_qs_slot_id)));
  }

  return {
    status: 'success',
    data: {
      queue_no: target.queue_slot_number,
      oqueue: target.oqueue,
      patient_name: maskPatientName(target.patient_name),
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
