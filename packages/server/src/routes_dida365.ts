// 批次 4.6 路由：dida365 OAuth(7)。契约对齐 app/routers/dida365_oauth.py。
// 认证分界：/callback 免认证（浏览器重定向），其余全部 getCurrentUser。
// token/client_secret Fernet 加密进 event_backends.json 的 dida365 配置
//（syncer 的 load/save_backend_config 同款后端配置）；单次 state 进程内字典（5 分钟）。
// setup-mcp 差异（PRD §4.5 预裁决落地）：git clone 照移植；`uv venv`/`uv pip
// install` 属 Python venv 环节，按 venv 不迁移原则不在 TS 执行（环境预置外部化），
// 但 .mcp.json 注册写的是同一条 `uv run --directory …` 命令——装了 uv 的机器行为不变。

import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { HttpError } from "./types";
import { getCurrentUser, type AuthContext } from "./auth";
import type { ServerConfig } from "./config";
import { deriveFernetKey, fernetDecryptText, fernetEncrypt } from "./crypto/fernet";
import { BackendConfigStore } from "./events/syncer";

export interface DidaDeps {
  config: ServerConfig;
  db: DatabaseSync;
  auth: AuthContext;
  jwtSecret: string;
  /** 测试注入 token/projects 的传输层。 */
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}

const TICKTICK_MCP_REPO = "https://github.com/jacepark12/ticktick-mcp.git";

const SERVICE_URLS: Record<string, { auth_url: string; token_url: string; base_url: string }> = {
  dida365: {
    auth_url: "https://dida365.com/oauth/authorize",
    token_url: "https://dida365.com/oauth/token",
    base_url: "https://api.dida365.com/open/v1",
  },
  ticktick: {
    auth_url: "https://ticktick.com/oauth/authorize",
    token_url: "https://ticktick.com/oauth/token",
    base_url: "https://api.ticktick.com/open/v1",
  },
};

// 单次 state（进程内）：{state: {expires, redirect_uri}}
const pendingStates = new Map<string, { expires: number; redirect_uri: string }>();

function pruneExpiredStates(): void {
  const now = Date.now() / 1000;
  for (const [k, v] of pendingStates) if (v.expires < now) pendingStates.delete(k);
}

const execFileAsync = promisify(execFile);

export function registerDidaRoutes(app: Hono, deps: DidaDeps): void {
  const { config, auth } = deps;
  const configs = new BackendConfigStore(config.homeDir);
  const key = deriveFernetKey(deps.jwtSecret);
  const fetchImpl = deps.fetchImpl ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const mcpDir = () => join(config.homeDir, "ticktick-mcp");
  const mcpJsonPath = () => join(config.homeDir, ".mcp.json");

  const decryptOrThrow = (enc: string): string => fernetDecryptText(key, enc);

  function readMcpConfig(): Record<string, Record<string, unknown>> {
    if (existsSync(mcpJsonPath())) {
      try {
        return JSON.parse(readFileSync(mcpJsonPath(), "utf8"));
      } catch {
        /* 坏文件重建 */
      }
    }
    return { mcpServers: {} };
  }

  function atomicWriteJson(path: string, data: unknown): void {
    const tmp = `${path}.tmp-${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    renameSync(tmp, path);
    try {
      chmodSync(path, 0o600);
    } catch {
      /* Windows chmod 部分位忽略 */
    }
  }

  /** _register_ticktick_mcp 移植：ticktick MCP 注册进 .mcp.json（token 环境变量）。 */
  function registerTicktickMcp(cfg: Record<string, unknown>): void {
    if (!existsSync(mcpDir())) return;
    let accessToken: string;
    try {
      accessToken = decryptOrThrow(String(cfg["access_token_enc"] ?? ""));
    } catch {
      return;
    }
    const env: Record<string, string> = { TICKTICK_ACCESS_TOKEN: accessToken };
    if (cfg["service_type"] === "dida365") env["TICKTICK_BASE_URL"] = "https://api.dida365.com/open/v1";
    const mcpData = readMcpConfig();
    mcpData["mcpServers"] = mcpData["mcpServers"] ?? {};
    (mcpData["mcpServers"] as Record<string, unknown>)["ticktick"] = {
      command: "uv",
      args: ["run", "--directory", mcpDir(), "-m", "ticktick_mcp.cli", "run"],
      env,
    };
    atomicWriteJson(mcpJsonPath(), mcpData);
  }

  /** refresh_token_if_needed 移植：5 分钟内到期则刷。返回是否刷过。 */
  async function refreshTokenIfNeeded(): Promise<boolean> {
    const cfg = configs.load("dida365");
    if (!cfg["access_token_enc"]) return false;
    const expiresAt = Number(cfg["expires_at"] ?? 0);
    if (Date.now() / 1000 < expiresAt - 300) return false;
    const refreshEnc = cfg["refresh_token_enc"];
    if (!refreshEnc) return false;
    let clientId: string, clientSecret: string, tokenUrl: string, refreshToken: string;
    try {
      clientId = String(cfg["client_id"] ?? "");
      clientSecret = decryptOrThrow(String(cfg["client_secret_enc"] ?? ""));
      tokenUrl = String(cfg["token_url"] ?? "");
      refreshToken = decryptOrThrow(String(refreshEnc));
    } catch (e) {
      console.warn(`[vibe-server] Failed to decrypt dida365 creds: ${e instanceof Error ? e.message : e}`);
      return false;
    }
    let tokens: Record<string, unknown>;
    try {
      const resp = await fetchImpl(tokenUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      tokens = (await resp.json()) as Record<string, unknown>;
    } catch (e) {
      console.warn(`[vibe-server] Dida365 token refresh failed: ${e instanceof Error ? e.message : e}`);
      return false;
    }
    cfg["access_token_enc"] = fernetEncrypt(key, String(tokens["access_token"]));
    if (tokens["refresh_token"]) cfg["refresh_token_enc"] = fernetEncrypt(key, String(tokens["refresh_token"]));
    cfg["expires_at"] = Math.floor(Date.now() / 1000) + Number(tokens["expires_in"] ?? 3600);
    configs.save("dida365", cfg);
    registerTicktickMcp(cfg);
    return true;
  }

  const html = (c: import("hono").Context, body: string, status: 200 | 400 | 500 = 200) =>
    c.body(`<!DOCTYPE html><html><body>${body}</body></html>`, status, { "content-type": "text/html; charset=utf-8" });

  app.get("/api/dida365/status", (c) => {
    getCurrentUser(c, auth);
    const cfg = configs.load("dida365");
    return c.json({
      connected: Boolean(cfg["access_token_enc"]),
      service_type: String(cfg["service_type"] ?? ""),
      project_id: String(cfg["project_id"] ?? ""),
    });
  });

  app.post("/api/dida365/setup-mcp", async (c) => {
    getCurrentUser(c, auth);
    const alreadyInstalled = existsSync(mcpDir());
    if (!alreadyInstalled) {
      // clone 照移植；uv venv/pip install 环节见文件头注释（环境预置外部化）。
      try {
        await execFileAsync("git", ["clone", TICKTICK_MCP_REPO, mcpDir()], { timeout: 60_000 });
      } catch (e) {
        const stderr = (e as { stderr?: string }).stderr ?? "";
        throw new HttpError(500, `git clone failed: ${String(stderr).trim() || (e instanceof Error ? e.message : String(e))}`);
      }
    }
    return c.json({ ok: true, already_installed: alreadyInstalled, path: mcpDir() });
  });

  app.post("/api/dida365/authorize", async (c) => {
    getCurrentUser(c, auth);
    const body = (await c.req.json().catch(() => ({}))) as { client_id?: string; client_secret?: string; service_type?: string };
    if (!body.client_id || !body.client_secret) throw new HttpError(422, "client_id and client_secret required");
    const svc = body.service_type ?? "dida365";
    const urls = SERVICE_URLS[svc];
    if (!urls) throw new HttpError(400, `Invalid service_type: ${svc}`);

    const cfg = configs.load("dida365");
    cfg["service_type"] = svc;
    cfg["client_id"] = body.client_id;
    cfg["client_secret_enc"] = fernetEncrypt(key, body.client_secret);
    cfg["base_url"] = urls.base_url;
    cfg["token_url"] = urls.token_url;
    cfg["auth_url"] = urls.auth_url;
    configs.save("dida365", cfg);

    pruneExpiredStates();
    const state = randomBytes(32).toString("base64url");
    const callbackUrl = `${new URL(c.req.url).origin}/api/dida365/callback`;
    pendingStates.set(state, { expires: Date.now() / 1000 + 300, redirect_uri: callbackUrl });
    const params = new URLSearchParams({
      client_id: body.client_id,
      response_type: "code",
      redirect_uri: callbackUrl,
      scope: "tasks:read tasks:write",
      state,
    });
    return c.json({ auth_url: `${urls.auth_url}?${params}`, callback_url: callbackUrl });
  });

  // 免认证：OAuth 回调是浏览器重定向（对照原实现无 Depends(get_current_user)）。
  app.get("/api/dida365/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const error = c.req.query("error");
    if (error) return html(c, `<h2>Authorization Failed</h2><p>Error: ${error}</p><p>You can close this window.</p>`, 400);
    if (!code || !state) return html(c, "<h2>Invalid Request</h2><p>Missing code or state parameter.</p>", 400);

    pruneExpiredStates();
    const stateData = pendingStates.get(state);
    if (!stateData) return html(c, "<h2>Invalid or Expired State</h2><p>Please try connecting again.</p>", 400);
    pendingStates.delete(state);
    const callbackUrl = stateData.redirect_uri;

    const cfg = configs.load("dida365");
    if (!cfg["client_id"]) return html(c, "<h2>Configuration Error</h2><p>Client credentials not found.</p>", 500);
    let clientSecret: string;
    try {
      clientSecret = decryptOrThrow(String(cfg["client_secret_enc"] ?? ""));
    } catch {
      return html(c, "<h2>Configuration Error</h2><p>Failed to decrypt client secret.</p>", 500);
    }
    const tokenUrl = String(cfg["token_url"] ?? "");

    let tokens: Record<string, unknown>;
    try {
      const resp = await fetchImpl(tokenUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${Buffer.from(`${cfg["client_id"]}:${clientSecret}`).toString("base64")}`,
        },
        body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: callbackUrl }).toString(),
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      tokens = (await resp.json()) as Record<string, unknown>;
    } catch (e) {
      return html(c, `<h2>Token Exchange Failed</h2><p>${e instanceof Error ? e.message : String(e)}</p><p>You can close this window.</p>`, 500);
    }

    cfg["access_token_enc"] = fernetEncrypt(key, String(tokens["access_token"]));
    if (tokens["refresh_token"]) cfg["refresh_token_enc"] = fernetEncrypt(key, String(tokens["refresh_token"]));
    cfg["expires_at"] = Math.floor(Date.now() / 1000) + Number(tokens["expires_in"] ?? 3600);
    configs.save("dida365", cfg);
    registerTicktickMcp(cfg);

    return html(
      c,
      "<h2>Connected Successfully!</h2><p>You can close this window and return to Vibe Seller.</p><script>window.close()</script>",
    );
  });

  app.get("/api/dida365/projects", async (c) => {
    getCurrentUser(c, auth);
    let cfg = configs.load("dida365");
    if (!cfg["access_token_enc"]) throw new HttpError(400, "Not connected");
    await refreshTokenIfNeeded();
    cfg = configs.load("dida365");
    let accessToken: string;
    try {
      accessToken = decryptOrThrow(String(cfg["access_token_enc"] ?? ""));
    } catch {
      throw new HttpError(400, "Not connected");
    }
    const baseUrl = String(cfg["base_url"] ?? "https://api.ticktick.com/open/v1");
    const doGet = (token: string) =>
      fetchImpl(`${baseUrl}/project`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      });
    try {
      let resp = await doGet(accessToken);
      if (resp.status === 401) {
        const refreshed = await refreshTokenIfNeeded();
        if (refreshed) {
          cfg = configs.load("dida365");
          accessToken = decryptOrThrow(String(cfg["access_token_enc"] ?? ""));
          resp = await doGet(accessToken);
        }
        if (resp.status === 401) throw new HttpError(401, "Token expired, reconnect");
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const projects = (await resp.json()) as { id?: string; name?: string }[];
      return c.json(projects.map((p) => ({ id: p.id ?? "", name: p.name ?? "" })));
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(500, `Failed to list projects: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  app.post("/api/dida365/configure", async (c) => {
    getCurrentUser(c, auth);
    const body = (await c.req.json().catch(() => ({}))) as { project_id?: string };
    if (body.project_id === undefined) throw new HttpError(422, "project_id required");
    const cfg = configs.load("dida365");
    cfg["project_id"] = body.project_id;
    configs.save("dida365", cfg);
    if (cfg["access_token_enc"]) registerTicktickMcp(cfg);
    return c.json({ ok: true });
  });

  app.delete("/api/dida365/disconnect", (c) => {
    getCurrentUser(c, auth);
    const cfg = configs.load("dida365");
    for (const k of ["access_token_enc", "refresh_token_enc", "expires_at"]) delete cfg[k];
    configs.save("dida365", cfg);
    const mcpData = readMcpConfig();
    const servers = (mcpData["mcpServers"] ?? {}) as Record<string, unknown>;
    if ("ticktick" in servers) {
      delete servers["ticktick"];
      mcpData["mcpServers"] = servers;
      atomicWriteJson(mcpJsonPath(), mcpData);
    }
    return c.json({ ok: true });
  });
}
