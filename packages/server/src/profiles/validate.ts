// 保存前探测 AI profile 的端点（app/ai/profile_validation.py 移植）。
// Settings UI 保存时打一次最小 /v1/messages，别等下一次任务跑才暴露坏配置。
// 认证头镜像 Claude Code 的 env→header 映射：AUTH_TOKEN→Bearer、API_KEY→x-api-key。
// 结果永远是 HTTP 200，裁决在 body 的 ok 字段；密钥绝不入日志。

const PLACEHOLDER_RE = /\{[^}]+\}/;
const CONTEXT_TAG_RE = /\[1m\]$/i;

const BASE_URL_KEY = "ANTHROPIC_BASE_URL";
const MODEL_KEY = "ANTHROPIC_MODEL";
const AUTH_TOKEN_KEY = "ANTHROPIC_AUTH_TOKEN";
const API_KEY_KEY = "ANTHROPIC_API_KEY";

const ANTHROPIC_VERSION = "2023-06-01";
// 足够让默认 thinking 模型不因预算过小 400，又只是个无关痛痒的探针
const PROBE_MAX_TOKENS = 64;
const TIMEOUT_MS = 20_000;

export interface ProfileValidationResult {
  ok: boolean;
  code: string;
  error: string;
  reported_model: string | null;
}

function result(ok: boolean, code: string, error = "", reportedModel: string | null = null): ProfileValidationResult {
  return { ok, code, error, reported_model: reportedModel };
}

/** base URL 接 /v1/messages，容忍尾部斜杠（如 Kimi 的 .../coding/）。 */
function probeUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "") + "/v1/messages";
}

function authHeaders(env: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = (env[AUTH_TOKEN_KEY] ?? "").trim();
  const apiKey = (env[API_KEY_KEY] ?? "").trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (apiKey) headers["x-api-key"] = apiKey;
  return headers;
}

function extractErrorMessage(bodyText: string): string {
  let data: unknown;
  try {
    data = JSON.parse(bodyText);
  } catch {
    return bodyText.trim().slice(0, 300);
  }
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const err = obj.error;
    if (err && typeof err === "object" && typeof (err as Record<string, unknown>).message === "string") {
      return String((err as Record<string, unknown>).message);
    }
    if (typeof err === "string" && err) return err;
    if (obj.message) return String(obj.message);
  }
  return JSON.stringify(data).slice(0, 300);
}

function interpret(status: number, bodyText: string): ProfileValidationResult {
  if (status === 200) {
    let data: unknown;
    try {
      data = JSON.parse(bodyText);
    } catch {
      return result(false, "protocol", "Endpoint returned 200 but the body was not JSON; it does not look like an Anthropic-compatible API.");
    }
    if (data && typeof data === "object") {
      const obj = data as Record<string, unknown>;
      if (obj.type === "message" || "content" in obj || obj.role === "assistant") {
        return result(true, "ok", "", obj.model ? String(obj.model) : null);
      }
    }
    // 200 但不是 Anthropic message——多半是 base URL 指到了非 Anthropic 端点（OpenAI 形状）
    return result(
      false,
      "protocol",
      "Endpoint responded but not in Anthropic message format. Check that the base URL is the provider's Anthropic-compatible endpoint.",
    );
  }
  const message = extractErrorMessage(bodyText);
  if (status === 401 || status === 403) {
    return result(false, "auth", `Authentication failed (HTTP ${status}). Check the API key. ${message}`.trim());
  }
  if (status === 404) {
    return result(false, "not_found", `Endpoint not found (HTTP 404). Check the base URL. ${message}`.trim());
  }
  // 400 多半是过期/错误的模型 id——原样转出供应商自己的报错文本
  return result(false, "http_error", `HTTP ${status}: ${message}`.trim());
}

export async function validateProfileEnv(env: Record<string, string> | null | undefined, fetchImpl: typeof fetch = fetch): Promise<ProfileValidationResult> {
  const e = env ?? {};
  const baseUrl = (e[BASE_URL_KEY] ?? "").trim();
  if (!baseUrl) return result(true, "no_endpoint");

  const placeholder = PLACEHOLDER_RE.exec(baseUrl);
  if (placeholder) {
    return result(
      false,
      "placeholder",
      `Base URL still contains the placeholder ${placeholder[0]} — replace it with your real value before saving.`,
    );
  }

  const headers = authHeaders(e);
  if (Object.keys(headers).length === 0) {
    return result(false, "missing_key", "API key is required (set ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY).");
  }

  const model = (e[MODEL_KEY] ?? "").trim();
  if (!model) {
    return result(false, "missing_model", `Model is required (set ${MODEL_KEY}).`);
  }

  // `[1m]` 是客户端约定：客户端解析后以裸模型 id 请求。有些端点拒绝字面后缀
  // （Z.AI [1211]、DashScope 400）——镜像客户端行为，探针剥后缀。
  const probeModel = model.replace(CONTEXT_TAG_RE, "");

  const url = probeUrl(baseUrl);
  try {
    const resp = await fetchImpl(url, {
      method: "POST",
      headers: { ...headers, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" },
      body: JSON.stringify({ model: probeModel, max_tokens: PROBE_MAX_TOKENS, messages: [{ role: "user", content: "ping" }] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return interpret(resp.status, await resp.text());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return result(false, "unreachable", `Could not reach ${baseUrl}: ${message}`);
  }
}
