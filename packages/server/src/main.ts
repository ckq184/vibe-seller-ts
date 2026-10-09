// 服务端引导：配置 → 密钥 → DB（建表+种子）→ app → 监听。
// 与原后端同库同路径，可与 Python 后端交替启动（不并存写）。
// 遥测启动序列（原 main.py lifespan 对齐）：持久化开关 → telemetry.init() →
// 安装规模计数 → app_started；测试/CI 环境被门控拦住，不触发网络。

import { serve } from "@hono/node-server";
import type { DatabaseSync } from "node:sqlite";
import type { ServerConfig } from "./config";
import { resolveJwtSecret } from "./config";
import { getSetting, openDb, seed } from "./db";
import { createApp, hashPassword } from "./app";
import { EventBus } from "./bus";
import * as telemetry from "./telemetry/core";
import { TelemetryEvent } from "./telemetry/events";

/** 原 _apply_persisted_telemetry_flag：读 settings 行 telemetry_enabled，
 * value=='false' → set_db_disabled(True)；读库异常只 debug。 */
export function applyPersistedTelemetryFlag(db: DatabaseSync): void {
  try {
    const value = getSetting(db, telemetry.SETTINGS_KEY);
    telemetry.setDbDisabled(value === "false");
  } catch {
    console.debug("[vibe-telemetry] no persisted telemetry flag");
  }
}

/** 原 lifespan 的 app_started 计数段：store/task/活动 schedule/user 裸 int；
 * 统计失败发空 props（base properties 仍由 send() 合入）。countFn 可注入
 * （单测注入抛错查询覆盖统计失败分支，不必造坏库）。 */
export function sendAppStarted(db: DatabaseSync, countFn?: (sql: string) => number): void {
  let props: Record<string, unknown>;
  try {
    const count = countFn ?? ((sql: string): number => (db.prepare(sql).get() as { n: number }).n);
    props = {
      store_count: count("SELECT COUNT(*) AS n FROM stores"),
      total_task_count: count("SELECT COUNT(*) AS n FROM tasks"),
      active_schedule_count: count("SELECT COUNT(*) AS n FROM schedules WHERE is_active = 1"),
      user_count: count("SELECT COUNT(*) AS n FROM users"),
    };
  } catch {
    props = {};
  }
  telemetry.send(TelemetryEvent.APP_STARTED, props);
}

export function boot(config: ServerConfig): { port: number; close: () => Promise<void> } {
  const jwtSecret = resolveJwtSecret(config);
  const db = openDb(config);
  seed(db, config, hashPassword);
  applyPersistedTelemetryFlag(db);
  telemetry.init(config.dataDir);
  const bus = new EventBus();
  const app = createApp({ config, jwtSecret, db, bus, runScheduler: true, bootSync: true });
  const server = serve({ fetch: app.fetch, port: config.port });
  // 启动序列末尾发 app_started（原 lifespan 在各子系统拉起后计数上报）
  sendAppStarted(db);
  console.log(`[vibe-server] listening on 127.0.0.1:${config.port} (db=${config.dbPath})`);
  return {
    port: config.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          try {
            db.close();
          } catch {
            /* 已关闭 */
          }
          void telemetry.shutdown(); // 原 lifespan 退出时 flush
          err ? reject(err) : resolve();
        });
      }),
  };
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("main.ts");
if (isMain) {
  const { readServerConfig } = await import("./config");
  boot(readServerConfig());
}
