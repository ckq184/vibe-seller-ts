// 编排器队列语义（2026-10-12 实测事故的回归钉）：drain 复用 storeBusy（含"队列非空"）
// 把队头任务自己判忙，店铺泳道永远排不出——queued 任务只能等重启恢复才开工
//（生产证据：三单排队时长 1750s/289s/930s，started_at 全部恰等于下次服务重启时刻）。
// 本文件直接驱动 TaskOrchestrator（脚本引擎 + hold 工具桩控运行时长），零网络。
// 看门狗：queue_drain 系统作业注册钉（作业体 = orchestrator.drainQueues()，其排水
// 语义由上面用例钉死，这里只钉"作业在、间隔 60s"）。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Decision, ToolPort } from "@vibe/core";
import { createScriptedEngine } from "./scripted-engine";
import { hashPassword } from "../src/app";
import { openDb, seed } from "../src/db";
import { EventBus } from "../src/bus";
import { TaskOrchestrator, type EngineFactory } from "../src/agent/orchestrator";
import { startScheduler } from "../src/scheduler/scheduler";
import type { ServerConfig } from "../src/config";

let dir: string;
let config: ServerConfig;
let db: ReturnType<typeof openDb>;
let bus: EventBus;

/** hold 工具桩：脚本调 "hold" 即挂起，测试 release(taskId) 放行 → 跑到 respond 终局。 */
const holdGates = new Map<string, () => void>();
/** 引擎工厂故障名单：工厂直接 throw（钉"工厂失败也必须排水"）。 */
const broken = new Set<string>();
const engines = new Map<string, Decision[]>();

const HOLD: Decision[] = [
  { kind: "call_tool", intent: { name: "hold", arguments: {} } },
  { kind: "respond", content: "放行了" },
];
const SAY = (text: string): Decision[] => [{ kind: "respond", content: text }];

const engineFactory: EngineFactory = async ({ taskId }) => {
  if (broken.has(taskId)) throw new Error("engine factory boom");
  const decisions = engines.get(taskId) ?? SAY("空");
  const toolPort: ToolPort = {
    execute: async (intent) => {
      if (intent.name === "hold") {
        await new Promise<void>((r) => holdGates.set(taskId, r));
        return { status: "success", result: { held: true } };
      }
      return { status: "success", result: { echo: intent.name } };
    },
  };
  return {
    engine: createScriptedEngine({ decisions, gatedTools: [], toolNames: ["hold"] }, toolPort),
    tools: { execute: async () => ({ status: "error", error: { code: "invalid_tool", message: "unused" } }) },
  };
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibe-orchq-"));
  config = {
    homeDir: dir,
    dataDir: dir,
    dbPath: join(dir, "vibe_seller.db"),
    jwtSecretFile: join(dir, "jwt_secret"),
    port: 0,
    adminEmail: "admin@vibe-seller.local",
    adminPassword: "admin",
    adminUsername: "admin",
    version: "0.1.0-test",
    jwtSecret: "test-secret",
  };
  db = openDb(config);
  seed(db, config, hashPassword);
  bus = new EventBus();
});

afterAll(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

function makeOrch(maxConcurrent: number): TaskOrchestrator {
  return new TaskOrchestrator({ config, db, bus, engineFactory, maxConcurrent });
}

function insertTask(storeId: string, title: string): string {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tasks (id, parent_task_id, store_id, schedule_id, template_id, created_by, assigned_to,
                        title, description, platform, country, status, priority, input_data,
                        plan, plan_history, result, accepted_result, submitted_result, review_gaps,
                        submission_count, transcript_tail, todos, error, error_category,
                        started_at, completed_at, plan_mode, is_plan_only, plan_version,
                        skip_reflection, wait_condition, batch_id, is_finalize, ai_profile_id,
                        session_id, created_at, updated_at)
     VALUES (?, NULL, ?, NULL, NULL, '00000000-0000-0000-0000-000000000001', NULL,
             ?, NULL, NULL, NULL, 'pending', 0, NULL,
             NULL, NULL, NULL, NULL, NULL, NULL,
             0, NULL, NULL, NULL, NULL,
             NULL, NULL, 0, 0, NULL, 0, NULL, NULL, 0, 'default', NULL, ?, ?)`,
  ).run(id, storeId, title, now, now);
  return id;
}

const launch = (orch: TaskOrchestrator, taskId: string, storeId: string) =>
  orch.enqueueOrLaunch(taskId, { mode: "execute", store: { id: storeId, name: storeId }, queueWhenSaturated: true });

const statusOf = (taskId: string): string | undefined =>
  (db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string } | undefined)?.status;

const release = (taskId: string): void => holdGates.get(taskId)?.();

async function waitFor(fn: () => string | boolean | undefined, timeout = 8000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (fn() !== undefined && fn() !== false) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`waitFor timeout（最后观测：${fn()}）`);
}

describe("编排器队列排水", () => {
  it("跨店泳道：占坑任务终局释放容量后，队头立即开工（2026-10-12 死锁回归钉）", async () => {
    const orch = makeOrch(2);
    const t1 = insertTask("qs1", "占坑一");
    const t2 = insertTask("qs2", "占坑二");
    const t3 = insertTask("qs3", "排队的队头");
    engines.set(t1, HOLD);
    engines.set(t2, HOLD);
    engines.set(t3, SAY("队头干完了"));
    expect(launch(orch, t1, "qs1")).toBe("launched");
    expect(launch(orch, t2, "qs2")).toBe("launched");
    await waitFor(() => holdGates.has(t1) && holdGates.has(t2));
    expect(launch(orch, t3, "qs3")).toBe("queued");
    expect(statusOf(t3)).toBe("queued");

    release(t1);
    await waitFor(() => statusOf(t1) === "completed");
    await waitFor(() => statusOf(t3) !== "queued");
    await waitFor(() => statusOf(t3) === "completed");
  });

  it("同店 FIFO：前一单终局后，同店队头接棒", async () => {
    const orch = makeOrch(2);
    const t1 = insertTask("fs1", "同店前一单");
    const t2 = insertTask("fs1", "同店后一单");
    engines.set(t1, HOLD);
    engines.set(t2, SAY("接棒完成"));
    expect(launch(orch, t1, "fs1")).toBe("launched");
    await waitFor(() => holdGates.has(t1));
    expect(launch(orch, t2, "fs1")).toBe("queued");

    release(t1);
    await waitFor(() => statusOf(t1) === "completed");
    await waitFor(() => statusOf(t2) === "completed");
  });

  it("排水不越权：该店仍有 run 在跑时队头不动（全局有空位也不行），前单终局后才开工", async () => {
    const orch = makeOrch(2);
    const t1 = insertTask("ns1", "本店还占着");
    const t2 = insertTask("ns2", "别店占坑");
    const t3 = insertTask("ns1", "同店排队");
    engines.set(t1, HOLD);
    engines.set(t2, HOLD);
    engines.set(t3, SAY("轮到我了"));
    expect(launch(orch, t1, "ns1")).toBe("launched");
    expect(launch(orch, t2, "ns2")).toBe("launched");
    await waitFor(() => holdGates.has(t1) && holdGates.has(t2));
    expect(launch(orch, t3, "ns1")).toBe("queued");

    release(t2);
    await waitFor(() => statusOf(t2) === "completed");
    await new Promise((r) => setTimeout(r, 300)); // 给错误实现留"越权排水"的窗口
    expect(statusOf(t3)).toBe("queued"); // ns1 仍被 t1 占用：不许启动

    release(t1);
    await waitFor(() => statusOf(t1) === "completed");
    await waitFor(() => statusOf(t3) === "completed");
  });

  it("引擎工厂失败路径也必须排水：占坑 run 落 FAILED 后，排队任务接棒", async () => {
    const orch = makeOrch(1);
    const t1 = insertTask("bf1", "工厂要炸的单");
    const t2 = insertTask("bf2", "排队接棒的单");
    broken.add(t1);
    engines.set(t2, SAY("接棒完成"));
    expect(launch(orch, t1, "bf1")).toBe("launched");
    expect(launch(orch, t2, "bf2")).toBe("queued"); // max=1 已饱和
    await waitFor(() => statusOf(t1) === "failed");
    await waitFor(() => statusOf(t2) === "completed");
  });
});

describe("queue_drain 看门狗作业", () => {
  it("注册为系统作业（60s 间隔），作业体 drainQueues 空队列零副作用", () => {
    const orch = makeOrch(2);
    const boot = startScheduler({ config, db, bus, orchestrator: orch }, { recover: false });
    expect(boot.systemJobIds).toContain("queue_drain");
    expect(boot.scheduler.hasJob("queue_drain")).toBe(true);
    expect(boot.scheduler.listJobs().find((j) => j.job_id === "queue_drain")?.trigger).toBe("interval[0:01:00]");
    expect(() => orch.drainQueues()).not.toThrow(); // 空队列幂等
    boot.scheduler.stop();
  });
});
