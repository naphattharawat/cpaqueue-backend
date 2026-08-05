CREATE TABLE IF NOT EXISTS login_logs (
  log_id BIGINT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(120) NOT NULL,
  display_name VARCHAR(255) NULL,
  role VARCHAR(30) NULL,
  success TINYINT(1) NOT NULL DEFAULT 0,
  failure_reason VARCHAR(500) NULL,
  ip_address VARCHAR(80) NULL,
  user_agent VARCHAR(500) NULL,
  logged_at DATETIME NOT NULL,
  INDEX idx_login_logs_logged_at (logged_at),
  INDEX idx_login_logs_username_logged_at (username, logged_at),
  INDEX idx_login_logs_success_logged_at (success, logged_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS queue_call_logs (
  log_id BIGINT AUTO_INCREMENT PRIMARY KEY,
  action VARCHAR(20) NOT NULL,
  slot_id VARCHAR(50) NOT NULL,
  hn VARCHAR(50) NULL,
  vn VARCHAR(50) NULL,
  queue_no VARCHAR(20) NULL,
  oqueue VARCHAR(20) NULL,
  patient_name VARCHAR(255) NULL,
  location_id VARCHAR(20) NULL,
  location_name VARCHAR(255) NULL,
  room_id VARCHAR(20) NULL,
  room_name VARCHAR(100) NULL,
  room_number VARCHAR(30) NULL,
  doctor_name VARCHAR(255) NULL,
  caller_username VARCHAR(120) NULL,
  caller_display_name VARCHAR(255) NULL,
  ip_address VARCHAR(80) NULL,
  logged_at DATETIME NOT NULL,
  INDEX idx_queue_call_logs_logged_at (logged_at),
  INDEX idx_queue_call_logs_location_logged_at (location_id, logged_at),
  INDEX idx_queue_call_logs_room_logged_at (room_id, logged_at),
  INDEX idx_queue_call_logs_action_logged_at (action, logged_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
