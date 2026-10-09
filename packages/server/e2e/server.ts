// e2e 专用 server 引导：以真端口拉起 TS server（@hono/node-server serve，
// BACKEND_PORT=0 临时端口），同时保留 db / bus / telemetry 的进程内引用供
// 服务端断言（订阅者数、app_settings 行、app_locale）。这是测试基建首次真监听
// （契约测试走 app.request，不占端口）。
//
// 与 src/main.ts boot() 的差异只有一处（均有因）：
//   runScheduler:false / bootSync:false —— e2e 只验证前端关键流；调度器系统作业
//   与 knowledge/skills 远端同步检查会引入时间与网络不确定性（零真网红线），
//   沿用 createApp 的测试缺省（同契约测试）。其余序列（密钥 → DB → 种子 →
//   持久化遥测开关 → telemetry.init → serve）与 boot() 一致。
//
// 零改动红线（5.3 起语义）：前端源已 vendor 进本仓 frontend/，"零改动" =
// vendor 树与哈希清单逐一一致（清单 = 参考仓库字节级快照，见
// packages/server/test/frontend-vendor.test.ts 与 scripts/vendor-frontend.mjs
// --check）；构建产物（frontend/dist）允许随时重建，不在红线内。server 对
// 该目录只读（app.ts notFound 兜底 readFile）。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { serve } from "@hono/node-server";
import { createApp, hashPassword, openDb, readServerConfig, resolveJwtSecret, seed, EventBus } from "../src/index";
import { applyPersistedTelemetryFlag } from "../src/main";
import * as telemetry from "../src/telemetry/core";

// 前端资产：vendor 进本仓的 frontend/ 构建产物（scripts/vendor-frontend.mjs +
// corepack pnpm build，见 package.json）；默认路径即 <repoRoot>/frontend/dist——
// 批次 5.3 收口批次 4.7 台账第 8 项"硬编码参考仓库路径"。可用 FRONTEND_DIST 覆盖。
// 刻意用正斜杠形式（跨平台脚本常见写法）：批次 4.7 曾因 app.ts SPA 前缀守卫
// 未归一两侧路径分隔符导致资产全部落 index.html 白屏——修复后此处即为该
// 缺陷的真实浏览器回归钉（spa.test.ts 是同缺陷的契约级钉子）。
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const FRONTEND_DIST = process.env.FRONTEND_DIST ?? join(REPO_ROOT, "frontend", "dist");

export interface E2eServer {
  baseUrl: string;
  db: DatabaseSync;
  bus: EventBus;
  adminUsername: string;
  adminPassword: string;
  close: () => void;
}

let singleton: Promise<E2eServer> | undefined;

/** 模块级单例：单 worker 下整个 e2e 共享一个真端口 server。 */
export function startE2eServer(): Promise<E2eServer> {
  singleton ??= boot();
  return singleton;
}

async function boot(): Promise<E2eServer> {
  const homeDir = mkdtempSync(join(tmpdir(), "vibe-e2e-"));
  const config = readServerConfig({
    ...process.env,
    VIBE_HOME: homeDir,
    FRONTEND_DIST,
    BACKEND_PORT: "0", // 临时端口；listening 后从 address() 读实际端口
    JWT_SECRET: "e2e-fixed-jwt-secret-do-not-use-in-prod",
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "vibe-e2e-admin",
    ADMIN_EMAIL: "admin@e2e.local",
  });
  const jwtSecret = resolveJwtSecret(config);
  const db = openDb(config);
  seed(db, config, hashPassword); // admin 凭据每次启动重置（db.ts seed 契约）
  applyPersistedTelemetryFlag(db);
  telemetry.init(config.dataDir); // NODE_ENV=test（playwright.config.ts 置）→ 门控不建客户端，服务端零外呼
  const bus = new EventBus();
  const app = createApp({ config, jwtSecret, db, bus, runScheduler: false, bootSync: false });
  const server = serve({ fetch: app.fetch, port: config.port });
  if (!server.address()) {
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  }
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    db,
    bus,
    adminUsername: config.adminUsername,
    adminPassword: config.adminPassword,
    close: () => {
      server.close();
      try {
        db.close();
      } catch {
        /* 已关闭 */
      }
      // 批次 4.7 整改 E2：SSE keep-alive 连接未排空时 Windows 句柄未释放会
      // EBUSY——参照 replay.test.ts teardown 的 maxRetries/retryDelay 模式重试。
      rmSync(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}
