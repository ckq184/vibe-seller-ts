// boot 可关闭性（Phase 5.2 优雅停机的可测路径）：真端口拉起（BACKEND_PORT=0）→
// health 200 → close() 按 停调度器→关 HTTP→关 DB 收尾 → 同端口连接拒绝。
// 信号本身不直测（Windows 信号语义不稳，PRD §4.3 明示允许）；scheduler.stop() 的
// 行为已由 schedules 套件覆盖，这里钉 boot 返回的真停止句柄确实可关、可重复等待。
// Phase 5 整改新增：① 服务缺省绑 loopback（BACKEND_HOST，BootHandle 暴露实际绑定
// 地址）；② 有活跃 SSE 连接时 close() 仍能在限时内完成（closeAllConnections 防挂死）。

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

const testEnv = (home: string): NodeJS.ProcessEnv => ({
  ...process.env,
  VIBE_HOME: home,
  BACKEND_PORT: "0", // 临时端口；boot 返回实际绑定端口
  JWT_SECRET: "boot-test-secret-do-not-use-in-prod",
  ADMIN_USERNAME: "admin",
  ADMIN_PASSWORD: "admin",
  ADMIN_EMAIL: "admin@boot.local",
});

describe("boot 优雅关闭", () => {
  it("boot → health 200 → close 排空后同端口连接拒绝", async () => {
    dir = mkdtempSync(join(tmpdir(), "vibe-boot-"));
    const config = readServerConfig(testEnv(dir));
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

  it("缺省未设 BACKEND_HOST → config.host=127.0.0.1 且 serve 实际绑定 127.0.0.1（loopback 红线）", async () => {
    dir = mkdtempSync(join(tmpdir(), "vibe-boot-host-"));
    const env = testEnv(dir);
    delete env.BACKEND_HOST; // 显式保证缺省路径
    const config = readServerConfig(env);
    expect(config.host).toBe("127.0.0.1");
    const booted = await boot(config);
    try {
      // BootHandle.hostname = server.address().address（实际绑定地址，非配置回显）
      expect(booted.hostname).toBe("127.0.0.1");
    } finally {
      await booted.close();
    }
  });

  it("BACKEND_HOST=127.0.0.2 → serve 收到该参数并绑定（透传钉子；loopback 别名不涉防火墙）", async () => {
    dir = mkdtempSync(join(tmpdir(), "vibe-boot-host-override-"));
    const config = readServerConfig({ ...testEnv(dir), BACKEND_HOST: "127.0.0.2" });
    expect(config.host).toBe("127.0.0.2");
    const booted = await boot(config);
    try {
      expect(booted.hostname).toBe("127.0.0.2");
      const health = await fetch(`http://127.0.0.2:${booted.port}/api/health`);
      expect(health.status).toBe(200);
    } finally {
      await booted.close();
    }
  });

  it("有活跃 SSE 连接时 close() 仍能在 5s 内完成（closeAllConnections 防挂死）", async () => {
    dir = mkdtempSync(join(tmpdir(), "vibe-boot-sse-"));
    const booted = await boot(readServerConfig(testEnv(dir)));
    let closePromise: Promise<void> | undefined;
    try {
      // 挂一条 SSE 长连接：响应头到达 = 服务端已受理并保持流（事件由 bus 推送，
      // 首个 ping 在 30s——连接在此期间不会自然结束）。
      const res = await fetch(`http://127.0.0.1:${booted.port}/api/sse`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      closePromise = booted.close();
      await Promise.race([
        closePromise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("close() 超时：活跃 SSE 连接未被切断，停机挂死")), 5000),
        ),
      ]);
    } finally {
      // 红测（未实现 closeAllConnections）时 close 永不 resolve：race 已拒绝，
      // 这里把悬挂的 close promise 安抚掉，避免未处理 rejection 噪音。
      void closePromise?.catch(() => {});
      // close 正常完成时重复调用是 no-op（server 已关），仅清残留。
      if (!closePromise) await booted.close().catch(() => {});
    }
    // 监听已关：新连接被拒
    await expect(fetch(`http://127.0.0.1:${booted.port}/api/health`)).rejects.toThrow();
  }, 15000); // it 超时须大于内部 race 的 5s，让挂死失败信息（而非笼统超时）浮出
});
