// 紫鸟客户端本地 HTTP API 调用面（app/browser/ziniao_utils.py 的"请求面"移植——
// PRD §4.7 预裁决：进程外 HTTP 调用，非浏览器层源码移植）。
// 紫鸟客户端在本机 socket_port 上听 POST JSON：{action, requestId, company,
// username, password}；statusCode=='0' 为成功。WSL 主机探测/回退与状态机
//（running_webdriver/running_normal/not_running/not_installed）逐条对齐；
// 进程检测用 tasklist/pkill/taskkill 子进程（与原实现同命令面）。

import { existsSync, readFileSync } from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import * as telemetry from "../telemetry/core";
import { BrowserFailureReason, TelemetryEvent } from "../telemetry/events";

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export class ZiniaoNormalModeError extends Error {
  constructor(message = "Ziniao is running but not in WebDriver mode. Please close Ziniao and try again.") {
    super(message);
  }
}

export interface ZiniaoUserInfo {
  company: string;
  username: string;
  password: string;
}

const LOCALHOST = "127.0.0.1";

// ── 平台判定 ──

export function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const version = readFileSync("/proc/version", "utf8");
    return version.toLowerCase().includes("microsoft") || version.toLowerCase().includes("wsl");
  } catch {
    return false;
  }
}

function getZiniaoHost(): string {
  if (isWsl()) {
    try {
      const out = execFileSync("ip", ["route", "show", "default"], { timeout: 5000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const m = /via\s+(\d+\.\d+\.\d+\.\d+)/.exec(out);
      if (m) return m[1]!;
    } catch {
      /* 回退 localhost */
    }
  }
  return LOCALHOST;
}

let hostCache: string | null = null;
function ziniaoHost(): string {
  if (hostCache === null) hostCache = getZiniaoHost();
  return hostCache;
}

export function resetZiniaoHostCache(): void {
  hostCache = null;
}

// ── HTTP 面 ──

async function sendHttp(port: number, data: Record<string, unknown>, timeoutMs: number, host?: string, fetchImpl: FetchImpl = fetch): Promise<Record<string, unknown> | null> {
  const target = host ?? ziniaoHost();
  try {
    // 紫鸟恒为本机/LAN——Node fetch 默认不读 env 代理（trust_env=False 语义一致）。
    const resp = await fetchImpl(`http://${target}:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return (await resp.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** try_connect_ziniao：WSL 先 127.0.0.1（镜像网络）再网关 IP（NAT）；其余平台标准解析。 */
export async function tryConnectZiniao(
  port: number,
  data: Record<string, unknown>,
  timeoutMs: number,
  fetchImpl?: FetchImpl,
): Promise<{ result: Record<string, unknown> | null; host: string }> {
  if (!isWsl()) {
    const host = ziniaoHost();
    return { result: await sendHttp(port, data, timeoutMs, host, fetchImpl), host };
  }
  const viaLocal = await sendHttp(port, data, timeoutMs, LOCALHOST, fetchImpl);
  if (viaLocal !== null) return { result: viaLocal, host: LOCALHOST };
  const gateway = ziniaoHost();
  return { result: await sendHttp(port, data, timeoutMs, gateway, fetchImpl), host: gateway };
}

function probePayload(userInfo: ZiniaoUserInfo): Record<string, unknown> {
  return { action: "getBrowserList", requestId: crypto.randomUUID(), ...userInfo };
}

// ── 进程/安装检测（与原实现同命令面） ──

function runCapture(cmd: string, args: string[], opts: { timeout: number; cwd?: string }): string | null {
  try {
    return execFileSync(cmd, args, { timeout: opts.timeout, encoding: "utf8", cwd: opts.cwd, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

export function isZiniaoProcessRunning(): boolean {
  if (process.platform === "win32") {
    const out = runCapture("tasklist", ["/FI", "IMAGENAME eq ziniao.exe"], { timeout: 10_000 });
    return (out ?? "").toLowerCase().includes("ziniao.exe");
  }
  if (isWsl()) {
    const cmdPath = "/mnt/c/Windows/System32/cmd.exe";
    if (!existsSync(cmdPath)) return false;
    const out = runCapture(cmdPath, ["/c", 'tasklist /FI "IMAGENAME eq ziniao.exe"'], { timeout: 10_000, cwd: "/mnt/c/" });
    return (out ?? "").toLowerCase().includes("ziniao.exe");
  }
  if (process.platform === "darwin") {
    const r = spawnSync("pgrep", ["-f", "ziniao.app/Contents/MacOS"], { timeout: 10_000 });
    return r.status === 0;
  }
  return false;
}

function isZiniaoInstalledMac(): boolean {
  if (process.platform !== "darwin") return false;
  const out = runCapture("mdfind", ["kMDItemFSName == \"ziniao.app\""], { timeout: 10_000 });
  return Boolean((out ?? "").trim());
}

export function getPlatform(): string {
  if (process.platform === "darwin") return "mac";
  if (process.platform === "win32") return "windows";
  if (isWsl()) return "wsl";
  return "linux";
}

// ── 状态与生命周期 ──

export type ZiniaoStatus = {
  status: "running_webdriver" | "no_permission" | "api_error" | "running_normal" | "not_running" | "not_installed";
};

export async function getZiniaoStatus(socketPort: number, userInfo: ZiniaoUserInfo, fetchImpl?: FetchImpl): Promise<ZiniaoStatus> {
  const { result } = await tryConnectZiniao(socketPort, probePayload(userInfo), 5000, fetchImpl);
  if (result !== null) {
    const statusCode = String(result["statusCode"] ?? "");
    if (statusCode === "0") return { status: "running_webdriver" };
    if (statusCode === "-10003") return { status: "no_permission" };
    return { status: "api_error" };
  }
  if (isZiniaoProcessRunning()) return { status: "running_normal" };
  if (process.platform === "darwin") {
    return { status: isZiniaoInstalledMac() ? "not_running" : "not_installed" };
  }
  return { status: "not_running" };
}

/** graceful_exit：紫鸟 `exit` action（比 SIGKILL 干净，见原 docs/ziniao-concurrency.md）。 */
async function gracefulExitZiniao(socketPort: number, userInfo: ZiniaoUserInfo, fetchImpl?: FetchImpl): Promise<boolean> {
  const { result } = await tryConnectZiniao(socketPort, { action: "exit", requestId: crypto.randomUUID(), ...userInfo }, 5000, fetchImpl);
  return result !== null;
}

export function forceKillZiniao(): void {
  if (process.platform === "darwin") {
    spawnSync("pkill", ["-9", "-f", "ziniao.app/Contents/MacOS"], { timeout: 10_000 });
  } else if (process.platform === "win32") {
    spawnSync("taskkill", ["/F", "/IM", "ziniao.exe"], { timeout: 10_000 });
  } else if (isWsl()) {
    const taskkill = "/mnt/c/Windows/System32/taskkill.exe";
    if (!existsSync(taskkill)) throw new Error(`taskkill.exe not found at ${taskkill}; WSL interop may be disabled`);
    spawnSync(taskkill, ["/F", "/IM", "ziniao.exe"], { timeout: 10_000, cwd: "/mnt/c/" });
  } else {
    throw new Error("Force kill is only supported on Mac, Windows and WSL");
  }
}

/** 启动命令（build_launch_cmd 移植）。browser_launch_env 的 PATH 防逃逸属浏览器层红线，不在本批。 */
export function buildLaunchCmd(clientPath: string, socketPort: number): string[] {
  if (process.platform === "win32") {
    const exe = clientPath && clientPath.toLowerCase().endsWith(".exe") ? clientPath : findZiniaoExeWindows();
    if (!exe) {
      throw new Error("Could not find ziniao.exe. Please make sure Ziniao is installed (default: C:\\Program Files\\ziniao\\ziniao.exe).");
    }
    return [exe, "--run_type=web_driver", "--ipc_type=http", `--port=${socketPort}`];
  }
  if (process.platform === "darwin") {
    return ["open", "-a", clientPath, "--args", "--run_type=web_driver", "--ipc_type=http", `--port=${socketPort}`];
  }
  if (isWsl()) {
    throw new Error(
      "WSL cannot launch Ziniao automatically. Please download and run the launcher script on Windows first:\n  1. Download: /api/ziniao/launcher\n  2. Double-click ziniao_webdriver.bat on Windows\n  3. Wait for \"ready\" message, then retry",
    );
  }
  return [clientPath, "--no-sandbox", "--run_type=web_driver", "--ipc_type=http", `--port=${socketPort}`];
}

function findZiniaoExeWindows(): string | null {
  for (const envVar of ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]) {
    const base = process.env[envVar];
    if (base) {
      const candidate = join(base, "ziniao", "ziniao.exe");
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function spawnDetached(cmd: string[]): void {
  const child = spawn(cmd[0]!, cmd.slice(1), { detached: true, stdio: "ignore" });
  child.unref();
}

/** kill_and_relaunch_ziniao：优雅退出 → 兜底强杀 → 等终止 → 重拉 → 探活（60s）。
 * Mac/原生 Windows 自动重拉；WSL/原生 Linux 只杀（Electron 经 interop 无法带参重拉）。 */
export async function killAndRelaunchZiniao(socketPort: number, clientPath: string, userInfo: ZiniaoUserInfo, fetchImpl?: FetchImpl): Promise<boolean> {
  if (!(await gracefulExitZiniao(socketPort, userInfo, fetchImpl))) forceKillZiniao();
  let terminated = false;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    if (!isZiniaoProcessRunning()) {
      terminated = true;
      break;
    }
  }
  if (!terminated && isZiniaoProcessRunning()) {
    throw new Error("Failed to terminate Ziniao after 10 seconds. Please close it manually via Task Manager.");
  }
  if (!(process.platform === "darwin" || process.platform === "win32")) return true;
  try {
    spawnDetached(buildLaunchCmd(clientPath, socketPort));
  } catch (e) {
    throw new Error(`Failed to relaunch Ziniao: ${e instanceof Error ? e.message : String(e)}`);
  }
  const probe = probePayload(userInfo);
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const { result } = await tryConnectZiniao(socketPort, probe, 10_000, fetchImpl);
    if (result !== null) return true;
  }
  throw new Error("Ziniao relaunch timed out after 60 seconds");
}

/** ensure_ziniao_running：探活 → WSL 指引 → normal mode 报错 → 自动拉起 → 探活 60s。
 * 返回 true = 可达；失败抛 Error/ZiniaoNormalModeError。
 * 遥测面（原 ziniao_utils.py:619-772 逐点移植）：attempted 每次探活一条；
 * started 判定 = 连通即成功（statusCode≠0 仍算）；failed 的 error_category ∈
 * BrowserFailureReason。 */
export async function ensureZiniaoRunning(socketPort: number, clientPath: string, userInfo: ZiniaoUserInfo, fetchImpl?: FetchImpl): Promise<boolean> {
  const runtimeOs = telemetry.runtimeOs();

  const fireFailed = (category: string, attempts: number): void => {
    try {
      telemetry.send(TelemetryEvent.BROWSER_SESSION_FAILED, {
        backend: "ziniao",
        os: runtimeOs,
        attempts_total: attempts,
        error_category: category,
      });
    } catch {
      /* 遥测不影响主流程 */
    }
  };

  const probeTimeoutMs = isWsl() ? 3000 : 10_000;
  const probe = probePayload(userInfo);
  try {
    telemetry.send(TelemetryEvent.BROWSER_SESSION_ATTEMPTED, { backend: "ziniao", os: runtimeOs, attempt_number: 1 });
  } catch {
    /* 遥测不影响主流程 */
  }
  const { result } = await tryConnectZiniao(socketPort, probe, probeTimeoutMs, fetchImpl);
  if (result !== null) {
    // 紫鸟在凭据错误时也回响应（statusCode != 0）——可达即成功，状态校验交给调用方。
    try {
      telemetry.send(TelemetryEvent.BROWSER_SESSION_STARTED, {
        backend: "ziniao",
        os: runtimeOs,
        attempts_to_success: 1,
        auto_launched: false,
      });
    } catch {
      /* 遥测不影响主流程 */
    }
    return true;
  }
  if (isWsl()) {
    if (isZiniaoProcessRunning()) {
      fireFailed(BrowserFailureReason.WSL_WRONG_PORT, 1);
      throw new Error(
        `Ziniao is running on Windows but not listening on port ${socketPort}. Please close Ziniao and re-launch it using the ziniao_webdriver.bat script.\nDownload: /api/ziniao/launcher`,
      );
    }
    fireFailed(BrowserFailureReason.WSL_NOT_RUNNING, 1);
    throw new Error(
      "Ziniao is not running. WSL cannot launch Ziniao automatically.\nPlease download and run the launcher script on Windows:\n  1. Download: /api/ziniao/launcher\n  2. Double-click ziniao_webdriver.bat\n  3. Wait for \"ready\" message, then retry",
    );
  }
  if (isZiniaoProcessRunning()) {
    if (process.platform === "darwin" || process.platform === "win32") {
      fireFailed(BrowserFailureReason.NORMAL_MODE, 1);
      throw new ZiniaoNormalModeError();
    }
    fireFailed(BrowserFailureReason.WRONG_PORT, 1);
    throw new Error(`Ziniao is already running but not listening on port ${socketPort}. Please close Ziniao and try again so it can be auto-launched with the correct port.`);
  }
  try {
    spawnDetached(buildLaunchCmd(clientPath, socketPort));
  } catch (e) {
    fireFailed(BrowserFailureReason.LAUNCH_FAILED, 1);
    throw new Error(`Failed to launch Ziniao client: ${e instanceof Error ? e.message : String(e)}`);
  }
  for (let i = 0; i < 30; i++) {
    try {
      // attempt_number 从 2 起（1 是初始探活，原实现同注释）
      telemetry.send(TelemetryEvent.BROWSER_SESSION_ATTEMPTED, { backend: "ziniao", os: runtimeOs, attempt_number: i + 2 });
    } catch {
      /* 遥测不影响主流程 */
    }
    await sleep(2000);
    const { result: retry } = await tryConnectZiniao(socketPort, probe, 10_000, fetchImpl);
    if (retry !== null) {
      try {
        telemetry.send(TelemetryEvent.BROWSER_SESSION_STARTED, {
          backend: "ziniao",
          os: runtimeOs,
          attempts_to_success: i + 2,
          auto_launched: true,
        });
      } catch {
        /* 遥测不影响主流程 */
      }
      return true;
    }
  }
  fireFailed(BrowserFailureReason.STARTUP_TIMEOUT, 31);
  throw new Error("Ziniao startup timed out after 60 seconds");
}
