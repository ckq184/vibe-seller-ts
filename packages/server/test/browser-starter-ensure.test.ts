// 路线 2 PRD §4.1 / §六-4、§六-5：BrowserStarter 懒启动入口契约测试（browse 工具前置，T2）。
// 钉死：peekCdpPort 无会话/死端口 → null（只读，不 kill 不删项）；ensureStoreChrome 慢路径
// 经全局启动锁拉起并落 browser_sessions 行（status=running + cdp_port + chrome_pid）；
// ensureWebChrome（'_web'）进程内管理、不落行；锁被占 → BrowserBusyError 原样向外抛。
//
// 测试边界声明：快路径"存活 → touch lastUsedAt → 复用端口"的复用语义由 T3 的 browse
// 假 starter 行为测试覆盖（sessions Map 模块私有，本文件无注入口）；本文件只钉慢路径与
// 守卫面。全部零真网（fetchImpl 恒抛 → cdpAlive 恒 false）、零真 Chrome：VIBE_CHROME_PATH
// 指向 process.execPath（node.exe）——spawn 成功拿到 pid 后进程立刻因非法参数退出，
// startChrome 的"spawn 即返回 session"语义保持完整，且绝无真 Chrome/真 CDP 监听。

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, seed } from "../src/db";
import { hashPassword } from "../src/app";
import type { ServerConfig } from "../src/config";
import { BrowserStarter, BrowserBusyError } from "../src/browser/starter";

let dir: string;
let db: import("node:sqlite").DatabaseSync;
let config: ServerConfig;
let starter: BrowserStarter;
let prevChromePath: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibe-bse-"));
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
  // fetchImpl 恒抛：等价"127.0.0.1 端口上无监听"（连接拒绝），零真网且确定性
  starter = new BrowserStarter({ config, db, fetchImpl: (async () => { throw new Error("no network in tests"); }) as typeof fetch });
  // 假 Chrome 可执行文件：node.exe 带非法参数 spawn 即退（.cmd/.bat 会被 Node 的
  // spawn shell 守卫 EINVAL 拒绝，违背"spawn 即返回 session"前提，故用 execPath）
  prevChromePath = process.env["VIBE_CHROME_PATH"];
  process.env["VIBE_CHROME_PATH"] = process.execPath;
});

afterEach(async () => {
  if (prevChromePath === undefined) delete process.env["VIBE_CHROME_PATH"];
  else process.env["VIBE_CHROME_PATH"] = prevChromePath;
  db.close();
  await rm(dir, { recursive: true, force: true });
});

function sessionRow(storeId: string): { status: string; cdp_port: number | null; chrome_pid: number | null } {
  return db.prepare("SELECT status, cdp_port, chrome_pid FROM browser_sessions WHERE store_id = ?").get(storeId) as {
    status: string;
    cdp_port: number | null;
    chrome_pid: number | null;
  };
}

describe("peekCdpPort（只读存活快查）", () => {
  it("无会话 → null；'_web' 无会话同样 null", async () => {
    expect(await starter.peekCdpPort("no-such-store")).toBeNull();
    expect(await starter.peekCdpPort("_web")).toBeNull();
  });
});

describe("ensureStoreChrome（慢路径：锁内拉起 + 落行）", () => {
  it("拉起返回正端口并落 browser_sessions 行（running + cdp_port + chrome_pid）", async () => {
    const store = { id: "st-ensure-1", name: "Ensure 店" };
    const r = await starter.ensureStoreChrome(store, true);
    expect(r.cdpPort).toBeGreaterThan(0);
    const row = sessionRow(store.id);
    expect(row.status).toBe("running");
    expect(row.cdp_port).toBe(r.cdpPort);
    expect(row.chrome_pid).not.toBeNull();
  });

  it("探活失败时 peek 对已登记会话返回 null；二次 ensure 再走慢路径拿新端口并更新行", async () => {
    const store = { id: "st-ensure-2", name: "Ensure 店二" };
    const r1 = await starter.ensureStoreChrome(store, true);
    // 假 Chrome 没有真 CDP 监听（fetchImpl 恒抛）→ peek 必为 null，且只读（不 kill 不删项）
    expect(await starter.peekCdpPort(store.id)).toBeNull();
    // 二次 ensure：快路径探活失败 → 再进锁拉起 → 新端口 + 行更新为新端口
    const r2 = await starter.ensureStoreChrome(store, true);
    expect(r2.cdpPort).toBeGreaterThan(0);
    expect(r2.cdpPort).not.toBe(r1.cdpPort);
    expect(sessionRow(store.id).cdp_port).toBe(r2.cdpPort);
  });

  it("并发两个 ensure：至少一方成功；拒绝方必为 BrowserBusyError（锁立即抛不排队）", async () => {
    // withLaunchLock 是"忙即抛"非排队：微任务时序下第二方通常在第一方持锁（freePort/spawn await）
    // 期间调用 → 抛 BrowserBusyError。不把断言绑死在事件循环细节上，放宽为：
    // 两者都 resolve，或恰有拒绝者且必为 BrowserBusyError（文案点名全局启动锁）。
    const store = { id: "st-ensure-3", name: "Ensure 店三" };
    const results = await Promise.allSettled([
      starter.ensureStoreChrome(store, true),
      starter.ensureStoreChrome(store, true),
    ]);
    const fulfilled = results.filter((r): r is PromiseFulfilledResult<{ cdpPort: number }> => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    for (const f of fulfilled) expect(f.value.cdpPort).toBeGreaterThan(0);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(BrowserBusyError);
      expect(String((r.reason as Error).message)).toContain("global launch lock");
    }
    // 无论串行成功还是一方被拒，最终该店会话行都已落（成功方写行）
    expect(sessionRow(store.id).status).toBe("running");
  });
});

describe("ensureWebChrome（'_web'，不落行）", () => {
  it("拉起返回正端口；browser_sessions 零行（对齐 startWebSession 进程内管理语义）", async () => {
    const r = await starter.ensureWebChrome(true);
    expect(r.cdpPort).toBeGreaterThan(0);
    const rows = db.prepare("SELECT store_id FROM browser_sessions").all() as { store_id: string }[];
    expect(rows).toEqual([]);
    // 假 Chrome 无真监听 → peek '_web' 为 null（探活守卫生效）
    expect(await starter.peekCdpPort("_web")).toBeNull();
  });
});
