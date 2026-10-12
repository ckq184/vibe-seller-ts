// 浏览器会话的"外部进程托管"移植（PRD §4.7 预裁决）。
// 范围：spawn 参数、browser_sessions 表状态推进、全局启动锁 + BrowserBusyError
//（503）语义、aux/web 会话复用与空闲清扫。Python 的 CDPMuxProxy/wrapper 生成/
// browser_launch_env 的 PATH 防逃逸属浏览器层红线，不在本批重写——TS 侧直接
// spawn Chrome（remote-debugging-port），会话记录进 browser_sessions。
// 差异记录：aux 返回的 `ws` 是 Chrome 自身 DevTools 端点（无 mux 的 /client-aux
// 路径语义改为直连端点）；空闲清扫的 busy 判定用 TS 侧维护的 lastUsed 时间戳
//（Python 用 mux 的 has_active_clients/idle_seconds，两者都是"最近无人用"语义）。

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ZiniaoNormalModeError, ensureZiniaoRunning, killAndRelaunchZiniao, type ZiniaoUserInfo } from "./ziniao";

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export class BrowserBusyError extends Error {}

interface ManagedSession {
  key: string; // store_id 或 '_web'
  slug: string;
  proc: ChildProcess | null;
  cdpPort: number | null;
  stderrLog: string; // Chrome stderr 落盘路径（秒退/单实例转发的唯一现场证据）
  startedAt: number;
  lastUsedAt: number;
}

const sessions = new Map<string, ManagedSession>();
const auxSessions = new Map<string, ManagedSession>();

// ── 全局启动锁（GlobalLaunchLock 语义：忙 503 并点名持有者/时长。2026-10-12 起
// "忙"= 有界等待 launchLockWaitMs 后仍被占才抛——持有者的正常窗口就是就绪等待
// （≤10s），等待接力把"一个 ensure 失败放大成并行任务全部浏览器操作 skipped"
// 的放大效应收敛为串行重试；等满窗口仍被占才按原文案忙抛） ──
const DEFAULT_LAUNCH_LOCK_WAIT_MS = 12_000; // 就绪窗口(10s)+余量：正常持锁不超过它

let lockHolder: string | null = null;
let lockSince = 0;
let lockChain: Promise<void> = Promise.resolve();

function busyError(): BrowserBusyError {
  const held = (Date.now() - lockSince) / 1000;
  return new BrowserBusyError(
    `Browser launch skipped: ${lockHolder} has held the global launch lock for ${held.toFixed(0)}s. Nothing is known to be wrong with this store — retry shortly; if it does not clear, restart the browser.`,
  );
}

async function withLaunchLock<T>(what: string, fn: () => Promise<T>, waitMs: number = DEFAULT_LAUNCH_LOCK_WAIT_MS): Promise<T> {
  const deadline = Date.now() + waitMs;
  while (lockHolder) {
    if (Date.now() >= deadline) throw busyError();
    // 链解析 = 当前持有者释放；期间换了持有者则下一轮继续等新链条
    await Promise.race([lockChain, delay(Math.min(200, deadline - Date.now()))]);
  }
  const prev = lockChain;
  let release: () => void;
  lockChain = new Promise<void>((r) => (release = r));
  lockHolder = what;
  lockSince = Date.now();
  try {
    return await fn();
  } finally {
    lockHolder = null;
    release!();
    lockChain = prev;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
    srv.on("error", reject);
  });
}

function findChromeExecutable(): string {
  const override = process.env["VIBE_CHROME_PATH"];
  if (override && existsSync(override)) return override;
  if (process.platform === "win32") {
    for (const base of [process.env["ProgramFiles"], process.env["ProgramFiles(x86)"], process.env["LOCALAPPDATA"]]) {
      if (!base) continue;
      for (const rel of [["Google", "Chrome", "Application", "chrome.exe"], ["Chromium", "Application", "chrome.exe"]]) {
        const candidate = join(base, ...rel);
        if (existsSync(candidate)) return candidate;
      }
    }
  } else if (process.platform === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }
  return "google-chrome";
}

/** CDP 存活探测（GET /json/version）。 */
async function cdpAlive(port: number, fetchImpl: FetchImpl = fetch): Promise<boolean> {
  try {
    const resp = await fetchImpl(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
    return resp.ok;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const READINESS_POLL_MS = 250;
const DEFAULT_READINESS_TIMEOUT_MS = 10_000; // Chrome 开 CDP 端口实测 ~2.3s，10s 留足余量

/** 就绪超时文案（导出供测试钉分支）。进程秒退 = 单实例冲突指纹：老实例还占着同
 * profile，新 spawn 被 Chrome 转发后立即退出、调试端口永不出现（2026-10-12 实测
 * 事故）——给出与"还活着"不同的处置指引；stderr 日志路径两条都给，它是唯一现场证据。 */
export function readinessTimeoutMessage(
  pid: number | null | undefined,
  timeoutMs: number,
  exit: { code: number | string | null },
  stderrLog: string,
): string {
  const head = `Chrome (pid ${pid ?? "unknown"}) did not expose its debugging port within ${timeoutMs}ms; browser session not started — `;
  if (exit.code !== null) {
    return `${head}the process exited immediately (exit ${exit.code}) — a leftover Chrome instance may be holding the same profile dir; close it (or restart the server, which now sweeps orphan browsers) and retry. stderr: ${stderrLog}`;
  }
  return `${head}inspect the Chrome process or retry the browse call. stderr: ${stderrLog}`;
}

/** ensure 慢路径的有界就绪等待（审查 Major2）：Chrome 开 CDP 端口实测 ~2.3s，spawn 即返回
 * 会让 agent 首次调用必败、快速重试时 startChrome 复用检查把"启动中"误判"死亡"→ kill 重拉
 * churn。只读轮询 cdpAlive（GET /json/version 探针，无任何副作用——PRD 4.2"绝不重试变异
 * 命令"铁律不受影响，探针不是命令重发）。就绪即返回；超时 throw 可操作错误（含 pid、
 * 秒退指纹与 stderr 日志路径）；调用方 markSessionRow 保持"就绪后"时序，超时路径零假 running 行。 */
async function waitForCdpReadiness(port: number, proc: ChildProcess | null, fetchImpl: FetchImpl | undefined, timeoutMs: number, stderrLog: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cdpAlive(port, fetchImpl)) return;
    if (Date.now() >= deadline) {
      throw new Error(readinessTimeoutMessage(proc?.pid ?? null, timeoutMs, { code: proc?.exitCode ?? proc?.signalCode ?? null }, stderrLog));
    }
    await delay(READINESS_POLL_MS);
  }
}

export interface StartChromeOpts {
  slug: string;
  headless: boolean;
  profileRoot: string;
  fetchImpl?: FetchImpl;
}

/** spawn Chrome（持久 profile + CDP 端口）；复用存活实例。返回管理的会话。 */
async function startChrome(key: string, opts: StartChromeOpts): Promise<ManagedSession> {
  const existing = sessions.get(key);
  if (existing && existing.proc && existing.cdpPort && (await cdpAlive(existing.cdpPort, opts.fetchImpl))) {
    existing.lastUsedAt = Date.now();
    return existing;
  }
  if (existing) {
    existing.proc?.kill();
    sessions.delete(key);
  }
  const profileDir = join(opts.profileRoot, opts.slug);
  mkdirSync(profileDir, { recursive: true });
  const port = await freePort();
  const args = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=DialMediaRouteProvider",
  ];
  if (opts.headless) args.push("--headless=new");
  // stderr 落盘（append）而非 stdio:"ignore"：Chrome 秒退/单实例转发的真实原因只在
  // stderr 里（2026-10-12 事故零可观测的教训）。fd 直接交给子进程、父侧随即关闭——
  // 不引入管道（detached + 管道会牵住父进程事件循环）。
  const stderrLog = join(profileDir, "chrome-stderr.log");
  const stderrFd = openSync(stderrLog, "a");
  const proc = spawn(findChromeExecutable(), args, { detached: true, stdio: ["ignore", "ignore", stderrFd] });
  proc.unref();
  closeSync(stderrFd);
  const session: ManagedSession = { key, slug: opts.slug, proc, cdpPort: port, stderrLog, startedAt: Date.now(), lastUsedAt: Date.now() };
  sessions.set(key, session);
  return session;
}

export interface BrowserStarterDeps {
  config: { homeDir: string };
  db: DatabaseSync;
  fetchImpl?: FetchImpl;
  /** ensure* 慢路径 spawn 后的就绪等待上限，缺省 10_000ms（仅测试注入小值）。 */
  readinessTimeoutMs?: number;
  /** 全局启动锁"忙"的有界等待上限，缺省 12_000ms（就绪窗口 10s + 余量）。 */
  launchLockWaitMs?: number;
  /** 孤儿浏览器进程扫杀（缺省按平台 powershell/pgrep 实现）；注入点供测试。 */
  killOrphans?: (profileRoot: string) => number;
}

function markSessionRow(db: DatabaseSync, storeId: string, patch: { status: string; cdpPort?: number | null; chromePid?: number | null }): void {
  db.prepare(
    `INSERT INTO browser_sessions (id, store_id, cdp_port, proxy_port, proxy_pid, chrome_pid, status, started_at, updated_at)
     VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?)
     ON CONFLICT(store_id) DO UPDATE SET
       cdp_port=excluded.cdp_port, chrome_pid=excluded.chrome_pid, status=excluded.status, updated_at=excluded.updated_at`,
  ).run(
    `sess-${storeId}`,
    storeId,
    patch.cdpPort ?? null,
    patch.chromePid ?? null,
    patch.status,
    new Date().toISOString(),
    new Date().toISOString(),
  );
}

export class BrowserStarter {
  constructor(private deps: BrowserStarterDeps) {}

  private get profileRoot(): string {
    return join(this.deps.config.homeDir, "browser_profiles");
  }

  /** 店铺浏览器：chrome → spawn；ziniao → ensure（+force 重拉）并落会话行。 */
  async startStoreSession(store: { id: string; name: string; browser_backend: string | null; ziniao_account_id: string | null }, headless: boolean, ziniaoCreds?: { socket_port: number; client_path: string; user_info: ZiniaoUserInfo } | null): Promise<void> {
    await withLaunchLock(`start_session(${store.name})`, async () => {      if (store.browser_backend === "ziniao" && ziniaoCreds) {
        await ensureZiniaoRunning(ziniaoCreds.socket_port, ziniaoCreds.client_path, ziniaoCreds.user_info, this.deps.fetchImpl);
        markSessionRow(this.deps.db, store.id, { status: "running" });
        this.deps.db.prepare("UPDATE browser_sessions SET updated_at = ? WHERE store_id = ?").run(new Date().toISOString(), store.id);
        return;
      }
      // chrome（含未知后端的兜底）
      const session = await startChrome(store.id, { slug: storeSlugOf(store.name, store.id), headless, profileRoot: this.profileRoot, fetchImpl: this.deps.fetchImpl });
      markSessionRow(this.deps.db, store.id, { status: "running", cdpPort: session.cdpPort, chromePid: session.proc?.pid ?? null });
    }, this.deps.launchLockWaitMs);
  }

  /** 店铺无关的 orchestrator web 浏览器（'_web'，进程内管理，无 browser_sessions 行）。 */
  async startWebSession(headless: boolean): Promise<void> {
    await withLaunchLock("start_web_session", async () => {
      await startChrome("_web", { slug: "_web", headless, profileRoot: this.profileRoot, fetchImpl: this.deps.fetchImpl });
    }, this.deps.launchLockWaitMs);
  }

  /** AUX：登录无关 Chromium，返回 {ok, proxy_port, ws}（ws=Chrome DevTools 端点）。 */
  async startAux(store: { id: string; name: string }, headless: boolean): Promise<{ ok: boolean; proxy_port: number; ws: string }> {
    const existing = auxSessions.get(store.id);
    if (existing && existing.cdpPort && (await cdpAlive(existing.cdpPort, this.deps.fetchImpl))) {
      existing.lastUsedAt = Date.now();
      return { ok: true, proxy_port: existing.cdpPort, ws: `ws://127.0.0.1:${existing.cdpPort}/client-aux` };
    }
    const session = await startChrome(`aux:${store.id}`, { slug: `${storeSlugOf(store.name, store.id)}-aux`, headless, profileRoot: this.profileRoot, fetchImpl: this.deps.fetchImpl });
    return { ok: true, proxy_port: session.cdpPort!, ws: `ws://127.0.0.1:${session.cdpPort}/client-aux` };
  }

  // ── browse 工具懒启动入口（PRD §4.1 幂等懒启动：对齐原版 autostart 块——
  //    存活即复用并 touch，不存活才经全局启动锁拉起；既有 start*/sweep 方法不动） ──

  /** 会话存活快查（只读）：sessions Map（含 '_web'）有该 key 且 CDP 探活通过 →
   * touch lastUsedAt（与 sweepIdleBrowsers 的空闲判定兼容：每次工具调用都续命）
   * 并返回 cdpPort；无会话 / 探活失败 → null。绝不 kill、绝不删 Map 项——死会话
   * 清理交给既有 startChrome 复用路径（kill 旧 proc + 重建）。 */
  async peekCdpPort(key: string): Promise<number | null> {
    const session = sessions.get(key);
    if (!session || session.cdpPort === null) return null;
    if (!(await cdpAlive(session.cdpPort, this.deps.fetchImpl))) return null;
    session.lastUsedAt = Date.now();
    return session.cdpPort;
  }

  /** 店铺 Chrome 懒启动（仅供 chrome 后端；ziniao 守卫在 browse 调用层）：
   * 快路径 peek 命中 → 直接复用（不进锁）；慢路径经 withLaunchLock 拉起 + 有界就绪等待
   *（waitForCdpReadiness：就绪才返回，防冷启动"启动中"被误判"死亡"的 kill/respawn
   * churn），就绪后才落 browser_sessions 行（与 startStoreSession chrome 分支同构；
   * 超时 throw 时零行写入——markSessionRow 时序保持"就绪后"）。锁被占 →
   * BrowserBusyError 原样向外抛（文案点名持有者/时长，调用方透传为工具错误）。 */
  async ensureStoreChrome(store: { id: string; name: string }, headless: boolean): Promise<{ cdpPort: number }> {
    const alive = await this.peekCdpPort(store.id);
    if (alive !== null) return { cdpPort: alive };
    const session = await withLaunchLock(`ensure_session(${store.name})`, async () => {
      const s = await startChrome(store.id, { slug: storeSlugOf(store.name, store.id), headless, profileRoot: this.profileRoot, fetchImpl: this.deps.fetchImpl });
      await waitForCdpReadiness(s.cdpPort!, s.proc, this.deps.fetchImpl, this.deps.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS, s.stderrLog);
      markSessionRow(this.deps.db, store.id, { status: "running", cdpPort: s.cdpPort, chromePid: s.proc?.pid ?? null });
      return s;
    }, this.deps.launchLockWaitMs);
    return { cdpPort: session.cdpPort! };
  }

  /** 店铺无关 web Chrome 懒启动（key/slug 均 '_web'，进程内管理，不落
   * browser_sessions 行——对齐既有 startWebSession 语义）。慢路径同样做有界就绪等待。 */
  async ensureWebChrome(headless: boolean): Promise<{ cdpPort: number }> {
    const alive = await this.peekCdpPort("_web");
    if (alive !== null) return { cdpPort: alive };
    const session = await withLaunchLock("ensure_web_session", () =>
      startChrome("_web", { slug: "_web", headless, profileRoot: this.profileRoot, fetchImpl: this.deps.fetchImpl })
        .then(async (s) => {
          await waitForCdpReadiness(s.cdpPort!, s.proc, this.deps.fetchImpl, this.deps.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS, s.stderrLog);
          return s;
        }),
    this.deps.launchLockWaitMs);
    return { cdpPort: session.cdpPort! };
  }

  /** 空闲清扫：无活跃任务绑定 + 空闲 ≥ idleSeconds 的浏览器停掉。返回停止数。
   * 持有浏览器的任务态 = PENDING/QUEUED/DESIGNING/PLANNED/RUNNING（WAITING 不持有，
   * 唤醒走懒启动）。 */
  async sweepIdleBrowsers(idleSeconds: number): Promise<number> {
    if (idleSeconds <= 0) return 0;
    const db = this.deps.db;
    const holds = db
      .prepare("SELECT DISTINCT store_id FROM tasks WHERE status IN ('pending','queued','designing','planned','running')")
      .all() as { store_id: string | null }[];
    const holdStores = new Set(holds.map((r) => r.store_id).filter(Boolean) as string[]);
    const nostoreActive = holds.some((r) => r.store_id === null);
    let stopped = 0;
    const cutoff = Date.now() - idleSeconds * 1000;

    for (const [key, session] of [...sessions]) {
      if (key === "_web") {
        if (nostoreActive || session.lastUsedAt > cutoff) continue;
      } else if (holdStores.has(key) || session.lastUsedAt > cutoff) {
        continue;
      }
      session.proc?.kill();
      sessions.delete(key);
      if (key !== "_web") {
        db.prepare("UPDATE browser_sessions SET status = 'idle', cdp_port = NULL, chrome_pid = NULL, updated_at = ? WHERE store_id = ?").run(new Date().toISOString(), key);
      }
      stopped += 1;
    }
    for (const [storeId, session] of [...auxSessions]) {
      if (holdStores.has(storeId) || session.lastUsedAt > cutoff) continue;
      session.proc?.kill();
      auxSessions.delete(storeId);
      stopped += 1;
    }
    return stopped;
  }

  /** 启动恢复：①先按 profileRoot 扫杀孤儿浏览器进程——spawn 是 detached，服务死了
   * Chrome 还活着、继续占着 browser_profiles 下的 user-data-dir；只复位行不杀进程的话，
   * 恢复入队任务的第一次 spawn 就会被 Chrome 单实例机制转发即退、调试端口永不出现
   * （2026-10-12 实测事故）。按命令行匹配 profileRoot：店铺会话有行、'_web' 无行，
   * 路径匹配两者都覆盖。②再复位 DB 里遗留 'running' 行（进程内状态已丢）。
   * 快路径：profileRoot 目录不存在 = 本机从未拉起过浏览器 → 不可能有孤儿，跳过进程
   * 扫描（powershell/pgrep 有百 ms~秒级开销且 spawnSync 会冻结事件循环，测试里海量
   * boot 因此零成本）。 */
  cleanupStaleSessions(): number {
    if (existsSync(this.profileRoot)) {
      try {
        const killed = (this.deps.killOrphans ?? killOrphanBrowsersDefault)(this.profileRoot);
        if (killed > 0) console.log(`[vibe-browser] swept ${killed} orphan browser process(es) under ${this.profileRoot}`);
      } catch (e) {
        // 扫杀失败不阻断启动（最坏退化为旧行为：残留实例占坑，任务首次浏览报错后可重试）
        console.warn(`[vibe-browser] orphan browser sweep failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const r = this.deps.db
      .prepare("UPDATE browser_sessions SET status = 'idle', cdp_port = NULL, chrome_pid = NULL, updated_at = ? WHERE status = 'running'")
      .run(new Date().toISOString());
    return Number(r.changes);
  }
}

// ── 孤儿浏览器进程扫杀（平台命令） ──

/** 构造"杀掉命令行含 profileRoot 的 chrome/chromium 进程"的平台命令（导出供测试）。 */
export function orphanKillCommand(profileRoot: string, platform: NodeJS.Platform = process.platform): { cmd: string; args: string[] } {
  if (platform === "win32") {
    // Contains() 而非 -like：路径里的 [] 等在 -like 语义里是通配符，.NET Contains 无此坑；
    // 单引号双写是 PowerShell 字符串转义。
    const esc = profileRoot.replace(/'/g, "''");
    const script = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe' or Name='chromium.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${esc}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Output $_.ProcessId }`;
    return { cmd: "powershell", args: ["-NoProfile", "-Command", script] };
  }
  // pkill/pgrep 的模式是 ERE：路径里的 . 等元字符转义，避免误伤恰好含相似片段的无关进程
  const pattern = profileRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return { cmd: "pgrep", args: ["-f", pattern] };
}

/** 默认执行器：同步扫杀（boot 路径，先杀完再放行恢复入队的任务）。返回杀掉的进程数。 */
function killOrphanBrowsersDefault(profileRoot: string): number {
  const { cmd, args } = orphanKillCommand(profileRoot);
  if (cmd === "pgrep") {
    const found = spawnSync(cmd, args, { encoding: "utf8" });
    const pids = (found.stdout ?? "").split(/\s+/).filter(Boolean);
    if (pids.length === 0) return 0;
    spawnSync("kill", ["-9", ...pids]);
    return pids.length;
  }
  const out = spawnSync(cmd, args, { encoding: "utf8" });
  return (out.stdout ?? "").split(/\s+/).filter(Boolean).length;
}

/** ziniao 强重启（force=true 路径复用）。 */
export async function forceRelaunchZiniao(creds: { socket_port: number; client_path: string; user_info: ZiniaoUserInfo }, fetchImpl?: FetchImpl): Promise<void> {
  await killAndRelaunchZiniao(creds.socket_port, creds.client_path, creds.user_info, fetchImpl);
}

export { ZiniaoNormalModeError };

function storeSlugOf(name: string, id: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/_/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || `store-${id.slice(0, 8)}`;
}
