// 视觉图像生成：配置 + kie.ai 客户端 + 确认登记处（app/vision.py 移植）。
// 三件事同文件（原实现注释同款理由：小且只被 vision 路由成组使用）：
//  1. 配置：kie.ai key 存 ~/.vibe-seller/vision.json（秘密不进 DB；对齐 profiles.json）。
//  2. kie.ai 客户端：createTask → 轮询 recordInfo → 下载 PNG。VISION_FAKE 短路网络。
//  3. 确认登记：进程内 request_id → resolver Map（原实现是 asyncio.Future——
//     generate 路由 park 在 promise 上，confirm 路由 resolve）。

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

const KIE_BASE = "https://api.kie.ai";
const KIE_UPLOAD_BASE = "https://kieai.redpandaai.co";

export const CREDIT_USD = 0.005;
export const USD_CNY = 7.2;

// ── 模型目录（_FAMILIES 展开为一档一变体；首个 = 默认） ──

interface Family {
  fid: string;
  slug: string;
  provider: string;
  label: string;
  refField: string;
  refArray: boolean;
  baseExtra: Record<string, unknown>;
  tiers: { suffix: string; label: string; usd: number; extra: Record<string, unknown> }[];
}

const FAMILIES: Family[] = [
  {
    fid: "nano-banana-pro", slug: "nano-banana-pro", provider: "Google", label: "Nano Banana Pro",
    refField: "image_input", refArray: true, baseExtra: { aspect_ratio: "1:1", output_format: "png" },
    tiers: [
      { suffix: "2k", label: "2K", usd: 0.09, extra: { resolution: "2K" } },
      { suffix: "4k", label: "4K", usd: 0.12, extra: { resolution: "4K" } },
    ],
  },
  {
    fid: "nano-banana-2", slug: "nano-banana-2", provider: "Google", label: "Nano Banana 2",
    refField: "image_input", refArray: true, baseExtra: { aspect_ratio: "1:1" },
    tiers: [
      { suffix: "1k", label: "1K", usd: 0.04, extra: { resolution: "1K" } },
      { suffix: "2k", label: "2K", usd: 0.06, extra: { resolution: "2K" } },
      { suffix: "4k", label: "4K", usd: 0.09, extra: { resolution: "4K" } },
    ],
  },
  {
    fid: "nano-banana-edit", slug: "google/nano-banana-edit", provider: "Google", label: "Nano Banana Edit",
    refField: "image_urls", refArray: true, baseExtra: {},
    tiers: [{ suffix: "", label: "", usd: 0.02, extra: {} }],
  },
  {
    fid: "gpt-image-2", slug: "gpt-image-2-image-to-image", provider: "OpenAI", label: "GPT Image 2",
    refField: "input_urls", refArray: true, baseExtra: { aspect_ratio: "1:1" },
    tiers: [
      { suffix: "1k", label: "1K", usd: 0.03, extra: { resolution: "1K" } },
      { suffix: "2k", label: "2K", usd: 0.05, extra: { resolution: "2K" } },
      { suffix: "4k", label: "4K", usd: 0.08, extra: { resolution: "4K" } },
    ],
  },
  {
    // 只留最便宜的 Medium 档（$0.02）：high 档 $0.11 被更新的 GPT Image 2 4K（$0.08）严格支配。
    fid: "gpt-image-1.5", slug: "gpt-image/1.5-image-to-image", provider: "OpenAI", label: "GPT Image 1.5",
    refField: "input_urls", refArray: true, baseExtra: { aspect_ratio: "1:1" },
    tiers: [{ suffix: "medium", label: "Medium", usd: 0.02, extra: { quality: "medium" } }],
  },
  {
    fid: "seedream-5-pro", slug: "seedream/5-pro-image-to-image", provider: "ByteDance", label: "Seedream 5 Pro",
    refField: "image_urls", refArray: true, baseExtra: {},
    tiers: [
      { suffix: "basic", label: "Basic", usd: 0.035, extra: { quality: "basic" } },
      { suffix: "high", label: "High", usd: 0.07, extra: { quality: "high" } },
    ],
  },
  {
    fid: "seedream-4.5", slug: "seedream/4.5-edit", provider: "ByteDance", label: "Seedream 4.5",
    refField: "image_urls", refArray: true, baseExtra: {},
    tiers: [{ suffix: "", label: "", usd: 0.0325, extra: {} }],
  },
  {
    fid: "flux-2-pro", slug: "flux-2/pro-image-to-image", provider: "Black Forest Labs", label: "Flux-2 Pro",
    refField: "input_urls", refArray: true, baseExtra: {},
    tiers: [
      { suffix: "1k", label: "1K", usd: 0.025, extra: { resolution: "1K" } },
      { suffix: "2k", label: "2K", usd: 0.035, extra: { resolution: "2K" } },
    ],
  },
  {
    fid: "flux-2-flex", slug: "flux-2/flex-image-to-image", provider: "Black Forest Labs", label: "Flux 2 Flex",
    refField: "input_urls", refArray: true, baseExtra: {},
    tiers: [
      { suffix: "1k", label: "1K", usd: 0.07, extra: { resolution: "1K" } },
      { suffix: "2k", label: "2K", usd: 0.12, extra: { resolution: "2K" } },
    ],
  },
  {
    fid: "qwen-image-edit", slug: "qwen/image-edit", provider: "Qwen", label: "Qwen Image Edit",
    refField: "image_url", refArray: false, baseExtra: {},
    tiers: [{ suffix: "", label: "", usd: 0.03, extra: {} }],
  },
  {
    fid: "ideogram-v3-remix", slug: "ideogram/v3-remix", provider: "Ideogram", label: "Ideogram V3 Remix",
    refField: "image_url", refArray: false, baseExtra: {},
    tiers: [
      { suffix: "turbo", label: "Turbo", usd: 0.0175, extra: { rendering_speed: "TURBO" } },
      { suffix: "balanced", label: "Balanced", usd: 0.035, extra: { rendering_speed: "BALANCED" } },
      { suffix: "quality", label: "Quality", usd: 0.05, extra: { rendering_speed: "QUALITY" } },
    ],
  },
];

export interface ImageModel {
  id: string;
  slug: string;
  provider: string;
  label: string;
  ref_field: string;
  ref_array: boolean;
  usd: number;
  extra: Record<string, unknown>;
}

export const IMAGE_MODELS: ImageModel[] = FAMILIES.flatMap((fam) =>
  fam.tiers.map((tier) => ({
    id: tier.suffix ? `${fam.fid}-${tier.suffix}` : fam.fid,
    slug: fam.slug,
    provider: fam.provider,
    label: tier.label ? `${fam.label} · ${tier.label}` : fam.label,
    ref_field: fam.refField,
    ref_array: fam.refArray,
    usd: tier.usd,
    extra: { ...fam.baseExtra, ...tier.extra },
  })),
);

const MODELS_BY_ID = new Map(IMAGE_MODELS.map((m) => [m.id, m]));
export const DEFAULT_MODEL = IMAGE_MODELS[0]!.id;

export function modelIds(): string[] {
  return IMAGE_MODELS.map((m) => m.id);
}

export function getModel(modelId: string | null | undefined): ImageModel {
  return MODELS_BY_ID.get(modelId ?? "") ?? MODELS_BY_ID.get(DEFAULT_MODEL)!;
}

/** 前端/代理看到的目录：id/provider/label/价格提示（USD + 固定汇率 CNY）。
 * kie.ai slug 永不出服务器。 */
export function catalogPublic(): Record<string, unknown>[] {
  return IMAGE_MODELS.map((m) => ({
    id: m.id,
    provider: m.provider,
    label: m.label,
    usd: Math.round(m.usd * 10000) / 10000,
    cny: Math.round(m.usd * USD_CNY * 100) / 100,
    default: m.id === DEFAULT_MODEL,
  }));
}

// ── 配置 ──

export class VisionConfig {
  constructor(private readonly homeDir: string) {}

  private get path(): string {
    return join(this.homeDir, "vision.json");
  }

  load(): Record<string, unknown> {
    if (!existsSync(this.path)) return {};
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  save(kieApiKey: string): void {
    const cfg = this.load();
    cfg["kie_api_key"] = (kieApiKey ?? "").trim();
    mkdirSync(this.homeDir, { recursive: true });
    writeFileSync(this.path, JSON.stringify(cfg, null, 2), "utf8");
    try {
      chmodSync(this.path, 0o600);
    } catch {
      /* Windows chmod 部分位忽略 */
    }
  }

  getKieApiKey(): string | null {
    const env = (process.env["KIE_API_KEY"] ?? "").trim();
    if (env) return env;
    const key = (this.load()["kie_api_key"] as string | undefined)?.trim();
    return key || null;
  }
}

/** 末 4 位掩码；永不回全量。 */
export function maskKey(key: string | null): string {
  if (!key) return "";
  if (key.length <= 4) return "••••";
  return "••••" + key.slice(-4);
}

export function isFake(): boolean {
  return ["1", "true", "yes"].includes((process.env["VISION_FAKE"] ?? "").toLowerCase());
}

// ── 确认登记处 ──
// 恒不超时（对齐 AskUserQuestion：工具调用就一直等用户）。唯一不变量：
// 单任务单挂起——新请求 supersede（resolve）旧的，UI 永不同时见两张活卡。

interface PendingConfirm {
  resolve: (decision: Record<string, unknown>) => void;
  settled: boolean;
}

const pendingConfirms = new Map<string, PendingConfirm>();
const pendingByTask = new Map<string, string>();
const pendingPayload = new Map<string, Record<string, unknown>>();

export function createConfirm(requestId: string, taskId: string, payload: Record<string, unknown> | null = null): Promise<Record<string, unknown>> {
  return new Promise<Record<string, unknown>>((resolve) => {
    pendingConfirms.set(requestId, { resolve, settled: false });
    pendingByTask.set(taskId, requestId);
    pendingPayload.set(requestId, payload ?? {});
  });
}

export function getPendingRequest(taskId: string): Record<string, unknown> | null {
  const reqId = pendingByTask.get(taskId);
  if (!reqId) return null;
  const p = pendingConfirms.get(reqId);
  if (!p || p.settled) return null;
  return { request_id: reqId, ...pendingPayload.get(reqId) };
}

/** 同任务旧请求 resolve 为 superseded；返回旧 request_id（发过期事件用）。 */
export function supersedePending(taskId: string): string | null {
  const oldId = pendingByTask.get(taskId);
  if (!oldId) return null;
  const p = pendingConfirms.get(oldId);
  if (p && !p.settled) {
    p.settled = true;
    p.resolve({ action: "superseded" });
    return oldId;
  }
  return null;
}

export function resolveConfirm(requestId: string, payload: Record<string, unknown>): boolean {
  const p = pendingConfirms.get(requestId);
  if (!p || p.settled) return false;
  p.settled = true;
  p.resolve(payload);
  return true;
}

export function discardConfirm(requestId: string, taskId?: string): void {
  pendingConfirms.delete(requestId);
  pendingPayload.delete(requestId);
  if (taskId && pendingByTask.get(taskId) === requestId) pendingByTask.delete(taskId);
}

// ── kie.ai 客户端 ──

const POLL_EVERY_S = 4;
const POLL_BUDGET_S: Record<string, number> = { "1K": 240, "2K": 240, "4K": 600 };
const POLL_BUDGET_DEFAULT_S = 240;

/** 轮询预算按分辨率档给（4K 尾延迟 147s+，240s 档不够；600s ≈ 4× 中位）。 */
export function pollBudgetS(m: ImageModel): number {
  return POLL_BUDGET_S[String(m.extra["resolution"] ?? "")] ?? POLL_BUDGET_DEFAULT_S;
}

export class GenerationTimeout extends Error {
  constructor(readonly kieTaskId: string, readonly waitedS: number, readonly modelId: string) {
    super(`kie.ai generation still running after ${waitedS}s (model ${modelId}, kie taskId ${kieTaskId})`);
  }
}

async function uploadLocalFile(fetchImpl: FetchImpl, data: Buffer, ext: string, fileName: string, apiKey: string): Promise<string> {
  const resp = await fetchImpl(`${KIE_UPLOAD_BASE}/api/file-base64-upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ base64Data: `data:image/${ext};base64,${data.toString("base64")}`, uploadPath: "images", fileName }),
  });
  const body = (await resp.json()) as { data?: { downloadUrl?: string; url?: string } };
  const url = body.data?.downloadUrl ?? body.data?.url;
  if (!url) throw new Error(`kie.ai upload failed: ${JSON.stringify(body)}`);
  return url;
}

async function resolveReference(fetchImpl: FetchImpl, ref: string, taskDir: string, apiKey: string): Promise<string | null> {
  if (ref.startsWith("http://") || ref.startsWith("https://")) return ref;
  const { resolve, isAbsolute, relative } = await import("node:path");
  const local = resolve(taskDir, ref);
  if (isAbsolute(local) === isAbsolute(taskDir) === false) return null;
  if (!relative(taskDir, local).startsWith("..") && existsSync(local)) {
    const { stat, readFile } = await import("node:fs/promises");
    const st = await stat(local);
    if (!st.isFile()) return null;
    const data = await readFile(local);
    const ext = (local.split(".").pop() ?? "png").toLowerCase();
    return uploadLocalFile(fetchImpl, data, ext, local.split(/[\\/]/).pop() ?? "ref.png", apiKey);
  }
  return null;
}

export interface GenerateImageOpts {
  prompt: string;
  model: string;
  referenceImages: string[];
  taskDir: string;
  resumeTaskId?: string | null;
  apiKey: string;
  fetchImpl?: FetchImpl;
  /** 轮询间隔覆盖（测试）。 */
  pollEveryMs?: number;
}

/** 生成一张图并返回 PNG 字节。失败抛 Error；预算耗尽抛 GenerationTimeout（带 taskId，
 * 任务没被取消照样计费——调用方保留 handle 以便免费续收）。 */
export async function generateImage(opts: GenerateImageOpts): Promise<Buffer> {
  if (isFake()) return fakePng();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const m = getModel(opts.model);
  const headers = { Authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" };
  let kieTask: string;

  if (opts.resumeTaskId) {
    kieTask = opts.resumeTaskId;
  } else {
    const resolved: string[] = [];
    for (const ref of opts.referenceImages ?? []) {
      const url = await resolveReference(fetchImpl, ref, opts.taskDir, opts.apiKey);
      if (url) resolved.push(url);
    }
    const imageInput: Record<string, unknown> = { prompt: opts.prompt };
    if (m.ref_array) imageInput[m.ref_field] = resolved;
    else if (resolved.length) imageInput[m.ref_field] = resolved[0];
    Object.assign(imageInput, m.extra);

    const create = await fetchImpl(`${KIE_BASE}/api/v1/jobs/createTask`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: m.slug, input: imageInput }),
    });
    const cbody = (await create.json()) as { data?: { taskId?: string } };
    kieTask = cbody.data?.taskId ?? "";
    if (!kieTask) throw new Error(`kie.ai createTask failed: ${JSON.stringify(cbody)}`);
  }

  const budgetS = pollBudgetS(m);
  let resultUrl: string | null = null;
  const pollEvery = opts.pollEveryMs ?? POLL_EVERY_S * 1000;
  for (let i = 0; i < Math.max(1, Math.floor(budgetS / POLL_EVERY_S)); i++) {
    await new Promise((r) => setTimeout(r, pollEvery));
    const info = await fetchImpl(`${KIE_BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(kieTask)}`, { headers });
    const data = ((await info.json()) as { data?: { state?: string; resultJson?: string; failMsg?: string } }).data ?? {};
    if (data.state === "success") {
      const resultJson = data.resultJson ? (JSON.parse(data.resultJson) as { resultUrls?: string[] }) : {};
      const urls = resultJson.resultUrls ?? [];
      if (urls.length) resultUrl = urls[0]!;
      break;
    }
    if (data.state === "fail") throw new Error(`kie.ai generation failed: ${data.failMsg}`);
  }
  if (!resultUrl) throw new GenerationTimeout(kieTask, budgetS, m.id);
  const img = await fetchImpl(resultUrl, {});
  return Buffer.from(await img.arrayBuffer());
}

/** VISION_FAKE 模式的确定性占位 PNG（1x1，与 Python 兜底字节一致）。 */
export function fakePng(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );
}
