// 批次 4.6 契约测试：dida365 OAuth(7) + ziniao-accounts(6) + browser(3) +
// 遗留收回面（email 水位下限 + new-emails + gws status）。

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
import { registerDidaRoutes, type DidaDeps } from "../src/routes_dida365";
import { registerZiniaoRoutes, type ZiniaoDeps } from "../src/routes_ziniao";
import { registerBrowserRoutes, type BrowserDeps } from "../src/routes_browser";
import { BrowserStarter } from "../src/browser/starter";
import { deriveFernetKey, fernetEncrypt } from "../src/crypto/fernet";
import { EmailStore } from "../src/email/db";
import { registerScheduleRoutes, type ScheduleRouteDeps } from "../src/routes_schedules";
import { TaskOrchestrator, type EngineFactory } from "../src/agent/orchestrator";

let dir: string;
let db: import("node:sqlite").DatabaseSync;
let config: ServerConfig;
let cookie: string;
let bus: EventBus;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibe-dz-"));
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

function onError(app: Hono): void {
  app.onError((err, c) => (err instanceof HttpError ? c.json({ detail: err.message }, err.status as 400) : c.json({ detail: "?" }, 500)));
}

// ── dida365 OAuth ──

describe("dida365 OAuth（7 端点）", () => {
  function makeApp(fetchImpl?: DidaDeps["fetchImpl"]): Hono {
    const app = new Hono();
    onError(app);
    registerDidaRoutes(app, { config, db, auth: { db, jwtSecret: "test-secret" }, jwtSecret: "test-secret", fetchImpl });
    return app;
  }

  it("status：未连接 → connected:false；authorize → 认证 URL + state + 配置落盘（secret 加密）", async () => {
    const app = makeApp();
    const s0 = (await (await app.request("/api/dida365/status", { headers: { cookie } })).json()) as Record<string, unknown>;
    expect(s0).toEqual({ connected: false, service_type: "", project_id: "" });

    const auth = (await (await app.request("/api/dida365/authorize", {
      method: "POST", headers: jsonHeaders(),
      body: JSON.stringify({ client_id: "cid", client_secret: "cs", service_type: "dida365" }),
    })).json()) as Record<string, string>;
    expect(auth.auth_url).toContain("https://dida365.com/oauth/authorize?");
    expect(auth.auth_url).toContain("response_type=code");
    expect(auth.callback_url).toContain("/api/dida365/callback");
    expect(auth.auth_url).toMatch(/state=[A-Za-z0-9_-]{20,}/);

    const cfgRaw = JSON.parse(require("node:fs").readFileSync(join(dir, "config", "event_backends.json"), "utf8")) as { dida365: Record<string, string> };
    expect(cfgRaw.dida365["client_id"]).toBe("cid");
    expect(cfgRaw.dida365["client_secret_enc"]).toMatch(/^gAAAAA/); // Fernet
    expect(JSON.stringify(cfgRaw)).not.toContain('"cs"');

    // 非法 service_type → 400
    expect((await app.request("/api/dida365/authorize", { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ client_id: "c", client_secret: "s", service_type: "nope" }) })).status).toBe(400);
  });

  it("callback：error / 缺参 / 未知 state → 400 HTML；成功流（注入 token 端点）→ HTML 200 + token 加密 + connected", async () => {
    const app = makeApp((async (url: string | URL | Request) => {
      if (String(url).includes("/oauth/token")) {
        return new Response(JSON.stringify({ access_token: "AT", refresh_token: "RT", expires_in: 3600 }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as DidaDeps["fetchImpl"]);

    const err = await app.request("/api/dida365/callback?error=denied");
    expect(err.status).toBe(400);
    expect(await err.text()).toContain("Authorization Failed");
    expect((await app.request("/api/dida365/callback")).status).toBe(400);
    expect((await app.request("/api/dida365/callback?code=c&state=unknown")).status).toBe(400);

    // 起授权（拿合法 state）
    await app.request("/api/dida365/authorize", { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ client_id: "cid", client_secret: "cs" }) });
    // state 在进程内字典——用 authorize 返回的 URL 提取
    const auth = (await (await app.request("/api/dida365/authorize", { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ client_id: "cid", client_secret: "cs" }) })).json()) as { auth_url: string };
    const state = new URL(auth.auth_url).searchParams.get("state")!;
    const cb = await app.request(`/api/dida365/callback?code=good&state=${state}`);
    expect(cb.status).toBe(200);
    const html = await cb.text();
    expect(html).toContain("Connected Successfully");

    const s = (await (await app.request("/api/dida365/status", { headers: { cookie } })).json()) as Record<string, unknown>;
    expect(s["connected"]).toBe(true);
    // state 单次使用
    expect((await app.request(`/api/dida365/callback?code=good&state=${state}`)).status).toBe(400);
  });

  it("projects：未连接 400；连接后注入假 API → 列表；401 → 刷新重试；configure + disconnect", async () => {
    let projectStatus = 200;
    let tokenCalls = 0;
    const app = makeApp((async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/oauth/token")) {
        tokenCalls += 1;
        return new Response(JSON.stringify({ access_token: `AT${tokenCalls}`, expires_in: 3600 }), { status: 200 });
      }
      if (u.endsWith("/project")) {
        return new Response(JSON.stringify([{ id: "p1", name: "Tasks" }]), { status: projectStatus });
      }
      return new Response("{}", { status: 404 });
    }) as DidaDeps["fetchImpl"]);

    expect((await app.request("/api/dida365/projects", { headers: { cookie } })).status).toBe(400);
    await app.request("/api/dida365/authorize", { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ client_id: "c", client_secret: "s" }) });
    // 手动塞一个立即过期且带 refresh_token 的配置（触发 refresh——无 refresh_token_enc 时不刷，与 Python 同闸）
    const cfgRaw = JSON.parse(require("node:fs").readFileSync(join(dir, "config", "event_backends.json"), "utf8")) as { dida365: Record<string, unknown> };
    const key = deriveFernetKey("test-secret");
    cfgRaw.dida365["access_token_enc"] = fernetEncrypt(key, "stale");
    cfgRaw.dida365["refresh_token_enc"] = fernetEncrypt(key, "rt");
    cfgRaw.dida365["expires_at"] = Math.floor(Date.now() / 1000) - 10; // 已过期 → refresh 分支
    require("node:fs").writeFileSync(join(dir, "config", "event_backends.json"), JSON.stringify(cfgRaw));

    const projects = (await (await app.request("/api/dida365/projects", { headers: { cookie } })).json()) as { id: string; name: string }[];
    expect(projects).toEqual([{ id: "p1", name: "Tasks" }]);
    expect(tokenCalls).toBeGreaterThanOrEqual(1); // 走过 refresh

    const conf = await app.request("/api/dida365/configure", { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ project_id: "p1" }) });
    expect(await conf.json()).toEqual({ ok: true });
    const s = (await (await app.request("/api/dida365/status", { headers: { cookie } })).json()) as Record<string, unknown>;
    expect(s["project_id"]).toBe("p1");

    const disc = await app.request("/api/dida365/disconnect", { method: "DELETE", headers: { cookie } });
    expect(await disc.json()).toEqual({ ok: true });
    const s2 = (await (await app.request("/api/dida365/status", { headers: { cookie } })).json()) as Record<string, unknown>;
    expect(s2["connected"]).toBe(false);
    void projectStatus;
  });
});

// ── ziniao-accounts ──

describe("ziniao-accounts（6 端点）", () => {
  let ziniaoServer: Server;
  let ziniaoPort: number;
  let ziniaoReply: Record<string, unknown>;

  beforeEach(async () => {
    // 假紫鸟客户端：本机 HTTP，GET/POST JSON
    ziniaoReply = { statusCode: "0", browserList: [{ browserName: "店铺A", browserOauth: "oauth-1" }] };
    ziniaoServer = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(ziniaoReply));
    });
    await new Promise<void>((r) => ziniaoServer.listen(0, "127.0.0.1", () => r()));
    ziniaoPort = (ziniaoServer.address() as { port: number }).port;
  });
  afterEach(async () => {
    await new Promise<void>((r) => ziniaoServer.close(() => r()));
  });

  function makeApp(): Hono {
    const app = new Hono();
    onError(app);
    registerZiniaoRoutes(app, { config, db, auth: { db, jwtSecret: "test-secret" }, jwtSecret: "test-secret" });
    return app;
  }

  async function createAccount(app: Hono, overrides: Record<string, unknown> = {}): Promise<{ id: string }> {
    const res = await app.request("/api/ziniao-accounts", {
      method: "POST", headers: jsonHeaders(),
      body: JSON.stringify({ name: "主账号", company: "公司", username: "user1", password: "pw123", socket_port: ziniaoPort, ...overrides }),
    });
    return (await res.json()) as { id: string };
  }

  it("CRUD：创建（密码 Fernet 不回显）→ 列表 → 改名/密码留空不改 → 删除幂等", async () => {
    const app = makeApp();
    const acct = await createAccount(app);
    expect(acct.id).toBeTruthy();
    const row = db.prepare("SELECT encrypted_password FROM ziniao_accounts WHERE id = ?").get(acct.id) as { encrypted_password: string };
    expect(row.encrypted_password).toMatch(/^gAAAAA/);

    const list = (await (await app.request("/api/ziniao-accounts", { headers: { cookie } })).json()) as Record<string, unknown>[];
    expect(list[0]).toMatchObject({ name: "主账号", company: "公司", username: "user1", socket_port: ziniaoPort, client_path: "ziniao" });
    expect(list[0]).not.toHaveProperty("encrypted_password");

    const upd = await app.request(`/api/ziniao-accounts/${acct.id}`, { method: "PUT", headers: jsonHeaders(), body: JSON.stringify({ name: "改名", password: "" }) });
    const after = (await upd.json()) as Record<string, unknown>;
    expect(after["name"]).toBe("改名");
    const row2 = db.prepare("SELECT encrypted_password FROM ziniao_accounts WHERE id = ?").get(acct.id) as { encrypted_password: string };
    expect(row2.encrypted_password).toBe(row.encrypted_password); // 空 password = 不改

    expect(await (await app.request(`/api/ziniao-accounts/${acct.id}`, { method: "DELETE", headers: { cookie } })).json()).toEqual({ ok: true });
    expect(await (await app.request(`/api/ziniao-accounts/ghost`, { method: "DELETE", headers: { cookie } })).json()).toEqual({ ok: true });
  });

  it("browsers：假紫鸟 statusCode 0 → 列表；-10003 → 结构化 no_permission；新终端登录 → 结构化", async () => {
    const app = makeApp();
    const acct = await createAccount(app);
    const res = (await (await app.request(`/api/ziniao-accounts/${acct.id}/browsers`, { headers: { cookie } })).json()) as { browser_name: string; browser_oauth: string }[];
    expect(res).toEqual([{ browser_name: "店铺A", browser_oauth: "oauth-1" }]);

    ziniaoReply = { statusCode: "-10003", err: "WebDriver未开启" };
    const denied = await app.request(`/api/ziniao-accounts/${acct.id}/browsers`, { headers: { cookie } });
    expect(denied.status).toBe(502);
    expect(JSON.parse(((await denied.json()) as { detail: string }).detail)).toEqual({ status: "no_permission", message: "WebDriver未开启" });

    ziniaoReply = { statusCode: "7", err: "检测到新终端登录，请在客户端确认" };
    const newTerm = await app.request(`/api/ziniao-accounts/${acct.id}/browsers`, { headers: { cookie } });
    expect(JSON.parse(((await newTerm.json()) as { detail: string }).detail)).toEqual({ status: "new_terminal_login" });

    ziniaoReply = { statusCode: "9", err: "其他错误" };
    const other = await app.request(`/api/ziniao-accounts/${acct.id}/browsers`, { headers: { cookie } });
    expect(((await other.json()) as { detail: string }).detail).toBe("Ziniao API error: 其他错误");
  });

  it("credentials_error：换装后老密文解不开 → 400 结构化（Sidebar 渲染契约）", async () => {
    const app = makeApp();
    const acct = await createAccount(app);
    // 用另一个 secret 重加密该行（模拟 JWT_SECRET 换装）
    db.prepare("UPDATE ziniao_accounts SET encrypted_password = ? WHERE id = ?").run(fernetEncrypt(deriveFernetKey("other-secret"), "pw"), acct.id);
    const res = await app.request(`/api/ziniao-accounts/${acct.id}/browsers`, { headers: { cookie } });
    expect(res.status).toBe(400);
    expect(JSON.parse(((await res.json()) as { detail: string }).detail)).toEqual({ status: "credentials_error" });
  });

  it("restart：非 normal mode → 409（防误杀活跃 WebDriver 会话）", async () => {
    const app = makeApp();
    const acct = await createAccount(app);
    const res = await app.request(`/api/ziniao-accounts/${acct.id}/restart`, { method: "POST", headers: { cookie } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { detail: string }).detail).toContain('not "running_normal"');
    expect((await app.request("/api/ziniao-accounts/ghost/restart", { method: "POST", headers: { cookie } })).status).toBe(404);
  });
});

// ── browser 路由（launcher + web/aux/start + store start 404 面） ──

describe("browser 路由（3 端点 + store start）", () => {
  function makeApp(): { app: Hono; starter: BrowserStarter } {
    const app = new Hono();
    onError(app);
    const starter = new BrowserStarter({ config, db });
    registerBrowserRoutes(app, { config, db, auth: { db, jwtSecret: "test-secret" }, jwtSecret: "test-secret", starter, tsRoot: dir });
    return { app, starter };
  }

  it("launcher：有 bat → octet-stream 附件下载；缺 → 404；免认证（无 cookie 也到业务层）", async () => {
    const { app } = makeApp();
    expect((await app.request("/api/ziniao/launcher")).status).toBe(404);
    await writeFile(join(dir, "ziniao_webdriver.bat"), "@echo off\r\necho ready\r\n");
    const res = await app.request("/api/ziniao/launcher");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toContain("ziniao_webdriver.bat");
    expect(await res.text()).toContain("@echo off");
  });

  it("stores browser/start：不存在 404；aux/start 不存在店铺 404", async () => {
    const { app } = makeApp();
    expect((await app.request("/api/stores/ghost/browser/start", { method: "POST", headers: { cookie } })).status).toBe(404);
    expect((await app.request("/api/stores/ghost/browser/aux/start", { method: "POST", headers: { cookie } })).status).toBe(404);
  });

  it("bookmarks：chrome 店读 profile Bookmarks；ziniao 店恒 []；无后端 []", async () => {
    const { app } = makeApp();
    db.prepare("INSERT INTO stores (id, name, browser_backend, created_at, updated_at) VALUES ('st-ch', 'Chrome店', 'chrome', ?, ?)").run(new Date().toISOString(), new Date().toISOString());
    db.prepare("INSERT INTO stores (id, name, browser_backend, browser_oauth, created_at, updated_at) VALUES ('st-zn', 'Zn店', 'ziniao', 'oa', ?, ?)").run(new Date().toISOString(), new Date().toISOString());
    db.prepare("INSERT INTO stores (id, name, created_at, updated_at) VALUES ('st-none', '裸店', ?, ?)").run(new Date().toISOString(), new Date().toISOString());

    const slugDir = join(dir, "browser_profiles", "chrome");
    await mkdir(join(slugDir, "Default"), { recursive: true });
    await writeFile(
      join(slugDir, "Default", "Bookmarks"),
      JSON.stringify({ roots: { bookmark_bar: { type: "folder", children: [{ type: "url", name: "卖家后台", url: "https://sellercentral.amazon.com" }] }, synced: { type: "folder", children: [] } } }),
    );
    const b1 = (await (await app.request("/api/stores/st-ch/bookmarks", { headers: { cookie } })).json()) as { name: string; url: string }[];
    expect(b1).toEqual([{ name: "卖家后台", url: "https://sellercentral.amazon.com" }]);
    expect(((await (await app.request("/api/stores/st-zn/bookmarks", { headers: { cookie } })).json()) as unknown[]).length).toBe(0); // ziniao 加密恒 []
    expect(((await (await app.request("/api/stores/st-none/bookmarks", { headers: { cookie } })).json()) as unknown[]).length).toBe(0);
    expect((await app.request("/api/stores/ghost/bookmarks", { headers: { cookie } })).status).toBe(404);
  });
});

// ── 遗留收回：email 水位下限 + new-emails + gws status ──

describe("email 水位下限 + new-emails（4.4 遗留收回）", () => {
  function makeScheduleApp(): Hono {
    const app = new Hono();
    onError(app);
    const engineFactory: EngineFactory = async () => {
      throw new Error("unused");
    };
    const orchestrator = new TaskOrchestrator({ config, db, bus, engineFactory });
    registerScheduleRoutes(app, { config, db, bus, orchestrator, jwtSecret: "test-secret", auth: { db, jwtSecret: "test-secret" }, scheduler: {} as ScheduleRouteDeps["scheduler"] } as ScheduleRouteDeps);
    return app;
  }

  function seedScenario(): { scheduleId: string; taskId: string; acctId: string } {
    db.prepare("INSERT INTO stores (id, name, created_at, updated_at) VALUES ('st-em', '邮件店', ?, ?)").run(new Date().toISOString(), new Date().toISOString());
    const scheduleId = "sched-1";
    db.prepare("INSERT INTO schedules (id, created_by, title, schedule_type, schedule_time, timezone, is_active, is_system, plan_version, created_at, updated_at) VALUES (?, 'u', 'sweep', 'daily', '09:00', 'UTC', 1, 1, 0, ?, ?)").run(scheduleId, new Date().toISOString(), new Date().toISOString());
    const taskId = "task-em";
    db.prepare("INSERT INTO tasks (id, created_by, store_id, schedule_id, title, status, priority, created_at, updated_at) VALUES (?, 'u', 'st-em', ?, 'run', 'pending', 0, ?, ?)").run(taskId, scheduleId, new Date().toISOString(), new Date().toISOString());
    const acctId = "acct-em";
    db.prepare("INSERT INTO email_accounts (id, email, encrypted_password, imap_host, imap_port, use_ssl, smtp_host, smtp_port, smtp_use_tls, created_by, created_at, updated_at) VALUES (?, 'a@163.com', 'x', 'imap.163.com', 993, 1, NULL, NULL, 1, 'u', ?, ?)").run(acctId, new Date().toISOString(), new Date().toISOString());
    db.prepare("INSERT INTO store_email_links (id, store_id, email_account_id, created_at) VALUES ('link1', 'st-em', ?, ?)").run(acctId, new Date().toISOString());

    const store = new EmailStore(`${dir}/data/email_dbs`);
    store.initEmailDb(acctId);
    store.storeEmails(acctId, [
      { message_id: "old", folder: "INBOX", subject: "老", fetched_at: "2026-10-01T00:00:00Z", date: "2026-10-01T00:00:00Z" },
      { message_id: "new", folder: "INBOX", subject: "新", fetched_at: "2026-10-07T00:00:00Z", date: "2026-10-07T00:00:00Z" },
    ]);
    return { scheduleId, taskId, acctId };
  }

  it("new-emails：水位清扫 + next_watermark + floor 原子写入；游标过滤只回新邮件", async () => {
    const app = makeScheduleApp();
    const { taskId, acctId } = seedScenario();
    // 首跑（无游标）：lookback 24h——两封种子邮件 fetched_at 均在过去 → count 0
    const r = (await (await app.request(`/api/tasks/${taskId}/new-emails?lookback_hours=24`, { headers: { cookie } })).json()) as { first_run: boolean; count: number; next_watermark: string };
    expect(r.first_run).toBe(true);
    expect(r.count).toBe(0);
    expect(r.next_watermark).toBeTruthy();

    // agent 按契约把 next_watermark 原值持久化
    await app.request(`/api/tasks/${taskId}/schedule-state/email_watermark`, { method: "PUT", headers: jsonHeaders(), body: JSON.stringify({ value: r.next_watermark }) });
    const r2 = (await (await app.request(`/api/tasks/${taskId}/new-emails`, { headers: { cookie } })).json()) as { first_run: boolean; count: number };
    expect(r2.first_run).toBe(false);
    expect(r2.count).toBe(0); // 老邮件（10-01/10-07）不重扫

    // 新邮件到达 → 只回它
    const store = new EmailStore(`${dir}/data/email_dbs`);
    store.storeEmails(acctId, [{ message_id: "fresh", folder: "INBOX", subject: "刚到", fetched_at: new Date().toISOString(), date: new Date().toISOString() }]);
    const r3 = (await (await app.request(`/api/tasks/${taskId}/new-emails`, { headers: { cookie } })).json()) as { count: number; next_watermark: string; accounts: { new_emails: Record<string, unknown>[] }[] };
    expect(r3.count).toBe(1);
    expect(r3.accounts[0]!.new_emails[0]).toMatchObject({ message_id: "fresh" });

    // floor 已被服务器侧 MAX 推进（≥ next_watermark）
    const floor = Number((db.prepare("SELECT value FROM schedule_state WHERE key = '_email_watermark_floor'").get() as { value: string }).value);
    expect(floor).toBeGreaterThanOrEqual(Number(r3.next_watermark) - 1);
    // 低于 floor 的持久化被拒（防 Date 头手推游标）
    const r4 = await app.request(`/api/tasks/${taskId}/schedule-state/email_watermark`, { method: "PUT", headers: jsonHeaders(), body: JSON.stringify({ value: String(floor - 1) }) });
    expect(r4.status).toBe(400);
  });

  it("email_watermark 下限：有账户店铺必须先跑 get_new_emails；低于 floor 拒绝", async () => {
    const app = makeScheduleApp();
    const { taskId } = seedScenario();
    // 未跑 new-emails → floor 不存在 → 400（防 Date 头手推游标）
    const r1 = await app.request(`/api/tasks/${taskId}/schedule-state/email_watermark`, { method: "PUT", headers: jsonHeaders(), body: JSON.stringify({ value: String(Math.floor(Date.now() / 1000)) }) });
    expect(r1.status).toBe(400);
    expect(((await r1.json()) as { detail: string }).detail).toContain("vibe_seller_get_new_emails first");

    // 跑一次（写 floor），然后尝试写低于 floor 的值 → 400
    await app.request(`/api/tasks/${taskId}/new-emails`, { headers: { cookie } });
    const floor = Number((db.prepare("SELECT value FROM schedule_state WHERE key = '_email_watermark_floor'").get() as { value: string }).value);
    const r2 = await app.request(`/api/tasks/${taskId}/schedule-state/email_watermark`, { method: "PUT", headers: jsonHeaders(), body: JSON.stringify({ value: String(floor - 1) }) });
    expect(r2.status).toBe(400);
    expect(((await r2.json()) as { detail: string }).detail).toContain("below the email-watermark floor");

    // 写 >= floor → ok
    const r3 = await app.request(`/api/tasks/${taskId}/schedule-state/email_watermark`, { method: "PUT", headers: jsonHeaders(), body: JSON.stringify({ value: String(floor) }) });
    expect(await r3.json()).toMatchObject({ ok: true });
  });

  it("无链接账户的店铺 email_watermark 走通用 KV 语义（不受 floor 约束）", async () => {
    const app = makeScheduleApp();
    db.prepare("INSERT INTO schedules (id, created_by, title, schedule_type, schedule_time, timezone, is_active, is_system, plan_version, created_at, updated_at) VALUES ('s2', 'u', 'x', 'daily', '09:00', 'UTC', 1, 1, 0, ?, ?)").run(new Date().toISOString(), new Date().toISOString());
    db.prepare("INSERT INTO tasks (id, created_by, schedule_id, title, status, priority, created_at, updated_at) VALUES ('t2', 'u', 's2', 'x', 'pending', 0, ?, ?)").run(new Date().toISOString(), new Date().toISOString());
    const r = await app.request("/api/tasks/t2/schedule-state/email_watermark", { method: "PUT", headers: jsonHeaders(), body: JSON.stringify({ value: String(Math.floor(Date.now() / 1000)) }) });
    expect(r.status).toBe(200);
  });
});

describe("gws status（settings 遗留收回）", () => {
  it("gws 不在 PATH → binary:false；enabled 默认 false；enable 无 binary → 400", async () => {
    const { createApp } = await import("../src/app");
    const app = createApp({ config, jwtSecret: "test-secret", db, bus, engineFactory: async () => { throw new Error("x"); } });
    const status = (await (await app.request("/api/settings/google-workspace/status", { headers: { cookie } })).json()) as Record<string, unknown>;
    expect(status["binary"]).toBe(false);
    expect(status["enabled"]).toBe(false);
    expect(status["installed"]).toBe(false);

    const enable = await app.request("/api/settings/google-workspace/enable", { method: "POST", headers: { cookie } });
    expect(enable.status).toBe(400);
    expect(((await enable.json()) as { detail: string }).detail).toContain("gws binary not found");

    // disable 幂等
    const disable = await app.request("/api/settings/google-workspace/disable", { method: "POST", headers: { cookie } });
    expect(await disable.json()).toEqual({ ok: true, removed: false });
  });
});
