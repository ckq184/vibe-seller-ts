// 老库补列测试（Phase 5.2 原地升级兜底）：手工建"缺全部补列"的最小老 schema 库
// （很老 Python 版本的表形状：受影响表只有早期列，各插一行老数据），openDb 后——
//   ① 原 app/database.py `_ensure_added_columns` 的 14 条补列 + 既有 2 条
//      （schedules.plan_mode/ai_profile_id，批次 4.4）全部在位；
//   ② 老数据读回不丢；ALTER 的显式 DEFAULT 对存量行生效（NOT NULL 列补 0/'{}'）；
//   ③ `_backfill_finalize_enabled_at`：有 finalize 提示的老行按升级时刻武装，
//      无提示的行不碰，finalize_description 保持原值；再次 openDb 幂等（不重打戳）。
// 旧表必须手工建（create_all 看到表已存在就跳过）——确保走的确实是 ALTER 补列路径。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import type { ServerConfig } from "../src/config";

let dir: string;

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function minimalConfig(dbPath: string): ServerConfig {
  return {
    homeDir: join(dir, "home"),
    dataDir: join(dir, "home"),
    dbPath,
    jwtSecretFile: join(dir, "home", "jwt_secret"),
    port: 0,
    adminEmail: "admin@vibe-seller.local",
    adminPassword: "admin",
    adminUsername: "admin",
    version: "0.1.0-test",
    jwtSecret: "test-secret",
  };
}

function columnNames(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

describe("ensureSchema 老库补列（_ensure_added_columns 全量移植）", () => {
  it("缺全部补列的老库 → openDb 后 16 列全在、老数据读回不丢、finalize 存量按升级时刻武装", () => {
    dir = mkdtempSync(join(tmpdir(), "vibe-db-upgrade-"));
    const dbPath = join(dir, "vibe_seller.db");

    // 最小老 schema：只含早期列（finalize_description 早于 finalize_enabled_at，
    // 与原实现"列是分期上线的"一致）；缺 16 列——tasks 10 + schedules 4 + users 1 + stores 1。
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE users (id VARCHAR NOT NULL, username VARCHAR NOT NULL, PRIMARY KEY (id));
      CREATE TABLE stores (id VARCHAR NOT NULL, name VARCHAR NOT NULL, PRIMARY KEY (id));
      CREATE TABLE tasks (id VARCHAR NOT NULL, title VARCHAR NOT NULL, status VARCHAR NOT NULL,
        schedule_id VARCHAR, batch_id VARCHAR, PRIMARY KEY (id));
      CREATE TABLE schedules (id VARCHAR NOT NULL, title VARCHAR NOT NULL, finalize_description TEXT, PRIMARY KEY (id));
      INSERT INTO users VALUES ('u1', 'alice');
      INSERT INTO stores VALUES ('s1', '老店铺');
      INSERT INTO tasks (id, title, status) VALUES ('t1', '老任务', 'completed');
      INSERT INTO schedules VALUES ('sc1', '老调度', 'finalize 上一批');
      INSERT INTO schedules VALUES ('sc2', '无 finalize', NULL);
    `);
    legacy.close();

    const db = openDb(minimalConfig(dbPath));

    // ① 补列全在（16 条 = 既有 2 + 原实现 14）
    expect(columnNames(db, "tasks")).toEqual(
      expect.arrayContaining([
        "is_finalize",
        "plan_mode",
        "is_plan_only",
        "skip_reflection",
        "plan_version",
        "accepted_result",
        "submitted_result",
        "review_gaps",
        "submission_count",
        "transcript_tail",
      ]),
    );
    expect(columnNames(db, "schedules")).toEqual(
      expect.arrayContaining(["finalize_description", "finalize_enabled_at", "plan_mode", "ai_profile_id"]),
    );
    expect(columnNames(db, "users")).toContain("sync_profile_to_schedules");
    expect(columnNames(db, "stores")).toContain("capabilities");

    // ② 老数据读回不丢；ALTER 的 NOT NULL DEFAULT 对存量行生效
    const task = db.prepare("SELECT * FROM tasks WHERE id = 't1'").get() as Record<string, unknown>;
    expect(task.title).toBe("老任务");
    expect(task.status).toBe("completed");
    expect(Number(task.is_finalize)).toBe(0);
    expect(Number(task.plan_mode)).toBe(0);
    expect(Number(task.submission_count)).toBe(0);
    expect(task.accepted_result).toBeNull();

    const store = db.prepare("SELECT * FROM stores WHERE id = 's1'").get() as Record<string, unknown>;
    expect(store.name).toBe("老店铺");
    expect(store.capabilities).toBe("{}");

    const user = db.prepare("SELECT * FROM users WHERE id = 'u1'").get() as Record<string, unknown>;
    expect(user.username).toBe("alice");
    expect(Number(user.sync_profile_to_schedules)).toBe(0);

    // ③ finalize 存量武装：有提示的行打升级时刻戳、提示保持原值；无提示的行不碰
    const withFinalize = db.prepare("SELECT * FROM schedules WHERE id = 'sc1'").get() as Record<string, unknown>;
    expect(withFinalize.finalize_description).toBe("finalize 上一批");
    expect(typeof withFinalize.finalize_enabled_at).toBe("string");
    expect(withFinalize.finalize_enabled_at as string).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const withoutFinalize = db.prepare("SELECT * FROM schedules WHERE id = 'sc2'").get() as Record<string, unknown>;
    expect(withoutFinalize.finalize_enabled_at).toBeNull();

    // 幂等：同库再 openDb，列不重复报错、时间戳不重打（backfill 只碰 NULL 行）
    const stamp = withFinalize.finalize_enabled_at as string;
    db.close();
    const reopened = openDb(minimalConfig(dbPath));
    const again = reopened.prepare("SELECT * FROM schedules WHERE id = 'sc1'").get() as Record<string, unknown>;
    expect(again.finalize_enabled_at).toBe(stamp);
    reopened.close();
  });
});
