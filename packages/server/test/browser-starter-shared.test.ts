// 共享浏览器组（share_group）starter 侧契约：storeSessionIdentity 身份解析、
// ensureStoreChrome 同组单实例（同端口/同 profile 目录/每店一行）、专用+共享混存、
// sweepIdleBrowsers 组粒度（任一成员被活跃任务持有即豁免；杀掉后全成员行复位）。
// 测试边界与 browser-starter-ensure.test.ts 同款：零真网（fetchImpl 脚本化）、零真
// Chrome（VIBE_CHROME_PATH=process.execPath，spawn 即退）、sessions Map 模块私有 →
// 跨测试用互不相同的组名/店铺 id，外部观察口 = peekCdpPort(原始 key) + browser_sessions 行。

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, seed } from "../src/db";
import { hashPassword } from "../src/app";
import type { ServerConfig } from "../src/config";
import { BrowserStarter, resetStarterSessionsForTests, storeSessionIdentity } from "../src/browser/starter";

let dir: string;
let db: import("node:sqlite").DatabaseSync;
let config: ServerConfig;
let starter: BrowserStarter;
let prevChromePath: string | undefined;

const okFetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;

beforeEach(async () => {
  resetStarterSessionsForTests(); // sessions Map 模块级共享：清残留，sweep stopped 计数才可精确断言
  dir = await mkdtemp(join(tmpdir(), "vibe-bss-"));
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
  starter = new BrowserStarter({ config, db, readinessTimeoutMs: 50, fetchImpl: okFetch });
  prevChromePath = process.env["VIBE_CHROME_PATH"];
  process.env["VIBE_CHROME_PATH"] = process.execPath;
});

afterEach(async () => {
  if (prevChromePath === undefined) delete process.env["VIBE_CHROME_PATH"];
  else process.env["VIBE_CHROME_PATH"] = prevChromePath;
  db.close();
  await rm(dir, { recursive: true, force: true });
});

function seedStore(id: string, name: string, browserConfig: Record<string, unknown> | null): void {
  db.prepare(
    "INSERT INTO stores (id, name, browser_backend, browser_config, ziniao_account_id, browser_oauth, platforms, countries, platform_countries, capabilities, config, created_at, updated_at) VALUES (?, ?, 'chrome', ?, NULL, NULL, '[]', '[]', '{}', '{}', NULL, ?, ?)",
  ).run(id, name, browserConfig === null ? null : JSON.stringify(browserConfig), new Date().toISOString(), new Date().toISOString());
}

function seedTask(id: string, storeId: string, status: string): void {
  // created_by 取 seed 出的 admin 用户 id（tasks.created_by NOT NULL）
  db.prepare("INSERT INTO tasks (id, store_id, title, status, created_by) VALUES (?, ?, ?, ?, '00000000-0000-0000-0000-000000000001')").run(id, storeId, `t-${id}`, status);
}

function rowsOf(...storeIds: string[]): { store_id: string; status: string; cdp_port: number | null }[] {
  return db
    .prepare(`SELECT store_id, status, cdp_port FROM browser_sessions WHERE store_id IN (${storeIds.map(() => "?").join(",")}) ORDER BY store_id`)
    .all(...storeIds) as { store_id: string; status: string; cdp_port: number | null }[];
}

describe("storeSessionIdentity（身份解析单一事实源）", () => {
  it("share_group 非空 → shared:<组> / _shared-<组>；未入组/空串/坏 JSON → 专用身份", () => {
    expect(storeSessionIdentity({ id: "s1", name: "My Shop", browser_config: '{"share_group":"main"}' })).toEqual({ key: "shared:main", slug: "_shared-main" });
    expect(storeSessionIdentity({ id: "s2", name: "My Shop", browser_config: "{}" })).toEqual({ key: "s2", slug: "my-shop" });
    expect(storeSessionIdentity({ id: "s3", name: "My Shop", browser_config: '{"share_group":""}' })).toEqual({ key: "s3", slug: "my-shop" });
    expect(storeSessionIdentity({ id: "s4", name: "My Shop", browser_config: "not-json" })).toEqual({ key: "s4", slug: "my-shop" });
    expect(storeSessionIdentity({ id: "s5", name: "My Shop" })).toEqual({ key: "s5", slug: "my-shop" });
  });
});

describe("ensureStoreChrome 共享组（同组单实例）", () => {
  it("同组两店 → 同端口单实例：返回 shared: key、每店一行且共享端口、profile 目录 _shared-<组>", async () => {
    seedStore("sh-a", "Shop A", { share_group: "g1" });
    seedStore("sh-b", "Shop B", { share_group: "g1" });
    const ra = await starter.ensureStoreChrome({ id: "sh-a", name: "Shop A", browser_config: '{"share_group":"g1"}' }, true);
    const rb = await starter.ensureStoreChrome({ id: "sh-b", name: "Shop B", browser_config: '{"share_group":"g1"}' }, true);
    expect(ra.key).toBe("shared:g1");
    expect(rb.key).toBe("shared:g1");
    expect(rb.cdpPort).toBe(ra.cdpPort); // 第二次命中同 key 复用（专用语义下必然新端口）
    expect(rowsOf("sh-a", "sh-b")).toEqual([
      { store_id: "sh-a", status: "running", cdp_port: ra.cdpPort },
      { store_id: "sh-b", status: "running", cdp_port: ra.cdpPort },
    ]);
    expect(existsSync(join(dir, "browser_profiles", "_shared-g1"))).toBe(true);
    expect(existsSync(join(dir, "browser_profiles", "shop-a"))).toBe(false);
    expect(await starter.peekCdpPort("shared:g1")).toBe(ra.cdpPort);
  });

  it("专用+共享混存：未入组店走自己 key 与独立端口", async () => {
    seedStore("sh-g", "Shop G", { share_group: "g2" });
    seedStore("sh-solo", "Solo", {});
    const rg = await starter.ensureStoreChrome({ id: "sh-g", name: "Shop G", browser_config: '{"share_group":"g2"}' }, true);
    const rs = await starter.ensureStoreChrome({ id: "sh-solo", name: "Solo", browser_config: "{}" }, true);
    expect(rs.key).toBe("sh-solo");
    expect(rs.cdpPort).not.toBe(rg.cdpPort);
    expect(existsSync(join(dir, "browser_profiles", "_shared-g2"))).toBe(true);
    expect(existsSync(join(dir, "browser_profiles", "solo"))).toBe(true);
  });
});

describe("sweepIdleBrowsers 组粒度", () => {
  it("成员 A 有活跃任务 → 老化越过阈值仍豁免（共享实例存活、两行仍 running）", async () => {
    seedStore("sw-ha", "Hold A", { share_group: "g3" });
    seedStore("sw-hb", "Hold B", { share_group: "g3" });
    const r = await starter.ensureStoreChrome({ id: "sw-ha", name: "Hold A", browser_config: '{"share_group":"g3"}' }, true);
    await starter.ensureStoreChrome({ id: "sw-hb", name: "Hold B", browser_config: '{"share_group":"g3"}' }, true);
    seedTask("task-hold", "sw-hb", "running"); // 任一成员（此处 B）持有即全组豁免
    await new Promise((resolve) => setTimeout(resolve, 1100)); // 老化越过 1s 阈值
    const stopped = await starter.sweepIdleBrowsers(1);
    expect(stopped).toBe(0);
    expect(await starter.peekCdpPort("shared:g3")).toBe(r.cdpPort);
    expect(rowsOf("sw-ha", "sw-hb").every((row) => row.status === "running")).toBe(true);
  });

  it("无持有 + 老化 → 杀一个实例（stopped=1）、全成员行复位 idle、peek null", async () => {
    seedStore("sw-ka", "Kill A", { share_group: "g4" });
    seedStore("sw-kb", "Kill B", { share_group: "g4" });
    const r = await starter.ensureStoreChrome({ id: "sw-ka", name: "Kill A", browser_config: '{"share_group":"g4"}' }, true);
    await starter.ensureStoreChrome({ id: "sw-kb", name: "Kill B", browser_config: '{"share_group":"g4"}' }, true);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const stopped = await starter.sweepIdleBrowsers(1);
    expect(stopped).toBe(1); // 组级单实例：只停一个浏览器，不是每成员一个
    expect(await starter.peekCdpPort("shared:g4")).toBeNull();
    expect(rowsOf("sw-ka", "sw-kb")).toEqual([
      { store_id: "sw-ka", status: "idle", cdp_port: null },
      { store_id: "sw-kb", status: "idle", cdp_port: null },
    ]);
  });

  it("组内部分成员退组：退组店回专用身份，原组实例不受牵连", async () => {
    seedStore("sw-la", "Leave A", { share_group: "g5" });
    const r = await starter.ensureStoreChrome({ id: "sw-la", name: "Leave A", browser_config: '{"share_group":"g5"}' }, true);
    // 退组（browser_config 清掉 share_group）后再 ensure → 专用 key 新实例
    const r2 = await starter.ensureStoreChrome({ id: "sw-la", name: "Leave A", browser_config: "{}" }, true);
    expect(r2.key).toBe("sw-la");
    expect(r2.cdpPort).not.toBe(r.cdpPort);
  });
});
