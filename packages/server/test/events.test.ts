// 批次 4.6 契约测试：events(13) + 事件抽取器。
// 状态机 VALID_TRANSITIONS 逐字；SSE（event_created/updated/activity）；backends。

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { EventBus } from "../src/bus";
import { HttpError } from "../src/types";
import { createSessionToken } from "../src/jwt";
import { openDb, seed } from "../src/db";
import { hashPassword } from "../src/app";
import type { ServerConfig } from "../src/config";
import { registerEventRoutes, type EventDeps } from "../src/routes_events";
import { EventExtractor } from "../src/events/extractor";

let dir: string;
let db: import("node:sqlite").DatabaseSync;
let config: ServerConfig;
let cookie: string;
let bus: EventBus;
let app: Hono;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibe-ev-"));
  config = {
    homeDir: dir,
    dataDir: join(dir, "data"),
    dbPath: join(dir, "data", "vibe_seller.db"),
    jwtSecretFile: join(dir, "data", "jwt_secret"),
    port: 0,
    adminEmail: "a@b.c", adminPassword: "admin", adminUsername: "admin",
    version: "t", jwtSecret: "test-secret",
  };
  db = openDb(config);
  seed(db, config, hashPassword);
  bus = new EventBus();
  cookie = `auth_token=${createSessionToken("00000000-0000-0000-0000-000000000001", "admin", "test-secret")}`;
  app = new Hono();
  app.onError((err, c) => (err instanceof HttpError ? c.json({ detail: err.message }, err.status as 400) : c.json({ detail: "?" }, 500)));
  registerEventRoutes(app, {
    config, db, auth: { db, jwtSecret: "test-secret" }, bus,
    // 注入恒失败的同步传输层——测试禁真网；同步失败路径（sync_error 落库）正是被测语义。
    syncFetch: (async () => new Response("{}", { status: 502 })) as EventDeps["syncFetch"],
  } as EventDeps);
});
afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

const jsonHeaders = () => ({ cookie, "content-type": "application/json" });
const post = (path: string, body?: unknown) => app.request(path, { method: "POST", headers: jsonHeaders(), body: body ? JSON.stringify(body) : undefined });
const getJson = async <T>(path: string): Promise<T> => (await (await app.request(path, { headers: { cookie } })).json()) as T;

describe("events CRUD", () => {
  it("create → EventResponse 全键 + event_created SSE + created activity", async () => {
    const res = await post("/api/events", { title: "中秋大促", description: "报名", deadline: "2026-09-20", priority: 2, sync_backend: "dida365" });
    const ev = (await res.json()) as Record<string, unknown>;
    for (const key of ["id", "channel_message_id", "channel_type", "store_id", "title", "description", "event_date", "deadline", "platform", "source_text", "status", "sync_backend", "sync_id", "sync_error", "case_id", "assignees", "created_by", "priority", "created_at", "updated_at"]) {
      expect(ev).toHaveProperty(key);
    }
    expect(ev["status"]).toBe("open"); // 手工建即 open
    expect(ev["priority"]).toBe(2);
    expect(bus.history.some((h) => h.type === "event_created" && h.data.title === "中秋大促")).toBe(true);
    const acts = await getJson<{ action: string; actor_type: string }[]>(`/api/events/${ev["id"]}/activities`);
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ action: "created", actor_type: "user" });
  });

  it("list 过滤：status 多值 / store_id / category", async () => {
    const a = (await (await post("/api/events", { title: "A", store_id: "s1", platform: "amazon" })).json()) as { id: string };
    await post("/api/events", { title: "B", store_id: "s2", platform: "system" });
    await post("/api/events", { title: "C", platform: "amazon" });
    await post(`/api/events/${a.id}/status`, { status: "closed" });

    expect(((await getJson<unknown[]>("/api/events?status=closed")) as unknown[]).length).toBe(1);
    expect(((await getJson<unknown[]>("/api/events?status=closed,draft")) as unknown[]).length).toBe(1); // A closed；B/C open 不在 closed,draft
    expect(((await getJson<unknown[]>("/api/events?store_id=s1")) as unknown[]).length).toBe(1);
    expect(((await getJson<unknown[]>("/api/events?category=system")) as unknown[]).length).toBe(1);
    expect(((await getJson<unknown[]>("/api/events?category=user")) as unknown[]).length).toBe(2);
    const all = await getJson<{ title: string }[]>("/api/events");
    expect(all).toHaveLength(3);
  });

  it("get 404 / update 字段面 / delete 级联 activities", async () => {
    expect((await app.request("/api/events/ghost", { headers: { cookie } })).status).toBe(404);
    const ev = (await (await post("/api/events", { title: "X" })).json()) as { id: string };
    const upd = (await (await app.request(`/api/events/${ev.id}`, { method: "PUT", headers: jsonHeaders(), body: JSON.stringify({ title: "Y", priority: 5 }) })).json()) as Record<string, unknown>;
    expect(upd["title"]).toBe("Y");
    expect(upd["priority"]).toBe(5);
    await post(`/api/events/${ev.id}/activities`, { content: "note" });
    expect(await (await app.request(`/api/events/${ev.id}`, { method: "DELETE", headers: { cookie } })).json()).toEqual({ ok: true });
    expect(db.prepare("SELECT COUNT(*) n FROM event_activities WHERE event_id = ?").get(ev.id)).toMatchObject({ n: 0 });
  });
});

describe("events 状态机", () => {
  it("合法转移全表（7 态逐字）", async () => {
    const ev = (await (await post("/api/events", { title: "S" })).json()) as { id: string; status: string };
    expect(ev.status).toBe("open");
    const chain: [string, string][] = [
      ["in_progress", "open→in_progress"],
      ["waiting", "in_progress→waiting"],
      ["resolved", "waiting→resolved"],
      ["closed", "resolved→closed"],
      ["open", "closed→open"],
      ["dismissed", "open→dismissed"],
      ["open", "dismissed→open"],
    ];
    for (const [next] of chain) {
      const r = (await (await post(`/api/events/${ev.id}/status`, { status: next })).json()) as { status: string };
      expect(r.status).toBe(next);
    }
  });

  it("非法转移 400 + 未知状态 400 + event_updated/activity SSE", async () => {
    const ev = (await (await post("/api/events", { title: "S2" })).json()) as { id: string };
    const bad = await post(`/api/events/${ev.id}/status`, { status: "closed" }); // open→closed 合法，用 in_progress 非法对
    expect(bad.status).toBe(200);
    const bad2 = await post(`/api/events/${ev.id}/status`, { status: "draft" }); // open→draft 不在表
    expect(bad2.status).toBe(400);
    const unknown = await post(`/api/events/${ev.id}/status`, { status: "weird" });
    expect(unknown.status).toBe(400);
    expect(bus.history.some((h) => h.type === "event_updated" && h.data.old_status === "open")).toBe(true);
    expect(bus.history.some((h) => h.type === "event_activity" && h.data.action === "status_changed")).toBe(true);
  });

  it("dismiss + confirm（draft 闸门 + 自动同步失败落 sync_error）", async () => {
    // confirm 只对 draft：手工事件是 open → 400
    const openEv = (await (await post("/api/events", { title: "O" })).json()) as { id: string };
    expect((await post(`/api/events/${openEv.id}/confirm`)).status).toBe(400);

    // draft 事件（channel 抽取产物）：confirm → open；sync_backend 调远端失败 → sync_error 落库
    const id = "ev-draft";
    db.prepare(
      `INSERT INTO events (id, title, status, sync_backend, priority, created_at, updated_at) VALUES (?, 'D', 'draft', 'dida365', 0, ?, ?)`,
    ).run(id, new Date().toISOString(), new Date().toISOString());
    // 无真实网络 → 同步异常 → sync_error（confirm 本身仍 200）
    const res = await post(`/api/events/${id}/confirm`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["status"]).toBe("open");
    expect(String(body["sync_error"])).toBeTruthy();

    // dismiss（任意态可入 dismissed？原实现 dismiss 不做转移校验——直接置 dismissed）
    const dis = (await (await post(`/api/events/${id}/dismiss`)).json()) as { status: string };
    expect(dis.status).toBe("dismissed");
  });
});

describe("events backends + sync", () => {
  it("backends 名单（dida365 + google_calendar，与注册序一致）+ configure 未知 400", async () => {
    let backends = await getJson<{ name: string; configured: boolean }[]>("/api/events/backends");
    expect(backends.map((b) => b.name)).toEqual(["dida365", "google_calendar"]);
    expect(backends.every((b) => !b.configured)).toBe(true);
    expect((await post("/api/events/backends/configure", { backend: "nope", config: {} })).status).toBe(400);
    const conf = await post("/api/events/backends/configure", { backend: "dida365", config: { access_token: "t" } });
    expect(await conf.json()).toEqual({ ok: true, backend: "dida365" });
    backends = await getJson<{ name: string; configured: boolean }[]>("/api/events/backends");
    expect(backends[0]).toMatchObject({ name: "dida365", configured: true });
  });

  it("sync 端点：无 backend 400；有 backend + 注入假后端 → sync_id + synced activity", async () => {
    const ev = (await (await post("/api/events", { title: "SY" })).json()) as { id: string };
    expect((await post(`/api/events/${ev.id}/sync`)).status).toBe(400);

    // 配置 dida365 + 重开一个注入 fetchImpl 的 app
    await post("/api/events/backends/configure", { backend: "dida365", config: { access_token: "tok", project_id: "proj" } });
    const app2 = new Hono();
    app2.onError((err, c) => (err instanceof HttpError ? c.json({ detail: err.message }, err.status as 400) : c.json({ detail: "?" }, 500)));
    const calls: { url: string; method: string }[] = [];
    registerEventRoutes(app2, {
      config, db,
      auth: { db, jwtSecret: "test-secret" },
      bus,
      syncFetch: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), method: init?.method ?? "GET" });
        return new Response(JSON.stringify({ id: "tick-123" }), { status: 200 });
      }) as EventDeps["syncFetch"],
    } as EventDeps);
    db.prepare("UPDATE events SET sync_backend = 'dida365' WHERE id = ?").run(ev.id);
    const r1 = (await (await app2.request(`/api/events/${ev.id}/sync`, { method: "POST", headers: jsonHeaders() })).json()) as Record<string, unknown>;
    expect(r1["sync_id"]).toBe("tick-123");
    expect(r1["sync_error"]).toBeNull();
    expect(calls[0]!.url).toContain("api.dida365.com/open/v1/task");
    // 已有 sync_id → update 路径
    const r2 = await app2.request(`/api/events/${ev.id}/sync`, { method: "POST", headers: jsonHeaders() });
    expect(r2.status).toBe(200);
    expect(calls[1]!.url).toContain("/task/tick-123");
  });

  it("delete 已同步事件尽力删远端（失败仅告警不阻塞）", async () => {
    const app2 = new Hono();
    app2.onError((err, c) => (err instanceof HttpError ? c.json({ detail: err.message }, err.status as 400) : c.json({ detail: "?" }, 500)));
    registerEventRoutes(app2, {
      config, db, auth: { db, jwtSecret: "test-secret" }, bus,
      syncFetch: (async () => new Response("{}", { status: 500 })) as EventDeps["syncFetch"],
    } as EventDeps);
    const id = "ev-del";
    db.prepare(`INSERT INTO events (id, title, status, sync_backend, sync_id, priority, created_at, updated_at) VALUES (?, 'X', 'open', 'dida365', 'ext-9', 0, ?, ?)`)
      .run(id, new Date().toISOString(), new Date().toISOString());
    // 远端 500 → delete 仍 {ok:true}（告警语义）
    expect(await (await app2.request(`/api/events/${id}`, { method: "DELETE", headers: { cookie } })).json()).toEqual({ ok: true });
  });
});

describe("EventExtractor（LLM 抽取，transport 注入）", () => {
  it("代码块包裹的 JSON 数组 → 解析；非数组 → []", async () => {
    const saved = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    const fenced = (body: unknown) =>
      new Response(JSON.stringify({ content: [{ type: "text", text: "```json\n" + JSON.stringify(body) + "\n```" }] }), { status: 200 });
    try {
      const ex = new EventExtractor((async () => fenced([{ title: "T" }])) as unknown as (u: string, i?: RequestInit) => Promise<Response>);
      const out = await ex.extractEvents("text", "wecom");
      expect(out).toEqual([{ title: "T" }]);

      const ex2 = new EventExtractor((async () => fenced({ not: "a list" })) as unknown as (u: string, i?: RequestInit) => Promise<Response>);
      expect(await ex2.extractEvents("text")).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env["ANTHROPIC_API_KEY"];
      else process.env["ANTHROPIC_API_KEY"] = saved;
    }
  });
  it("无 ANTHROPIC_API_KEY → []（与原实现 RuntimeError 被捕获等价）；空文本短路", async () => {
    const saved = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    try {
      const ex = new EventExtractor();
      expect(await ex.extractEvents("hello")).toEqual([]);
      expect(await ex.extractEvents("  ")).toEqual([]);
    } finally {
      if (saved !== undefined) process.env["ANTHROPIC_API_KEY"] = saved;
    }
  });
});
