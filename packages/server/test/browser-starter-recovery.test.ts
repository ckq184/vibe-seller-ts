// 浏览器启动可靠性回归（2026-10-12 实测事故钉子）。事故链：孤儿 Chrome（detached，
// 跨服务重启存活）占着 browser_profiles 下的 user-data-dir → 新 spawn 被 Chrome 单实例
// 机制转发后立即退出、调试端口永不出现 → 就绪等待 10s 超时（"未能暴露调试端口"）；期间
// 全局启动锁被持有 → 并行任务的浏览器操作全部 "Browser launch skipped"。
// 本文件钉死三层防御：
//   ① cleanupStaleSessions 先按 profileRoot 扫杀孤儿进程（覆盖无 DB 行的 '_web'），再复位行；
//   ② 全局启动锁"忙"从立即抛改为**有界等待**：持有者释放后接力成功，等满窗口仍被占才按
//      原文案忙抛（点名持有者/时长，语义兼容）；
//   ③ 就绪超时错误可观测：超时文案（readinessTimeoutMessage）对"进程已秒退"（单实例冲突
//      指纹）报 exited immediately + chrome-stderr.log 路径；stderr 真实落盘——
//      stdio:"ignore" 是本次事故零可观测的根因之一。
// 零真 Chrome：VIBE_CHROME_PATH=process.execPath（node.exe 带非法参数即退，机制说明见
// browser-starter-ensure.test.ts 文件头）。

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, seed } from "../src/db";
import { hashPassword } from "../src/app";
import type { ServerConfig } from "../src/config";
import { BrowserStarter, BrowserBusyError, orphanKillCommand, readinessTimeoutMessage } from "../src/browser/starter";

let dir: string;
let db: import("node:sqlite").DatabaseSync;
let config: ServerConfig;
let prevChromePath: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibe-bsr-"));
  config = {
    homeDir: dir,
    dataDir: join(dir, "data"),
    dbPath: join(dir, "data", "vibe_seller.db"),
    jwtSecretFile: join(dir, "data", "jwt_secret"),
    port: 0,
    adminEmail: "a@b.c", adminPassword: "admin", adminUsername: "admin",
    version: "t", jwtSecret: "test-secret",
  };
  db = openDb(config);
  seed(db, config, hashPassword);
  prevChromePath = process.env["VIBE_CHROME_PATH"];
  process.env["VIBE_CHROME_PATH"] = process.execPath;
});

afterEach(async () => {
  if (prevChromePath === undefined) delete process.env["VIBE_CHROME_PATH"];
  else process.env["VIBE_CHROME_PATH"] = prevChromePath;
  db.close();
  await rm(dir, { recursive: true, force: true });
});

const okAlways = () => (async () => new Response("{}", { status: 200 })) as typeof fetch;
const neverOk = () => (async () => { throw new Error("no network in tests"); }) as typeof fetch;
/** 前 delayMs 毫秒探针必败：持有者借就绪等待占锁 ≈delayMs 的时间。 */
const delayedOk = (delayMs: number) => {
  const t0 = Date.now();
  return (async () => {
    if (Date.now() - t0 < delayMs) throw new Error("not ready yet");
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
};

describe("全局启动锁：有界等待（忙不再立即抛）", () => {
  it("持有者释放后等待方接力成功：同一把模块级锁跨 starter 实例生效", async () => {
    // 持有者探针 ~300ms 才 ok（占锁 ≈300ms）；等待方默认窗口（12s）远大于其持锁时长。
    // 等待方用不同 key（店铺会话）：'_web' 会话在持有者 spawn 后即入 Map，okAlways
    // 探针会让等待方快路径"复用"持有者端口、绕过锁——换 key 才真实走慢路径的锁接力。
    const holder = new BrowserStarter({ config, db, readinessTimeoutMs: 2000, fetchImpl: delayedOk(300) });
    const waiter = new BrowserStarter({ config, db, readinessTimeoutMs: 2000, fetchImpl: okAlways() });
    const [h, w] = await Promise.all([
      holder.ensureWebChrome(true),
      waiter.ensureStoreChrome({ id: "st-lock-relay", name: "接力店" }, true),
    ]);
    expect(h.cdpPort).toBeGreaterThan(0);
    expect(w.cdpPort).toBeGreaterThan(0);
    // 接力拿到的是等待方自己的会话（持有者释放后串行进入慢路径）
    expect(w.cdpPort).not.toBe(h.cdpPort);
    const row = db.prepare("SELECT status FROM browser_sessions WHERE store_id = 'st-lock-relay'").get() as { status: string };
    expect(row.status).toBe("running");
  });

  it("等满窗口仍被占 → BrowserBusyError，文案点名持有者与全局锁（原语义兼容）", async () => {
    // 持有者探针 800ms 内永不开端口（占锁 800ms）；等待方只肯等 100ms。
    // 等待方探针也用 neverOk：okAlways 会把持有者刚入 Map 的死会话谎报为存活、
    // 快路径直接复用而绕过锁（见上一用例注释）。
    const holder = new BrowserStarter({ config, db, readinessTimeoutMs: 800, fetchImpl: neverOk() });
    const waiter = new BrowserStarter({ config, db, launchLockWaitMs: 100, fetchImpl: neverOk() });
    const held = holder.ensureWebChrome(true).catch(() => "holder settled");
    await expect(waiter.ensureWebChrome(true)).rejects.toBeInstanceOf(BrowserBusyError);
    await expect(waiter.ensureWebChrome(true)).rejects.toThrow(/global launch lock/);
    await held;
  });
});

describe("readinessTimeoutMessage（超时文案：秒退指纹 + stderr 路径）", () => {
  const log = "C:\\p\\browser_profiles\\_web\\chrome-stderr.log";

  it("进程已秒退（exitCode 非空）→ exited immediately + 冲突处置指引 + 日志路径", () => {
    const msg = readinessTimeoutMessage(4242, 10_000, { code: 9 }, log);
    expect(msg).toMatch(/pid 4242/);
    expect(msg).toMatch(/did not expose its debugging port within 10000ms/);
    expect(msg).toMatch(/exited immediately \(exit 9\)/);
    expect(msg).toContain("leftover Chrome");
    expect(msg).toContain(log);
  });

  it("信号终止（signalCode）同样按秒退处理", () => {
    expect(readinessTimeoutMessage(7, 10_000, { code: "SIGKILL" }, log)).toMatch(/exited immediately \(exit SIGKILL\)/);
  });

  it("进程仍在运行 → 维持原 inspect 提示，stderr 路径照给", () => {
    const msg = readinessTimeoutMessage(4242, 10_000, { code: null }, log);
    expect(msg).not.toMatch(/exited immediately/);
    expect(msg).toMatch(/inspect the Chrome process/);
    expect(msg).toContain(log);
  });
});

describe("就绪超时（集成）：秒退指纹真实出现在错误里，stderr 落盘", () => {
  it("node.exe 秒退 → 300ms 超时错误含 exited immediately + 日志路径；文件存在且非空", async () => {
    // 300ms：node.exe（非法参数即退）远早于deadline退出 → exitCode 必非空（确定性）
    const st = new BrowserStarter({ config, db, readinessTimeoutMs: 300, fetchImpl: neverOk() });
    const err = await st.ensureWebChrome(true).then(() => null as Error | null, (e: Error) => e);
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/did not expose its debugging port within 300ms/);
    expect(err!.message).toMatch(/exited immediately/);
    const stderrLog = join(dir, "browser_profiles", "_web", "chrome-stderr.log");
    expect(err!.message).toContain(stderrLog);
    expect(existsSync(stderrLog)).toBe(true);
    expect((await readFile(stderrLog, "utf8")).length).toBeGreaterThan(0); // node.exe 的报错真实落盘
  });
});

describe("cleanupStaleSessions：先扫杀孤儿进程，再复位行", () => {
  const insertRunning = (storeId: string): void => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO browser_sessions (id, store_id, cdp_port, proxy_port, proxy_pid, chrome_pid, status, started_at, updated_at)
       VALUES (?, ?, 1111, NULL, NULL, 4242, 'running', ?, ?)`,
    ).run(`sess-${storeId}`, storeId, now, now);
  };

  it("profileRoot 目录存在 → killOrphans 收到该路径；行复位语义不变（返回复位数、行变 idle）", () => {
    mkdirSync(join(dir, "browser_profiles"), { recursive: true }); // 目录存在 = 本机用过浏览器
    insertRunning("s-kill-1");
    const calls: string[] = [];
    const st = new BrowserStarter({
      config, db,
      killOrphans: (root) => { calls.push(root); return 2; },
    });
    expect(st.cleanupStaleSessions()).toBe(1);
    expect(calls).toEqual([join(dir, "browser_profiles")]);
    const row = db.prepare("SELECT status FROM browser_sessions WHERE store_id = 's-kill-1'").get() as { status: string };
    expect(row.status).toBe("idle");
  });

  it("profileRoot 目录不存在（从未用过浏览器）→ 零成本快路径：不扫杀、行照常复位", () => {
    insertRunning("s-kill-3");
    const st = new BrowserStarter({
      config, db,
      killOrphans: () => { throw new Error("不该被调用"); },
    });
    expect(st.cleanupStaleSessions()).toBe(1);
    const row = db.prepare("SELECT status FROM browser_sessions WHERE store_id = 's-kill-3'").get() as { status: string };
    expect(row.status).toBe("idle");
  });

  it("killOrphans 抛错不阻断启动：行复位照常完成（清扫失败非致命）", () => {
    mkdirSync(join(dir, "browser_profiles"), { recursive: true });
    insertRunning("s-kill-2");
    const st = new BrowserStarter({
      config, db,
      killOrphans: () => { throw new Error("boom"); },
    });
    expect(() => st.cleanupStaleSessions()).not.toThrow();
    const row = db.prepare("SELECT status FROM browser_sessions WHERE store_id = 's-kill-2'").get() as { status: string };
    expect(row.status).toBe("idle");
  });
});

describe("orphanKillCommand（纯函数：平台命令构造）", () => {
  it("win32 → powershell 按命令行 Contains(profileRoot) 过滤并 Stop-Process", () => {
    const { cmd, args } = orphanKillCommand("D:\\vibe\\browser_profiles", "win32");
    expect(cmd).toBe("powershell");
    const script = args.at(-1)!;
    expect(script).toContain("Win32_Process");
    expect(script).toContain("D:\\vibe\\browser_profiles");
    expect(script).toContain("Stop-Process");
  });

  it("win32 路径中的单引号按 PowerShell 规则双写转义", () => {
    const { args } = orphanKillCommand("D:\\it's\\browser_profiles", "win32");
    expect(args.at(-1)).toContain("it''s");
  });

  it("unix → pgrep -f，profileRoot 的正则元字符已转义", () => {
    const { cmd, args } = orphanKillCommand("/home/u/.vibe-seller/browser_profiles", "linux");
    expect(cmd).toBe("pgrep");
    expect(args[0]).toBe("-f");
    expect(args[1]).toBe("/home/u/\\.vibe-seller/browser_profiles");
  });
});
