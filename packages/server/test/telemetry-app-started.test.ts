// 批次 4.7 整改 F：sendAppStarted 直测（批次 4.7.1 的事件面只经 boot 间接可达，
// 测试不触发 boot）。transport 注入假捕获（telemetry.__test.enable）+ 计数查询
// 可注入（main.sendAppStarted 的 countFn 参数），绝不真网。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as telemetry from "../src/telemetry/core";
import { TelemetryEvent } from "../src/telemetry/events";
import { sendAppStarted } from "../src/main";
import { openDb, seed } from "../src/db";
import { hashPassword } from "../src/app";
import type { DatabaseSync } from "node:sqlite";
import type { ServerConfig } from "../src/config";

let dir: string;
let db: DatabaseSync;
let captured: { event: string; properties: Record<string, unknown> }[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibe-app-started-"));
  const cfg: ServerConfig = {
    homeDir: dir,
    dataDir: join(dir, "data"),
    dbPath: join(dir, "data", "vibe_seller.db"),
    jwtSecretFile: join(dir, "data", "jwt_secret"),
    port: 0,
    adminEmail: "admin@vibe-seller.local",
    adminPassword: "admin",
    adminUsername: "admin",
    version: "0.1.0-test",
    jwtSecret: "test-secret",
  };
  db = openDb(cfg);
  seed(db, cfg, hashPassword); // admin + ai_bot 两个用户 + 活动 catalog 系统调度
});

afterAll(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("sendAppStarted（原 main.py lifespan 计数段直测）", () => {
  it("种子库计数：四计数裸 int（store 0 / task 0 / 活动 schedule 1 / user 2）+ base properties 合入", () => {
    captured = [];
    telemetry.__test.enable(captured);
    sendAppStarted(db);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.event).toBe(TelemetryEvent.APP_STARTED);
    const props = captured[0]!.properties;
    expect(props.store_count).toBe(0);
    expect(props.total_task_count).toBe(0);
    expect(props.active_schedule_count).toBe(1); // seed 的 _catalog_sync is_active
    expect(props.user_count).toBe(2); // admin + ai_bot
    // base properties 由 send() 合入，caller 四计数不被覆盖
    expect(props.app_version).toBe(telemetry.APP_VERSION);
    expect(props).toHaveProperty("node_version");
  });

  it("统计失败（注入抛错计数查询）→ 发空 props，事件本身照发", () => {
    captured = [];
    telemetry.__test.enable(captured);
    sendAppStarted(db, () => {
      throw new Error("db boom");
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.event).toBe(TelemetryEvent.APP_STARTED);
    expect(captured[0]!.properties).toEqual({ ...telemetry.baseProperties() });
  });

  it("门控关闭（db_disabled）→ 不发送", () => {
    captured = [];
    telemetry.__test.enable(captured);
    telemetry.setDbDisabled(true);
    try {
      sendAppStarted(db);
      expect(captured).toHaveLength(0);
    } finally {
      telemetry.setDbDisabled(false);
    }
  });
});
