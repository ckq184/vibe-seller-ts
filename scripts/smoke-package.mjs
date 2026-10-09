// 分发包冒烟（PRD §5.1 Task 5.3 核心验收）：对 release/vibe-seller-ts 产物跑
// 两个场景，全绿才算过——
//   A 全新安装：start.bat 同款 env（默认 admin/admin 凭据、VIBE_HOME/端口注入）
//     → bundled node 起 server → health/version 200 → 登录 200 → 首页 HTML 200
//     → stores API 200 → stop.bat 能停（pid 文件清掉、端口失联）。
//   B Python→TS 原地升级：参考仓库 venv 跑 scripts/smoke/seed_legacy.py（真
//     FastAPI lifespan 进程内造数：admin/legacy_member 用户、店铺、设置、
//     install_id；VIBE_SELLER_TELEMETRY=0 全程零真网）→ 同一 VIBE_HOME 用
//     bundled TS server 启动 → 老 admin 凭据可登录、legacy_member 登录 200
//     （TS seed 只重写 admin 行，member 登录 = 老 bcrypt 哈希真实验证通过）、
//     老店铺/设置还在、data/install_id 不变、启动日志无 ERROR → 清理。
//
// 前置：npm run package 已产出 release/vibe-seller-ts/（本脚本不重新构建）。
// 零真网：两场景 server 端都设 VIBE_SELLER_TELEMETRY=0（遥测门控不建客户端）。
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE = join(root, "release", "vibe-seller-ts");
const NODE_EXE = join(RELEASE, "node", "node.exe");
const SERVER_MJS = join(RELEASE, "server.mjs");
const TASKLIST = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tasklist.exe");
// 参考仓库（老版本种子）：可用 env 覆盖（CI 换盘符/路径时）。
const REFERENCE_PYTHON =
  process.env.VIBE_REFERENCE_PYTHON ?? "D:/CKQ/workplace/_reference/vibe-seller-src/.venv/Scripts/python.exe";
const SEED_SCRIPT = join(root, "scripts", "smoke", "seed_legacy.py");

// 与 seed_legacy.py 的冒烟契约（SMOKE CONTRACT，手工同步）。
const LEGACY = {
  adminUsername: "admin",
  adminPassword: "legacy-admin-pass",
  adminEmail: "admin@legacy.local",
  memberUsername: "legacy_member",
  memberPassword: "legacy-member-pass",
  installId: "12345678-90ab-4cde-8f01-234567890abc",
  storeName: "Legacy Smoke Store",
  markerKey: "smoke_legacy_marker",
  markerValue: "seeded-by-python",
};

const results = [];
const ok = (name, detail = "") => {
  results.push({ name, pass: true });
  console.log(`  [PASS] ${name}${detail ? ` — ${detail}` : ""}`);
};
const fail = (name, detail = "") => {
  results.push({ name, pass: false });
  console.error(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
};
const step = (msg) => console.log(`\n[smoke] ${msg}`);

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
    srv.on("error", reject);
  });
}

async function fetchJson(url, { method = "GET", body, cookie } = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text(); // body 只能读一次：先 text 再尝试 JSON.parse
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应（首页 HTML 等） */
  }
  return { status: res.status, json, text, setCookie: res.headers.getSetCookie() };
}

/** 轮询直到 probe 通过（冒烟专用的确定性等待，超时抛错带最近观测）。 */
async function waitFor(desc, probe, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = "never probed";
  for (;;) {
    try {
      const r = await probe();
      if (r) return r;
      last = String(r);
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() > deadline) throw new Error(`waitFor 超时（${timeoutMs}ms）：${desc}；last=${last}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

function sessionCookie(setCookies) {
  const hit = setCookies.find((c) => c.startsWith("vibe_session=")) ?? setCookies[0];
  if (!hit) throw new Error("登录响应没有 set-cookie");
  return hit.split(";")[0];
}

async function login(baseUrl, identifier, password) {
  const res = await fetchJson(`${baseUrl}/api/auth/login`, {
    method: "POST",
    body: { identifier, password },
  });
  if (res.status !== 200) throw new Error(`登录 ${identifier} 失败：HTTP ${res.status} ${JSON.stringify(res.json)}`);
  return sessionCookie(res.setCookie);
}

function pidAlive(pid) {
  const r = spawnSync(TASKLIST, ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8" });
  return r.status === 0 && (r.stdout ?? "").includes(String(pid));
}

/** 跑 release 里的 bat（stdio 全 ignore）。实测 spawnSync 管道 stdio 会挂：
 * start.bat 拉起的 detach node 继承了 cmd 的 stdio 句柄，cmd 已退出但管道
 * 等不到 EOF，spawnSync ETIMEDOUT（真实用户从 cmd 双击场景无管道，不受影响）。
 * ignore 断掉句柄继承，完成与否用 pid 文件/退出码事件判定。 */
function runBat(name, env) {
  return new Promise((resolve) => {
    const child = spawn("cmd", ["/c", name], { cwd: RELEASE, env, stdio: "ignore" });
    const timer = setTimeout(() => resolve({ status: null, note: "timeout 60s" }), 60000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ status: code, note: "" });
    });
  });
}

// ── 场景 A：全新安装（start.bat 同款 env，start/stop.bat 真实走一遍） ──
async function scenarioA() {
  step("场景 A：全新安装（bundled node + start.bat → 五步断言 → stop.bat 停）");
  const home = mkdtempSync(join(tmpdir(), "vibe-smoke-a-"));
  const port = await freePort();
  const env = { ...process.env, VIBE_HOME: home, BACKEND_PORT: String(port) };
  const started = await runBat("start.bat", env);
  if (started.status !== 0) fail("A0 start.bat 退出码 0", `status=${started.status} ${started.note}`);
  await waitFor("start.bat 写出 pid 文件", async () => existsSync(join(home, "vibe-seller.pid")));
  const pid = Number(readFileSync(join(home, "vibe-seller.pid"), "utf8").trim());
  if (!Number.isInteger(pid) || !pidAlive(pid)) fail("A0 pid 文件存在且进程存活", `pid=${pid}`);
  ok("A0 start.bat 后台启动 + pid 文件", `pid=${pid} port=${port}`);

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const health = await waitFor("health 200", async () => {
      const r = await fetchJson(`${baseUrl}/api/health`);
      return r.status === 200 && r.json?.status === "ok" ? r : null;
    });
    ok("A1 health 200", JSON.stringify(health.json));

    const version = await fetchJson(`${baseUrl}/api/version`);
    version.status === 200 && version.json?.version
      ? ok("A2 version 200", JSON.stringify(version.json))
      : fail("A2 version 200", `HTTP ${version.status}`);

    const cookie = await login(baseUrl, "admin", "admin"); // start.bat 未设 ADMIN_* → 默认凭据
    ok("A3 默认 admin 登录 200");

    const index = await fetchJson(`${baseUrl}/`);
    index.status === 200 && index.text.includes('<div id="root">')
      ? ok("A4 首页 HTML 200（SPA 入口）")
      : fail("A4 首页 HTML 200", `HTTP ${index.status}`);

    const stores = await fetchJson(`${baseUrl}/api/stores`, { cookie });
    stores.status === 200 && Array.isArray(stores.json) && stores.json.length === 0
      ? ok("A5 stores API 200（全新安装空列表）")
      : fail("A5 stores API 200（全新安装空列表）", `HTTP ${stores.status} ${JSON.stringify(stores.json)}`);
  } finally {
    // stop.bat 能停：退出码 0 + pid 消失 + 端口失联 + pid 文件清掉
    const stopped = await runBat("stop.bat", env);
    stopped.status === 0
      ? ok("A6 stop.bat 退出码 0", stopped.note)
      : fail("A6 stop.bat 退出码 0", `status=${stopped.status} ${stopped.note}`);
    await waitFor("pid 消失", async () => !pidAlive(pid));
    await waitFor("端口失联", async () => {
      try {
        await fetchJson(`${baseUrl}/api/health`);
        return false;
      } catch {
        return true;
      }
    }, 15000);
    !existsSync(join(home, "vibe-seller.pid"))
      ? ok("A7 pid 文件已清理")
      : fail("A7 pid 文件已清理");
    ok("A8 stop.bat 后服务确实停止（pid 消失 + 端口失联）");
  }
  return home;
}

// ── 场景 B：Python → TS 原地升级 ──
async function scenarioB() {
  step("场景 B：Python→TS 原地升级（venv 种子 → 同 VIBE_HOME 捆绑 TS server）");
  const home = mkdtempSync(join(tmpdir(), "vibe-smoke-b-"));
  const seedEnv = {
    ...process.env,
    VIBE_HOME: home,
    LOG_DIR: join(home, "logs"),
    VIBE_SELLER_TELEMETRY: "0", // 零真网红线：老后端遥测门控不建客户端
    VIBE_AUTH_REQUIRED: "true",
    BACKEND_PORT: "0", // 只用 lifespan 造数，不监听
    ADMIN_USERNAME: LEGACY.adminUsername,
    ADMIN_PASSWORD: LEGACY.adminPassword,
    ADMIN_EMAIL: LEGACY.adminEmail,
    LEGACY_MEMBER_PASSWORD: LEGACY.memberPassword,
    LEGACY_INSTALL_ID: LEGACY.installId,
  };
  const seeded = spawnSync(REFERENCE_PYTHON, [SEED_SCRIPT], { env: seedEnv, encoding: "utf8", timeout: 300000 });
  if (seeded.status !== 0) fail("B0 seed_legacy.py 退出码 0", `stderr=${seeded.stderr?.slice(-2000)}`);
  ok("B0 老 Python 版造数完成（真 FastAPI lifespan，进程内、零监听）", `venv=${REFERENCE_PYTHON}`);

  const installIdBefore = readFileSync(join(home, "data", "install_id"), "utf8").trim();
  installIdBefore === LEGACY.installId
    ? ok("B1 种子后 install_id 固定", installIdBefore)
    : fail("B1 种子后 install_id 固定", `got=${installIdBefore}`);

  // 同一 VIBE_HOME 换捆绑 TS server 启动（start.bat 同款 env；stdout/stderr 落盘供 ERROR 断言）
  const port = await freePort();
  const serverEnv = {
    ...process.env,
    VIBE_HOME: home,
    FRONTEND_DIST: join(RELEASE, "frontend"),
    BACKEND_PORT: String(port),
    VIBE_SELLER_TELEMETRY: "0",
    ADMIN_USERNAME: LEGACY.adminUsername,
    ADMIN_PASSWORD: LEGACY.adminPassword,
    ADMIN_EMAIL: LEGACY.adminEmail,
  };
  const outLog = join(home, "ts-server-out.log");
  const errLog = join(home, "ts-server-err.log");
  const out = openSync(outLog, "w");
  const err = openSync(errLog, "w");
  const child = spawn(NODE_EXE, [SERVER_MJS], { env: serverEnv, stdio: ["ignore", out, err] });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const health = await waitFor("TS server health 200", async () => {
      if (child.exitCode !== null) throw new Error(`TS server 提前退出（code=${child.exitCode}），errLog 见失败输出`);
      const r = await fetchJson(`${baseUrl}/api/health`);
      return r.status === 200 && r.json?.status === "ok" ? r : null;
    });
    ok("B2 老 VIBE_HOME 上 TS server 启动，health 200", JSON.stringify(health.json));

    // 老 admin 凭据可登录（bcrypt 兼容：老 Python bcrypt 哈希在 TS 验证链路成立）
    await login(baseUrl, LEGACY.adminUsername, LEGACY.adminPassword);
    ok("B3 老 admin 凭据登录 200");

    // legacy_member：TS seed 只重写 admin 行——这条登录 = 老 bcrypt 哈希本身验证通过
    const memberCookie = await login(baseUrl, LEGACY.memberUsername, LEGACY.memberPassword);
    ok("B4 legacy_member 登录 200（老 bcrypt 哈希真实验证，非 admin 重种子）", memberCookie.split("=")[0]);

    const adminCookie = await login(baseUrl, LEGACY.adminUsername, LEGACY.adminPassword);
    const stores = await fetchJson(`${baseUrl}/api/stores`, { cookie: adminCookie });
    const names = (stores.json ?? []).map((s) => s.name);
    names.includes(LEGACY.storeName)
      ? ok("B5 老店铺还在（GET /api/stores 含 Legacy Smoke Store）", JSON.stringify(names))
      : fail("B5 老店铺还在", JSON.stringify(stores.json));

    const settings = await fetchJson(`${baseUrl}/api/settings`, { cookie: adminCookie });
    settings.status === 200
      ? ok("B6 设置 API 200（升级后可读）", `auth_required=${settings.json?.auth_required}`)
      : fail("B6 设置 API 200", `HTTP ${settings.status}`);

    // 原始行级核对（node:sqlite 只读直查，绕过 API 合成视图）
    const db = new DatabaseSync(join(home, "data", "vibe_seller.db"), { readOnly: true });
    const marker = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(LEGACY.markerKey);
    marker?.value === LEGACY.markerValue
      ? ok("B7 老设置行还在（app_settings.smoke_legacy_marker）", String(marker.value))
      : fail("B7 老设置行还在", JSON.stringify(marker));
    const userCount = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
    userCount === 3
      ? ok("B8 老用户都在（admin/ai_bot/legacy_member）", `count=${userCount}`)
      : fail("B8 老用户都在", `count=${userCount}`);
    db.close();

    const installIdAfter = readFileSync(join(home, "data", "install_id"), "utf8").trim();
    installIdAfter === installIdBefore
      ? ok("B9 data/install_id 不变", installIdAfter)
      : fail("B9 data/install_id 不变", `before=${installIdBefore} after=${installIdAfter}`);

    await waitFor("TS server 安静下来（日志定稿）", async () => child.exitCode === null, 1500);
    const errText = readFileSync(errLog, "utf8");
    const errorLines = errText.split("\n").filter((line) => /error/i.test(line));
    errorLines.length === 0
      ? ok("B10 启动日志无 ERROR", `errLog ${errText.length} 字节`)
      : fail("B10 启动日志无 ERROR", errorLines.slice(0, 5).join(" | "));
  } finally {
    // 停 TS server：kill 后按进程存活与端口失联判定（不依赖 exit 事件——
    // Windows 上 TerminateProcess 后 child 'exit'/exitCode 可能迟迟不来，
    // 实测 waitFor(exitCode) 15s 超时而进程早已死）。
    child.kill();
    await waitFor("TS server 进程消失", async () => !pidAlive(child.pid));
    await waitFor("TS server 端口失联", async () => {
      try {
        await fetchJson(`${baseUrl}/api/health`);
        return false;
      } catch {
        return true;
      }
    }, 15000);
    ok("B11 升级冒烟结束后 TS server 已停止（进程消失 + 端口失联）");
  }
  return home;
}

// ── 主流程 ──
const requireRelease = existsSync(SERVER_MJS) && existsSync(NODE_EXE);
if (!requireRelease) {
  console.error(`[smoke] release 产物不齐：先跑 npm run package（缺 ${SERVER_MJS} 或 ${NODE_EXE}）`);
  process.exit(1);
}
if (!existsSync(REFERENCE_PYTHON)) {
  console.error(`[smoke] 参考仓库 venv python 不存在：${REFERENCE_PYTHON}（场景 B 需要）`);
  process.exit(1);
}
const homes = [];
try {
  homes.push(await scenarioA());
  homes.push(await scenarioB());
} finally {
  for (const home of homes) {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}
const failed = results.filter((r) => !r.pass);
console.log(`\n[smoke] 结果：${results.length - failed.length}/${results.length} 通过${failed.length ? `，失败 ${failed.length}` : ""}`);
process.exit(failed.length ? 1 : 0);
