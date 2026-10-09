// SPA 静态托管契约：批次 4.7 e2e 发现的 Windows 路径缺陷回归钉子。
// FRONTEND_DIST 以正斜杠形式传入（跨平台脚本/环境变量的常见写法）时，
// 前缀守卫曾因 join() 产出反斜杠而全部失配 → 所有资产请求落到 index.html
// （text/html），浏览器拒载模块脚本、页面白屏。修复后两侧都经 path.resolve
// 归一再比对（原缺陷现场见批次 4.7 交付报告）。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, hashPassword, type AppDeps } from "../src/app";
import { openDb, seed } from "../src/db";
import { EventBus } from "../src/bus";
import type { ServerConfig } from "../src/config";

let dir: string;
let deps: AppDeps;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "vibe-spa-"));
  const dist = join(dir, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><html><body><div id=\"root\"></div></body></html>");
  writeFileSync(join(dist, "assets", "app.js"), "console.log('spa-asset-js');");
  writeFileSync(join(dist, "assets", "app.css"), "body{color:red}");
  // 刻意用正斜杠形式构造（Windows 上 join() 产出反斜杠，曾触发前缀失配）
  const frontendDist = dist.split(sep).join("/");
  const cfg: ServerConfig = {
    homeDir: dir,
    dataDir: join(dir, "data"),
    dbPath: join(dir, "data", "vibe_seller.db"),
    jwtSecretFile: join(dir, "data", "jwt_secret"),
    port: 0,
    adminEmail: "admin@vibe-seller.local",
    adminPassword: "admin",
    adminUsername: "admin",
    version: "0.1.0-test",
    jwtSecret: "test-secret",
    frontendDist,
  };
  mkdirSync(cfg.dataDir, { recursive: true });
  const db = openDb(cfg);
  seed(db, cfg, hashPassword);
  deps = { config: cfg, jwtSecret: "test-secret", db, bus: new EventBus() };
  app = createApp(deps);
});

afterAll(() => {
  deps.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("SPA 静态托管（正斜杠 FRONTEND_DIST）", () => {
  it("资产文件按真实内容与 MIME 返回，而非 index.html 兜底", async () => {
    const res = await app.request("/assets/app.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(await res.text()).toBe("console.log('spa-asset-js');");
  });

  it("CSS 资产同上", async () => {
    const res = await app.request("/assets/app.css");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
  });

  it("根路径与深链仍回 index.html（SPA fallback 语义不变）", async () => {
    for (const p of ["/", "/settings/general"]) {
      const res = await app.request(p);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain('id="root"');
    }
  });

  it("缺失资产回 index.html；/api 404 形状不受影响", async () => {
    const miss = await app.request("/assets/nope.js");
    expect(miss.status).toBe(200);
    expect(miss.headers.get("content-type")).toContain("text/html");
    const api = await app.request("/api/no-such-route");
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ detail: "Not Found" });
  });
});
