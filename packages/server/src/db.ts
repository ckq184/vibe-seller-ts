// 数据库层：node:sqlite（零原生依赖），与原 SQLAlchemy/aiosqlite 同一个
// data/vibe_seller.db 文件原地共存。批次 4.1 建 users/app_settings 两张表；
// 其余表由原后端（或后续批次）建——本层绝不删改已有表。
// 注意：不开 PRAGMA foreign_keys（原实现同样未启用，行为保持一致）。

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ServerConfig } from "./config";

export interface UserRow {
  id: string;
  username: string;
  email: string | null;
  password_hash: string;
  role: string;
  is_active: number;
  avatar_url: string | null;
  plan_mode_default: number;
  debug_mode: number;
  default_profile_id: string;
  sync_profile_to_schedules: number;
  created_at: string;
  updated_at: string;
}

export function openDb(cfg: ServerConfig): DatabaseSync {
  mkdirSync(dirname(cfg.dbPath), { recursive: true });
  const db = new DatabaseSync(cfg.dbPath);
  ensureSchema(db);
  return db;
}

/** PRAGMA-guarded ALTER：缺列才补（对齐原 _ensure_added_columns）。 */
export function ensureColumn(db: DatabaseSync, table: string, column: string, ddlType: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddlType}`);
  }
}

function ensureSchema(db: DatabaseSync): void {
  // SQLAlchemy create_all 的 DDL：Python 侧 default 不进 DDL，列无 DEFAULT 子句
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key VARCHAR NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (key)
    );
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR NOT NULL,
      username VARCHAR NOT NULL,
      email VARCHAR,
      password_hash VARCHAR NOT NULL,
      role VARCHAR NOT NULL,
      is_active BOOLEAN NOT NULL,
      avatar_url TEXT,
      plan_mode_default BOOLEAN NOT NULL,
      debug_mode BOOLEAN NOT NULL,
      default_profile_id VARCHAR(50) NOT NULL,
      sync_profile_to_schedules BOOLEAN NOT NULL,
      created_at VARCHAR,
      updated_at VARCHAR,
      PRIMARY KEY (id),
      UNIQUE (username),
      UNIQUE (email)
    );
    CREATE TABLE IF NOT EXISTS stores (
      id VARCHAR NOT NULL,
      name VARCHAR NOT NULL,
      browser_backend VARCHAR,
      browser_config TEXT,
      ziniao_account_id VARCHAR,
      browser_oauth VARCHAR,
      platforms TEXT,
      countries TEXT,
      platform_countries TEXT,
      capabilities TEXT,
      config TEXT,
      created_at VARCHAR,
      updated_at VARCHAR,
      PRIMARY KEY (id)
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id VARCHAR NOT NULL,
      parent_task_id VARCHAR,
      store_id VARCHAR,
      schedule_id VARCHAR,
      template_id VARCHAR,
      created_by VARCHAR NOT NULL,
      assigned_to VARCHAR,
      title VARCHAR NOT NULL,
      description TEXT,
      platform VARCHAR,
      country VARCHAR,
      status VARCHAR NOT NULL,
      priority INTEGER,
      input_data TEXT,
      plan TEXT,
      plan_history TEXT,
      result TEXT,
      accepted_result TEXT,
      submitted_result TEXT,
      review_gaps TEXT,
      submission_count INTEGER,
      transcript_tail TEXT,
      todos TEXT,
      error TEXT,
      error_category VARCHAR,
      started_at VARCHAR,
      completed_at VARCHAR,
      plan_mode BOOLEAN,
      is_plan_only BOOLEAN,
      plan_version INTEGER,
      skip_reflection BOOLEAN,
      wait_condition TEXT,
      batch_id VARCHAR,
      is_finalize BOOLEAN,
      ai_profile_id VARCHAR(50),
      session_id VARCHAR,
      created_at VARCHAR,
      updated_at VARCHAR,
      PRIMARY KEY (id)
    );
    CREATE INDEX IF NOT EXISTS ix_tasks_schedule_id ON tasks (schedule_id);
    CREATE INDEX IF NOT EXISTS ix_tasks_batch_id ON tasks (batch_id);
    CREATE TABLE IF NOT EXISTS task_steps (
      id VARCHAR NOT NULL,
      task_id VARCHAR NOT NULL,
      step_index INTEGER NOT NULL,
      name VARCHAR NOT NULL,
      description TEXT,
      action_type VARCHAR NOT NULL,
      action_data TEXT,
      status VARCHAR,
      screenshot_id VARCHAR,
      result TEXT,
      error TEXT,
      started_at VARCHAR,
      completed_at VARCHAR,
      created_at VARCHAR,
      PRIMARY KEY (id)
    );
    CREATE TABLE IF NOT EXISTS task_messages (
      id VARCHAR NOT NULL,
      task_id VARCHAR NOT NULL,
      role VARCHAR NOT NULL,
      content TEXT NOT NULL,
      seq INTEGER NOT NULL,
      profile_id VARCHAR(50),
      created_at VARCHAR,
      PRIMARY KEY (id)
    );
    CREATE INDEX IF NOT EXISTS ix_task_messages_task_id ON task_messages (task_id);
    CREATE TABLE IF NOT EXISTS task_logs (
      id VARCHAR NOT NULL,
      task_id VARCHAR NOT NULL,
      log_type VARCHAR,
      content TEXT NOT NULL,
      timestamp_ms INTEGER,
      PRIMARY KEY (id)
    );
    CREATE TABLE IF NOT EXISTS task_attachments (
      id VARCHAR NOT NULL,
      task_id VARCHAR NOT NULL,
      file_name VARCHAR NOT NULL,
      file_path TEXT NOT NULL,
      file_type VARCHAR NOT NULL,
      file_size INTEGER NOT NULL,
      created_at VARCHAR,
      PRIMARY KEY (id)
    );
    CREATE TABLE IF NOT EXISTS ad_task_declarations (
      id VARCHAR NOT NULL,
      task_id VARCHAR NOT NULL,
      seq INTEGER,
      kind VARCHAR NOT NULL,
      scope TEXT,
      user_turn INTEGER,
      created_at VARCHAR,
      PRIMARY KEY (id)
    );
    CREATE TABLE IF NOT EXISTS store_email_links (
      id VARCHAR NOT NULL,
      store_id VARCHAR NOT NULL,
      email_account_id VARCHAR NOT NULL,
      watermark_date VARCHAR,
      last_polled_at VARCHAR,
      seen_message_ids TEXT,
      created_at VARCHAR,
      PRIMARY KEY (id),
      UNIQUE (store_id, email_account_id)
    );
    CREATE TABLE IF NOT EXISTS browser_sessions (
      id VARCHAR NOT NULL,
      store_id VARCHAR NOT NULL,
      cdp_port INTEGER,
      proxy_port INTEGER,
      proxy_pid INTEGER,
      chrome_pid INTEGER,
      status VARCHAR,
      current_platform VARCHAR,
      current_country VARCHAR,
      current_url TEXT,
      active_tab_count INTEGER,
      started_at VARCHAR,
      updated_at VARCHAR,
      PRIMARY KEY (id),
      UNIQUE (store_id)
    );
    CREATE TABLE IF NOT EXISTS schedules (
      id VARCHAR NOT NULL,
      store_id VARCHAR,
      created_by VARCHAR NOT NULL,
      title VARCHAR NOT NULL,
      description TEXT,
      platform VARCHAR,
      country VARCHAR,
      plan TEXT,
      schedule_type VARCHAR NOT NULL,
      schedule_time VARCHAR NOT NULL,
      schedule_day INTEGER,
      interval_value INTEGER,
      timezone VARCHAR NOT NULL,
      is_active BOOLEAN,
      is_system BOOLEAN,
      phase_mode VARCHAR(32),
      staleness_check VARCHAR(32),
      skip_reflection BOOLEAN,
      finalize_description TEXT,
      finalize_enabled_at VARCHAR,
      plan_mode BOOLEAN,
      ai_profile_id VARCHAR(50),
      plan_status VARCHAR(16),
      plan_version INTEGER NOT NULL,
      current_planning_task_id VARCHAR,
      plan_error TEXT,
      created_at VARCHAR,
      updated_at VARCHAR,
      PRIMARY KEY (id)
    );
    CREATE TABLE IF NOT EXISTS schedule_state (
      schedule_id VARCHAR NOT NULL,
      store_id VARCHAR NOT NULL,
      key VARCHAR NOT NULL,
      value TEXT,
      updated_at VARCHAR,
      updated_by_task_id VARCHAR,
      PRIMARY KEY (schedule_id, store_id, key)
    );
    CREATE TABLE IF NOT EXISTS events (
      id VARCHAR NOT NULL,
      channel_message_id VARCHAR,
      channel_type VARCHAR,
      store_id VARCHAR,
      title VARCHAR NOT NULL,
      description TEXT,
      event_date VARCHAR,
      deadline VARCHAR,
      platform VARCHAR,
      source_text TEXT,
      status VARCHAR,
      sync_backend VARCHAR,
      sync_id VARCHAR,
      sync_error TEXT,
      case_id VARCHAR,
      assignees TEXT,
      created_by VARCHAR,
      priority INTEGER NOT NULL,
      created_at VARCHAR,
      updated_at VARCHAR,
      PRIMARY KEY (id)
    );
    CREATE TABLE IF NOT EXISTS event_activities (
      id VARCHAR NOT NULL,
      event_id VARCHAR NOT NULL,
      user_id VARCHAR,
      actor_type VARCHAR,
      action VARCHAR NOT NULL,
      content TEXT NOT NULL,
      extra_data TEXT,
      created_at VARCHAR,
      PRIMARY KEY (id)
    );
    CREATE TABLE IF NOT EXISTS email_accounts (
      id VARCHAR NOT NULL,
      email VARCHAR NOT NULL,
      encrypted_password VARCHAR NOT NULL,
      imap_host VARCHAR NOT NULL,
      imap_port INTEGER,
      use_ssl BOOLEAN,
      smtp_host VARCHAR,
      smtp_port INTEGER,
      smtp_use_tls BOOLEAN,
      created_by VARCHAR NOT NULL,
      created_at VARCHAR,
      updated_at VARCHAR,
      PRIMARY KEY (id),
      UNIQUE (email)
    );
    CREATE TABLE IF NOT EXISTS wecom_bots (
      id VARCHAR NOT NULL,
      name VARCHAR NOT NULL,
      webhook_url VARCHAR NOT NULL,
      created_by VARCHAR NOT NULL,
      created_at VARCHAR,
      updated_at VARCHAR,
      PRIMARY KEY (id)
    );
    CREATE TABLE IF NOT EXISTS ziniao_accounts (
      id VARCHAR NOT NULL,
      name VARCHAR NOT NULL,
      company VARCHAR NOT NULL,
      username VARCHAR NOT NULL,
      encrypted_password VARCHAR NOT NULL,
      socket_port INTEGER,
      client_path TEXT,
      created_at VARCHAR,
      updated_at VARCHAR,
      PRIMARY KEY (id)
    );
    CREATE TABLE IF NOT EXISTS screenshots (
      id VARCHAR NOT NULL,
      task_id VARCHAR NOT NULL,
      step_id VARCHAR,
      file_path VARCHAR NOT NULL,
      thumbnail_path VARCHAR,
      created_at VARCHAR,
      PRIMARY KEY (id)
    );
  `);
  // 老库补列（原地升级兜底）：原 app/database.py:36-84 `_ensure_added_columns` 全量移植。
  // create_all 只建缺表、绝不 ALTER 已有表，列是分期上线的——老 Python 版本的库直跳
  // TS 时靠这里逐条补齐。PRAGMA 守卫幂等，每次启动可重跑；ALTER 文本逐条对齐原实现
  // （注意与上方 create_all 的差异：SQLite 对存量行加 NOT NULL 列必须显式带 DEFAULT，
  // 原实现正是这样写的）。
  // 以下前 2 条为批次 4.4 既有；其余 14 条 = 原 Python 列表全量（无删减）。
  ensureColumn(db, "schedules", "plan_mode", "BOOLEAN");
  ensureColumn(db, "schedules", "ai_profile_id", "VARCHAR(50)");
  ensureColumn(db, "schedules", "finalize_description", "TEXT");
  // Backfilled below — see _backfill_finalize_enabled_at 等价注释（原 :48-49）
  ensureColumn(db, "schedules", "finalize_enabled_at", "TEXT");
  ensureColumn(db, "tasks", "is_finalize", "BOOLEAN NOT NULL DEFAULT 0");
  ensureColumn(db, "tasks", "plan_mode", "BOOLEAN NOT NULL DEFAULT 0");
  ensureColumn(db, "tasks", "is_plan_only", "BOOLEAN NOT NULL DEFAULT 0");
  ensureColumn(db, "tasks", "skip_reflection", "BOOLEAN NOT NULL DEFAULT 0");
  ensureColumn(db, "tasks", "plan_version", "INTEGER");
  // Outcome 模型：submission 独立留存，流式 prose 不再与交付物共列（原 :60-66 注释）
  ensureColumn(db, "tasks", "accepted_result", "TEXT");
  ensureColumn(db, "tasks", "submitted_result", "TEXT");
  ensureColumn(db, "tasks", "review_gaps", "TEXT");
  ensureColumn(db, "tasks", "submission_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "tasks", "transcript_tail", "TEXT");
  // 用户偏好：default profile 变更时回钉自有调度（原 :67-68）
  ensureColumn(db, "users", "sync_profile_to_schedules", "BOOLEAN NOT NULL DEFAULT 0");
  // 店铺实际产能（FBA / ads / FBN），区别于销售地（原 :69-71）
  ensureColumn(db, "stores", "capabilities", "TEXT NOT NULL DEFAULT '{}'");
  // 原 _backfill_finalize_enabled_at（database.py:87-109）：升级时刻武装存量 finalize
  // 调度——已有 finalize 提示而无时间戳的老行，诚实读法是"从本次升级起"生效（更早的
  // 批次早已在无 finalize 的情况下完成，无人欠它们补终局）。自限：只碰
  // finalize_description 非空且时间戳为 NULL 的行，首启后即稳定为 no-op。
  db.prepare(
    "UPDATE schedules SET finalize_enabled_at = ? " +
      "WHERE finalize_enabled_at IS NULL AND finalize_description IS NOT NULL AND TRIM(finalize_description) != ''",
  ).run(new Date().toISOString());
}

export interface DbBundle {
  db: DatabaseSync;
}

/** 启动种子：对齐原 init_db——auth_required 首启 'true'；admin 每次启动重置凭据；ai_bot 兜底。 */
export function seed(db: DatabaseSync, cfg: ServerConfig, hashPassword: (plain: string) => string): void {
  const now = new Date().toISOString();
  const getSetting = db.prepare("SELECT value FROM app_settings WHERE key = ?");
  const setSetting = db.prepare(
    "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING",
  );
  if (!getSetting.get("auth_required")) setSetting.run("auth_required", "true");

  const upsertUser = db.prepare(`
    INSERT INTO users (id, username, email, password_hash, role, is_active, avatar_url,
                       plan_mode_default, debug_mode, default_profile_id, sync_profile_to_schedules,
                       created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, NULL, 0, 0, 'default', 0, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      username = excluded.username,
      email = excluded.email,
      password_hash = excluded.password_hash,
      role = excluded.role,
      is_active = 1,
      updated_at = excluded.updated_at
  `);
  upsertUser.run(
    "00000000-0000-0000-0000-000000000001",
    cfg.adminUsername,
    cfg.adminEmail,
    hashPassword(cfg.adminPassword),
    "admin",
    now,
    now,
  );
  const aiBot = db.prepare("SELECT id FROM users WHERE id = ?");
  if (!aiBot.get("00000000-0000-0000-0000-000000000002")) {
    db.prepare(
      `INSERT INTO users (id, username, email, password_hash, role, is_active, avatar_url,
                          plan_mode_default, debug_mode, default_profile_id, sync_profile_to_schedules,
                          created_at, updated_at)
       VALUES ('00000000-0000-0000-0000-000000000002', 'ai_bot', 'ai@vibe-seller.local', 'disabled', 'ai_bot',
               1, NULL, 0, 0, 'default', 0, ?, ?)`,
    ).run(now, now);
  }

  // 系统 catalog 调度（原 init_db database.py:190-216，按 id 判存 = fresh install 才种）：
  // two_phase + staleness_check='catalog' + skip_reflection，创建人 = ai_bot；
  // timezone 列原模型缺省 get_server_timezone()。
  if (!db.prepare("SELECT id FROM schedules WHERE id = '_catalog_sync'").get()) {
    db.prepare(
      `INSERT INTO schedules (id, store_id, created_by, title, description, platform, country, plan,
                              schedule_type, schedule_time, schedule_day, interval_value, timezone,
                              is_active, is_system, phase_mode, staleness_check, skip_reflection,
                              finalize_description, finalize_enabled_at, plan_mode, ai_profile_id,
                              plan_status, plan_version, current_planning_task_id, plan_error,
                              created_at, updated_at)
       VALUES ('_catalog_sync', NULL, '00000000-0000-0000-0000-000000000002', 'Update Knowledge Catalogs', ?,
               NULL, NULL, NULL, 'days', '03:00', NULL, 1, ?, 1, 1, 'two_phase', 'catalog', 1,
               NULL, NULL, 0, 'default', 'none', 0, NULL, NULL, ?, ?)`,
    ).run(
      "Regenerate knowledge catalogs in two phases: L2 (global knowledge/) then L3 (per-store). " +
        "Each level accumulates entries from the level below. Old catalogs have been removed — you MUST write new ones.",
      serverTimezone(),
      now,
      now,
    );
  }
}

/** 服务器 IANA 时区（原 get_server_timezone；解析失败回 UTC）。 */
function serverTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function getUserById(db: DatabaseSync, id: string): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
}

export function getSetting(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function isAuthRequired(db: DatabaseSync): boolean {
  const value = getSetting(db, "auth_required");
  if (!value) return false;
  return ["true", "1"].includes(value.trim().toLowerCase());
}
