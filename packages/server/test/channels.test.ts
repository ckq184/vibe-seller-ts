// 批次 4.6 契约测试：channels(7) + wecom-bots(8)。
// 打码契约（列表 webhook_url_masked / 单查全量）、路径白名单、poll→事件抽取链。

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { Hono } from "hono";
import { EventBus } from "../src/bus";
import { HttpError } from "../src/types";
import { createSessionToken } from "../src/jwt";
import { openDb, seed } from "../src/db";
import { hashPassword } from "../src/app";
import type { ServerConfig } from "../src/config";
import { registerChannelRoutes, getActiveChannelForTest, type ChannelDeps } from "../src/routes_channels";
import { registerWecomRoutes, type WecomDeps } from "../src/routes_wecom";
import { WeComChannel, getChannel } from "../src/channels/registry";
import { maskWebhookUrl } from "../src/channels/wecom";

let dir: string;
let db: import("node:sqlite").DatabaseSync;
let config: ServerConfig;
let cookie: string;
let bus: EventBus;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibe-ch-"));
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
});
afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

const jsonHeaders = () => ({ cookie, "content-type": "application/json" });

describe("WeComChannel（注入 fetch）", () => {
  it("webhook 优先：send → errcode 0 → true；非 0 → false", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ errcode: calls.length === 1 ? 0 : 93000 }), { status: 200 });
    };
    const ch = new WeComChannel(fetchImpl);
    await ch.configure({ webhook_url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc" });
    expect(await ch.send("hello")).toBe(true);
    expect(await ch.send("hello2")).toBe(false);
    expect((calls[0]!.body as { msgtype: string }).msgtype).toBe("text");
  });

  it("未知 channel 类型 → 抛错（400 面）", () => {
    expect(() => getChannel("slack")).toThrow(/Unknown channel type/);
  });
});

describe("channels 路由（7 端点）", () => {
  function makeApp(extractImpl?: ChannelDeps["extractImpl"], syncBody?: Record<string, unknown>, fetchImpl?: ChannelDeps["fetchImpl"]): Hono {
    const app = new Hono();
    app.onError((err, c) => (err instanceof HttpError ? c.json({ detail: err.message }, err.status as 400) : c.json({ detail: "?" }, 500)));
    registerChannelRoutes(app, {
      config, db, auth: { db, jwtSecret: "test-secret" }, bus,
      extractImpl,
      fetchImpl,
      syncFetch: syncBody ? (async () => new Response(JSON.stringify(syncBody), { status: 200 })) : undefined,
    } as ChannelDeps);
    return app;
  }

  it("types → wecom（read_write）；configure 持久化 channels.json；configs/active 形状", async () => {
    const app = makeApp();
    const types = await (await app.request("/api/channels/types", { headers: { cookie } })).json();
    expect(types).toEqual([{ type: "wecom", read_write: true }]);

    const conf = await app.request("/api/channels/configure", {
      method: "POST", headers: jsonHeaders(),
      body: JSON.stringify({ channel_type: "wecom", config: { webhook_url: "https://x/key" }, channel_id: "w1", auto_create_events: true }),
    });
    expect(await conf.json()).toEqual({ channel_id: "w1", status: "configured", auto_create_events: true });

    const configs = (await (await app.request("/api/channels/configs", { headers: { cookie } })).json()) as Record<string, unknown>;
    expect(configs["w1"]).toMatchObject({ channel_type: "wecom", auto_create_events: true });
    const active = await (await app.request("/api/channels/active", { headers: { cookie } })).json();
    expect(active).toEqual([{ channel_id: "w1", channel_type: "wecom", read_write: true }]);
  });

  it("poll：无渠道 404；推送消息 → 抽取 → Event 落库 + event_created SSE + activity", async () => {
    const app = makeApp(async () => [{ title: "闪促报名截止", deadline: "2026-03-15", platform: "amazon" }]);
    expect((await app.request("/api/channels/ghost/poll", { method: "POST", headers: { cookie } })).status).toBe(404);

    await app.request("/api/channels/configure", { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ channel_type: "wecom", config: {} }) });
    getActiveChannelForTest("wecom")!.poll(); // 清空
    (getActiveChannelForTest("wecom") as WeComChannel).pushMessage({
      channel_type: "wecom", sender: "ops", content: "msg body", subject: "sub", attachments: [], raw: {}, message_id: "mid-1",
    });
    const res = await app.request("/api/channels/wecom/poll", { method: "POST", headers: { cookie } });
    const body = (await res.json()) as { messages: unknown[]; events_created: number };
    expect(body.messages).toHaveLength(1);
    expect(body.events_created).toBe(1);

    const row = db.prepare("SELECT * FROM events WHERE channel_message_id = ?").get("mid-1") as { title: string; status: string; sync_backend: null };
    expect(row.title).toBe("闪促报名截止");
    expect(row.status).toBe("draft"); // 无已配置后端 → 不自动同步
    expect(bus.history.some((h) => h.type === "event_created" && h.data.title === "闪促报名截止")).toBe(true);
    const act = db.prepare("SELECT actor_type, action FROM event_activities WHERE event_id = ?").get(row.title && (db.prepare("SELECT id FROM events WHERE channel_message_id = 'mid-1'").get() as { id: string }).id);
    expect(act).toMatchObject({ actor_type: "channel", action: "created" });
  });

  it("poll + auto_create_events + 已配置后端 → 自动同步（synced，注入 dida365 传输层）", async () => {
    // 预写 dida365 后端配置（event_backends.json）
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(join(dir, "config", "event_backends.json"), JSON.stringify({ dida365: { access_token: "t", project_id: "p" } }));

    const app2 = makeApp(async () => [{ title: "自动同步事件" }], { id: "kie-task-1" });
    await app2.request("/api/channels/configure", { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ channel_type: "wecom", config: {}, auto_create_events: true }) });
    (getActiveChannelForTest("wecom") as WeComChannel).pushMessage({ channel_type: "wecom", sender: "s", content: "c", subject: "", attachments: [], raw: {}, message_id: "mid-2" });
    const res = await app2.request("/api/channels/wecom/poll", { method: "POST", headers: { cookie } });
    const body = (await res.json()) as { events_created: number };
    expect(body.events_created).toBe(1);
    const row = db.prepare("SELECT status, sync_backend, sync_id FROM events WHERE channel_message_id = 'mid-2'").get() as { status: string; sync_backend: string; sync_id: string };
    expect(row.status).toBe("synced");
    expect(row.sync_backend).toBe("dida365");
    expect(row.sync_id).toBe("kie-task-1");
  });

  it("send（read_write 渠道）→ ok；delete → {ok:true}；再 poll 404", async () => {
    // 注入 fetch（测试禁真网红线）：errcode 0 → ok:true
    const app = makeApp(undefined, undefined, (async () => new Response(JSON.stringify({ errcode: 0 }), { status: 200 })) as ChannelDeps["fetchImpl"]);
    await app.request("/api/channels/configure", { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ channel_type: "wecom", config: { webhook_url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k" } }) });
    const send = await app.request("/api/channels/wecom/send", { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ content: "hi" }) });
    expect(await send.json()).toEqual({ ok: true });
    const del = await app.request("/api/channels/wecom", { method: "DELETE", headers: { cookie } });
    expect(await del.json()).toEqual({ ok: true });
    expect((await app.request("/api/channels/wecom/poll", { method: "POST", headers: { cookie } })).status).toBe(404);
  });
});

describe("wecom-bots 路由（8 端点）", () => {
  const WEBHOOK = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=supersecretkey1234";

  function makeApp(fetchImpl?: WecomDeps["fetchImpl"]): Hono {
    const app = new Hono();
    app.onError((err, c) => (err instanceof HttpError ? c.json({ detail: err.message }, err.status as 400) : c.json({ detail: "?" }, 500)));
    registerWecomRoutes(app, { config, db, auth: { db, jwtSecret: "test-secret" }, fetchImpl });
    return app;
  }

  it("创建（全量 URL）→ 列表打码 → 单查全量；空名 400", async () => {
    const app = makeApp();
    const created = await app.request("/api/wecom-bots", { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ name: "运营群", webhook_url: WEBHOOK }) });
    const bot = (await created.json()) as Record<string, unknown>;
    expect(bot["webhook_url"]).toBe(WEBHOOK); // 创建响应给全量

    const list = (await (await app.request("/api/wecom-bots", { headers: { cookie } })).json()) as Record<string, unknown>[];
    expect(list).toHaveLength(1);
    expect(list[0]!["webhook_url_masked"]).toBe("https://qyapi.weixin.qq.com/...?key=****1234");
    expect(list[0]).not.toHaveProperty("webhook_url"); // 打码契约

    const one = (await (await app.request(`/api/wecom-bots/${bot["id"]}`, { headers: { cookie } })).json()) as Record<string, unknown>;
    expect(one["webhook_url"]).toBe(WEBHOOK);

    expect((await app.request("/api/wecom-bots", { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ name: "  ", webhook_url: WEBHOOK }) })).status).toBe(400);
  });

  it("maskWebhookUrl：坏 URL → '***'", () => {
    expect(maskWebhookUrl("not a url")).toBe("***");
    expect(maskWebhookUrl("https://h.com/?key=ab")).toBe("https://h.com/..."); // ≤4 位无尾码
  });

  it("更新：null/空白拒绝；正常更新返回全量；删除", async () => {
    const app = makeApp();
    const bot = (await (await app.request("/api/wecom-bots", { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ name: "n", webhook_url: WEBHOOK }) })).json()) as { id: string };
    const bad = await app.request(`/api/wecom-bots/${bot.id}`, { method: "PUT", headers: jsonHeaders(), body: JSON.stringify({ name: null }) });
    expect(bad.status).toBe(400);
    const blank = await app.request(`/api/wecom-bots/${bot.id}`, { method: "PUT", headers: jsonHeaders(), body: JSON.stringify({ name: "  " }) });
    expect(blank.status).toBe(400);
    const upd = (await (await app.request(`/api/wecom-bots/${bot.id}`, { method: "PUT", headers: jsonHeaders(), body: JSON.stringify({ name: "新名" }) })).json()) as Record<string, unknown>;
    expect(upd["name"]).toBe("新名");
    expect(upd["webhook_url"]).toBe(WEBHOOK);
    expect(await (await app.request(`/api/wecom-bots/${bot.id}`, { method: "DELETE", headers: { cookie } })).json()).toEqual({ ok: true });
  });

  it("test/send：注入 webhook（errcode 0 / 非 0）；msgtype 校验", async () => {
    let errcode = 0;
    const app = makeApp((async () => new Response(JSON.stringify({ errcode, errmsg: errcode === 0 ? "ok" : "wrong key" }), { status: 200 })) as WecomDeps["fetchImpl"]);
    const bot = (await (await app.request("/api/wecom-bots", { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ name: "n", webhook_url: WEBHOOK }) })).json()) as { id: string };

    const t = (await (await app.request(`/api/wecom-bots/${bot.id}/test`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({}) })).json()) as { ok: boolean; message: string };
    expect(t.ok).toBe(true);
    expect(t.message).toBe("Message sent");

    errcode = 94;
    const send = (await (await app.request(`/api/wecom-bots/${bot.id}/send`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ content: "hello", msgtype: "markdown" }) })).json()) as { ok: boolean; message: string };
    expect(send.ok).toBe(false);
    expect(send.message).toBe("wrong key"); // errmsg 透传；URL 永不回显

    expect((await app.request(`/api/wecom-bots/${bot.id}/send`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ content: "x", msgtype: "image" }) })).status).toBe(400);
    expect((await app.request(`/api/wecom-bots/${bot.id}/send`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ content: "  " }) })).status).toBe(400);
  });

  it("send-file：白名单外 400；白名单内（downloads/）→ 注入上传流 errcode 0 → ok；<6 字节拒", async () => {
    const app = makeApp((async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("upload_media")) {
        return new Response(JSON.stringify({ errcode: 0, media_id: "MEDIA" }), { status: 200 });
      }
      return new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
    }) as WecomDeps["fetchImpl"]);

    const bot = (await (await app.request("/api/wecom-bots", { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ name: "n", webhook_url: WEBHOOK }) })).json()) as { id: string };

    // 白名单外（家目录敏感文件——绝不放行 ~/.vibe-seller 运行时目录）
    const outside = await app.request(`/api/wecom-bots/${bot.id}/send-file`, {
      method: "POST", headers: jsonHeaders(),
      body: JSON.stringify({ path: join(dir, "data", "jwt_secret") }),
    });
    expect(outside.status).toBe(400);

    // 相对路径 → 400
    const rel = await app.request(`/api/wecom-bots/${bot.id}/send-file`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ path: "relative/file.txt" }) });
    expect(rel.status).toBe(400);

    // 白名单内：downloads/ 下 >5 字节的文件
    const downloads = join(dir, "downloads");
    await mkdir(downloads, { recursive: true });
    const okFile = join(downloads, "report.txt");
    await writeFile(okFile, "0123456789");
    const okRes = (await (await app.request(`/api/wecom-bots/${bot.id}/send-file`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ path: okFile }) })).json()) as { ok: boolean; message: string };
    expect(okRes.ok).toBe(true);

    // 太小（<6 字节）
    const tiny = join(downloads, "tiny.txt");
    await writeFile(tiny, "abc");
    const small = (await (await app.request(`/api/wecom-bots/${bot.id}/send-file`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ path: tiny }) })).json()) as { ok: boolean };
    expect(small.ok).toBe(false);
  });
});
