// Phase 5.1 原生 ToolPort 测试：22 工具 schema 钉子（fixture 对账）+ 执行器逐工具
// method/path/body 命中与结果形状 + 语义保真件（能力门 / send_email 两段式 /
// generate_image 无超时阻塞 / 错误包装 / 孤立代理对清洗）。
// 全部走 createApp 的进程内 app.request（零真网、零子进程）；发送类工具用注入的
// 假请求层（对齐 channels/wecom 测试的 fetchImpl 注入模式）。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolIntent } from "@vibe/core";
import { createApp, hashPassword, type AppDeps } from "../src/app";
import { openDb, seed } from "../src/db";
import { EventBus } from "../src/bus";
import {
  BROWSE_TOOL_SCHEMAS,
  buildNativeToolSchemas,
  createNativeToolPort,
  filterVisibleTools,
  imageModelGuide,
  mintServiceToken,
  MCP_TOOL_SCHEMAS,
} from "../src/agent/native-tools";
import { BROWSE_TOOL_NAMES } from "../src/browser/browse";
import { catalogPublic, DEFAULT_MODEL, modelIds } from "../src/vision/vision";
import type { ServerConfig } from "../src/config";

// 原实现 TOOLS 的 ast 抽取（app/mcp_tool_schemas.py + mcp_ad_tool_schemas.py），
// generate_image 的两个动态位保留占位符（原 :17-29 由 vision catalog 派生）。
const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/mcp-tools.json", import.meta.url), "utf8")) as {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}[];

let dir: string;
let deps: AppDeps;
let app: ReturnType<typeof createApp>;

const config: ServerConfig = {
  homeDir: "",
  dataDir: "",
  dbPath: "",
  jwtSecretFile: "",
  port: 0,
  adminEmail: "admin@vibe-seller.local",
  adminPassword: "admin",
  adminUsername: "admin",
  version: "0.1.0-test",
  jwtSecret: "test-secret",
};

interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

/** 记录器包装：命中断言用；请求仍打到真 app（结果形状来自真实服务器）。 */
function recorder(calls: RecordedCall[]) {
  return async (path: string, init: RequestInit): Promise<Response> => {
    calls.push({
      method: String(init.method ?? "GET"),
      path,
      body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
      headers: (init.headers ?? {}) as Record<string, string>,
    });
    return await app.request(path, init);
  };
}

function makePort(calls: RecordedCall[], taskId = "task-1") {
  return createNativeToolPort({ app, taskId, authToken: mintServiceToken(deps.db, "test-secret"), request: recorder(calls) });
}

const exec = async (port: ReturnType<typeof makePort>, name: string, args: Record<string, unknown>) =>
  port.execute({ name, arguments: args } as ToolIntent, new AbortController().signal);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibe-native-"));
  const cfg: ServerConfig = { ...config, homeDir: dir, dataDir: dir, dbPath: join(dir, "vibe_seller.db") };
  const db = openDb(cfg);
  seed(db, cfg, hashPassword);
  deps = { config: cfg, jwtSecret: "test-secret", db, bus: new EventBus() };
  app = createApp(deps);
  // 测试夹具：running 任务（result/error 成功形状）+ fanout 调度上的 scheduled 任务
  //（schedule-state / register-finalize / new-emails 成功形状）。
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO tasks (id, title, created_by, status, created_at, updated_at) VALUES ('task-1', 'T', '00000000-0000-0000-0000-000000000002', 'running', ?, ?)",
  ).run(now, now);
  db.prepare(
    `INSERT INTO schedules (id, store_id, created_by, title, description, platform, country, plan,
                            schedule_type, schedule_time, schedule_day, interval_value, timezone,
                            is_active, is_system, phase_mode, staleness_check, skip_reflection,
                            finalize_description, finalize_enabled_at, plan_mode, ai_profile_id,
                            plan_status, plan_version, current_planning_task_id, plan_error,
                            created_at, updated_at)
     VALUES ('sched-1', NULL, '00000000-0000-0000-0000-000000000002', 'S', 'D', NULL, NULL, NULL,
             'days', '03:00', NULL, 1, 'UTC', 1, 0, 'fanout', 'none', 1,
             NULL, NULL, 0, 'default', 'none', 0, NULL, NULL, ?, ?)`,
  ).run(now, now);
  db.prepare(
    "INSERT INTO tasks (id, title, created_by, status, schedule_id, store_id, created_at, updated_at) VALUES ('task-sched', 'S', '00000000-0000-0000-0000-000000000002', 'pending', 'sched-1', 'store-1', ?, ?)",
  ).run(now, now);
  db.prepare(
    "INSERT INTO wecom_bots (id, name, webhook_url, created_by, created_at, updated_at) VALUES ('bot-1', '运维群', 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=SECRET', '00000000-0000-0000-0000-000000000002', ?, ?)",
  ).run(now, now);
});

afterAll(async () => {
  deps.db.close(); // Windows：句柄未释放时 rm 会 EBUSY
  await rm(dir, { recursive: true, force: true });
});

describe("schema 钉子（22 工具与原 Python 逐字段对账）", () => {
  it("工具全集与顺序精确相等（原 TOOLS = AD_TOOLS + 其余 21 个）", () => {
    expect(MCP_TOOL_SCHEMAS.map((t) => t.name)).toEqual(FIXTURE.map((t) => t.name));
  });

  it("全量 deep-equal：description 全文（审计契约）+ inputSchema 与原 Python ast 抽取逐字节相等（含动态位哨兵）", () => {
    expect(MCP_TOOL_SCHEMAS).toEqual(FIXTURE);
  });

  it("generate_image 的动态位确实来自 vision catalog（enum=modelIds，guide 含 providers 与默认模型）", () => {
    const gi = buildNativeToolSchemas({ imageModelIds: ["m-a", "m-b"], imageModelGuide: "Providers: P. Default m-a" })[21]!;
    expect(gi.name).toBe("vibe_seller_generate_image");
    const model = (gi.inputSchema as { properties: { model: { enum: string[]; description: string } } }).properties.model;
    expect(model.enum).toEqual(["m-a", "m-b"]);
    expect(model.description).toContain("Providers: P. Default m-a.");
    expect(model.description).not.toContain("<<MODEL_GUIDE>>");
  });
});

describe("能力门（原 _visible_tools，无 KIE key 且非 fake → 隐藏 generate_image）", () => {
  const schemas = () => buildNativeToolSchemas({ imageModelIds: modelIds(), imageModelGuide: imageModelGuide(catalogPublic(), DEFAULT_MODEL) });

  it("两态：false → 21+5=26 且无 generate_image；true → 27 全量（browse 段只受第三参管，见下组）", () => {
    const hidden = filterVisibleTools(schemas(), false);
    expect(hidden).toHaveLength(26);
    expect(hidden.map((t) => t.name)).not.toContain("vibe_seller_generate_image");
    expect(filterVisibleTools(schemas(), true)).toHaveLength(27);
  });

  it("隐藏 ≠ 不可调用：dispatch 与可见性无关（原 tools/call 不查 _visible_tools，无 key 时端点自报 400 detail）", async () => {
    const calls: RecordedCall[] = [];
    const port = makePort(calls);
    const r = await exec(port, "vibe_seller_generate_image", { prompt: "p" });
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/tasks/task-1/image/generate" });
    expect(r.status).toBe("success"); // 原实现无 raise_for_status：{detail} 按成功结果透出
  });
});

describe("browse 五工具注册（T4：手写段，来源 route2 PRD，非 ast 抽取、不进 fixture 对账）", () => {
  const schemas = () => buildNativeToolSchemas({ imageModelIds: modelIds(), imageModelGuide: imageModelGuide(catalogPublic(), DEFAULT_MODEL) });

  it("build 后工具面 = fixture 22 + browse 5 = 27，browse 五名按 BROWSE_TOOL_NAMES 序追加在尾部", () => {
    const all = schemas();
    expect(all).toHaveLength(27);
    expect(all.map((t) => t.name)).toEqual([...FIXTURE.map((t) => t.name), ...BROWSE_TOOL_NAMES]);
  });

  it("五 schema 契约钉子：required 面与 description 承载语义（PRD §二：数据只走 read/eval 绝不截图、互动失败绝不盲重试）", () => {
    const byName = new Map(BROWSE_TOOL_SCHEMAS.map((t) => [t.name, t]));
    expect(byName.size).toBe(5);
    const descOf = (name: string): string => byName.get(name)!.description;
    const reqOf = (name: string): unknown => byName.get(name)!.inputSchema["required"];

    expect(reqOf("vibe_seller_browser_navigate")).toEqual(["url"]);
    expect(descOf("vibe_seller_browser_navigate")).toContain("http");
    expect(descOf("vibe_seller_browser_navigate")).toContain('load_state="timeout"');
    expect(descOf("vibe_seller_browser_navigate")).toContain("{tab_id, url, title}");
    expect(descOf("vibe_seller_browser_navigate")).toContain("seller-center");

    expect(reqOf("vibe_seller_browser_tabs")).toEqual(["action"]);
    expect(descOf("vibe_seller_browser_tabs")).toContain("NEVER closes the last");

    expect(reqOf("vibe_seller_browser_read")).toEqual(["mode"]);
    expect(descOf("vibe_seller_browser_read")).toContain("innerText");
    expect(descOf("vibe_seller_browser_read")).toContain("outerHTML");
    expect(descOf("vibe_seller_browser_read")).toContain("screenshots");
    expect(descOf("vibe_seller_browser_read")).toContain("8000");
    expect(descOf("vibe_seller_browser_read")).toContain("20000");

    expect(reqOf("vibe_seller_browser_act")).toEqual(["action"]);
    expect(descOf("vibe_seller_browser_act")).toContain("Enter");
    expect(descOf("vibe_seller_browser_act")).toContain("NEVER");
    expect(descOf("vibe_seller_browser_act")).toContain("re-read");

    expect(reqOf("vibe_seller_browser_eval")).toEqual(["expression"]);
    expect(descOf("vibe_seller_browser_eval")).toContain("20000");
    expect(descOf("vibe_seller_browser_eval")).toContain("vibe_seller_browser_act");

    // session 通用参数：三工具以上共享的 store/web 枚举（navigate/tabs/read/act/eval 全带）
    for (const name of BROWSE_TOOL_NAMES) {
      const props = (byName.get(name)!.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties;
      expect(props["session"]!.enum).toEqual(["store", "web"]);
    }
  });

  it("filterVisibleTools 第三参：false → 隐藏 5 个 browse 名且其余 22 原样；缺省 true（既有调用点零改动）", () => {
    const noBrowser = filterVisibleTools(schemas(), true, false);
    expect(noBrowser).toHaveLength(22);
    expect(noBrowser.map((t) => t.name)).toEqual(FIXTURE.map((t) => t.name));
    expect(filterVisibleTools(schemas(), false, false)).toHaveLength(21);
    expect(filterVisibleTools(schemas(), true)).toHaveLength(27); // 第三参缺省 true
  });

  it("browse dispatch 命中 deps.browse（假 executor 记录调用返回哨兵；零 loopback 流量——routeTool 不接 browse 名）", async () => {
    const calls: RecordedCall[] = [];
    const seen: Array<{ name: string; args: Record<string, unknown> }> = [];
    const port = createNativeToolPort({
      app,
      taskId: "task-1",
      authToken: "t",
      request: recorder(calls),
      browse: {
        execute: async (name, args) => {
          seen.push({ name, args });
          return { sentry: "browse-ok", name };
        },
      },
    });
    const r = await exec(port, "vibe_seller_browser_read", { mode: "text", selector: "#price" });
    expect(seen).toEqual([{ name: "vibe_seller_browser_read", args: { mode: "text", selector: "#price" } }]);
    expect(calls).toHaveLength(0);
    expect(r.status).toBe("success");
    expect(r.result).toEqual({ sentry: "browse-ok", name: "vibe_seller_browser_read" });
  });

  it("无 deps.browse：dispatch → 单键 error 兜底（disabled，非 Unknown tool——browse 名在 routeTool 之前拦截）", async () => {
    const calls: RecordedCall[] = [];
    const r = await exec(makePort(calls), "vibe_seller_browser_navigate", { url: "https://example.com" });
    expect(calls).toHaveLength(0);
    expect(r.status).toBe("error");
    expect(r.error).toEqual({ code: "tool_error", message: "browser tools are disabled or not wired on this server" });
  });

  it("可见性与 dispatch 独立：隐藏后仍可达，走 disabled 兜底（与 generate_image 的'隐藏≠不可调用'同构）", async () => {
    expect(filterVisibleTools(schemas(), true, false).map((t) => t.name)).not.toContain("vibe_seller_browser_eval");
    const r = await exec(makePort([]), "vibe_seller_browser_eval", { expression: "1+1" });
    expect(r.status).toBe("error");
    expect(r.error!.message).toBe("browser tools are disabled or not wired on this server");
  });
});

describe("执行器逐工具：调用 → method/path/body 命中 → 结果形状", () => {
  it("list_stores：GET /api/stores → 店铺数组", async () => {
    const calls: RecordedCall[] = [];
    const r = await exec(makePort(calls), "vibe_seller_list_stores", {});
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/stores" });
    expect(calls[0]!.headers.cookie).toContain("auth_token=");
    expect(r.status).toBe("success");
    expect(r.result).toEqual([]); // 夹具库无店铺
  });

  it("list_tasks：store_id/parent_task_id 真值才进查询串（原 :117-121 falsy 跳过）", async () => {
    const calls: RecordedCall[] = [];
    await exec(makePort(calls), "vibe_seller_list_tasks", { store_id: "s1", parent_task_id: "" });
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/tasks?store_id=s1" });
    const calls2: RecordedCall[] = [];
    const r = await exec(makePort(calls2), "vibe_seller_list_tasks", {});
    expect(calls2[0]).toMatchObject({ method: "GET", path: "/api/tasks" });
    expect(Array.isArray(r.result)).toBe(true);
  });

  it("create_task：POST /api/tasks，未提供的可选键按 JSON 序列化丢弃（Python .get→null 的服务端等价）", async () => {
    const calls: RecordedCall[] = [];
    const r = await exec(makePort(calls), "vibe_seller_create_task", { title: "拉清单" });
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/tasks", body: { title: "拉清单" } });
    expect(r.status).toBe("success");
    expect(r.result).toMatchObject({ title: "拉清单", status: "pending" });
  });

  it("list_cron_jobs：GET /api/cron/jobs → 数组", async () => {
    const calls: RecordedCall[] = [];
    const r = await exec(makePort(calls), "vibe_seller_list_cron_jobs", {});
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/cron/jobs" });
    expect(Array.isArray(r.result)).toBe(true);
  });

  it("add_cron_job：POST /api/cron/jobs → 回显形状", async () => {
    const calls: RecordedCall[] = [];
    const r = await exec(makePort(calls), "vibe_seller_add_cron_job", { job_id: "j1", task_title: "日报", cron_expression: "0 3 * * *" });
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/api/cron/jobs",
      body: { job_id: "j1", task_title: "日报", cron_expression: "0 3 * * *" },
    });
    expect(r.result).toMatchObject({ job_id: "j1", cron: "0 3 * * *", task_title: "日报" });
  });

  it("email_info：GET /api/email-accounts/info-by-store/{store_id} → 信息形状", async () => {
    const calls: RecordedCall[] = [];
    const r = await exec(makePort(calls), "vibe_seller_email_info", { store_id: "s9" });
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/email-accounts/info-by-store/s9" });
    expect(r.result).toMatchObject({ store_id: "s9", accounts: [] });
    expect(Object.keys(r.result as object)).toContain("schema");
  });

  it("get_new_emails：GET /api/tasks/{taskId}/new-emails?lookback_hours=N（int 截断）", async () => {
    const calls: RecordedCall[] = [];
    const r = await exec(makePort(calls, "task-sched"), "vibe_seller_get_new_emails", { lookback_hours: 5 });
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/tasks/task-sched/new-emails?lookback_hours=5" });
    expect(r.result).toMatchObject({ key: "email_watermark", first_run: true, count: 0 });
  });

  it("get_new_emails：不带 lookback → 无查询串", async () => {
    const calls: RecordedCall[] = [];
    await exec(makePort(calls, "task-sched"), "vibe_seller_get_new_emails", {});
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/tasks/task-sched/new-emails" });
  });

  it("sync_email_now：POST /api/email-accounts/sync-now；未知名账户 → 404 detail 按成功形状透出（原无 raise_for_status）", async () => {
    const calls: RecordedCall[] = [];
    const r = await exec(makePort(calls), "vibe_seller_sync_email_now", { account_email: "ghost@x.com" });
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/email-accounts/sync-now", body: { account_email: "ghost@x.com" } });
    expect(r.status).toBe("success");
    expect(r.result).toEqual({ detail: "No account found for ghost@x.com" });
  });

  it("write_workspace_file：PUT /api/workspace/file?path=…（原样拼装，不额外编码）→ {path,status:'ok'}", async () => {
    const calls: RecordedCall[] = [];
    const r = await exec(makePort(calls), "vibe_seller_write_workspace_file", { path: "stores/s9/notes.md", content: "hello" });
    expect(calls[0]).toMatchObject({ method: "PUT", path: "/api/workspace/file?path=stores/s9/notes.md", body: { content: "hello" } });
    expect(r.result).toEqual({ path: "stores/s9/notes.md", status: "ok" });
  });

  it("set_task_error：POST /api/tasks/{taskId}/error → {ok,task_id,status}（只记录不转状态）", async () => {
    const calls: RecordedCall[] = [];
    const r = await exec(makePort(calls), "vibe_seller_set_task_error", { error: "浏览器起不来" });
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/tasks/task-1/error", body: { error: "浏览器起不来" } });
    expect(r.result).toMatchObject({ ok: true, task_id: "task-1", status: "running" });
  });

  it("declare_ad_task：POST /api/tasks/{taskId}/ad-declaration，scope falsy → {}", async () => {
    const calls: RecordedCall[] = [];
    const r = await exec(makePort(calls), "vibe_seller_declare_ad_task", { kind: "investigate" });
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/tasks/task-1/ad-declaration", body: { kind: "investigate", scope: {} } });
    expect(r.result).toMatchObject({ seq: 1, kind: "investigate", scope: {} });
  });

  it("get_schedule_state：key 按 quote(safe='') 编码；未命中回 other_known_keys", async () => {
    const calls: RecordedCall[] = [];
    const r = await exec(makePort(calls, "task-sched"), "vibe_seller_get_schedule_state", { key: "email_watermark" });
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/tasks/task-sched/schedule-state/email_watermark" });
    expect(r.result).toMatchObject({ key: "email_watermark", value: null, other_known_keys: [] });
  });

  it("get_schedule_state：特殊字符 key 编码与 Python quote(safe='') 一致（!*'() 也编码）", async () => {
    const calls: RecordedCall[] = [];
    await exec(makePort(calls, "task-sched"), "vibe_seller_get_schedule_state", { key: "a b!c*d" });
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/tasks/task-sched/schedule-state/a%20b%21c%2Ad" });
  });

  it("set_schedule_state：PUT + {value}；email_watermark 走 epoch 校验成功形状", async () => {
    const calls: RecordedCall[] = [];
    const nowEpoch = String(Math.floor(Date.now() / 1000));
    const r = await exec(makePort(calls, "task-sched"), "vibe_seller_set_schedule_state", { key: "email_watermark", value: nowEpoch });
    expect(calls[0]).toMatchObject({ method: "PUT", path: "/api/tasks/task-sched/schedule-state/email_watermark", body: { value: nowEpoch } });
    expect(r.result).toMatchObject({ ok: true, key: "email_watermark", value: nowEpoch });
  });

  it("register_finalize：POST /api/tasks/{taskId}/register-finalize → {ok,finalize_description}", async () => {
    const calls: RecordedCall[] = [];
    const r = await exec(makePort(calls, "task-sched"), "vibe_seller_register_finalize", { description: "合并全部店铺为一封 WeCom" });
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/api/tasks/task-sched/register-finalize",
      body: { description: "合并全部店铺为一封 WeCom" },
    });
    expect(r.result).toEqual({ ok: true, finalize_description: "合并全部店铺为一封 WeCom" });
  });

  it("list_wecom_bots：GET 后剥离为 {id,name}——webhook secret 永不进代理结果（原 :240-244）", async () => {
    const calls: RecordedCall[] = [];
    const r = await exec(makePort(calls), "vibe_seller_list_wecom_bots", {});
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/wecom-bots" });
    expect(r.status).toBe("success");
    expect(r.result).toEqual([{ id: "bot-1", name: "运维群" }]);
    expect(JSON.stringify(r.result)).not.toContain("SECRET");
  });

  it("set_task_result：POST /api/tasks/{taskId}/result，incomplete falsy → []", async () => {
    const calls: RecordedCall[] = [];
    const r = await exec(makePort(calls), "vibe_seller_set_task_result", { result: "完成", incomplete: ["截图缺"] });
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/tasks/task-1/result", body: { result: "完成", incomplete: ["截图缺"] } });
    expect(r.result).toMatchObject({ ok: true, task_id: "task-1", status: "running", resolved_from_file: false });
  });

  it("set_task_result：无 incomplete → 请求体为 []（原 or [] 分支）", async () => {
    const calls: RecordedCall[] = [];
    await exec(makePort(calls), "vibe_seller_set_task_result", { result: "完成" });
    expect(calls[0]).toMatchObject({ body: { result: "完成", incomplete: [] } });
  });

  it("list_skills：GET /api/workspace/skills → 数组", async () => {
    const calls: RecordedCall[] = [];
    const r = await exec(makePort(calls), "vibe_seller_list_skills", {});
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/workspace/skills" });
    expect(Array.isArray(r.result)).toBe(true);
  });

  it("save_skill：PUT /api/workspace/skills/{slug}（quote 编码），files 真值才带（原 :296-297）", async () => {
    const calls: RecordedCall[] = [];
    const r = await exec(makePort(calls), "vibe_seller_save_skill", {
      slug: "revenue-report",
      skill_md: "---\nname: rev\n---\nbody",
      files: { "refs/a.md": "A" },
    });
    expect(calls[0]).toMatchObject({
      method: "PUT",
      path: "/api/workspace/skills/revenue-report",
      body: { skill_md: "---\nname: rev\n---\nbody", files: { "refs/a.md": "A" } },
    });
    expect(r.result).toMatchObject({ slug: "revenue-report", action: expect.any(String) });

    const calls2: RecordedCall[] = [];
    await exec(makePort(calls2), "vibe_seller_save_skill", { slug: "no-files", skill_md: "x" });
    expect(calls2[0]!.body).toEqual({ skill_md: "x" });
  });

  it("save_skill：slug 特殊字符按 quote(safe='') 编码进路径", async () => {
    const calls: RecordedCall[] = [];
    await exec(makePort(calls), "vibe_seller_save_skill", { slug: "a b/c", skill_md: "x" });
    expect(calls[0]).toMatchObject({ method: "PUT", path: "/api/workspace/skills/a%20b%2Fc" });
  });
});

describe("send_email 两段式（原 :163-186：MCP 层先按邮箱查账户 ID 再发信）", () => {
  it("账户不存在 → 不触网络，单键 error 包装 'No account found for …'", async () => {
    const calls: RecordedCall[] = [];
    const r = await exec(makePort(calls), "vibe_seller_send_email", { account_email: "nope@x.com", to: "b@y.com", subject: "S", body: "B" });
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/email-accounts" });
    expect(calls).toHaveLength(1);
    expect(r.status).toBe("error");
    expect(r.error).toEqual({ code: "tool_error", message: "No account found for nope@x.com" });
  });

  it("注入假上游：命中账户 → 两跳拼装，body 不含 account_email；body_html 仅真值带上；成功结果透传", async () => {
    const sent: RecordedCall[] = [];
    const port = createNativeToolPort({
      app,
      taskId: "task-1",
      authToken: "t",
      request: async (path, init) => {
        sent.push({ method: String(init.method), path, body: init.body ? JSON.parse(String(init.body)) : undefined, headers: {} });
        if (path === "/api/email-accounts") {
          return new Response(JSON.stringify([{ id: "acc-9", email: "fake@x.com" }, { id: "acc-0", email: "other@x.com" }]), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true, message_id: "<m1@x>" }), { status: 200 });
      },
    });
    const r = await exec(port, "vibe_seller_send_email", { account_email: "fake@x.com", to: "b@y.com", subject: "S", body: "B" });
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ method: "GET", path: "/api/email-accounts" });
    expect(sent[1]).toMatchObject({ method: "POST", path: "/api/email-accounts/acc-9/send", body: { to: "b@y.com", subject: "S", body: "B" } });
    expect(sent[1]!.body).not.toHaveProperty("account_email");
    expect(sent[1]!.body).not.toHaveProperty("body_html");
    expect(r.status).toBe("success");
    expect(r.result).toEqual({ ok: true, message_id: "<m1@x>" });
  });

  it("注入假上游：body_html 真值 → 第四键带上", async () => {
    const sent: RecordedCall[] = [];
    const port = createNativeToolPort({
      app,
      taskId: "task-1",
      authToken: "t",
      request: async (path, init) => {
        sent.push({ method: String(init.method), path, body: init.body ? JSON.parse(String(init.body)) : undefined, headers: {} });
        if (path === "/api/email-accounts") return new Response(JSON.stringify([{ id: "acc-9", email: "fake@x.com" }]), { status: 200 });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    await exec(port, "vibe_seller_send_email", { account_email: "fake@x.com", to: "b@y.com", subject: "S", body: "B", body_html: "<p>B</p>" });
    expect(sent[1]!.body).toEqual({ to: "b@y.com", subject: "S", body: "B", body_html: "<p>B</p>" });
  });
});

describe("wecom 发送类（注入假上游，方法/路径/body 命中）", () => {
  const fakePort = (sent: RecordedCall[]) =>
    createNativeToolPort({
      app,
      taskId: "task-1",
      authToken: "t",
      request: async (path, init) => {
        sent.push({ method: String(init.method), path, body: init.body ? JSON.parse(String(init.body)) : undefined, headers: {} });
        return new Response(JSON.stringify({ ok: true, message: "Message sent" }), { status: 200 });
      },
    });

  it("send_wecom_message：POST /api/wecom-bots/{bot_id}/send，msgtype 缺省 text", async () => {
    const sent: RecordedCall[] = [];
    const r = await exec(fakePort(sent), "vibe_seller_send_wecom_message", { bot_id: "b1", content: "hello" });
    expect(sent[0]).toMatchObject({ method: "POST", path: "/api/wecom-bots/b1/send", body: { content: "hello", msgtype: "text" } });
    expect(r.status).toBe("success");
    expect(r.result).toEqual({ ok: true, message: "Message sent" });
  });

  it("send_wecom_message：markdown 透传", async () => {
    const sent: RecordedCall[] = [];
    await exec(fakePort(sent), "vibe_seller_send_wecom_message", { bot_id: "b1", content: "# hi", msgtype: "markdown" });
    expect(sent[0]!.body).toEqual({ content: "# hi", msgtype: "markdown" });
  });

  it("send_wecom_file：POST /api/wecom-bots/{bot_id}/send-file body {path}", async () => {
    const sent: RecordedCall[] = [];
    await exec(fakePort(sent), "vibe_seller_send_wecom_file", { bot_id: "b1", path: "/tmp/report.pdf" });
    expect(sent[0]).toMatchObject({ method: "POST", path: "/api/wecom-bots/b1/send-file", body: { path: "/tmp/report.pdf" } });
  });
});

describe("generate_image：无超时阻塞 + VISION_FAKE 短路全链", () => {
  it("阻塞等确认：execute 挂起 → confirm 端点批复 → 假 PNG 结果返回（进程内自调天然无 HTTP 超时层）", async () => {
    const calls: RecordedCall[] = [];
    const port = makePort(calls, "gt1");
    const authHeaders = { cookie: `auth_token=${mintServiceToken(deps.db, "test-secret")}` };
    process.env["VISION_FAKE"] = "1";
    try {
      const pending = exec(port, "vibe_seller_generate_image", { prompt: "产品图", kind: "main" });
      // 等请求到达且确认卡挂起（recorder 在 handler 进入 createConfirm 前就已记录）；
      // 截止 10s——全量套件并行时 collect 阶段机器负载高，固定短轮询会假阴性
      let card: { pending: boolean; request_id?: string } = { pending: false };
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
        card = (await (await app.request("/api/tasks/gt1/image/pending", { headers: authHeaders })).json()) as { pending: boolean; request_id?: string };
        if (card.pending) break;
      }
      expect(calls[0]).toMatchObject({
        method: "POST",
        path: "/api/tasks/gt1/image/generate",
        body: { prompt: "产品图", reference_images: [], kind: "main" },
      });
      expect(card.pending).toBe(true);
      const conf = await app.request("/api/tasks/gt1/image/confirm", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify({ request_id: card.request_id, action: "confirm" }),
      });
      expect(conf.status).toBe(200);
      const r = await pending;
      expect(r.status).toBe("success");
      expect(r.result).toMatchObject({ status: "ok", prompt: "产品图" });
      expect(String((r.result as { path: string }).path)).toContain("generated_images/");
    } finally {
      delete process.env["VISION_FAKE"];
    }
  });
});

describe("错误包装与参数语义（原 handle_tool_call except 分支 / KeyError 派发）", () => {
  it("未知工具 → 单键 error 'Unknown tool: …'（原 :304）", async () => {
    const r = await exec(makePort([]), "vibe_seller_nope", {});
    expect(r.status).toBe("error");
    expect(r.error).toEqual({ code: "tool_error", message: "Unknown tool: vibe_seller_nope" });
  });

  it("缺必派发参数 → KeyError 语义：错误消息为带引号的键名（str(KeyError('account_email'))）", async () => {
    const r = await exec(makePort([]), "vibe_seller_send_email", { to: "b@y.com" });
    expect(r.status).toBe("error");
    expect(r.error!.message).toBe("'account_email'");
  });

  it("响应体非 JSON → 异常包装进单键 error（原 resp.json() 抛错路径）", async () => {
    const port = createNativeToolPort({
      app,
      taskId: "t",
      authToken: "t",
      request: async () => new Response("<html>nope</html>", { status: 200, headers: { "content-type": "text/html" } }),
    });
    const r = await exec(port, "vibe_seller_list_stores", {});
    expect(r.status).toBe("error");
    expect(r.error!.code).toBe("tool_error");
  });

  it("单键 {error} 的正常响应 → 判别为 error 状态（原 mcp_server.py:307-308 错误包同一判别式）", async () => {
    const port = createNativeToolPort({
      app,
      taskId: "t",
      authToken: "t",
      request: async () => new Response(JSON.stringify({ error: "boom" }), { status: 200 }),
    });
    const r = await exec(port, "vibe_seller_list_stores", {});
    expect(r.status).toBe("error");
    expect(r.error).toEqual({ code: "tool_error", message: "boom" });
  });

  it("非单键对象（含 detail）→ 成功透传；数组结果原样", async () => {
    const port = createNativeToolPort({
      app,
      taskId: "t",
      authToken: "t",
      request: async () => new Response(JSON.stringify({ error: "boom", extra: 1 }), { status: 200 }),
    });
    expect((await exec(port, "vibe_seller_list_stores", {})).status).toBe("success");
    const port2 = createNativeToolPort({
      app,
      taskId: "t",
      authToken: "t",
      request: async () => new Response(JSON.stringify([{ id: 1 }]), { status: 200 }),
    });
    expect((await exec(port2, "vibe_seller_list_stores", {})).result).toEqual([{ id: 1 }]);
  });
});

describe("孤立代理对清洗（原 sanitize_json：出站 body 递归清洗，先清洗后序列化）", () => {
  it("字符串里的 lone surrogate → U+FFFD；dict/list 递归", async () => {
    const calls: RecordedCall[] = [];
    await exec(makePort(calls), "vibe_seller_write_workspace_file", {
      path: "notes.md",
      content: { nested: ["a\uD800b", { deep: "\uDCAD尾" }] } as unknown as string,
    });
    expect(calls[0]!.body).toEqual({ content: { nested: ["a\uFFFDb", { deep: "\uFFFD尾" }] } });
    expect(JSON.stringify(calls[0]!.body)).not.toMatch(/[\uD800-\uDFFF]/);
  });

  it("无代理对的 body 原样（原 sanitize_text 同对象直返）", async () => {
    const calls: RecordedCall[] = [];
    await exec(makePort(calls), "vibe_seller_write_workspace_file", { path: "n.md", content: "正常文本✅" });
    expect(calls[0]!.body).toEqual({ content: "正常文本✅" });
  });
});
