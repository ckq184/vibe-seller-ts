// 路线 2 PRD §4.1 / §六-4、§六-5：BrowserStarter 懒启动入口契约测试（browse 工具前置，T2）。
// 钉死：peekCdpPort 无会话/死端口 → null（只读，不 kill 不删项）；ensureStoreChrome 慢路径
// 经全局启动锁拉起、spawn 后做**有界就绪等待**（readinessTimeoutMs 注入小值）——就绪才返回
// 并落 browser_sessions 行（status=running + cdp_port + chrome_pid）；恒败探针 + 小上限 →
// 超时 throw（含 pid 与 within 语义）且**不落 running 行**（markSessionRow 时序保持"就绪后"，
// 审查 Major2：防冷启动 kill/respawn churn 与假 running 行）；ensureWebChrome（'_web'）
// 进程内管理、不落行；锁被占 → BrowserBusyError 原样向外抛。
//
// 测试边界声明：快路径"存活 → touch lastUsedAt → 复用端口"的复用语义由 T3 的 browse
// 假 starter 行为测试覆盖（sessions Map 模块私有，本文件无注入口）；本文件只钉慢路径与
// 守卫面。全部零真网（fetchImpl 脚本化 → cdpAlive 可控）、零真 Chrome：VIBE_CHROME_PATH
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
  // fetchImpl 恒抛：等价"127.0.0.1 端口上无监听"（连接拒绝），零真网且确定性。
  // readinessTimeoutMs=50：假 Chrome 永不开端口 → 慢路径必走"就绪等待超时 throw"分支
  //（生产缺省 10_000ms，仅测试注入小值）。
  starter = new BrowserStarter({
    config,
    db,
    readinessTimeoutMs: 50,
    fetchImpl: (async () => { throw new Error("no network in tests"); }) as typeof fetch,
  });
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

describe("ensureStoreChrome（慢路径：锁内拉起 + 有界就绪等待 + 落行）", () => {
  it("延迟 ok 的探针（第 2 次轮询才 ok）→ ensure 成功返回端口并落 running 行（就绪等待真实生效）", async () => {
    let polls = 0;
    const st = new BrowserStarter({
      config,
      db,
      readinessTimeoutMs: 2000, // 第 2 轮（~250ms）就绪，上限须大于一个轮询周期
      fetchImpl: (async () => {
        polls += 1;
        if (polls < 2) throw new Error("not ready yet");
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    const store = { id: "st-ensure-ready", name: "就绪店" };
    const r = await st.ensureStoreChrome(store, true);
    expect(r.cdpPort).toBeGreaterThan(0);
    expect(polls).toBeGreaterThanOrEqual(2); // 第 1 轮失败后等待重探——就绪等待真实生效
    const row = sessionRow(store.id);
    expect(row.status).toBe("running"); // 就绪后才落行（markSessionRow 时序 = 就绪后）
    expect(row.cdp_port).toBe(r.cdpPort);
    expect(row.chrome_pid).not.toBeNull();
  });

  it("恒败探针 + 小就绪上限 → 超时 throw（含 pid 与 within 语义）、不落 running 行、peek null（状态一致）", async () => {
    const store = { id: "st-ensure-1", name: "Ensure 店" };
    const err = await starter.ensureStoreChrome(store, true).then(
      () => null as Error | null,
      (e: Error) => e,
    );
    expect(err).not.toBeNull(); // 假 Chrome 永不开端口：不得"spawn 即成功"假就绪
    expect(err!.message).toMatch(/pid \d+/);
    expect(err!.message).toMatch(/did not expose its debugging port within 50ms/);
    expect(sessionRow(store.id)).toBeUndefined(); // throw 前不落 browser_sessions running 行
    expect(await starter.peekCdpPort(store.id)).toBeNull(); // 探活恒败 → 会话不可用状态一致
  });

  it("就绪超时后恢复：恢复前 peek null；再 ensure 走慢路径 kill 旧实例换新端口并更新行", async () => {
    // 端口脚本化探针：allDead 段全死（首次 ensure 超时）；恢复后仅首个端口保持死
    //（旧实例已死），新端口首轮即就绪
    const deadPorts = new Set<number>();
    let allDead = true;
    const seen: number[] = [];
    const st = new BrowserStarter({
      config,
      db,
      readinessTimeoutMs: 50,
      fetchImpl: (async (url: string) => {
        const port = Number(/127\.0\.0\.1:(\d+)\//.exec(String(url))?.[1]);
        if (Number.isFinite(port) && port > 0 && !seen.includes(port)) seen.push(port);
        if (allDead || deadPorts.has(port)) throw new Error("no network in tests");
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    const store = { id: "st-ensure-2", name: "Ensure 店二" };
    await expect(st.ensureStoreChrome(store, true)).rejects.toThrow(/did not expose its debugging port within 50ms/);
    expect(sessionRow(store.id)).toBeUndefined();
    const firstPort = seen[0]!;
    expect(firstPort).toBeGreaterThan(0);
    deadPorts.add(firstPort);
    allDead = false;
    // 恢复后：旧端口仍死（peek null，只读不 kill）；再 ensure → 慢路径 kill 旧 + 新端口就绪 → 行更新为新端口
    expect(await st.peekCdpPort(store.id)).toBeNull();
    const r2 = await st.ensureStoreChrome(store, true);
    expect(r2.cdpPort).toBeGreaterThan(0);
    expect(r2.cdpPort).not.toBe(firstPort);
    expect(sessionRow(store.id).cdp_port).toBe(r2.cdpPort);
    expect(await st.peekCdpPort(store.id)).toBe(r2.cdpPort); // 新实例探活命中
  });

  it("并发两个 ensure（恒 ok 探针：慢路径首轮即就绪）：至少一方成功；拒绝方必为 BrowserBusyError（锁立即抛不排队）", async () => {
    // withLaunchLock 是"忙即抛"非排队：微任务时序下第二方通常在第一方持锁（freePort/spawn/
    // 就绪轮询 await）期间调用 → 抛 BrowserBusyError；若锁已释放则快路径探活命中同样成功。
    // 不把断言绑死在事件循环细节上，放宽为：
    // 两者都 resolve，或恰有拒绝者且必为 BrowserBusyError（文案点名全局启动锁）。
    const st = new BrowserStarter({
      config,
      db,
      readinessTimeoutMs: 50,
      fetchImpl: (async () => new Response("{}", { status: 200 })) as typeof fetch,
    });
    const store = { id: "st-ensure-3", name: "Ensure 店三" };
    const results = await Promise.allSettled([
      st.ensureStoreChrome(store, true),
      st.ensureStoreChrome(store, true),
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
  it("就绪后返回正端口；browser_sessions 零行；peek 命中（快路径复用）", async () => {
    const st = new BrowserStarter({
      config,
      db,
      readinessTimeoutMs: 50,
      fetchImpl: (async () => new Response("{}", { status: 200 })) as typeof fetch,
    });
    const r = await st.ensureWebChrome(true);
    expect(r.cdpPort).toBeGreaterThan(0);
    const rows = db.prepare("SELECT store_id FROM browser_sessions").all() as { store_id: string }[];
    expect(rows).toEqual([]); // '_web' 进程内管理，不落行（对齐 startWebSession 语义）
    expect(await st.peekCdpPort("_web")).toBe(r.cdpPort); // 就绪后探活命中
  });

  it("恒败探针 + 小就绪上限 → 超时 throw（含 pid 语义），依旧零行", async () => {
    await expect(starter.ensureWebChrome(true)).rejects.toThrow(/did not expose its debugging port within 50ms/);
    const rows = db.prepare("SELECT store_id FROM browser_sessions").all() as { store_id: string }[];
    expect(rows).toEqual([]);
  });
});

// ── touch 语义与空闲清扫不冲突（路线 2 PRD §六.5 的 starter 侧直接证据）──
// 本段用 fetchImpl 恒 ok 的 starter（cdpAlive 恒真）驱动真实代码路径：
// peekCdpPort 快路径 touch lastUsedAt（starter.ts peekCdpPort 的 `session.lastUsedAt =
// Date.now()` 行）→ 会话在 sweepIdleBrowsers 的 1s 空闲阈值下存活。**因果钉子**：删掉
// starter.ts peekCdpPort 里那一行 touch，"peek 后存活"用例必红（lastUsedAt 停留在
// ensure 时刻、老化越过阈值被清 → 二次 peek null），恢复该行即绿——这就是"touch 与
// 清扫不冲突"的直接测试证据，而非经 browse 层的行为面间接推断。

describe("peekCdpPort touch ↔ sweepIdleBrowsers（PRD §六.5 直接证据）", () => {
  /** fetchImpl 恒 ok：任何 /json/version 都 200 → cdpAlive 恒真 → peek 快路径恒命中。 */
  const okStarter = () =>
    new BrowserStarter({
      config,
      db,
      fetchImpl: (async () => new Response("{}", { status: 200 })) as typeof fetch,
    });

  it("peek（touch）过的会话在 sweepIdleBrowsers(1) 下存活：二次 peek 返回同一端口", async () => {
    const st = okStarter();
    const store = { id: "st-touch-alive", name: "Touch 店A" };
    // 慢路径建会话 A（lastUsedAt = t0；假 Chrome = process.execPath，spawn 即退，见文件头）
    const ensured = await st.ensureStoreChrome(store, true);
    expect(ensured.cdpPort).toBeGreaterThan(0);
    // 真实睡眠 ≥1s：让 lastUsedAt（若不被 touch）老化越过 1s 清扫阈值——
    // 不用假时钟，清扫的 cutoff 就是 Date.now() 差值语义
    await new Promise((r) => setTimeout(r, 1100));
    // 快路径 peek：命中 + touch（lastUsedAt 刷新到此刻）
    const peeked = await st.peekCdpPort(store.id);
    expect(peeked).toBe(ensured.cdpPort);
    // 1s 空闲阈值清扫：被 touch 过 → lastUsedAt > cutoff → 存活
    await st.sweepIdleBrowsers(1);
    expect(await st.peekCdpPort(store.id)).toBe(ensured.cdpPort);
  });

  it("对照组：建会话后不 peek，同阈值清扫即被移出（二次 peek null = Map 项已删）", async () => {
    const st = okStarter();
    const store = { id: "st-touch-swept", name: "Touch 店B" };
    await st.ensureStoreChrome(store, true);
    await new Promise((r) => setTimeout(r, 1100)); // 同样老化越过 1s 阈值
    // 不 peek（无 touch）→ 清扫：lastUsedAt 停在 ensure 时刻 < cutoff → 删 Map 项 + kill proc
    await st.sweepIdleBrowsers(1);
    // sessions Map 模块私有，从外部观察"被清"的可行表达 = peek 二次返回 null
    expect(await st.peekCdpPort(store.id)).toBeNull();
  });
});
