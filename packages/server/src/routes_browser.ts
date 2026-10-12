// 批次 4.6 路由：browser(3)。契约对齐 app/routers/browser.py：
// launcher 免认证（下载 BASE_DIR/ziniao_webdriver.bat）；web/start 的 force
// 是兼容性 no-op；aux/start 的 headless 取 CI env / browser_headless 设置。
// BrowserBusyError → 503（启动锁被占不是"坏了"；PRD 写 409，参考实现为 503，从参考）。

import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HttpError } from "./types";
import { getCurrentUser, type AuthContext } from "./auth";
import type { ServerConfig } from "./config";
import { BrowserBusyError, BrowserStarter, ZiniaoNormalModeError, forceRelaunchZiniao, storeSessionIdentity } from "./browser/starter";
import type { ZiniaoUserInfo } from "./browser/ziniao";
import { readBookmarks, readZiniaoBookmarks } from "./browser/bookmarks";
import { deriveFernetKey, fernetDecryptText } from "./crypto/fernet";

export interface BrowserDeps {
  config: ServerConfig;
  db: DatabaseSync;
  auth: AuthContext;
  jwtSecret: string;
  /** TS 侧仓库根（ziniao_webdriver.bat 所在）；env VIBE_TS_ROOT 解析。 */
  tsRoot?: string;
  starter: BrowserStarter;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}

function readHeadless(db: DatabaseSync): boolean {
  if (process.env["CI"] === "true") return true;
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'browser_headless'").get() as { value: string } | undefined;
  return Boolean(row && row.value === "true");
}

export function registerBrowserRoutes(app: Hono, deps: BrowserDeps): void {
  const { db, auth, config } = deps;

  // 免认证：launcher 下载（对照原实现无 Depends）。
  app.get("/api/ziniao/launcher", (c) => {
    const root = deps.tsRoot ?? process.env["VIBE_TS_ROOT"] ?? "";
    const batPath = root ? join(root, "ziniao_webdriver.bat") : "";
    if (!batPath || !existsSync(batPath)) throw new HttpError(404, "Launcher script not found");
    return c.body(new Uint8Array(readFileSync(batPath)), 200, {
      "content-type": "application/octet-stream",
      "content-disposition": 'attachment; filename="ziniao_webdriver.bat"',
    });
  });

  // 店铺书签（stores.py 的遗留项，本批收回）：读店铺浏览器 profile 的 Bookmarks。
  // slug 经 storeSessionIdentity：入组店的 profile 在 `_shared-<组>`，不在店铺 slug 目录。
  app.get("/api/stores/:store_id/bookmarks", (c) => {
    getCurrentUser(c, auth);
    const store = db.prepare("SELECT * FROM stores WHERE id = ?").get(c.req.param("store_id") ?? "") as
      | { id: string; name: string; browser_backend: string | null; browser_config: string | null; browser_oauth: string | null }
      | undefined;
    if (!store) throw new HttpError(404, "Store not found");
    if (store.browser_backend === "chrome") {
      return c.json(readBookmarks(config.homeDir, storeSessionIdentity(store).slug));
    }
    if (store.browser_backend === "ziniao" && store.browser_oauth) {
      return c.json(readZiniaoBookmarks(store.browser_oauth));
    }
    return c.json([]);
  });

  app.post("/api/browser/web/start", async (c) => {
    getCurrentUser(c, auth);
    // force 查询参数仅为与 store 路由对齐——web 浏览器无 ziniao 强重启路径（原实现注释同款）。
    try {
      await deps.starter.startWebSession(readHeadless(db));
    } catch (e) {
      if (e instanceof BrowserBusyError) throw new HttpError(503, e.message);
      throw new HttpError(500, `Failed to start web browser: ${e instanceof Error ? e.message : String(e)}`);
    }
    return c.json({ ok: true });
  });

  app.post("/api/stores/:store_id/browser/aux/start", async (c) => {
    getCurrentUser(c, auth);
    const store = db.prepare("SELECT * FROM stores WHERE id = ?").get(c.req.param("store_id") ?? "") as { id: string; name: string } | undefined;
    if (!store) throw new HttpError(404, "Store not found");
    try {
      return c.json(await deps.starter.startAux(store, readHeadless(db)));
    } catch (e) {
      throw new HttpError(500, `Failed to start aux browser: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  // 店铺主浏览器启动（stores.py:395 的 force 路径在本批收回）
  app.post("/api/stores/:store_id/browser/start", async (c) => {
    getCurrentUser(c, auth);
    const force = c.req.query("force") === "true";
    const store = db.prepare("SELECT * FROM stores WHERE id = ?").get(c.req.param("store_id") ?? "") as
      | { id: string; name: string; browser_backend: string | null; ziniao_account_id: string | null }
      | undefined;
    if (!store) throw new HttpError(404, "Store not found");

    const ziniaoCreds = (): { socket_port: number; client_path: string; user_info: ZiniaoUserInfo } | null => {
      if (store.browser_backend !== "ziniao" || !store.ziniao_account_id) return null;
      const account = db.prepare("SELECT * FROM ziniao_accounts WHERE id = ?").get(store.ziniao_account_id) as
        | { company: string; username: string; encrypted_password: string; socket_port: number | null; client_path: string | null }
        | undefined;
      if (!account) return null;
      const key = deriveFernetKey(deps.jwtSecret);
      return {
        socket_port: account.socket_port ?? 16851,
        client_path: account.client_path || "ziniao",
        user_info: { company: account.company, username: account.username, password: fernetDecryptText(key, account.encrypted_password) },
      };
    };

    try {
      await deps.starter.startStoreSession(store, readHeadless(db), ziniaoCreds());
      return c.json({ ok: true });
    } catch (e) {
      if (e instanceof BrowserBusyError) throw new HttpError(503, e.message);
      if (e instanceof ZiniaoNormalModeError) {
        // force=true 且是 ziniao 店 → 强重启后重试；否则原样失败（安全边界保持显式）。
        if (force) {
          const creds = ziniaoCreds();
          if (creds) {
            try {
              await forceRelaunchZiniao(creds, deps.fetchImpl);
            } catch (relaunchErr) {
              throw new HttpError(502, `Ziniao relaunch failed: ${relaunchErr instanceof Error ? relaunchErr.message : String(relaunchErr)}`);
            }
            try {
              await deps.starter.startStoreSession(store, readHeadless(db), creds);
              return c.json({ ok: true });
            } catch (retryErr) {
              throw new HttpError(500, `Failed to start browser after Ziniao relaunch: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`);
            }
          }
        }
        throw new HttpError(500, `Failed to start browser: ${e instanceof Error ? e.message : String(e)}`);
      }
      void config;
      throw new HttpError(500, `Failed to start browser: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
}
