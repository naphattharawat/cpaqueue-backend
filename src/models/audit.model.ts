import { cpaDb } from '../db.js';

export async function logLogin(input: {
  username: string;
  displayName?: string;
  role?: string;
  success: boolean;
  failureReason?: string;
  ip?: string;
  userAgent?: string;
}) {
  await cpaDb('login_logs').insert({
    username: input.username,
    display_name: input.displayName || null,
    role: input.role || null,
    success: input.success ? 1 : 0,
    failure_reason: input.failureReason || null,
    ip_address: normalizeIp(input.ip || ''),
    user_agent: String(input.userAgent || '').slice(0, 500),
    logged_at: new Date(),
  });
}

export async function logQueueAction(input: {
  action: 'call' | 'hold' | 'cancel';
  slotId: string;
  detail?: any;
  room?: any;
  user?: any;
  ip?: string;
}) {
  await cpaDb('queue_call_logs').insert({
    action: input.action,
    slot_id: String(input.slotId),
    hn: input.detail?.hn || null,
    vn: input.detail?.vn || null,
    queue_no: input.detail?.queue_slot_number || null,
    oqueue: input.detail?.oqueue || null,
    patient_name: input.detail?.patient_name || null,
    location_id: input.room?.opd_qs_location_id || null,
    location_name: input.room?.opd_qs_location_name || null,
    room_id: input.room?.opd_qs_room_id || input.room?.room_id || null,
    room_name: input.room?.opd_qs_room_name || null,
    room_number: input.room?.opd_qs_room_number || null,
    doctor_name: input.detail?.doctor_name || null,
    caller_username: input.user?.username || null,
    caller_display_name: input.user?.displayName || null,
    ip_address: normalizeIp(input.ip || ''),
    logged_at: new Date(),
  });
}

export async function dashboardSummary() {
  const [start, end] = todayRange();
  const loginTotal = await cpaDb('login_logs')
    .where({ success: 1 })
    .whereBetween('logged_at', [start, end])
    .countDistinct({ count: 'username' })
    .first();
  const loginAttempts = await cpaDb('login_logs')
    .whereBetween('logged_at', [start, end])
    .count({ count: '*' })
    .first();
  const failedLogins = await cpaDb('login_logs')
    .where({ success: 0 })
    .whereBetween('logged_at', [start, end])
    .count({ count: '*' })
    .first();
  const callCounts = await cpaDb('queue_call_logs')
    .select('action')
    .count({ count: '*' })
    .whereBetween('logged_at', [start, end])
    .groupBy('action');
  const activeRooms = await cpaDb('queue_call_logs')
    .select('location_id', 'location_name', 'room_id', 'room_name', 'room_number')
    .max({ last_called_at: 'logged_at' })
    .count({ call_count: '*' })
    .where({ action: 'call' })
    .whereBetween('logged_at', [start, end])
    .groupBy('location_id', 'location_name', 'room_id', 'room_name', 'room_number')
    .orderBy('last_called_at', 'desc');
  const recentCalls = await cpaDb('queue_call_logs')
    .select('action', 'queue_no', 'oqueue', 'location_name', 'room_name', 'room_number', 'caller_display_name', 'logged_at')
    .whereBetween('logged_at', [start, end])
    .orderBy('logged_at', 'desc')
    .limit(20);

  return {
    date: todayText(),
    login_users_today: Number(loginTotal?.count || 0),
    login_attempts_today: Number(loginAttempts?.count || 0),
    failed_logins_today: Number(failedLogins?.count || 0),
    call_counts_today: Object.fromEntries(callCounts.map((row: any) => [row.action, Number(row.count || 0)])),
    active_rooms_today: activeRooms,
    recent_calls: recentCalls,
  };
}

function todayText() {
  return new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function todayRange(): [Date, Date] {
  const day = todayText();
  return [new Date(`${day}T00:00:00`), new Date(`${day}T23:59:59`)];
}

function normalizeIp(ip: string) {
  return String(ip || '').replace(/^::ffff:/, '');
}
