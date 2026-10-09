// 匿名 PostHog 遥测核心（app/telemetry.py 的移植）。选择退出：VIBE_SELLER_TELEMETRY=0。
// 门控链（PRD §3.2）：send() 生效当且仅当 ① init() 建过客户端；② env 非 '0'；
// ③ 非测试 runner / CI 环境（CI 变量只拦 init）；④ settings 未关闭（db_disabled）。
// base properties 差异（PRD §6.2 预裁决，唯一一处事件面差异）：
//   删 python_version（TS 无该运行时事实）、增 node_version = process.version。

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { release } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PosthogTransport, type TelemetryClient } from "./transport";

// 对齐原 APP_VERSION = importlib.metadata.version('vibe-seller')（pyproject 单一事实
// 源，缺失即安装损坏、响亮报错不做静默兜底）；TS 侧预裁决取仓库根 package.json 的
// version。定位不能写死上溯级数：源码树里本文件是 <root>/packages/server/src/telemetry/
//（4 级），打成 bundle（scripts/dev-start.mjs、5.3 的 dist/server.mjs）后深度会变——
// 从本文件真实位置逐级向上找 name === "vibe-seller-ts" 的 package.json，找不到按
// 原哲学响亮报错（等价 importlib.metadata.version 缺失）。
function findRootPackageJson(startFile: string): string {
  let dir = dirname(startFile);
  for (;;) {
    const candidate = join(dir, "package.json");
    try {
      if ((JSON.parse(readFileSync(candidate, "utf8")) as { name?: string }).name === "vibe-seller-ts") return candidate;
    } catch {
      /* 无 package.json / 非 JSON：继续向上 */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("vibe-seller-ts 根 package.json 未找到：安装损坏（原 importlib.metadata.version 缺失同款响亮失败）");
}

export const APP_VERSION: string = (
  JSON.parse(readFileSync(findRootPackageJson(fileURLToPath(import.meta.url)), "utf8")) as { version: string }
).version;

export const POSTHOG_PROJECT_KEY = "phc_NP0EO5Koq1dWqXEHwR14Po7bVqqtAdWINXiWypKU6H7";
export const POSTHOG_HOST = "https://t.vibe-sellers.com";
export const SETTINGS_KEY = "telemetry_enabled"; // app_settings 表行键（原 telemetry.SETTINGS_KEY）

let client: TelemetryClient | null = null;
let installId: string | null = null;
let dbDisabled = false;
// 前端最新 UI locale（/api/telemetry/locale 上报；i18n 启动与切语言时各一次）。
// 'unknown' 直到有浏览器上报过；并入 base_properties() 供看板按语言分组。
let appLocale = "unknown";

// ── 门控判定 ──

export function disabledViaEnv(): boolean {
  return (process.env["VIBE_SELLER_TELEMETRY"] ?? "").trim() === "0";
}

// 原 _running_under_pytest：'pytest' in sys.modules or 'PYTEST_CURRENT_TEST' in env。
// TS 等价（PRD §3.2 预裁决）：vitest 注入的 VITEST 或 NODE_ENV==='test'。
function runningUnderTestRunner(): boolean {
  return process.env["VITEST"] !== undefined || process.env["NODE_ENV"] === "test";
}

// CI runner 检测——CI 作业里拉起的真 server 各自拿到新 install_id，会污染看板
// （原 _running_in_ci 同名变量表移植；只拦 init，不参与 is_enabled）。
function runningInCi(): boolean {
  const ciSignals = ["CI", "GITHUB_ACTIONS", "BUILDKITE", "GITLAB_CI", "CIRCLECI", "JENKINS_URL"] as const;
  return ciSignals.some((name) => process.env[name]);
}

function resolveInstallId(dataDir: string): string {
  const file = join(dataDir, "install_id");
  try {
    if (existsSync(file)) {
      const value = readFileSync(file, "utf8").trim();
      if (value) return value;
    }
    const value = randomUUID();
    writeFileSync(file, value, "utf8");
    return value;
  } catch {
    // IO 失败：一次性 uuid，不落盘（与原实现一致）
    return randomUUID();
  }
}

/** 建客户端 + 解析 install_id（幂等；env/测试/CI 门控任一命中则不建）。 */
export function init(dataDir: string): void {
  if (client !== null) return;
  if (disabledViaEnv() || runningUnderTestRunner() || runningInCi()) return;
  try {
    installId = resolveInstallId(dataDir);
    client = new PosthogTransport({ apiKey: POSTHOG_PROJECT_KEY, host: POSTHOG_HOST });
  } catch (err) {
    console.warn("[vibe-telemetry] init failed:", err);
    client = null;
  }
}

export function setDbDisabled(disabled: boolean): void {
  dbDisabled = disabled;
}

export function isEnabled(): boolean {
  if (client === null || disabledViaEnv()) return false;
  return !dbDisabled;
}

export function getInstallId(): string | null {
  return installId;
}

/** 发送事件：base properties 合入每一个事件（caller 键覆盖 base）；永不抛出。 */
export function send(event: string, properties?: Record<string, unknown>): void {
  if (!isEnabled() || installId === null || client === null) return;
  try {
    const props = { ...baseProperties(), ...(properties ?? {}) };
    client.capture(installId, event, props);
  } catch (err) {
    console.debug(`[vibe-telemetry] send failed for ${event}:`, err instanceof Error ? err.message : err);
  }
}

// ── 平台与 base properties ──

export function runtimeOs(): string {
  const s = process.platform;
  if (s === "darwin") return "mac";
  if (s === "win32") return "windows";
  if (s === "linux") {
    try {
      if (readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft")) return "wsl";
    } catch {
      /* 非 Linux 内核信息可读时按原生 Linux 处理 */
    }
    return "linux";
  }
  return "other";
}

export function baseProperties(): Record<string, unknown> {
  return {
    app_version: APP_VERSION,
    os: runtimeOs(),
    os_release: release(),
    // 预裁决（PRD §6.2）：原实现此键为 python_version = '{major}.{minor}'；
    // TS 侧改报 node_version（完整 process.version，如 v24.x）。
    node_version: process.version,
    is_docker: existsSync("/.dockerenv"),
    app_locale: appLocale,
  };
}

/** 记录前端 UI locale；客户端在手时补推一条 $identify（person property）。 */
export function setAppLocale(locale: string): void {
  appLocale = locale || "unknown";
  if (client === null || installId === null) return;
  try {
    client.identify(installId, { app_locale: appLocale });
  } catch (err) {
    console.debug("[vibe-telemetry] identify failed:", err instanceof Error ? err.message : err);
  }
}

// ── bucket 函数全集（逐边界对齐 app/telemetry.py） ──

export function countBucket(n: number): string {
  if (n <= 0) return "0";
  if (n <= 5) return "1-5";
  if (n <= 20) return "6-20";
  if (n <= 100) return "21-100";
  return "100+";
}

export function durationBucket(seconds: number | null): string {
  if (seconds === null) return "unknown";
  const secs = Math.max(0, Math.trunc(seconds)); // int() 截断 + 负数钳 0
  if (secs < 30) return "<30s";
  if (secs < 120) return "30s-2m";
  if (secs < 600) return "2m-10m";
  if (secs < 1800) return "10m-30m";
  return ">30m";
}

export function durationBucketFromIso(startIso: string | null, endIso: string | null): string {
  return durationBucket(durationSecondsFromIso(startIso, endIso));
}

export function durationSecondsFromIso(startIso: string | null, endIso: string | null): number | null {
  if (!startIso || !endIso) return null;
  try {
    const start = Date.parse(startIso);
    const end = Date.parse(endIso);
    if (Number.isNaN(start) || Number.isNaN(end)) return null;
    return Math.max(0, Math.trunc((end - start) / 1000));
  } catch {
    return null;
  }
}

export function lengthBucket(n: number): string {
  if (n <= 0) return "0";
  if (n < 50) return "<50";
  if (n < 200) return "50-200";
  if (n < 1000) return "200-1k";
  if (n < 5000) return "1k-5k";
  return "5k+";
}

export function ageBucketDays(days: number | null): string {
  if (days === null) return "unknown";
  if (days < 1) return "<1d";
  if (days < 7) return "1-7d";
  if (days < 30) return "1-4w";
  if (days < 90) return "1-3m";
  if (days < 365) return "3-12m";
  return ">1y";
}

export function retentionDaysBucket(days: number): string {
  if (days <= 0) return "0-disabled";
  if (days < 7) return "<7";
  if (days <= 30) return "7-30";
  if (days <= 90) return "30-90";
  return "90+";
}

export function tzContinentBucket(iana: string | null): string {
  if (!iana) return "UTC";
  if (!iana.includes("/")) return iana === "UTC" ? iana : "other";
  const head = iana.split("/", 1)[0] ?? "";
  if (["Asia", "America", "Europe", "Africa", "Australia", "Pacific", "Atlantic", "Indian", "Antarctica"].includes(head)) {
    return head;
  }
  return "other";
}

const EMAIL_DOMAIN_KIND: Record<string, string> = {
  "gmail.com": "gmail",
  "googlemail.com": "gmail",
  "outlook.com": "outlook",
  "hotmail.com": "outlook",
  "live.com": "outlook",
  "msn.com": "outlook",
  "icloud.com": "icloud",
  "me.com": "icloud",
  "yahoo.com": "yahoo",
  "yahoo.co.jp": "yahoo",
  "ymail.com": "yahoo",
};

export function emailProviderKind(email: string | null): string {
  if (!email || !email.includes("@")) return "other";
  const domain = email.split("@").pop()!.toLowerCase().trim();
  return EMAIL_DOMAIN_KIND[domain] ?? "other";
}

/** 优雅停机：排空队列；客户端不在手时无操作；异常裸吞（与原 shutdown 一致）。 */
export async function shutdown(): Promise<void> {
  if (client === null) return;
  try {
    await client.shutdown();
  } catch {
    /* 吞掉——停机路径上的遥测失败不可见 */
  }
}

// ── 测试专用钩子（对应原单元测试直接改 _client/_install_id 私有态的用法）：
// vitest 下 init() 被 runner 门控拦住，事件面测试经此注入假捕获客户端。 ──

export const __test = {
  reset(): void {
    client = null;
    installId = null;
    dbDisabled = false;
    appLocale = "unknown";
  },
  enable(
    captured: { event: string; properties: Record<string, unknown> }[],
    fixedInstallId = "test-install-id",
    opts?: { throwOnCapture?: boolean },
  ): void {
    installId = fixedInstallId;
    client = {
      capture: (_distinctId, event, properties) => {
        if (opts?.throwOnCapture) throw new Error("capture boom");
        void captured.push({ event, properties });
      },
      identify: () => {},
      flush: async () => {},
      shutdown: async () => {},
    };
  },
};
