CREATE TABLE IF NOT EXISTS opd_qs_call (
  call_id INT AUTO_INCREMENT PRIMARY KEY,
  slot_id VARCHAR(50) NOT NULL,
  hn VARCHAR(50),
  vn VARCHAR(50),
  queue_no VARCHAR(20) NOT NULL,
  patient_name VARCHAR(255),
  location_id VARCHAR(20),
  room_id VARCHAR(20),
  room_name VARCHAR(100),
  call_status VARCHAR(2) DEFAULT 'Y',
  call_datetime DATETIME,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE IF NOT EXISTS service_location_config (
  location_id VARCHAR(20) PRIMARY KEY,
  display_name VARCHAR(255),
  tts_provider VARCHAR(20) DEFAULT 'google',
  recorded_room_type VARCHAR(60) DEFAULT 'doctor_room',
  voice_rate DECIMAL(3,2) DEFAULT 1.00,
  call_repeat_count TINYINT NOT NULL DEFAULT 1,
  default_room_ids TEXT,
  settings_json JSON NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE IF NOT EXISTS display_devices (
  device_id INT AUTO_INCREMENT PRIMARY KEY,
  device_name VARCHAR(120) NOT NULL,
  device_type VARCHAR(20) NOT NULL DEFAULT 'multi',
  location_id VARCHAR(20) NOT NULL,
  room_ids TEXT,
  token_hash VARCHAR(128) NOT NULL,
  allowed_ips TEXT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  last_seen_at DATETIME NULL,
  last_seen_ip VARCHAR(80) NULL,
  settings_json JSON NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_display_devices_location (location_id),
  UNIQUE KEY uq_display_devices_token_hash (token_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE IF NOT EXISTS app_sessions (
  sid VARCHAR(128) NOT NULL PRIMARY KEY,
  expires_at DATETIME NULL,
  data MEDIUMTEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_app_sessions_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
