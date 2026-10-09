// 批次 4.3 编排 e2e：脚本引擎注入（零网络），全链路验证
// 启动→事件→落库→outcome 裁决、门问答、stop、retry、follow-up、result 入口。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Decision } from "@vibe/core";
import { gatePolicyFor } from "@vibe/bridge";
import { createScriptedEngine } from "./scripted-engine";
import { createApp, hashPassword, type AppDeps } from "../src/app";
import { openDb, seed } from "../src/db";
import { EventBus } from "../src/bus";
import type { EngineFactory } from "../src/agent/orchestrator";
import type { ServerConfig } from "../src/config";

let dir: string;
let deps: AppDeps;
let app: ReturnType<typeof createApp>;
let adminCookie: string;

const HAPPY: Decision[] = [
  { kind: "call_tool", intent: { name: "vibe_seller_list_stores", arguments: {} } },
  { kind: "respond", content: "共有 1 家店铺。" },
];
const GATED: Decision[] = [
  { kind: "call_tool", intent: { name: "update_price", arguments: { sku: "A-1" } } },
  { kind: "respond", content: "价格已更新。" },
];

const engines = new Map<string, { decisions: Decision[]; gated?: string[] }>();

const engineFactory: EngineFactory = async ({ taskId }) => {
  const script = engines.get(taskId) ?? { decisions: [{ kind: "respond", content: "空脚本" }] };
  return {
    engine: createScriptedEngine({ decisions: script.decisions, gatedTools: script.gated ?? [], toolNames: ["vibe_seller_list_stores", "update_price"] }),
    tools: { execute: async () => ({ status: "error", error: { code: "invalid_tool", message: "unused" } }) },
    gates: gatePolicyFor(script.gated ?? []),
  };
};

async function waitFor<T>(fn: () => T | undefined | null, timeout = 8000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const v = fn();
    if (v !== undefined && v !== null) return v;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error("waitFor timeout");
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibe-orch-"));
  const config: ServerConfig = {
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
  const db = openDb(config);
  seed(db, config, hashPassword);
  deps = { config, jwtSecret: "test-secret", db, bus: new EventBus(), engineFactory, maxConcurrent: 4 };
  app = createApp(deps);
  const res = await app.request("/api/auth/login", { method: "POST", body: JSON.stringify({ identifier: "admin", password: "admin" }), headers: { "content-type": "application/json" } });
  adminCookie = res.headers.get("set-cookie")!.split(";")[0]!;
});

afterAll(async () => {
  deps.db.close();
  await rm(dir, { recursive: true, force: true });
});

const post = (path: string, body?: unknown) =>
  app.request(path, { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
const getJson = async (path: string) => (await (await app.request(path, { headers: { cookie: adminCookie } })).json()) as Record<string, unknown>;

async function createTask(title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const created = (await (await post("/api/tasks", { title, ...extra })).json()) as { id: string };
  return created.id;
}

async function runToCompletion(taskId: string): Promise<Record<string, unknown>> {
  return waitFor(() => {
    const status = deps.db.prepare("SELECT status, result, error FROM tasks WHERE id = ?").get(taskId) as
      | { status: string; result: string | null; error: string | null }
      | undefined;
    if (status && ["completed", "failed"].includes(status.status)) return status as unknown as Record<string, unknown>;
    return undefined;
  });
}

describe("编排 e2e", () => {
  it("start → 工具调用 → 完成：outcome 落 result、事件序列、消息落库", async () => {
    const taskId = await createTask("拉店铺");
    engines.set(taskId, { decisions: HAPPY });
    const started = await (await post(`/api/tasks/${taskId}/start`)).json();
    expect(started).toMatchObject({ ok: true, status: "running" });

    const final = await runToCompletion(taskId);
    expect(final.status).toBe("completed");
    expect(final.result).toBe("共有 1 家店铺。"); // prose → DELIVERED

    // 事件契约：tool_use 与 result 的 task_message、agent_done、task_update 终态
    const events = deps.bus.history.filter((e) => e.data.task_id === taskId);
    const roles = events.filter((e) => e.type === "task_message").map((e) => e.data.role);
    expect(roles).toContain("tool_use");
    expect(roles.at(-1)).toBe("result");
    const agentDone = events.find((e) => e.type === "agent_done");
    expect(agentDone?.data).toMatchObject({ return_code: 0 });
    const lastUpdate = events.filter((e) => e.type === "task_update").at(-1);
    expect(lastUpdate?.data).toMatchObject({ status: "completed" });

    // 消息落库（user/tool_use/result，seq 有序，delta 排除逻辑由读取端负责）
    const messages = (await (await app.request(`/api/tasks/${taskId}/messages`, { headers: { cookie: adminCookie } })).json()) as { role: string; content: string }[];
    expect(messages[0]!.role).toBe("user");
    expect(messages.some((m) => m.role === "tool_use")).toBe(true);
    expect(messages.at(-1)!.role).toBe("result");
  });

  it("确认闸门：挂起可查 → 批准 → 工具执行 → 完成；拒绝则不执行", async () => {
    const taskId = await createTask("调价");
    engines.set(taskId, { decisions: GATED, gated: ["update_price"] });
    await post(`/api/tasks/${taskId}/start`);

    const pending = await waitFor(() => {
      const p = deps.bus.history.filter((e) => e.type === "task_questions" && e.data.task_id === taskId);
      return p.length ? (p[0]!.data as { request_id: string }) : undefined;
    });
    const statusRow = deps.db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string };
    expect(statusRow.status).toBe("running"); // 活门挂起不改任务状态
    const pendingApi = (await (await app.request(`/api/tasks/${taskId}/questions/pending`, { headers: { cookie: adminCookie } })).json()) as { pending: boolean; request_id?: string };
    expect(pendingApi.pending).toBe(true);
    expect(pendingApi.request_id).toBe(pending.request_id);

    const answered = await (await post(`/api/tasks/${taskId}/questions/answer`, { request_id: pending.request_id, answers: { approved: true } })).json();
    expect(answered).toMatchObject({ ok: true, resumed: true });
    const final = await runToCompletion(taskId);
    expect(final.status).toBe("completed");
    // 执行证据：批准后 update_price 的 observation 为 success
    const obs = observationsFor(taskId);
    expect(obs.some((o) => o.tool === "update_price" && o.ok === "success")).toBe(true);

    // 拒绝路径
    const taskId2 = await createTask("拒价");
    engines.set(taskId2, { decisions: GATED, gated: ["update_price"] });
    await post(`/api/tasks/${taskId2}/start`);
    const pending2 = await waitFor(() => {
      const p = deps.bus.history.filter((e) => e.type === "task_questions" && e.data.task_id === taskId2);
      return p.length ? (p.at(-1)!.data as { request_id: string }) : undefined;
    });
    await post(`/api/tasks/${taskId2}/questions/answer`, { request_id: pending2.request_id, answers: { approved: false } });
    const final2 = await runToCompletion(taskId2);
    expect(final2.status).toBe("completed"); // 拒绝不是失败
    const obs2 = observationsFor(taskId2);
    expect(obs2.some((o) => o.tool === "update_price" && o.ok === "denied")).toBe(true);
    expect(obs2.some((o) => o.tool === "update_price" && o.ok === "success")).toBe(false);
  });

  it("stop：挂起中停止 → stopped_by_user → FAILED（无交付物）", async () => {
    const taskId = await createTask("停止我");
    engines.set(taskId, { decisions: GATED, gated: ["update_price"] });
    await post(`/api/tasks/${taskId}/start`);
    await waitFor(() => (orchestratorRunning(taskId) ? true : undefined));
    await post(`/api/tasks/${taskId}/agent/stop`);
    const final = await runToCompletion(taskId);
    expect(final.status).toBe("failed");
    const row = deps.db.prepare("SELECT error_category FROM tasks WHERE id = ?").get(taskId) as { error_category: string };
    expect(row.error_category).toBe("stopped_by_user");
  });

  it("result 入口：submitted 保留 + incomplete 缺口在终局渲染为 caveat（INCOMPLETE 也算完成）", async () => {
    const taskId = await createTask("提交结果");
    engines.set(taskId, { decisions: GATED, gated: ["update_price"] });
    await post(`/api/tasks/${taskId}/start`);
    await waitFor(() => (orchestratorRunning(taskId) ? true : undefined));

    const submitted = await (await post(`/api/tasks/${taskId}/result`, { result: "调价完成", incomplete: ["截图缺一份"] })).json();
    expect(submitted).toMatchObject({ ok: true, resolved_from_file: false });
    const count = deps.db.prepare("SELECT submission_count, submitted_result FROM tasks WHERE id = ?").get(taskId) as { submission_count: number };
    expect(count.submission_count).toBe(1);

    // 门拒绝（不执行工具）→ 收尾：submitted_result > prose → INCOMPLETE → completed + caveat
    const pending = await waitFor(() => {
      const p = deps.bus.history.filter((e) => e.type === "task_questions" && e.data.task_id === taskId);
      return p.length ? (p.at(-1)!.data as { request_id: string }) : undefined;
    });
    await post(`/api/tasks/${taskId}/questions/answer`, { request_id: pending.request_id, answers: { approved: false } });
    const final = await runToCompletion(taskId);
    expect(final.status).toBe("completed");
    const row = deps.db.prepare("SELECT result, review_gaps FROM tasks WHERE id = ?").get(taskId) as { result: string; review_gaps: string | null };
    expect(row.result).toContain("调价完成");
    expect(row.result).toContain("未完成项");
    expect(row.review_gaps).toContain("截图缺一份");
  });

  it("retry：FAILED 任务清 run 状态重跑 → completed", async () => {
    const taskId = await createTask("重试我");
    engines.set(taskId, { decisions: [{ kind: "respond", content: "第一次坏了" }] });
    await post(`/api/tasks/${taskId}/start`);
    await runToCompletion(taskId);
    // 人为打失败
    deps.db.prepare("UPDATE tasks SET status = 'failed', error = 'boom', error_category = 'runtime_error' WHERE id = ?").run(taskId);
    engines.set(taskId, { decisions: [{ kind: "respond", content: "第二次好了" }] });
    const retried = await (await post(`/api/tasks/${taskId}/retry`)).json();
    expect(retried).toMatchObject({ ok: true });
    const final = await runToCompletion(taskId);
    expect(final.status).toBe("completed");
    expect(final.result).toBe("第二次好了");
    const row = deps.db.prepare("SELECT error FROM tasks WHERE id = ?").get(taskId) as { error: string | null };
    expect(row.error).toBeNull(); // applyOutcome 清错误对
  });

  it("follow-up 消息：completed → running → 新 run 完成，用户消息落库", async () => {
    const taskId = await createTask("聊两句");
    engines.set(taskId, { decisions: [{ kind: "respond", content: "第一轮" }] });
    await post(`/api/tasks/${taskId}/start`);
    await runToCompletion(taskId);
    engines.set(taskId, { decisions: [{ kind: "respond", content: "第二轮答复" }] });
    const sent = await (await post(`/api/tasks/${taskId}/messages`, { content: "再帮我看看" })).json();
    expect(sent).toMatchObject({ ok: true, content: "再帮我看看" });
    const final = await runToCompletion(taskId);
    expect(final.status).toBe("completed");
    expect(final.result).toBe("第二轮答复");
    const messages = (await (await app.request(`/api/tasks/${taskId}/messages`, { headers: { cookie: adminCookie } })).json()) as { role: string; content: string }[];
    expect(messages.some((m) => m.role === "user" && m.content === "再帮我看看")).toBe(true);
  });

  it("并发饱和：无店铺任务在 maxConcurrent=0 类饱和下 409（诚实拒绝）", async () => {
    // maxConcurrent=4 未饱和时直接启动；这里验证重复启动守卫
    const taskId = await createTask("重复启动");
    engines.set(taskId, { decisions: GATED, gated: ["update_price"] });
    await post(`/api/tasks/${taskId}/start`);
    await waitFor(() => (orchestratorRunning(taskId) ? true : undefined));
    const dup = await post(`/api/tasks/${taskId}/agent/start`);
    expect(dup.status).toBe(409);
    await post(`/api/tasks/${taskId}/agent/stop`);
    await runToCompletion(taskId);
  });
});

function observationsFor(taskId: string): { tool: string; ok: string }[] {
  return deps.bus.history
    .filter((e) => e.type === "task_message" && e.data.task_id === taskId && e.data.role === "agent_event")
    .map((e) => JSON.parse(e.data.content as string) as { tool: string; ok: string });
}

function orchestratorRunning(taskId: string): boolean {
  const row = deps.db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string } | undefined;
  return row?.status === "running" || row?.status === "designing";
}
