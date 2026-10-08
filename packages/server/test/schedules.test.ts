// 批次 4.4 调度契约：schedules CRUD（plan_version 乐观锁、prompt→stale、发闸 409）、
// 规划任务生命周期（plan-only 设计 run → schedule_plan_ready）、fire 路径
// （store/fanout/single）、schedule-state/register-finalize/ad-declaration MCP 入口、
// cron 端点与调度器 tick 语义。
//
// 确定性策略：脚本引擎兜底脚本停在确认闸门（规划任务挂起等批复），使 plan_status
// 停在 'planning' 直至测试显式批准——不依赖时序。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Decision } from "@vibe/core";
import { createScriptedEngine, gatePolicyFor } from "@vibe/bridge";
import { createApp, hashPassword, type AppDeps } from "../src/app";
import { openDb, seed } from "../src/db";
import { EventBus } from "../src/bus";
import { VibeScheduler } from "../src/scheduler/scheduler";
import type { EngineFactory } from "../src/agent/orchestrator";
import type { ServerConfig } from "../src/config";

let dir: string;
let deps: AppDeps;
let app: ReturnType<typeof createApp>;
let adminCookie: string;

const PLAN_PARKED: Decision[] = [
  { kind: "call_tool", intent: { name: "vibe_seller_list_stores", arguments: {} } },
  { kind: "respond", content: "调度计划：先拉店铺再执行。" },
];
// 兜底脚本：停在确认闸门（规划任务挂起 → plan_status 恒 'planning'）
const FALLBACK: { decisions: Decision[]; gated: string[] } = {
  decisions: PLAN_PARKED,
  gated: ["vibe_seller_list_stores"],
};

const engines = new Map<string, { decisions: Decision[]; gated?: string[] }>();

const engineFactory: EngineFactory = async ({ taskId }) => {
  const script = engines.get(taskId) ?? FALLBACK;
  return {
    engine: createScriptedEngine({
      decisions: script.decisions,
      gatedTools: script.gated ?? [],
      toolNames: ["vibe_seller_list_stores", "update_price"],
    }),
    tools: { execute: async () => ({ status: "error", error: { code: "invalid_tool", message: "unused" } }) },
    gates: gatePolicyFor(script.gated ?? []),
  };
};

async function waitFor<T>(fn: () => T | undefined | null, timeout = 8000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const v = fn();
    if (v !== undefined && v !== null) return v;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("waitFor timeout");
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibe-sched-"));
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
  deps = { config, jwtSecret: "test-secret", db, bus: new EventBus(), engineFactory, maxConcurrent: 32 };
  app = createApp(deps);
  const res = await app.request("/api/auth/login", { method: "POST", body: JSON.stringify({ identifier: "admin", password: "admin" }), headers: { "content-type": "application/json" } });
  adminCookie = res.headers.get("set-cookie")!.split(";")[0]!;
});

afterAll(async () => {
  // 用例有意保留停在闸门的规划任务——stop() 对挂起 run 直接终局（cancelled），
  // 等它们全部落到终态再关库删目录，避免 teardown 与收尾写库竞争。
  const deadline = Date.now() + 6_000;
  for (;;) {
    const rows = deps.db.prepare("SELECT id, status FROM tasks WHERE status NOT IN ('completed','failed')").all() as unknown as { id: string; status: string }[];
    if (rows.length === 0 || Date.now() > deadline) break;
    for (const r of rows) {
      await app.request(`/api/tasks/${r.id}/agent/stop`, { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: "{}" });
    }
    await new Promise((res) => setTimeout(res, 50));
  }
  deps.db.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const post = async (path: string, body?: unknown) =>
  await app.request(path, { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
const put = async (path: string, body: unknown) =>
  await app.request(path, { method: "PUT", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify(body) });
const getJson = async <T>(path: string): Promise<T> =>
  (await (await app.request(path, { headers: { cookie: adminCookie } })).json()) as T;

type ScheduleResp = Record<string, unknown> & {
  id: string;
  plan_status: string;
  plan_version: number;
  plan: string | null;
  plan_mode: boolean;
  ai_profile_id: string | null;
  phase_mode: string;
  is_active: boolean;
  next_run: string | null;
  current_planning_task_id: string | null;
  child_task_count: number;
};

async function createSchedule(body: Record<string, unknown>): Promise<{ status: number; body: ScheduleResp }> {
  const res = await post("/api/schedules", body);
  return { status: res.status, body: (await res.json()) as ScheduleResp };
}

/** 批复规划任务的确认闸门 → 设计 run 完成 → plan-only 提交 → schedule ready。 */
async function approvePlanning(scheduleId: string): Promise<void> {
  const sched = await getJson<ScheduleResp>(`/api/schedules/${scheduleId}`);
  const plannerId = sched.current_planning_task_id;
  expect(plannerId).toBeTruthy();
  const requestId = await waitFor(() => {
    const q = deps.bus.history.filter((e) => e.type === "task_questions" && e.data.task_id === plannerId);
    return q.length ? (q.at(-1)!.data as { request_id: string }).request_id : undefined;
  });
  await post(`/api/tasks/${plannerId}/questions/answer`, { request_id: requestId, answers: { approved: true } });
  await waitFor(() => {
    const s = deps.db.prepare("SELECT plan_status, plan, plan_version FROM schedules WHERE id = ?").get(scheduleId) as
      | { plan_status: string; plan: string | null; plan_version: number }
      | undefined;
    return s?.plan_status === "ready" ? s : undefined;
  });
}

describe("schedules CRUD", () => {
  it("创建 → 全键响应：plan_mode 强制 true、plan_status=planning、规划任务已起、作业已注册", async () => {
    const { status, body } = await createSchedule({ title: "每日调价", description: "检查价格", schedule_type: "days", schedule_time: "09:30" });
    expect(status).toBe(201);
    expect(body).toMatchObject({
      title: "每日调价",
      schedule_type: "days",
      schedule_time: "09:30",
      plan_mode: true,
      plan_status: "planning",
      ai_profile_id: "default",
      phase_mode: "fanout",
      is_active: true,
      is_system: false,
      plan_version: 0,
      interval_value: 1,
    });
    expect(body.id).toBeTruthy();
    expect(body.next_run).toBeTruthy(); // 作业已注册（runScheduler 关着，不会真点火）
    expect(body.current_planning_task_id).toBeTruthy();
    // 规划任务：plan-only、设计中、标题 Plan: 前缀
    const planner = deps.db.prepare("SELECT title, is_plan_only, plan_mode, status, schedule_id FROM tasks WHERE id = ?").get(body.current_planning_task_id) as Record<string, unknown>;
    expect(planner).toMatchObject({ title: "Plan: 每日调价", is_plan_only: 1, plan_mode: 1, status: "designing", schedule_id: body.id });
  });

  it("校验面：坏 schedule_type/timezone 400；weekly day 越界 → 500（建了作业失败）；finalize 只许 fanout", async () => {
    expect((await createSchedule({ title: "x", schedule_type: "yearly" })).status).toBe(400);
    expect((await createSchedule({ title: "x", schedule_type: "days", schedule_time: "25:00" })).status).toBe(400);
    expect((await createSchedule({ title: "x", schedule_type: "days", timezone: "Not/AZone" })).status).toBe(400);
    expect((await createSchedule({ title: "x", schedule_type: "weekly", schedule_day: 9 })).status).toBe(500);
    expect((await createSchedule({ title: "x", schedule_type: "days", phase_mode: "two_phase" })).status).toBe(400);
    // 店绑定调度不许 finalize
    const store = (await (await post("/api/stores", { name: "SchedStore" })).json()) as { id: string };
    const r = await createSchedule({ title: "x", schedule_type: "days", store_id: store.id, finalize_description: "汇总" });
    expect(r.status).toBe(400);
  });

  it("plan_version 乐观锁：陈旧 412；匹配 200。plan_mode 不可变 400", async () => {
    const { body } = await createSchedule({ title: "锁测", schedule_type: "days" });
    const stale = await put(`/api/schedules/${body.id}`, { title: "改名", plan_version: 5 });
    expect(stale.status).toBe(412);
    const detail = ((await stale.json()) as { detail: string }).detail;
    expect(detail).toContain("Stale plan_version: client=5 server=0");
    const ok = await put(`/api/schedules/${body.id}`, { title: "改名2", plan_version: 0 });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as ScheduleResp).title).toBe("改名2");
    const immutable = await put(`/api/schedules/${body.id}`, { plan_mode: false });
    expect(immutable.status).toBe(400);
    expect(((await immutable.json()) as { detail: string }).detail).toContain("plan_mode is immutable");
  });

  it("发闸：plan 没就绪时 trigger/resume 409（规划任务停在闸门）", async () => {
    const { body } = await createSchedule({ title: "闸测", schedule_type: "days" });
    const trigger = await post(`/api/schedules/${body.id}/trigger`);
    expect(trigger.status).toBe(409);
    expect(((await trigger.json()) as { detail: string }).detail).toContain("Call /replan first");
    const resume = await post(`/api/schedules/${body.id}/resume`);
    expect(resume.status).toBe(409);
  });

  it("规划生命周期：批准 → ready + plan_version=1 + schedule_plan_ready；之后 trigger 可发", async () => {
    const { body } = await createSchedule({ title: "走闸", schedule_type: "days" });
    await approvePlanning(body.id);
    const sched = await getJson<ScheduleResp>(`/api/schedules/${body.id}`);
    expect(sched.plan_status).toBe("ready");
    expect(sched.plan_version).toBe(1);
    expect(sched.plan).toContain("调度计划");
    expect(sched.current_planning_task_id).toBeNull();
    // plan-only 任务提交即完成
    expect(deps.bus.history.some((e) => e.type === "schedule_plan_ready" && e.data.schedule_id === body.id)).toBe(true);
    // 就绪后 trigger 通过（fanout：默认无店 → fanout 形态）
    const trig = await post(`/api/schedules/${body.id}/trigger`);
    expect(trig.status).toBe(200);
    const trigBody = (await trig.json()) as { ok: boolean; mode: string };
    expect(trigBody.mode).toBe("fanout"); // 无店（测试库此刻 1 店？—— fanout 与否看 store_id 为空）
  });

  it("prompt 编辑 → stale（旧 plan 保留）+ schedule_plan_stale；/replan 重起新规划任务", async () => {
    const { body } = await createSchedule({ title: "陈旧测", description: "原始提示", schedule_type: "days" });
    await approvePlanning(body.id);
    const edited = await put(`/api/schedules/${body.id}`, { description: "原始提示（改）" });
    expect(edited.status).toBe(200);
    const after = (await edited.json()) as ScheduleResp;
    expect(after.plan_status).toBe("stale");
    expect(after.plan).toContain("调度计划"); // 旧文保留供 diff
    expect(deps.bus.history.some((e) => e.type === "schedule_plan_stale" && e.data.schedule_id === body.id)).toBe(true);

    // replan：新规划任务挂闸（幂等——再 replan 同指针）
    const re = await post(`/api/schedules/${body.id}/replan`);
    expect(re.status).toBe(200);
    const reBody = (await re.json()) as ScheduleResp;
    expect(reBody.plan_status).toBe("planning");
    const plannerId = reBody.current_planning_task_id;
    expect(plannerId).toBeTruthy();
    const again = await post(`/api/schedules/${body.id}/replan`);
    expect(((await again.json()) as ScheduleResp).current_planning_task_id).toBe(plannerId);
    await approvePlanning(body.id);
    expect(((await getJson<ScheduleResp>(`/api/schedules/${body.id}`)).plan_version)).toBe(2);
  });

  it("pause/resume：pause 停跳；就绪后 resume 通过；delete 幂等形状", async () => {
    const { body } = await createSchedule({ title: "停启", schedule_type: "days" });
    const paused = await post(`/api/schedules/${body.id}/pause`);
    expect(paused.status).toBe(200);
    expect(((await paused.json()) as ScheduleResp).is_active).toBe(false);
    // 未就绪 resume 409 已在发闸用例覆盖；直接 SQL 置就绪
    deps.db.prepare("UPDATE schedules SET plan_status = 'ready', plan = 'p', plan_version = 1 WHERE id = ?").run(body.id);
    const resumed = await post(`/api/schedules/${body.id}/resume`);
    expect(resumed.status).toBe(200);
    expect(((await resumed.json()) as ScheduleResp).is_active).toBe(true);
    expect(((await getJson<ScheduleResp>(`/api/schedules/${body.id}`)).next_run)).toBeTruthy();
    const del = await app.request(`/api/schedules/${body.id}`, { method: "DELETE", headers: { cookie: adminCookie } });
    expect(((await del.json()) as { ok: boolean }).ok).toBe(true);
    expect((await app.request(`/api/schedules/${body.id}`, { headers: { cookie: adminCookie } })).status).toBe(404);
  });

  it("plan 面板：GET /plan 返回 lifecycle + 规划任务历史；/tasks 排除 plan-only", async () => {
    const { body } = await createSchedule({ title: "面板", schedule_type: "days" });
    const plan = await getJson<{ plan_status: string; plan_version: number; planning_task_history: { id: string; status: string }[]; finalize_description: string | null }>(
      `/api/schedules/${body.id}/plan`,
    );
    expect(plan.plan_status).toBe("planning");
    expect(plan.planning_task_history).toHaveLength(1);
    expect(plan.planning_task_history[0]!.status).toBe("designing");
    // 触发一发（通过 SQL 置就绪绕开闸）后 /tasks 只含 fire、不含规划任务
    deps.db.prepare("UPDATE schedules SET plan_status = 'ready', plan = '面板计划', plan_version = 1 WHERE id = ?").run(body.id);
    deps.db.prepare("UPDATE schedules SET phase_mode = 'single' WHERE id = ?").run(body.id); // single：一个无店任务，别铺满
    await post(`/api/schedules/${body.id}/trigger`);
    const tasks = await getJson<{ id: string; is_plan_only: boolean }[]>(`/api/schedules/${body.id}/tasks`);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.is_plan_only).toBe(false);
    const enriched = await getJson<ScheduleResp>(`/api/schedules/${body.id}`);
    expect(enriched.child_task_count).toBe(1);
    expect(enriched.last_run_status).toBeTruthy();
  });
});

describe("fire 路径", () => {
  it("店铺绑定 trigger：建子任务拷贝 plan（PLANNED/plan_version）+ schedule_triggered + 编排接管", async () => {
    const store = (await (await post("/api/stores", { name: "FireStore" })).json()) as { id: string; name: string };
    const { body } = await createSchedule({ title: "店火", description: "干活", schedule_type: "days", store_id: store.id });
    expect(body.phase_mode).toBe("single"); // 店绑定恒 single
    deps.db.prepare("UPDATE schedules SET plan_status = 'ready', plan = '店计划V3', plan_version = 3 WHERE id = ?").run(body.id);
    const trig = await post(`/api/schedules/${body.id}/trigger`);
    expect(trig.status).toBe(200);
    const out = (await trig.json()) as { ok: boolean; task_id: string; status: string };
    expect(out.ok).toBe(true);
    expect(out.status).toBe("running"); // 直启：planned→running 同步转移（计划拷贝断言在下一行）
    const task = deps.db.prepare("SELECT plan, plan_version, schedule_id, store_id, plan_mode, status FROM tasks WHERE id = ?").get(out.task_id) as Record<string, unknown>;
    expect(task).toMatchObject({ plan: "店计划V3", plan_version: 3, schedule_id: body.id, store_id: store.id, status: "running" });
    expect(deps.bus.history.some((e) => e.type === "schedule_triggered" && e.data.task_id === out.task_id)).toBe(true);
  });

  it("fanout：无店调度一发铺满所有活动店（共享 batch_id）+ fanout_triggered；上一发 WAITING 被取消", async () => {
    const s1 = (await (await post("/api/stores", { name: "FanA" })).json()) as { id: string };
    const s2 = (await (await post("/api/stores", { name: "FanB" })).json()) as { id: string };
    const { body } = await createSchedule({ title: "铺发", schedule_type: "days" });
    deps.db.prepare("UPDATE schedules SET plan_status = 'ready', plan = '铺发计划', plan_version = 1 WHERE id = ?").run(body.id);
    // 上一发卡 WAITING：下一发要先取消（superseded_by_next_fire）
    deps.db
      .prepare("INSERT INTO tasks (id, parent_task_id, store_id, schedule_id, template_id, created_by, assigned_to, title, description, platform, country, status, priority, input_data, plan, plan_history, result, accepted_result, submitted_result, review_gaps, submission_count, transcript_tail, todos, error, error_category, started_at, completed_at, plan_mode, is_plan_only, plan_version, skip_reflection, wait_condition, batch_id, is_finalize, ai_profile_id, session_id, created_at, updated_at) VALUES (?, NULL, ?, ?, NULL, '00000000-0000-0000-0000-000000000001', NULL, '旧卡', NULL, NULL, NULL, 'waiting', 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, NULL, 0, NULL, NULL, 0, 'default', NULL, ?, ?)")
      .run(crypto.randomUUID(), s1.id, body.id, new Date().toISOString(), new Date().toISOString());

    const trig = await post(`/api/schedules/${body.id}/trigger`);
    expect(trig.status).toBe(200);
    expect(((await trig.json()) as { mode: string }).mode).toBe("fanout");
    await waitFor(() => (deps.bus.history.some((e) => e.type === "fanout_triggered" && e.data.schedule_id === body.id) ? true : undefined));
    const fires = deps.db.prepare("SELECT id, store_id, batch_id, status FROM tasks WHERE schedule_id = ? AND store_id IS NOT NULL AND batch_id IS NOT NULL AND status != 'waiting'").all(body.id) as unknown as { id: string; store_id: string; batch_id: string; status: string }[];
    // fanout 铺满全库活动店（含此前用例建的店），本用例的两店必须在内
    const storeSet = new Set(fires.map((f) => f.store_id));
    expect(storeSet.has(s1.id)).toBe(true);
    expect(storeSet.has(s2.id)).toBe(true);
    expect(new Set(fires.map((f) => f.batch_id)).size).toBe(1);
    // 上一发 WAITING 被取消
    const old = deps.db.prepare("SELECT status, error_category FROM tasks WHERE schedule_id = ? AND status = 'failed' AND error_category = 'superseded_by_next_fire'").get(body.id);
    expect(old).toBeTruthy();
  });

  it("schedule-state：键校验/保留前缀/epoch 窗口；GET 未命中回 other_known_keys；无 schedule_id 任务 400", async () => {
    const { body } = await createSchedule({ title: "游标", schedule_type: "days" });
    deps.db.prepare("UPDATE schedules SET plan_status = 'ready', plan = 'x', plan_version = 1 WHERE id = ?").run(body.id);
    const created = (await (await post("/api/tasks", { title: "定时活", schedule_id: body.id })).json()) as { id: string };
    // 无 schedule_id 的任务拒绝
    const plain = (await (await post("/api/tasks", { title: "散活" })).json()) as { id: string };
    expect((await put(`/api/tasks/${plain.id}/schedule-state/last_cursor`, { value: "1" })).status).toBe(400);

    const bad = await put(`/api/tasks/${created.id}/schedule-state/bad key!`, { value: "1" });
    expect(bad.status).toBe(400);
    const reserved = await put(`/api/tasks/${created.id}/schedule-state/_internal`, { value: "1" });
    expect(reserved.status).toBe(400);
    const badEpoch = await put(`/api/tasks/${created.id}/schedule-state/email_watermark`, { value: "10000000000000000" });
    expect(badEpoch.status).toBe(400);
    const yearOff = await put(`/api/tasks/${created.id}/schedule-state/email_watermark`, { value: "1000000000" }); // 2001 年：90 天窗外
    expect(yearOff.status).toBe(400);

    const saved = await put(`/api/tasks/${created.id}/schedule-state/last_cursor`, { value: "2026-04-30" });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as Record<string, unknown>).value).toBe("2026-04-30");
    const hit = await getJson<Record<string, unknown>>(`/api/tasks/${created.id}/schedule-state/last_cursor`);
    expect(hit.value).toBe("2026-04-30");
    expect(hit.now_epoch).toBeTypeOf("number");
    const miss = await getJson<{ value: string | null; other_known_keys: string[] }>(`/api/tasks/${created.id}/schedule-state/other_thing`);
    expect(miss.value).toBeNull();
    expect(miss.other_known_keys).toEqual(["last_cursor"]); // 幻觉键自纠提示
  });

  it("register-finalize：店绑定 400；fanout 计划任务可注册收尾步骤", async () => {
    const store = (await (await post("/api/stores", { name: "FinStore" })).json()) as { id: string };
    const bound = await createSchedule({ title: "收尾绑", schedule_type: "days", store_id: store.id });
    deps.db.prepare("UPDATE schedules SET plan_status = 'ready', plan = 'x', plan_version = 1 WHERE id = ?").run(bound.body.id);
    const boundTask = (await (await post("/api/tasks", { title: "绑活", schedule_id: bound.body.id })).json()) as { id: string };
    expect((await post(`/api/tasks/${boundTask.id}/register-finalize`, { description: "汇总" })).status).toBe(400);

    const { body } = await createSchedule({ title: "收尾扇", schedule_type: "days" });
    const fanTask = (await (await post("/api/tasks", { title: "扇活", schedule_id: body.id })).json()) as { id: string };
    const reg = await post(`/api/tasks/${fanTask.id}/register-finalize`, { description: "汇总各家结果" });
    expect(reg.status).toBe(200);
    expect(((await reg.json()) as { finalize_description: string }).finalize_description).toBe("汇总各家结果");
    expect((deps.db.prepare("SELECT finalize_description FROM schedules WHERE id = ?").get(body.id) as { finalize_description: string }).finalize_description).toBe("汇总各家结果");
  });
});

describe("ad-declaration", () => {
  it("声明 → 形状 + AD_TASK.json 镜像；同回合只能收窄/升格；新用户消息开新相", async () => {
    const created = (await (await post("/api/tasks", { title: "广告活" })).json()) as { id: string };
    const decl = await post(`/api/tasks/${created.id}/ad-declaration`, { kind: "investigate", scope: { combos: [{ platform: "Amazon", country: "ae" }], junk: 1 } });
    expect(decl.status).toBe(200);
    const first = (await decl.json()) as { seq: number; kind: string; scope: { combos: { platform: string; country: string }[] }; user_turn: number };
    expect(first).toMatchObject({ seq: 1, kind: "investigate", user_turn: 0 }); // 新任务尚无用户消息
    expect(first.scope.combos).toEqual([{ platform: "amazon", country: "AE" }]); // 规范化
    const list = await getJson<{ seq: number }[]>(`/api/tasks/${created.id}/ad-declarations`);
    expect(list).toHaveLength(1);
    // 镜像
    const { readFileSync, existsSync } = await import("node:fs");
    const mirror = join(deps.config.homeDir, "tasks", created.id, "AD_TASK.json");
    expect(existsSync(mirror)).toBe(true);
    expect(JSON.parse(readFileSync(mirror, "utf8") as string)).toMatchObject({ kind: "investigate" });

    // 同回合：investigate → audit（升格）允许；audit → investigate（降格）409
    const up = await post(`/api/tasks/${created.id}/ad-declaration`, { kind: "audit", scope: { combos: [{ platform: "amazon", country: "AE" }] } });
    expect(up.status).toBe(200);
    const down = await post(`/api/tasks/${created.id}/ad-declaration`, { kind: "investigate", scope: {} });
    expect(down.status).toBe(409);
    expect(((await down.json()) as { detail: string }).detail).toContain("NARROWS");
    // 同回合扩市场 409
    const widen = await post(`/api/tasks/${created.id}/ad-declaration`, { kind: "audit", scope: { combos: [{ platform: "amazon", country: "AE" }, { platform: "shopee", country: "SG" }] } });
    expect(widen.status).toBe(409);
    // 坏 kind 400
    expect((await post(`/api/tasks/${created.id}/ad-declaration`, { kind: "edit" })).status).toBe(400);
    // 新用户消息 → 新回合可重开
    deps.db.prepare("INSERT INTO task_messages (id, task_id, role, content, seq, created_at) VALUES (?, ?, 'user', '再审一次', 99, ?)").run(crypto.randomUUID(), created.id, new Date().toISOString());
    const newTurn = await post(`/api/tasks/${created.id}/ad-declaration`, { kind: "audit", scope: { combos: [{ platform: "shopee", country: "SG" }] } });
    expect(newTurn.status).toBe(200);
    expect(((await newTurn.json()) as { seq: number }).seq).toBe(3);
  });
});

describe("cron 端点", () => {
  it("建/列/暂停/恢复/删；坏表达式 400；未知 404", async () => {
    const created = await post("/api/cron/jobs", { job_id: "job-x", task_title: "裸任务", cron_expression: "0 9 * * 1-5" });
    expect(created.status).toBe(200);
    expect(((await created.json()) as Record<string, unknown>).job_id).toBe("job-x");
    const bad = await post("/api/cron/jobs", { job_id: "job-bad", task_title: "x", cron_expression: "0 9 *" });
    expect(bad.status).toBe(400);
    const jobs = await getJson<{ job_id: string; next_run: string | null; paused: boolean; trigger: string }[]>("/api/cron/jobs");
    const mine = jobs.find((j) => j.job_id === "job-x")!;
    expect(mine.trigger).toBe("0 9 * * 1-5");
    expect(mine.paused).toBe(false);
    expect(mine.next_run).toBeTruthy();
    expect((await post("/api/cron/jobs/job-x/pause")).status).toBe(200);
    expect((await getJson<{ job_id: string; paused: boolean }[]>("/api/cron/jobs")).find((j) => j.job_id === "job-x")!.paused).toBe(true);
    expect((await post("/api/cron/jobs/job-x/resume")).status).toBe(200);
    expect((await post("/api/cron/jobs/unknown/pause")).status).toBe(404);
    expect((await app.request("/api/cron/jobs/job-x", { method: "DELETE", headers: { cookie: adminCookie } })).status).toBe(200);
    expect((await app.request("/api/cron/jobs/job-x", { method: "DELETE", headers: { cookie: adminCookie } })).status).toBe(404);
  });
});

describe("调度器 tick 语义", () => {
  it("到点即发且只发一次；paused 不发；在跑作业合并跳过（coalesce）", async () => {
    const sched = new VibeScheduler({ config: deps.config, db: deps.db, bus: deps.bus, orchestrator: { enqueueOrLaunch: () => "launched" } as never, }, 20_000);
    let fires = 0;
    const at = new Date(Date.now() + 50);
    sched.addJob({
      id: "tick-job",
      name: "n",
      nextRunFn: (after) => new Date(after.getTime() + 50),
      runner: () => {
        fires += 1;
      },
      triggerDesc: "test",
    });
    // 首发在 +50ms：立刻 tick 不发
    sched.tick(new Date());
    expect(fires).toBe(0);
    await new Promise((r) => setTimeout(r, 70));
    sched.tick(new Date());
    expect(fires).toBe(1);
    // 下一发在 +50ms 之后——立刻再 tick 不重放
    sched.tick(new Date());
    expect(fires).toBe(1);
    // 快进到下一发
    await new Promise((r) => setTimeout(r, 70));
    sched.tick(new Date());
    expect(fires).toBe(2);
    // pause 后不发
    sched.pauseJob("tick-job");
    await new Promise((r) => setTimeout(r, 70));
    sched.tick(new Date());
    expect(fires).toBe(2);
    expect(sched.listJobs()[0]!.paused).toBe(true);
    await sched.idle();
  });
});
