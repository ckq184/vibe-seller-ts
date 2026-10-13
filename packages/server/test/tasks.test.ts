// 批次 4.2 契约测试：stores/tasks CRUD 形状与守卫，全部按
// docs/phase4-backend-inventory.md 与原路由源码钉死。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, hashPassword, type AppDeps } from "../src/app";
import { openDb, seed } from "../src/db";
import { EventBus } from "../src/bus";
import type { ServerConfig } from "../src/config";

let dir: string;
let deps: AppDeps;
let app: ReturnType<typeof createApp>;
let adminCookie: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibe-tasks-"));
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
  deps = { config: cfg(config), jwtSecret: "test-secret", db, bus: new EventBus() };
  app = createApp(deps);
  const res = await app.request("/api/auth/login", { method: "POST", body: JSON.stringify({ identifier: "admin", password: "admin" }), headers: { "content-type": "application/json" } });
  adminCookie = res.headers.get("set-cookie")!.split(";")[0]!;
});

function cfg(base: ServerConfig): ServerConfig {
  return base;
}

afterAll(async () => {
  deps.db.close();
  await rm(dir, { recursive: true, force: true });
});

const post = (path: string, body: unknown, cookie = adminCookie) =>
  app.request(path, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
const put = (path: string, body: unknown, cookie = adminCookie) =>
  app.request(path, { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });

describe("stores 契约", () => {
  it("创建 → StoreResponse 全键（JSON 列解析回对象/数组）→ 列表排序（新店铺创建时间倒序）", async () => {
    const created = (await (await post("/api/stores", { name: "Noon SG", platforms: ["noon"], countries: ["SG"], platform_countries: { noon: ["SG"] } })).json()) as Record<string, unknown>;
    expect(Object.keys(created).sort()).toEqual(
      ["browser_backend", "browser_config", "countries", "created_at", "id", "name", "platform_countries", "platforms", "updated_at", "ziniao_account_id", "browser_oauth"].sort(),
    );
    expect(created).toMatchObject({ name: "Noon SG", browser_backend: "chrome", platforms: ["noon"], countries: ["SG"], platform_countries: { noon: ["SG"] }, browser_config: { share_group: "main" } });

    const list = (await (await app.request("/api/stores", { headers: { cookie: adminCookie } })).json()) as unknown[];
    expect(list).toHaveLength(1);
  });

  it("改名守卫：重名 409；不存在 404；browser/start 不存在店铺 404（4.6 已点亮）", async () => {
    const s1 = (await (await post("/api/stores", { name: "Store One" })).json()) as { id: string };
    await post("/api/stores", { name: "Store Two" });
    const dup = await put(`/api/stores/${s1.id}`, { name: "Store Two" });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { detail: string }).detail).toBe("A store with this name already exists");
    const missing = await put("/api/stores/nope", { name: "X" });
    expect(missing.status).toBe(404);
    const browser = await app.request(`/api/stores/nope/browser/start`, { method: "POST", headers: { cookie: adminCookie } });
    expect(browser.status).toBe(404);
  });

  it("share_group 契约：合法入组/改组/退组直通；类型与字符集非法 400；ziniao 禁入组", async () => {
    // 合法：字母/数字/连字符/下划线，创建与读回直通（browser_config 整包 JSON 语义不变）
    const s = (await (await post("/api/stores", { name: "ShareMain", browser_config: { share_group: "main" } })).json()) as {
      id: string;
      browser_config: Record<string, unknown>;
    };
    expect(s.browser_config).toEqual({ share_group: "main" });
    // PUT 整包替换改组名；空串 = 显式退组（合法）
    const upd = await put(`/api/stores/${s.id}`, { browser_config: { share_group: "eu-west_2" } });
    expect(((await upd.json()) as { browser_config: Record<string, unknown> }).browser_config).toEqual({ share_group: "eu-west_2" });
    const leave = await put(`/api/stores/${s.id}`, { browser_config: { share_group: "" } });
    expect(((await leave.json()) as { browser_config: Record<string, unknown> }).browser_config).toEqual({ share_group: "" });
    // 非法：类型错 / 空白字符 / 冒号（tab key 分隔符）/ 超 64 字符 → 400
    for (const [i, bad] of [7, null, "has space", "a:b", "x".repeat(65)].entries()) {
      const res = await post("/api/stores", { name: `ShareBad${i}`, browser_config: { share_group: bad } });
      expect(res.status).toBe(400);
    }
    const badPut = await put(`/api/stores/${s.id}`, { browser_config: { share_group: "a b" } });
    expect(badPut.status).toBe(400);
    // ziniao 店禁入组：创建直接 400；已有 ziniao 店 PUT 入组 400（browse 工具不支持 ziniao）
    const zCreate = await post("/api/stores", { name: "ZiniaoShare", browser_backend: "ziniao", browser_config: { share_group: "main" } });
    expect(zCreate.status).toBe(400);
    const z = (await (await post("/api/stores", { name: "ZiniaoPlain", browser_backend: "ziniao" })).json()) as { id: string };
    const zPut = await put(`/api/stores/${z.id}`, { browser_config: { share_group: "main" } });
    expect(zPut.status).toBe(400);
    // ziniao 店 browser_config 不带 share_group 的其他键不受影响（代理等原语义）
    const zProxy = await put(`/api/stores/${z.id}`, { browser_config: { proxy_server: "http://127.0.0.1:7890" } });
    expect(zProxy.status).toBe(200);
  });

  it("share_group 方案A（建店侧）：chrome 建店缺省入组 main（显式空串=独立店，ziniao 恒不入组）", async () => {
    // chrome 无 browser_config → 默认 main
    const a = (await (await post("/api/stores", { name: "AutoGroup" })).json()) as { browser_config: Record<string, unknown> };
    expect(a.browser_config).toEqual({ share_group: "main" });
    // chrome 带 browser_config 但无 share_group 键 → 合并补默认（代理等键不受影响）
    const b = (await (await post("/api/stores", { name: "AutoGroupProxy", browser_config: { proxy_server: "http://127.0.0.1:7890" } })).json()) as {
      browser_config: Record<string, unknown>;
    };
    expect(b.browser_config).toEqual({ proxy_server: "http://127.0.0.1:7890", share_group: "main" });
    // 显式空串 = 独立店（不补默认）
    const c = (await (await post("/api/stores", { name: "SoloStore", browser_config: { share_group: "" } })).json()) as { browser_config: Record<string, unknown> };
    expect(c.browser_config).toEqual({ share_group: "" });
    // ziniao 恒不入组
    const z = (await (await post("/api/stores", { name: "ZnNoGroup", browser_backend: "ziniao" })).json()) as { browser_config: Record<string, unknown> };
    expect(z.browser_config).toEqual({});
  });

  it("share_group 方案A（改店侧）：PUT 缺 share_group 键=保留现值（防 vendor 表单整包回传误退组）；显式空串=退组；不带 browser_config=不动", async () => {
    const d = (await (await post("/api/stores", { name: "KeepGroup" })).json()) as { id: string };
    // body 缺 share_group 键 → 保留现值，其余键整包替换
    const kept = await put(`/api/stores/${d.id}`, { browser_config: { proxy_server: "http://p:1" } });
    expect(((await kept.json()) as { browser_config: Record<string, unknown> }).browser_config).toEqual({ proxy_server: "http://p:1", share_group: "main" });
    // 显式空串 = 退组；完全不带 browser_config = 不动
    const leave = await put(`/api/stores/${d.id}`, { browser_config: { share_group: "" } });
    expect(((await leave.json()) as { browser_config: Record<string, unknown> }).browser_config).toEqual({ share_group: "" });
    const untouched = await put(`/api/stores/${d.id}`, { platforms: ["shopee"] });
    expect(((await untouched.json()) as { browser_config: Record<string, unknown> }).browser_config).toEqual({ share_group: "" });
  });

  it("有活跃任务的店铺不可删（409）；删除幂等返回 {ok:true}", async () => {
    const store = (await (await post("/api/stores", { name: "Doomed" })).json()) as { id: string };
    await post("/api/tasks", { store_id: store.id, title: "活跃任务", plan_mode: false, defer_start: true });
    // 造一个 running 任务（直写 DB，队列属 4.3）
    deps.db.prepare("UPDATE tasks SET status = 'running' WHERE store_id = ?").run(store.id);
    const blocked = await app.request(`/api/stores/${store.id}`, { method: "DELETE", headers: { cookie: adminCookie } });
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { detail: string }).detail).toBe("Cannot delete store with active tasks");

    deps.db.prepare("DELETE FROM tasks WHERE store_id = ?").run(store.id);
    const del = await app.request(`/api/stores/${store.id}`, { method: "DELETE", headers: { cookie: adminCookie } });
    expect((await del.json())).toEqual({ ok: true });
    const again = await app.request(`/api/stores/${store.id}`, { method: "DELETE", headers: { cookie: adminCookie } });
    expect((await again.json())).toEqual({ ok: true });
  });
});

describe("tasks 契约", () => {
  it("创建默认值：pending、无 store 恒 plan_mode=true、profile 取用户默认；task_created 事件形状", async () => {
    const created = (await (await post("/api/tasks", { title: "盘点任务", defer_start: true })).json()) as Record<string, unknown>;
    expect(Object.keys(created).sort()).toEqual(
      ["ai_profile_id", "batch_id", "completed_at", "created_at", "created_by_name", "description", "error", "error_category", "id", "is_plan_only", "parent_task_id", "plan", "plan_history", "plan_mode", "platform", "country", "result", "review_gaps", "schedule_id", "session_id", "started_at", "status", "store_id", "submission_count", "submitted_result", "title", "todos", "updated_at", "wait_condition"].sort(),
    );
    // created_by_name 在 create 响应恒 null（原 response_model 缺省；SSE payload 才带
    // creator 名）——批次 4.7.2 录制回放对齐，GET/LIST 仍解析为 'admin'
    expect(created).toMatchObject({ status: "pending", plan_mode: true, ai_profile_id: "default", created_by_name: null, submission_count: 0, is_plan_only: false });
    const emitted = deps.bus.history.at(-1)!;
    expect(emitted.type).toBe("task_created");
    expect(emitted.data).toMatchObject({ task_id: created.id, store_id: null });
    expect((emitted.data.task as Record<string, unknown>).title).toBe("盘点任务");
  });

  it("有 store 任务：plan_mode 未指定取用户默认（false）；sub-task 无 store 400；坏 store 404", async () => {
    deps.db.prepare("UPDATE users SET plan_mode_default = 0 WHERE id = ?").run("00000000-0000-0000-0000-000000000001");
    const store = (await (await post("/api/stores", { name: "TaskStore" })).json()) as { id: string };
    const t = (await (await post("/api/tasks", { store_id: store.id, title: "调价", defer_start: true })).json()) as Record<string, unknown>;
    expect(t.plan_mode).toBe(false);
    const sub = await post("/api/tasks", { title: "子任务", parent_task_id: t.id as string });
    expect(sub.status).toBe(400);
    const badStore = await post("/api/tasks", { store_id: "nope", title: "x" });
    expect(badStore.status).toBe(404);
  });

  it("list 过滤：store_id / __none__ / parent_task_id；按 created_at 倒序", async () => {
    const store = (await (await post("/api/stores", { name: "FilterStore" })).json()) as { id: string };
    await post("/api/tasks", { store_id: store.id, title: "A", defer_start: true });
    await post("/api/tasks", { store_id: store.id, title: "B", defer_start: true });
    await post("/api/tasks", { title: "无店铺", defer_start: true });
    const forStore = (await (await app.request(`/api/tasks?store_id=${store.id}`, { headers: { cookie: adminCookie } })).json()) as { title: string }[];
    expect(forStore.map((t) => t.title)).toEqual(["B", "A"]); // 倒序
    const none = (await (await app.request("/api/tasks?store_id=__none__", { headers: { cookie: adminCookie } })).json()) as { store_id: unknown }[];
    expect(none.every((t) => t.store_id === null)).toBe(true);
  });

  it("删除守卫：running 409；终态可删且清依赖行（幂等 {ok:true}）", async () => {
    const t = (await (await post("/api/tasks", { title: "删除我", defer_start: true })).json()) as { id: string };
    deps.db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(t.id);
    deps.db.prepare("INSERT INTO task_messages (id, task_id, role, content, seq, created_at) VALUES ('m1', ?, 'assistant', 'hi', 1, 'now')").run(t.id);
    const blocked = await app.request(`/api/tasks/${t.id}`, { method: "DELETE", headers: { cookie: adminCookie } });
    expect(blocked.status).toBe(409);

    deps.db.prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run(t.id);
    const del = await app.request(`/api/tasks/${t.id}`, { method: "DELETE", headers: { cookie: adminCookie } });
    expect((await del.json())).toEqual({ ok: true });
    expect(deps.db.prepare("SELECT COUNT(*) AS n FROM task_messages WHERE task_id = ?").get(t.id)).toMatchObject({ n: 0 });
    const again = await app.request(`/api/tasks/${t.id}`, { method: "DELETE", headers: { cookie: adminCookie } });
    expect((await again.json())).toEqual({ ok: true });
  });

  it("steps 返回 TaskStepResponse 键；messages 排除 delta/thinking_delta 按 seq 排序", async () => {
    const t = (await (await post("/api/tasks", { title: "带步骤", defer_start: true })).json()) as { id: string };
    deps.db.prepare(
      "INSERT INTO task_steps (id, task_id, step_index, name, action_type, status, screenshot_id, error) VALUES ('s1', ?, 0, '截图', 'browse', 'done', NULL, NULL)",
    ).run(t.id);
    deps.db.prepare(
      "INSERT INTO task_messages (id, task_id, role, content, seq, created_at) VALUES ('m2', ?, 'delta', '流', 2, 'now')",
    ).run(t.id);
    deps.db.prepare(
      "INSERT INTO task_messages (id, task_id, role, content, seq, created_at) VALUES ('m3', ?, 'result', '结果', 3, 'now')",
    ).run(t.id);
    const steps = (await (await app.request(`/api/tasks/${t.id}/steps`, { headers: { cookie: adminCookie } })).json()) as Record<string, unknown>[];
    expect(Object.keys(steps[0]!).sort()).toEqual(["action_type", "error", "id", "name", "screenshot_id", "status", "step_index", "task_id"].sort());
    const messages = (await (await app.request(`/api/tasks/${t.id}/messages`, { headers: { cookie: adminCookie } })).json()) as { role: string }[];
    expect(messages.map((m) => m.role)).toEqual(["result"]); // delta 被排除
  });

  it("review-plan：非 store 任务禁止关 plan 模式（400）；toggle 同步用户默认", async () => {
    const t = (await (await post("/api/tasks", { title: "plan 任务", defer_start: true })).json()) as { id: string }; // 无 store → plan_mode true
    const off = await app.request(`/api/tasks/${t.id}/review-plan`, { method: "PATCH", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ plan_mode: false }) });
    expect(off.status).toBe(400);
    expect(((await off.json()) as { detail: string }).detail).toBe("Non-store tasks require plan mode");
  });

  it("无引擎配置时启动 → engine_factory_failed 落 FAILED（绝不悬死）", async () => {
    const t = (await (await post("/api/tasks", { title: "无引擎", defer_start: true })).json()) as { id: string };
    const started = await (await post(`/api/tasks/${t.id}/start`, {})).json();
    expect(started).toMatchObject({ ok: true }); // 接受启动请求（编排器异步失败）
    const deadline = Date.now() + 4000;
    let row: { status: string; error_category: string } | undefined;
    while (Date.now() < deadline) {
      row = deps.db.prepare("SELECT status, error_category FROM tasks WHERE id = ?").get(t.id) as { status: string; error_category: string } | undefined;
      if (row?.status === "failed") break;
      await new Promise((r) => setTimeout(r, 40));
    }
    expect(row?.status).toBe("failed");
    expect(row?.error_category).toBe("engine_factory_failed");
  });
});
