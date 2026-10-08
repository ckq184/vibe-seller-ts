// 批次 4.6 路由：vision(7)。契约对齐 app/routers/vision.py + app/vision.py：
// generate = MCP 工具入口 + 确认闸门（无 key 立即 400；有 key 发 image_request
// SSE 后阻塞等 confirm/cancel/superseded/interrupted）；ref-proxy 是 SSRF 红线
//（拒绝内网/环回/链路本地/保留/组播地址，重定向逐跳复检）。

import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { readFile, stat, writeFile, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { randomUUID } from "node:crypto";
import { HttpError } from "./types";
import { getCurrentUser, type AuthContext } from "./auth";
import type { ServerConfig } from "./config";
import { GenerationTimeout, VisionConfig, catalogPublic, createConfirm, discardConfirm, generateImage, getPendingRequest, getModel, isFake, maskKey, modelIds, resolveConfirm, supersedePending, type FetchImpl } from "./vision/vision";

export interface VisionDeps {
  config: ServerConfig;
  db: DatabaseSync;
  auth: AuthContext;
  bus: { emit: (type: string, data: Record<string, unknown>) => void };
  /** 测试注入 kie.ai / ref-proxy 的传输层。 */
  fetchImpl?: FetchImpl;
  /** 测试覆盖轮询间隔。 */
  pollEveryMs?: number;
}

const GEN_SUBDIR = "generated_images";
const REF_SUBDIR = "generated_images/refs";
// 预览代理在内存里整体缓冲的上限（与上传上限刻意分开，刻意小）。
const MAX_PROXIED_IMAGE = 15 * 1024 * 1024;

// task_id → (kie.ai taskId, model)。轮询预算耗尽但任务还在跑：kie.ai 不取消照样
// 计费，句柄留在内存里，agent 的重试按同 model 续收（重启至多丢一个在途任务）。
const inflight = new Map<string, { kieTaskId: string; model: string }>();

function takeInflight(taskId: string, model: string): string | null {
  const entry = inflight.get(taskId);
  if (!entry || entry.model !== model) return null;
  inflight.delete(taskId);
  return entry.kieTaskId;
}

function safeName(name: string): string {
  let base = (name || "").split(/[\\/]/).pop() || "image.png";
  base = base.replace(/[^A-Za-z0-9._-]/g, "_");
  if (!base.toLowerCase().endsWith(".png")) base += ".png";
  return base;
}

/** sanitize_json 等价：把字符串里的孤代理换成 U+FFFD（出站 UTF-8 编码安全）。 */
function sanitizeJson(value: unknown): unknown {
  if (typeof value === "string") {
    // eslint-disable-next-line no-control-regex
    return /[\uD800-\uDFFF]/.test(value) ? value.replace(/[\uD800-\uDFFF]/g, "\uFFFD") : value;
  }
  if (Array.isArray(value)) return value.map(sanitizeJson);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = sanitizeJson(v);
    return out;
  }
  return value;
}

/** _is_public_host 移植：解析所有地址，任一命中内网/环回/链路本地/保留/组播即拒。 */
export type LookupFn = (host: string) => Promise<{ address: string; family: number }[]>;

/** lookupFn 可注入（测试离线钉死解析结果）；缺省真实 DNS。 */
export async function isPublicHost(host: string, lookupFn: LookupFn = (h) => lookup(h, { all: true })): Promise<boolean> {
  let addresses: string[];
  const literalV = isIP(host);
  if (literalV === 4 || literalV === 6) {
    addresses = [host];
  } else {
    try {
      addresses = (await lookupFn(host)).map((r) => r.address);
    } catch {
      return false;
    }
  }
  for (const addr of addresses) {
    const v = isIP(addr);
    if (v === 4) {
      const [a, b] = addr.split(".").map(Number) as [number, number];
      if (a === 10 || a === 127 || a === 0) return false; // 私有/环回/未指定
      if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT（is_private）
      if (a === 169 && b === 254) return false; // 链路本地
      if (a === 172 && b >= 16 && b <= 31) return false; // 私有
      if (a === 192 && b === 168) return false; // 私有
      if (a >= 224) return false; // 组播 + 保留（240/4）
    } else if (v === 6) {
      const low = addr.toLowerCase();
      if (low === "::1" || low === "::" || low.startsWith("fc") || low.startsWith("fd") || low.startsWith("fe8") || low.startsWith("fe9") || low.startsWith("fea") || low.startsWith("feb") || low.startsWith("ff")) {
        return false; // 环回/未指定/ULA/链路本地/组播
      }
    } else {
      return false;
    }
  }
  return true;
}

export function registerVisionRoutes(app: Hono, deps: VisionDeps, lookupFn?: LookupFn): void {
  const { db, auth, bus, config } = deps;
  const visionConfig = new VisionConfig(config.homeDir);
  const tasksDir = join(config.homeDir, "tasks");
  const fetchImpl = deps.fetchImpl;

  const taskDirOf = (taskId: string): string => {
    const dir = resolve(tasksDir, taskId);
    if (!relative(resolve(tasksDir), dir).startsWith("..") === false || isAbsolute(taskId) || taskId.includes("..")) {
      throw new HttpError(400, "Invalid task id");
    }
    return dir;
  };

  // ── config ──
  app.get("/api/vision/config", (c) => {
    getCurrentUser(c, auth); // 任意用户（key 打码）
    const key = visionConfig.getKieApiKey();
    return c.json({
      kie_api_key_set: Boolean(key),
      kie_api_key_masked: maskKey(key),
      models: catalogPublic(),
      default_model: modelIds()[0]!,
      fake: isFake(),
    });
  });

  app.put("/api/vision/config", async (c) => {
    const user = getCurrentUser(c, auth);
    if (user.role !== "admin") throw new HttpError(403, "Admin access required");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const sanitized = sanitizeJson(body) as Record<string, unknown>;
    visionConfig.save(String(sanitized["kie_api_key"] ?? ""));
    const key = visionConfig.getKieApiKey();
    return c.json({ kie_api_key_set: Boolean(key), kie_api_key_masked: maskKey(key) });
  });

  // ── generate（MCP 工具入口 + 确认闸门） ──
  app.post("/api/tasks/:task_id/image/generate", async (c) => {
    getCurrentUser(c, auth);
    let body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    body = sanitizeJson(body) as Record<string, unknown>;
    if (!visionConfig.getKieApiKey() && !isFake()) {
      throw new HttpError(400, "kie.ai API key not configured. Ask the user to set it in Settings → AI → Vision before generating images.");
    }
    const taskId = c.req.param("task_id") ?? "";
    const taskDir = taskDirOf(taskId);

    const prompt = String(body["prompt"] ?? "").trim();
    if (!prompt) throw new HttpError(400, "prompt is required");
    let model = (body["model"] as string) || modelIds()[0]!;
    if (!modelIds().includes(model)) model = modelIds()[0]!;
    const referenceImages = (body["reference_images"] as string[]) ?? [];
    const outputName = safeName((body["output_name"] as string) || "image.png");
    const kind = (body["kind"] as string) || "";

    // 单任务单挂起：新请求顶掉旧卡（agent 重试场景），并发过期事件。
    const superseded = supersedePending(taskId);
    if (superseded) bus.emit("image_request_expired", { task_id: taskId, request_id: superseded });

    const requestId = randomUUID().replace(/-/g, "");
    const card = {
      prompt,
      model,
      models: catalogPublic(),
      reference_images: referenceImages,
      output_name: outputName,
      kind,
    };
    const decisionPromise = createConfirm(requestId, taskId, card);
    bus.emit("image_request", { task_id: taskId, request_id: requestId, ...card });

    // 无超时——镜像 AskUserQuestion：工具调用就等用户。
    let decision: Record<string, unknown>;
    try {
      decision = await decisionPromise;
    } finally {
      discardConfirm(requestId, taskId);
    }

    if (decision["action"] === "superseded") {
      return c.json({
        status: "superseded",
        message: "This request was replaced by a newer image request. Do NOT retry it — the newer request is the live one.",
      });
    }
    if (decision["action"] === "interrupted") {
      return c.json({
        status: "interrupted",
        message: "The user sent a message instead of confirming this image — do NOT generate the proposed image. Read the user's next message and act on it; re-propose an image only if that still fits what they now want.",
      });
    }
    if (decision["action"] !== "confirm") {
      return c.json({ status: "cancelled", message: "User cancelled this image generation." });
    }

    // 用户改写的值优先于 agent 提案。
    const finalPrompt = (String(decision["prompt"] ?? "") || prompt).trim();
    let finalModel = (decision["model"] as string) || model;
    if (!modelIds().includes(finalModel)) finalModel = model;
    const added = ((decision["added_references"] as string[]) ?? []).filter(Boolean);
    const finalRefs = [...referenceImages, ...added];

    bus.emit("image_generating", { task_id: taskId, request_id: requestId, model: finalModel, kind });

    const apiKey = visionConfig.getKieApiKey() ?? "";
    const resumeId = takeInflight(taskId, finalModel);
    let png: Buffer;
    try {
      png = await generateImage({
        prompt: finalPrompt,
        model: finalModel,
        referenceImages: finalRefs,
        taskDir,
        resumeTaskId: resumeId,
        apiKey,
        fetchImpl,
        pollEveryMs: deps.pollEveryMs,
      });
    } catch (e) {
      if (e instanceof GenerationTimeout) {
        inflight.set(taskId, { kieTaskId: e.kieTaskId, model: finalModel });
        throw new HttpError(
          504,
          `Generation is still running on kie.ai after ${e.waitedS}s (model ${e.modelId}). The job was NOT cancelled and will finish. Call this tool AGAIN with the SAME model (${e.modelId}) — that resumes this exact job and collects the image at no extra cost. Do NOT switch to a different model: ${e.modelId} is the model chosen on the confirm card, a different one is a different image and a second charge.`,
        );
      }
      throw new HttpError(502, `Generation failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    inflight.delete(taskId);

    const outDir = join(taskDir, GEN_SUBDIR);
    mkdirSync(outDir, { recursive: true });
    let outPath = join(outDir, outputName);
    if (existsSync(outPath)) {
      const stem = outputName.replace(/\.png$/i, "");
      outPath = join(outDir, `${stem}-${requestId.slice(0, 6)}.png`);
    }
    writeFileSync(outPath, png);

    const relPath = `${GEN_SUBDIR}/${outPath.split(/[\\/]/).pop()}`;
    const fileUrl = `/api/tasks/${taskId}/files/${relPath}`;
    bus.emit("image_generated", { task_id: taskId, request_id: requestId, path: relPath, url: fileUrl, prompt: finalPrompt, model: finalModel, kind });
    // 落一条 generated_image 消息：conversation 从持久消息重建，不落导航后图就没了。
    const seqRow = db.prepare("SELECT MAX(seq) AS m FROM task_messages WHERE task_id = ?").get(taskId) as { m: number | null };
    const seq = seqRow.m === null ? 0 : seqRow.m + 1;
    db.prepare("INSERT INTO task_messages (id, task_id, role, content, seq, created_at) VALUES (?, ?, 'generated_image', ?, ?, ?)").run(
      randomUUID(),
      taskId,
      JSON.stringify({ path: relPath, url: fileUrl, prompt: finalPrompt, model: finalModel, kind }),
      seq,
      new Date().toISOString(),
    );
    return c.json({ status: "ok", path: relPath, url: fileUrl, prompt: finalPrompt, model: finalModel });
  });

  // ── confirm / pending ──
  app.post("/api/tasks/:task_id/image/confirm", async (c) => {
    getCurrentUser(c, auth);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const requestBody = sanitizeJson(body) as Record<string, unknown>;
    const requestId = requestBody["request_id"] as string | undefined;
    const action = requestBody["action"] as string | undefined;
    if (!requestId || (action !== "confirm" && action !== "cancel")) {
      throw new HttpError(400, "request_id and action required");
    }
    const payload: Record<string, unknown> = {
      action,
      prompt: requestBody["prompt"],
      model: requestBody["model"],
      added_references: requestBody["added_references"] ?? [],
    };
    if (!resolveConfirm(requestId, payload)) {
      throw new HttpError(404, "No pending image request (expired or already handled)");
    }
    return c.json({ ok: true });
  });

  app.get("/api/tasks/:task_id/image/pending", (c) => {
    getCurrentUser(c, auth);
    const req = getPendingRequest(c.req.param("task_id") ?? "");
    if (!req) return c.json({ pending: false });
    return c.json({ pending: true, ...req });
  });

  // ── 参考图上传 ──
  app.post("/api/tasks/:task_id/image/upload-reference", async (c) => {
    getCurrentUser(c, auth);
    const taskId = c.req.param("task_id") ?? "";
    const taskDir = taskDirOf(taskId);
    const upload = await readSingleFilePart(c);
    const origName = upload.filename || "ref.png";
    let name = safeName(origName);
    const origExt = (origName.includes(".") ? origName.slice(origName.lastIndexOf(".")) : "").toLowerCase();
    if ([".jpg", ".jpeg", ".webp", ".gif"].includes(origExt)) name = name.replace(/\.png$/, origExt);
    const outDir = join(taskDir, REF_SUBDIR);
    mkdirSync(outDir, { recursive: true });
    let outPath = join(outDir, name);
    if (existsSync(outPath)) {
      const dot = name.lastIndexOf(".");
      outPath = join(outDir, `${name.slice(0, dot)}-${randomUUID().replace(/-/g, "").slice(0, 6)}${name.slice(dot)}`);
    }
    await saveUpload(upload.data, outPath);
    const relPath = `${REF_SUBDIR}/${outPath.split(/[\\/]/).pop()}`;
    return c.json({ path: relPath, url: `/api/tasks/${taskId}/files/${relPath}` });
  });

  // ── 预览代理（SSRF 防护） ──
  app.get("/api/vision/ref-proxy", async (c) => {
    getCurrentUser(c, auth);
    const url = c.req.query("url") ?? "";
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new HttpError(400, "Invalid url");
    }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) throw new HttpError(400, "Invalid url");
    if (!(await isPublicHost(parsed.hostname, lookupFn))) throw new HttpError(400, "Host not allowed");

    const doGet = (u: string) => fetchImpl!(u, { headers: { "user-agent": "Mozilla/5.0" }, redirect: "manual", signal: AbortSignal.timeout(20_000) });
    let resp: Response;
    try {
      resp = await doGet(url);
      // httpx follow_redirects 每跳重解析——这里逐跳复检（SSRF 红线：跳去内网即拒）。
      for (let hop = 0; hop < 20 && [301, 302, 303, 307, 308].includes(resp.status); hop++) {
        const location = resp.headers.get("location");
        if (!location) break;
        const next = new URL(location, url).toString();
        const nextParsed = new URL(next);
        if (!(await isPublicHost(nextParsed.hostname, lookupFn))) throw new HttpError(400, "Host not allowed");
        resp = await doGet(next);
      }
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, "Fetch failed");
    }
    const ctype = resp.headers.get("content-type") ?? "";
    if (resp.status !== 200 || !ctype.startsWith("image/")) throw new HttpError(502, "Not an image");
    const bytes = Buffer.from(await resp.arrayBuffer());
    if (bytes.length > MAX_PROXIED_IMAGE) throw new HttpError(413, "Image too large");
    return c.body(new Uint8Array(bytes), 200, { "content-type": ctype, "cache-control": "private, max-age=300" });
  });
}

export interface FilePart {
  filename: string;
  contentType: string;
  data: Buffer;
}

/** multipart 里取单个 file 字段（Hono parseBody 缓冲整个 body——
 * Content-Length 预检（413 早拒）+ saveUpload 流式上限的内存上限差异已记录在
 * uploads.ts 的注释里；这里保持 413/400 契约不变）。 */
export async function readSingleFilePart(c: import("hono").Context): Promise<FilePart> {
  const { MAX_UPLOAD_SIZE, humanSize } = await import("./uploads");
  const declared = c.req.header("content-length");
  if (declared) {
    const n = Number.parseInt(declared, 10);
    if (!Number.isNaN(n) && n > MAX_UPLOAD_SIZE + 1024 * 1024) {
      throw new HttpError(413, `File too large (max ${humanSize(MAX_UPLOAD_SIZE)})`);
    }
  }
  const body = await c.req.parseBody();
  for (const value of Object.values(body)) {
    if (typeof value === "object" && value !== null && "arrayBuffer" in value) {
      const file = value as File & { name: string; type: string };
      return { filename: file.name, contentType: file.type, data: Buffer.from(await file.arrayBuffer()) };
    }
  }
  throw new HttpError(422, "file required");
}

/** save_upload 等价：总量超限 413 并删半截文件；0 字节 400。 */
export async function saveUpload(data: Buffer, dest: string): Promise<number> {
  const { MAX_UPLOAD_SIZE, humanSize } = await import("./uploads");
  if (data.length > MAX_UPLOAD_SIZE) {
    await unlink(dest).catch(() => undefined);
    throw new HttpError(413, `File too large (max ${humanSize(MAX_UPLOAD_SIZE)})`);
  }
  await writeFile(dest, data);
  if (data.length === 0) {
    await unlink(dest).catch(() => undefined);
    throw new HttpError(400, "Empty file");
  }
  return data.length;
}
