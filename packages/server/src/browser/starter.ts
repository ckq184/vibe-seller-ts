// 浏览器会话的"外部进程托管"移植（PRD §4.7 预裁决）。
// 范围：spawn 参数、browser_sessions 表状态推进、全局启动锁 + BrowserBusyError
//（503）语义、aux/web 会话复用与空闲清扫。Python 的 CDPMuxProxy/wrapper 生成/
// browser_launch_env 的 PATH 防逃逸属浏览器层红线，不在本批重写——TS 侧直接
// spawn Chrome（remote-debugging-port），会话记录进 browser_sessions。
// 差异记录：aux 返回的 `ws` 是 Chrome 自身 DevTools 端点（无 mux 的 /client-aux
// 路径语义改为直连端点）；空闲清扫的 busy 判定用 TS 侧维护的 lastUsed 时间戳
//（Python 用 mux 的 has_active_clients/idle_seconds，两者都是"最近无人用"语义）。

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
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
  startedAt: number;
  lastUsedAt: number;
}

const sessions = new Map<string, ManagedSession>();
const auxSessions = new Map<string, ManagedSession>();

// ── 全局启动锁（GlobalLaunchLock 语义：忙 503 并点名持有者/时长） ──
let lockHolder: string | null = null;
let lockSince = 0;
let lockChain: Promise<void> = Promise.resolve();

async function withLaunchLock<T>(what: string, fn: () => Promise<T>): Promise<T> {
  const prev = lockChain;
  let release: () => void;
  lockChain = new Promise<void>((r) => (release = r));
  if (lockHolder) {
    const held = (Date.now() - lockSince) / 1000;
    release!();
    lockChain = prev;
    throw new BrowserBusyError(
      `Browser launch skipped: ${lockHolder} has held the global launch lock for ${held.toFixed(0)}s. Nothing is known to be wrong with this store — retry shortly; if it does not clear, restart the browser.`,
    );
  }
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
  const proc = spawn(findChromeExecutable(), args, { detached: true, stdio: "ignore" });
  proc.unref();
  const session: ManagedSession = { key, slug: opts.slug, proc, cdpPort: port, startedAt: Date.now(), lastUsedAt: Date.now() };
  sessions.set(key, session);
  return session;
}

export interface BrowserStarterDeps {
  config: { homeDir: string };
  db: DatabaseSync;
  fetchImpl?: FetchImpl;
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
    await withLaunchLock(`start_session(${store.name})`, async () => {
      if (store.browser_backend === "ziniao" && ziniaoCreds) {
        await ensureZiniaoRunning(ziniaoCreds.socket_port, ziniaoCreds.client_path, ziniaoCreds.user_info, this.deps.fetchImpl);
        markSessionRow(this.deps.db, store.id, { status: "running" });
        this.deps.db.prepare("UPDATE browser_sessions SET updated_at = ? WHERE store_id = ?").run(new Date().toISOString(), store.id);
        return;
      }
      // chrome（含未知后端的兜底）
      const session = await startChrome(store.id, { slug: storeSlugOf(store.name, store.id), headless, profileRoot: this.profileRoot, fetchImpl: this.deps.fetchImpl });
      markSessionRow(this.deps.db, store.id, { status: "running", cdpPort: session.cdpPort, chromePid: session.proc?.pid ?? null });
    });
  }

  /** 店铺无关的 orchestrator web 浏览器（'_web'，进程内管理，无 browser_sessions 行）。 */
  async startWebSession(headless: boolean): Promise<void> {
    await withLaunchLock("start_web_session", async () => {
      await startChrome("_web", { slug: "_web", headless, profileRoot: this.profileRoot, fetchImpl: this.deps.fetchImpl });
    });
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

  /** 启动恢复：DB 里遗留 'running' 行（进程内状态已丢）复位 idle。 */
  cleanupStaleSessions(): number {
    const r = this.deps.db
      .prepare("UPDATE browser_sessions SET status = 'idle', cdp_port = NULL, chrome_pid = NULL, updated_at = ? WHERE status = 'running'")
      .run(new Date().toISOString());
    return Number(r.changes);
  }
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
