// 服务端引导：配置 → 密钥 → DB（建表+种子）→ app → 监听。
// 与原后端同库同路径，可与 Python 后端交替启动（不并存写）。

import { serve } from "@hono/node-server";
import type { ServerConfig } from "./config";
import { resolveJwtSecret } from "./config";
import { openDb, seed } from "./db";
import { createApp, hashPassword } from "./app";
import { EventBus } from "./bus";

export function boot(config: ServerConfig): { port: number; close: () => Promise<void> } {
  const jwtSecret = resolveJwtSecret(config);
  const db = openDb(config);
  seed(db, config, hashPassword);
  const bus = new EventBus();
  const app = createApp({ config, jwtSecret, db, bus, runScheduler: true, bootSync: true });
  const server = serve({ fetch: app.fetch, port: config.port });
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
