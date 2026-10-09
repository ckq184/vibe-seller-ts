// boot 可关闭性（Phase 5.2 优雅停机的可测路径）：真端口拉起（BACKEND_PORT=0）→
// health 200 → close() 按 停调度器→关 HTTP→关 DB 收尾 → 同端口连接拒绝。
// 信号本身不直测（Windows 信号语义不稳，PRD §4.3 明示允许）；scheduler.stop() 的
// 行为已由 schedules 套件覆盖，这里钉 boot 返回的真停止句柄确实可关、可重复等待。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { boot } from "../src/main";
import { readServerConfig } from "../src/config";

let dir: string;

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("boot 优雅关闭", () => {
  it("boot → health 200 → close 排空后同端口连接拒绝", async () => {
    dir = mkdtempSync(join(tmpdir(), "vibe-boot-"));
    const config = readServerConfig({
      ...process.env,
      VIBE_HOME: dir,
      BACKEND_PORT: "0", // 临时端口；boot 返回实际绑定端口
      JWT_SECRET: "boot-test-secret-do-not-use-in-prod",
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "admin",
      ADMIN_EMAIL: "admin@boot.local",
    });
    const booted = await boot(config);
    try {
      expect(booted.port).toBeGreaterThan(0);
      const health = await fetch(`http://127.0.0.1:${booted.port}/api/health`);
      expect(health.status).toBe(200);
      expect((await health.json()) as { status: string }).toMatchObject({ status: "ok" });
    } finally {
      await booted.close();
    }
    // 监听已关：新连接被拒（close() 在 server 回调完成后才 resolve）
    await expect(fetch(`http://127.0.0.1:${booted.port}/api/health`)).rejects.toThrow();
  });
});
