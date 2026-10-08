// 批次 4.6 契约测试：vision(7) + screenshots(1) + attachments(3)。
// 确认闸门（image_request SSE → 阻塞 → confirm/cancel/superseded）、SSRF 红线、
// 上传类型/大小契约。

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { EventBus } from "../src/bus";
import { HttpError } from "../src/types";
import { createSessionToken } from "../src/jwt";
import { openDb, seed } from "../src/db";
import { hashPassword } from "../src/app";
import type { ServerConfig } from "../src/config";
import { registerVisionRoutes, isPublicHost, saveUpload, type VisionDeps } from "../src/routes_vision";
import { registerAttachmentRoutes, type AttachmentDeps } from "../src/routes_attachments";

let dir: string;
let db: import("node:sqlite").DatabaseSync;
let config: ServerConfig;
let cookie: string;
let bus: EventBus;
let visionApp: Hono;
let attApp: Hono;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibe-vis-"));
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
  savedEnv["VISION_FAKE"] = process.env["VISION_FAKE"];
  savedEnv["KIE_API_KEY"] = process.env["KIE_API_KEY"];
  delete process.env["KIE_API_KEY"];

  visionApp = new Hono();
  visionApp.onError((err, c) => (err instanceof HttpError ? c.json({ detail: err.message }, err.status as 400) : c.json({ detail: "?" }, 500)));
  registerVisionRoutes(visionApp, { config, db, auth: { db, jwtSecret: "test-secret" }, bus } as VisionDeps);
  attApp = new Hono();
  attApp.onError((err, c) => (err instanceof HttpError ? c.json({ detail: err.message }, err.status as 400) : c.json({ detail: "?" }, 500)));
  registerAttachmentRoutes(attApp, { config, db, auth: { db, jwtSecret: "test-secret" } } as AttachmentDeps);
});
afterEach(async () => {
  if (savedEnv["VISION_FAKE"] === undefined) delete process.env["VISION_FAKE"];
  else process.env["VISION_FAKE"] = savedEnv["VISION_FAKE"]!;
  if (savedEnv["KIE_API_KEY"] !== undefined) process.env["KIE_API_KEY"] = savedEnv["KIE_API_KEY"]!;
  db.close();
  await rm(dir, { recursive: true, force: true });
});

const jsonHeaders = () => ({ cookie, "content-type": "application/json" });

async function makeTask(id: string): Promise<void> {
  db.prepare(
    `INSERT INTO tasks (id, created_by, title, status, priority, created_at, updated_at) VALUES (?, 'u', ?, 'pending', 0, ?, ?)`,
  ).run(id, `T-${id}`, new Date().toISOString(), new Date().toISOString());
}

describe("vision config", () => {
  it("GET：无 key → set:false + 空掩码 + 目录 + fake 标志", async () => {
    process.env["VISION_FAKE"] = "true";
    const cfg = (await (await visionApp.request("/api/vision/config", { headers: { cookie } })).json()) as Record<string, unknown>;
    expect(cfg["kie_api_key_set"]).toBe(false);
    expect(cfg["kie_api_key_masked"]).toBe("");
    expect(cfg["fake"]).toBe(true);
    expect(Array.isArray(cfg["models"]) && (cfg["models"] as unknown[]).length).toBeGreaterThan(10);
    expect(((cfg["models"] as { id: string; default: boolean }[]).find((m) => m.default))!.id).toBe((cfg["default_model"] as string));
  });

  it("PUT：admin 门（ai_bot 语义角色拒绝在 app 层测）+ 保存后掩码只露尾 4", async () => {
    process.env["VISION_FAKE"] = "true";
    const put = await visionApp.request("/api/vision/config", { method: "PUT", headers: jsonHeaders(), body: JSON.stringify({ kie_api_key: "sk-abcdef123456" }) });
    const body = (await put.json()) as Record<string, unknown>;
    expect(body["kie_api_key_set"]).toBe(true);
    expect(body["kie_api_key_masked"]).toBe("••••3456");
    // 永不回全量
    expect(JSON.stringify(body)).not.toContain("sk-abcdef123456");
    const stored = JSON.parse(await readFile(join(dir, "vision.json"), "utf8")) as Record<string, string>;
    expect(stored["kie_api_key"]).toBe("sk-abcdef123456");
  });
});

describe("vision generate 确认闸门（VISION_FAKE）", () => {
  it("无 key 且非 fake → 400 立即（agent 工具当场报错）", async () => {
    delete process.env["VISION_FAKE"];
    const res = await visionApp.request("/api/tasks/t1/image/generate", { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ prompt: "x" }) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { detail: string }).detail).toContain("kie.ai API key not configured");
  });

  it("无 prompt → 400；非法 task id → 400", async () => {
    process.env["VISION_FAKE"] = "true";
    expect((await visionApp.request("/api/tasks/t1/image/generate", { method: "POST", headers: jsonHeaders(), body: JSON.stringify({}) })).status).toBe(400);
    expect((await visionApp.request("/api/tasks/..%2Fescape/image/generate", { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ prompt: "x" }) })).status).toBe(400);
  });

  it("全链：image_request SSE → confirm（改写 prompt）→ 假 PNG 落盘 + generated_image 消息 + image_generated SSE", async () => {
    process.env["VISION_FAKE"] = "true";
    await makeTask("tk1");
    const generatePromise = visionApp.request("/api/tasks/tk1/image/generate", {
      method: "POST", headers: jsonHeaders(),
      body: JSON.stringify({ prompt: "main image", output_name: "hero.png", kind: "main" }),
    });
    // 等 SSE 事件出现后 confirm（带编辑）
    for (let i = 0; i < 100 && !bus.history.some((h) => h.type === "image_request"); i++) await new Promise((r) => setTimeout(r, 20));
    const req = bus.history.find((h) => h.type === "image_request")!;
    expect(req.data.task_id).toBe("tk1");
    expect(req.data.output_name).toBe("hero.png");

    // pending 端点在 confirm 前可恢复卡片
    const pending = (await (await visionApp.request("/api/tasks/tk1/image/pending", { headers: { cookie } })).json()) as Record<string, unknown>;
    expect(pending["pending"]).toBe(true);
    expect(pending["request_id"]).toBe(req.data.request_id);

    const conf = await visionApp.request("/api/tasks/tk1/image/confirm", {
      method: "POST", headers: jsonHeaders(),
      body: JSON.stringify({ request_id: req.data.request_id, action: "confirm", prompt: "edited prompt" }),
    });
    expect(await conf.json()).toEqual({ ok: true });

    const genRes = (await (await generatePromise).json()) as Record<string, unknown>;
    expect(genRes["status"]).toBe("ok");
    expect(genRes["prompt"]).toBe("edited prompt"); // 用户改写优先
    expect(genRes["path"]).toBe("generated_images/hero.png");
    const pngPath = join(dir, "tasks", "tk1", "generated_images", "hero.png");
    expect(existsSync(pngPath)).toBe(true);

    expect(bus.history.some((h) => h.type === "image_generating")).toBe(true);
    expect(bus.history.some((h) => h.type === "image_generated" && h.data.path === "generated_images/hero.png")).toBe(true);
    const msg = db.prepare("SELECT role, content FROM task_messages WHERE task_id = 'tk1' ORDER BY seq DESC LIMIT 1").get() as { role: string; content: string };
    expect(msg.role).toBe("generated_image");
    expect(JSON.parse(msg.content)["url"]).toBe("/api/tasks/tk1/files/generated_images/hero.png");
    // confirm 后 pending 清空
    const after = (await (await visionApp.request("/api/tasks/tk1/image/pending", { headers: { cookie } })).json()) as { pending: boolean };
    expect(after.pending).toBe(false);
  });

  it("cancel → status cancelled；supersede → 旧请求返回 superseded + image_request_expired", async () => {
    process.env["VISION_FAKE"] = "true";
    await makeTask("tk2");
    const g1 = visionApp.request("/api/tasks/tk2/image/generate", { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ prompt: "p1", output_name: "a.png" }) });
    for (let i = 0; i < 100 && !bus.history.some((h) => h.type === "image_request"); i++) await new Promise((r) => setTimeout(r, 20));
    const r1 = bus.history.filter((h) => h.type === "image_request").at(-1)!;

    // 第二个请求顶掉第一个
    const g2 = visionApp.request("/api/tasks/tk2/image/generate", { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ prompt: "p2", output_name: "b.png" }) });
    for (let i = 0; i < 100 && bus.history.filter((h) => h.type === "image_request").length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    expect(bus.history.some((h) => h.type === "image_request_expired" && h.data.request_id === r1.data.request_id)).toBe(true);

    const r1Body = (await (await g1).json()) as { status: string; message: string };
    expect(r1Body.status).toBe("superseded");
    expect(r1Body.message).toContain("Do NOT retry");

    // 取消第二个
    const r2 = bus.history.filter((h) => h.type === "image_request").at(-1)!;
    await visionApp.request("/api/tasks/tk2/image/confirm", { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ request_id: r2.data.request_id, action: "cancel" }) });
    const g2Body = (await (await g2).json()) as { status: string };
    expect(g2Body.status).toBe("cancelled");
  });

  it("confirm 未知 request_id → 404；缺参数 → 400", async () => {
    process.env["VISION_FAKE"] = "true";
    expect((await visionApp.request("/api/tasks/t/image/confirm", { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ request_id: "nope", action: "confirm" }) })).status).toBe(404);
    expect((await visionApp.request("/api/tasks/t/image/confirm", { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ request_id: "x" }) })).status).toBe(400);
  });
});

describe("ref-proxy SSRF 防护", () => {
  const publicLookup = (async () => [{ address: "93.184.216.34", family: 4 }]) as never;

  function makeProxyApp(fetchImpl?: VisionDeps["fetchImpl"]): Hono {
    const app = new Hono();
    app.onError((err, c) => (err instanceof HttpError ? c.json({ detail: err.message }, err.status as 400) : c.json({ detail: "?" }, 500)));
    registerVisionRoutes(app, { config, db, auth: { db, jwtSecret: "test-secret" }, bus, fetchImpl } as VisionDeps, publicLookup);
    return app;
  }

  it("isPublicHost 分类（单测）", async () => {
    for (const bad of ["127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "248.0.0.1", "::1", "fe80::1", "fd00::1", "ff02::1"]) {
      expect(await isPublicHost(bad), bad).toBe(false);
    }
    expect(await isPublicHost("93.184.216.34")).toBe(true);
    expect(await isPublicHost("2606:2800:220:1:248:1893:25c8:1946")).toBe(true);
  });

  it("坏 URL / 非法 scheme / 内网主机 → 400", async () => {
    const app = makeProxyApp();
    expect((await app.request("/api/vision/ref-proxy?url=notaurl", { headers: { cookie } })).status).toBe(400);
    expect((await app.request("/api/vision/ref-proxy?url=file%3A%2F%2F%2Fetc%2Fpasswd", { headers: { cookie } })).status).toBe(400);
    expect((await app.request("/api/vision/ref-proxy?url=http%3A%2F%2F127.0.0.1%2Fx.png", { headers: { cookie } })).status).toBe(400);
    expect((await app.request("/api/vision/ref-proxy?url=http%3A%2F%2F10.0.0.1%2Fx.png", { headers: { cookie } })).status).toBe(400);
  });

  it("成功路径：注入 fetch 返回 image/* → 透传 + Cache-Control；重定向到内网 → 400；非 image → 502", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    const app = makeProxyApp((async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("redirect")) return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/x" } });
      if (u.includes("html")) return new Response("<html>", { status: 200, headers: { "content-type": "text/html" } });
      return new Response(new Uint8Array(png), { status: 200, headers: { "content-type": "image/png" } });
    }) as VisionDeps["fetchImpl"]);
    const ok = await app.request("/api/vision/ref-proxy?url=https%3A%2F%2Fcdn.example.com%2Fa.png", { headers: { cookie } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(ok.headers.get("cache-control")).toBe("private, max-age=300");
    expect(Buffer.from(await ok.arrayBuffer()).equals(png)).toBe(true);

    expect((await app.request("/api/vision/ref-proxy?url=https%3A%2F%2Fcdn.example.com%2Fredirect", { headers: { cookie } })).status).toBe(400);
    expect((await app.request("/api/vision/ref-proxy?url=https%3A%2F%2Fcdn.example.com%2Fhtml", { headers: { cookie } })).status).toBe(502);
  });
});

describe("upload-reference + attachments + screenshots", () => {
  beforeEach(async () => {
    process.env["VISION_FAKE"] = "true";
    await makeTask("att1");
  });

  const pngForm = (): FormData => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(Buffer.from("89504e470d0a1a0a", "hex"))], { type: "image/png" }), "ref.png");
    return form;
  };

  it("upload-reference：写进 tasks/<id>/generated_images/refs + path/url", async () => {
    const res = await visionApp.request("/api/tasks/att1/image/upload-reference", { method: "POST", headers: { cookie }, body: pngForm() });
    const body = (await res.json()) as { path: string; url: string };
    expect(body.path).toContain("generated_images/refs/");
    expect(body.url).toContain("/api/tasks/att1/files/");
    expect(existsSync(join(dir, "tasks", "att1", "generated_images", "refs", "ref.png"))).toBe(true);
    // 同名冲突 → 加后缀不覆盖
    await visionApp.request("/api/tasks/att1/image/upload-reference", { method: "POST", headers: { cookie }, body: pngForm() });
    const refs = (await readFile(join(dir, "tasks", "att1", "generated_images", "refs", "ref.png"))).length;
    expect(refs).toBe(8); // 原文件未被覆盖（第二个文件带随机后缀）
  });

  it("attachments：上传（类型契约）→ 列表 → 下载 → 缺任务 404", async () => {
    const res = await attApp.request("/api/attachments/att1", { method: "POST", headers: { cookie }, body: pngForm() });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("id");
    expect(body["file_type"]).toBe("image/png");
    expect(body["file_size"]).toBe(8);
    expect(body).not.toHaveProperty("file_path"); // 响应契约不回服务器路径
    expect(existsSync(join(dir, "tasks", "att1", "uploads"))).toBe(true); // 落任务工作区

    const list = (await (await attApp.request("/api/attachments/att1", { headers: { cookie } })).json()) as unknown[];
    expect(list).toHaveLength(1);

    const dl = await attApp.request(`/api/attachments/file/${body["id"]}`, { headers: { cookie } });
    expect(dl.headers.get("content-type")).toBe("image/png");
    expect((await dl.arrayBuffer()).byteLength).toBe(8);
    expect((await attApp.request("/api/attachments/file/ghost", { headers: { cookie } })).status).toBe(404);

    // 类型契约：text/plain → 400
    const bad = new FormData();
    bad.append("file", new Blob(["x"], { type: "text/plain" }), "a.txt");
    expect((await attApp.request("/api/attachments/att1", { method: "POST", headers: { cookie }, body: bad })).status).toBe(400);
    // 任务不存在 → 404
    expect((await attApp.request("/api/attachments/ghost", { method: "POST", headers: { cookie }, body: pngForm() })).status).toBe(404);
  });

  it("saveUpload：空文件 400", async () => {
    const dest = join(dir, "zero.png");
    await expect(saveUpload(Buffer.alloc(0), dest)).rejects.toMatchObject({ status: 400 });
  });

  it("screenshots：按 id 文件流（image/png）；表/文件缺失 404", async () => {
    const shotDir = join(dir, "data", "screenshots");
    await mkdir(shotDir, { recursive: true });
    await writeFile(join(shotDir, "s1.png"), Buffer.from("pngdata"));
    db.prepare("INSERT INTO screenshots (id, task_id, file_path, created_at) VALUES ('s1', 'att1', ?, ?)").run(join(shotDir, "s1.png"), new Date().toISOString());
    const res = await attApp.request("/api/screenshots/s1", { headers: { cookie } });
    expect(res.headers.get("content-type")).toBe("image/png");
    expect((await res.arrayBuffer()).byteLength).toBe(7);
    expect((await attApp.request("/api/screenshots/ghost", { headers: { cookie } })).status).toBe(404);
    db.prepare("INSERT INTO screenshots (id, task_id, file_path, created_at) VALUES ('s2', 'att1', 'Z:/nope.png', ?)").run(new Date().toISOString());
    expect((await attApp.request("/api/screenshots/s2", { headers: { cookie } })).status).toBe(404);
  });
});
