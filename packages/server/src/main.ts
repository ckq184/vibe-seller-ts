// 服务端引导：配置 → 密钥 → DB（建表+种子）→ app → 监听。
// 与原后端同库同路径，可与 Python 后端交替启动（不并存写）。
// 遥测启动序列（原 main.py lifespan 对齐）：持久化开关 → telemetry.init() →
// 安装规模计数 → app_started；测试/CI 环境被门控拦住，不触发网络。
// 本文件是 npm start（scripts/dev-start.mjs：esbuild 临时 bundle 后进程内 import，
// 仅本机开发用——PRD 预裁决的 strip-types 直跑实测不可行，证据链见脚手架头注释）
// 的入口；分发形态是 Phase 5.3 的单文件 bundle，届时替换。

import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type { ServerConfig } from "./config";
import { resolveJwtSecret } from "./config";
import { getSetting, openDb, seed } from "./db";
import { createApp, hashPassword } from "./app";
import type { VibeScheduler } from "./scheduler/scheduler";
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

/** boot 句柄：port/hostname = 实际绑定地址（config.port=0 时 port 为系统分配值；
 * hostname 随 BACKEND_HOST 可变）；close = 优雅关闭。 */
export interface BootHandle {
  port: number;
  hostname: string;
  close: () => Promise<void>;
}

export async function boot(config: ServerConfig): Promise<BootHandle> {
  const jwtSecret = resolveJwtSecret(config);
  const db = openDb(config);
  seed(db, config, hashPassword);
  applyPersistedTelemetryFlag(db);
  telemetry.init(config.dataDir);
  const bus = new EventBus();
  let scheduler: VibeScheduler | undefined;
  const app = createApp({
    config,
    jwtSecret,
    db,
    bus,
    runScheduler: true,
    bootSync: true,
    schedulerSink: (s) => {
      scheduler = s;
    },
  });
  // 缺省绑 127.0.0.1（config.host，BACKEND_HOST 可覆盖）——与随包文档承诺一致：
  // 服务只听 loopback；改绑 0.0.0.0 属用户显式决定（docs/deploy.md）。
  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host ?? "127.0.0.1" });
  if (!server.address()) {
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  }
  // 启动序列末尾发 app_started（原 lifespan 在各子系统拉起后计数上报）
  sendAppStarted(db);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : config.port;
  const hostname = typeof addr === "object" && addr ? addr.address : (config.host ?? "127.0.0.1");
  console.log(`[vibe-server] listening on ${hostname}:${port} (db=${config.dbPath})`);
  return {
    port,
    hostname,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // 优雅停机序 = 原 stop.sh 清理语义的 TS 最小集（PRD §4.3 预裁决）：
        // 停调度器（不再 tick）→ 关 HTTP（先停监听，再切断存量连接——SSE 等
        // 长连接不会自然结束，不切断则排空永远等不完，Node ≥18.2 的
        // closeAllConnections）→ 关 DB → flush 遥测（await 完成后才 resolve，
        // 调用方随后才 process.exit，flush 与退出的竞速由此消除）。
        // 浏览器清扫不在停机路径做（原 reap_agents 是 stop.sh 对 SIGKILL 孤儿进程
        // 的兜底；TS 侧浏览器会话复位已由启动恢复承担）。
        try {
          scheduler?.stop();
        } catch {
          /* 未启动/已停 */
        }
        // closeAllConnections 必须在发起 close 之后立刻同步调用、不能放进 close
        // 回调——回调要等全部连接结束才触发，SSE 挂着它就永远不会执行（实测挂死）。
        server.close((err) => {
          try {
            db.close();
          } catch {
            /* 已关闭 */
          }
          // shutdown 自吞异常（与原 lifespan 退出 flush 一致），finally 保证 close 必定收尾
          void telemetry.shutdown().finally(() => {
            err ? reject(err) : resolve();
          });
        });
        // ServerType 联合未声明 closeAllConnections（http2 分支没有）；serve 走
        // node:http Server（≥18.2 有该方法），Partial 收窄 + 运行时 ?. 兜底。
        (server as Partial<Server>).closeAllConnections?.();
      }),
  };
}

// 自启守卫："本模块是 node 入口"才 boot（import.meta.url 与 argv[1] 同一文件）。
// npm start 经 scripts/dev-start.mjs 把本文件打成临时 bundle 后进程内 import，
// 脚手架把 argv[1] 指向 bundle——守卫照常成立；vitest/e2e 的普通 import 不触发。
const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMain) {
  const { readServerConfig } = await import("./config");
  const booted = await boot(readServerConfig());
  // 优雅关闭（SIGINT=Ctrl+C / SIGTERM）：close 内部已按 停调度器→HTTP(切断存量
  // 连接)→DB→flush 遥测 排空；第二次信号 = 排水卡住（如某个不肯退的连接），
  // 强制 process.exit(1)——用户可辨，不必等悬挂的停机序列。
  // Windows 无真 SIGTERM，taskkill/Ctrl+C 由 Node 映射，信号本身不直测（语义不稳）。
  let shutdownSignals = 0;
  const shutdown = (signal: string): void => {
    shutdownSignals += 1;
    if (shutdownSignals > 1) {
      console.error(`[vibe-server] ${signal} received again; graceful shutdown stalled, forcing exit(1)`);
      process.exit(1);
    }
    console.log(`[vibe-server] ${signal} received; shutting down (scheduler → http → db)`);
    booted.close().then(
      () => process.exit(0),
      (err: unknown) => {
        console.error("[vibe-server] shutdown error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
