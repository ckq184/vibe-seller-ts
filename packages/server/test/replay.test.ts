// 批次 4.7.2：录制流量回放契约测试。
//
// fixture（packages/server/test/fixtures/replay/traffic.jsonl）由
// python/record_replay_fixture.py 用参考仓库 venv 进程内录制原 FastAPI app
// 生成并提交进仓库；本测试在全新 tmp VIBE_HOME + 空 DB 上以 app.request 模式
// 启动 TS app，按序重放同一序列，逐步断言：
//   1) status 逐字节一致；
//   2) 响应 JSON 经 replay/normalize.ts 归一化后 deep-equal（两侧同规则）。
// 首个不一致输出可读 diff（步骤名 + 字段路径 + 期望 vs 实际）。
//
// 不依赖 Python / 参考仓库 / 真网。占位符（{{store_1}} 等）从 TS 侧自己的
// POST 响应按 fixture 的 capture 字段解析填充。
//
// 引擎策略：fixture 排除了 agent 执行（录制器把 schedule_or_run 置 no-op，
// 规划任务停在 PENDING）；TS 侧对应注入「停在确认闸门」的脚本引擎，使规划
// 任务停在 DESIGNING——两条不可观测的差异（PENDING vs DESIGNING 是任务行
// 内部状态，fixture 步骤全部不读它），可观测面（schedule.plan_status=
// 'planning'、current_planning_task_id 非空、trigger 409）两侧同态。

import { mkdtemp, rm } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Decision } from "@vibe/core";
import { createScriptedEngine, gatePolicyFor } from "@vibe/bridge";
import { createApp, hashPassword, type AppDeps } from "../src/app";
import { openDb, seed } from "../src/db";
import { EventBus } from "../src/bus";
import type { EngineFactory } from "../src/agent/orchestrator";
import type { ServerConfig } from "../src/config";
import { normalizeValue, firstDiff } from "./replay/normalize";
import { readFileSync } from "node:fs";

// 环境隔离：录制器以 VIBE_SELLER_TELEMETRY=0 录制（settings GET 回报
// telemetry_enabled='false'），回放侧必须同态。
process.env.VIBE_SELLER_TELEMETRY = "0";

interface FixtureStep {
  name: string;
  method: string;
  path: string;
  body?: unknown;
  status: number;
  json: unknown;
  auth?: "admin" | "member" | "none" | "bad";
  capture?: Record<string, string>;
  cookie_user?: string;
  settle_ms?: number;
}

const FIXTURE = join(import.meta.dirname, "fixtures", "replay", "traffic.jsonl");
const STEPS: FixtureStep[] = readFileSync(FIXTURE, "utf-8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as FixtureStep);

// 兜底脚本：规划任务停在确认闸门（gate 永不批复 → 恒 DESIGNING / plan_status planning）
const PLAN_PARKED: Decision[] = [
  { kind: "call_tool", intent: { name: "vibe_seller_list_stores", arguments: {} } },
  { kind: "respond", content: "调度计划：先拉店铺再执行。" },
];
const engineFactory: EngineFactory = async () => ({
  engine: createScriptedEngine({
    decisions: PLAN_PARKED,
    gatedTools: ["vibe_seller_list_stores"],
    toolNames: ["vibe_seller_list_stores"],
  }),
  tools: { execute: async () => ({ status: "error", error: { code: "invalid_tool", message: "unused" } }) },
  gates: gatePolicyFor(["vibe_seller_list_stores"]),
});

let dir: string;
let deps: AppDeps;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibe-replay-"));
  // 与原实现 config.py 导入期创建的目录骨架同构——workspace tree 逐条目比较，
  // 这些空目录是录制环境的既成事实（bin/bh-tmp/r/downloads/config.py mkdir；data/* 为
  // DATA_DIR 子目录）。config/ 由 channel configure 写入；knowledge 等由流程创建。
  for (const d of ["data/screenshots", "data/attachments", "data/email_dbs", "bin", "bh-tmp", "r", "downloads"]) {
    mkdirSync(join(dir, d), { recursive: true });
  }
  const config: ServerConfig = {
    homeDir: dir,
    dataDir: join(dir, "data"),
    dbPath: join(dir, "data", "vibe_seller.db"),
    jwtSecretFile: join(dir, "data", "jwt_secret"),
    port: 0,
    adminEmail: "admin@vibe-seller.local",
    adminPassword: "admin",
    adminUsername: "admin",
    version: "0.1.0-replay", // 与原 0.0.0+dev 不同——归一化 <ver> 规则由此获得真实覆盖
    jwtSecret: "record-replay-fixed-secret",
  };
  const db = openDb(config);
  seed(db, config, hashPassword);
  deps = { config, jwtSecret: "record-replay-fixed-secret", db, bus: new EventBus(), engineFactory, maxConcurrent: 32, runScheduler: true };
  app = createApp(deps);
});

afterAll(async () => {
  // 停掉停在闸门的规划 run（schedule_create 产生）到终态再关库，避免 teardown 竞争
  const deadline = Date.now() + 6_000;
  for (;;) {
    const rows = deps.db.prepare("SELECT id, status FROM tasks WHERE status NOT IN ('completed','failed','cancelled')").all() as unknown as { id: string; status: string }[];
    if (rows.length === 0 || Date.now() > deadline) break;
    for (const r of rows) {
      await app.request(`/api/tasks/${r.id}/agent/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    }
    await new Promise((res) => setTimeout(res, 50));
  }
  deps.db.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ── 回放机制 ──

const reg = new Map<string, string>();
const cookies: Record<"admin" | "member", string> = { admin: "", member: "" };

function substitute(text: string): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const v = reg.get(key);
    if (v === undefined) throw new Error(`占位符 {{${key}}} 未登记（回放序列错位）`);
    return v;
  });
}

function substituteBody(body: unknown): unknown {
  if (typeof body === "string") return substitute(body);
  if (Array.isArray(body)) return body.map(substituteBody);
  if (body !== null && typeof body === "object") {
    return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, substituteBody(v)]));
  }
  return body;
}

function jsonPathGet(data: unknown, path: string): unknown {
  let cur: unknown = data;
  for (const part of path.split(".")) {
    if (Array.isArray(cur)) cur = cur[Number(part)];
    else cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

async function replayStep(step: FixtureStep): Promise<void> {
  await new Promise((r) => setTimeout(r, 50 + (step.settle_ms ?? 0)));

  const headers: Record<string, string> = {};
  const mode = step.auth ?? "admin";
  if ((mode === "admin" || mode === "member") && cookies[mode]) headers.cookie = cookies[mode];
  else if (mode === "bad") headers.cookie = "auth_token=garbage";

  const path = substitute(step.path);
  const init: RequestInit = { method: step.method, headers: { ...headers, "content-type": "application/json" } };
  if (step.body !== undefined) init.body = JSON.stringify(substituteBody(step.body));

  const res = await app.request(path, init);

  // 登录步：解析 TS 自己的 Set-Cookie（fixture 记录 cookie_user 归属）
  const setCookie = res.headers.get("set-cookie");
  if (setCookie && step.method === "POST" && path === "/api/auth/login" && res.status === 200) {
    cookies[(step.cookie_user ?? "admin") as "admin" | "member"] = setCookie.split(";")[0]!;
  }

  const text = await res.text();
  let payload: unknown = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null; // 非 JSON（如 dida365 callback 的 HTML 错误页）——两侧同为 null
  }

  for (const [logical, jp] of Object.entries(step.capture ?? {})) {
    const v = jsonPathGet(payload, jp);
    if (v === undefined || v === null) {
      throw new Error(`步骤 ${step.name} capture ${logical}<${jp}> 失败：TS 响应缺路径（status ${res.status}）`);
    }
    reg.set(logical, String(v));
  }

  if (res.status !== step.status) {
    throw new Error(
      `[${step.name}] ${step.method} ${step.path}\n  status 不一致：fixture=${step.status} TS=${res.status}\n  TS body: ${text.slice(0, 300)}`,
    );
  }
  const expected = normalizeValue(step.json);
  const actual = normalizeValue(payload);
  const diff = firstDiff(expected, actual);
  if (diff) {
    throw new Error(
      `[${step.name}] ${step.method} ${step.path}\n` +
        `  JSON 归一化后不一致 @ ${diff.path}\n` +
        `    fixture: ${JSON.stringify(diff.expected)}\n` +
        `    TS     : ${JSON.stringify(diff.actual)}`,
    );
  }
}

describe("录制流量回放契约（fixture = 真 FastAPI 录制）", () => {
  it(`按序重放 ${STEPS.length} 步，status 与归一化 JSON 逐步一致`, async () => {
    expect(STEPS.length).toBeGreaterThanOrEqual(60);
    const failures: string[] = [];
    for (const step of STEPS) {
      try {
        await replayStep(step);
      } catch (e) {
        failures.push(e instanceof Error ? e.message : String(e));
      }
    }
    // 收集全部失败再一次性报告：定位首个红灯后仍能看完整差异面
    if (failures.length > 0) {
      throw new Error(`\n回放失败 ${failures.length}/${STEPS.length} 步：\n${failures.join("\n\n")}`);
    }
  }, 180_000);
});
