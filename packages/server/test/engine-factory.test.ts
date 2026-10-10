// Phase 5.1 engine 工厂测试：VIBE_BRIDGE_MCP_COMMAND 分支已删除——env 设了也不生效
//（零子进程），默认原生 ToolPort（进程内 app.request 自调）；工具面 22/21 两态随能力门；
// dispose 无进程可清 → undefined（返回件形状 tools/toolSpecs/dispose 不变）。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolIntent } from "@vibe/core";
import { createApp, hashPassword, type AppDeps } from "../src/app";
import { openDb, seed } from "../src/db";
import { EventBus } from "../src/bus";
import { defaultEngineFactory } from "../src/agent/engine";
import { BrowserStarter } from "../src/browser/starter";
import type { ServerConfig } from "../src/config";

let dir: string;
let deps: AppDeps;
let app: ReturnType<typeof createApp>;
let factoryEnv: NodeJS.ProcessEnv;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibe-engine-"));
  const config: ServerConfig = {
    homeDir: dir,
    dataDir: dir,
    dbPath: join(dir, "vibe_seller.db"),
    jwtSecretFile: join(dir, "jwt_secret"),
    port: 0,
    adminEmail: "admin@vibe-seller.local",
    adminPassword: "admin",
    adminUsername: "admin",
    version: "0.1.0-test",
    jwtSecret: "test-secret",
  };
  const db = openDb(config);
  seed(db, config, hashPassword);
  deps = { config, jwtSecret: "test-secret", db, bus: new EventBus() };
  app = createApp(deps);
  factoryEnv = {
    VIBE_BRIDGE_API_KEY: "test-key",
    // MCP 分支删除的钉子：设了也不 spawn（实现里已无该分支；若有残留引用此测试失败）
    VIBE_BRIDGE_MCP_COMMAND: "python -m app.mcp_server --port 9999",
    VIBE_BRIDGE_DATA_DIR: dir,
  };
});

afterAll(async () => {
  deps.db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("defaultEngineFactory（原生 ToolPort）", () => {
  it("VIBE_BRIDGE_MCP_COMMAND 不再生效：dispose 为空，工具进程内执行（零子进程）", async () => {
    const factory = defaultEngineFactory(factoryEnv, deps.config, { db: deps.db, app, jwtSecret: "test-secret" });
    const per = await factory({ taskId: "t1", profileId: "default" });
    // 返回件形状 = engine/tools/gates/dispose（toolSpecs 只进 makeEngine，不出工厂）
    expect(per.dispose).toBeUndefined();
    expect(typeof per.engine).toBe("function");
    expect(typeof per.tools.execute).toBe("function");

    // list_stores 打的是进程内 Hono app（种子库为空 → []），不是 Python 子进程
    const r = await per.tools.execute({ name: "vibe_seller_list_stores", arguments: {} } as ToolIntent, new AbortController().signal);
    expect(r.status).toBe("success");
    expect(r.result).toEqual([]);

    // generate_image 隐藏 ≠ 不可调用：dispatch 打到进程内端点，无 key 时端点自报
    // 400 detail（按成功形状透出，原 call_api 无 raise_for_status）
    const img = await per.tools.execute({ name: "vibe_seller_generate_image", arguments: { prompt: "p" } } as ToolIntent, new AbortController().signal);
    expect(img.status).toBe("success");
    expect(img.result).toMatchObject({ detail: expect.stringContaining("kie.ai API key") });
  });

  it("能力门 true（VISION_FAKE）→ 工厂正常组装（22/21 两态钉在 native-tools.test.ts）", async () => {
    process.env["VISION_FAKE"] = "1";
    try {
      const factory = defaultEngineFactory(factoryEnv, deps.config, { db: deps.db, app, jwtSecret: "test-secret" });
      const per = await factory({ taskId: "t2", profileId: "default" });
      expect(per.dispose).toBeUndefined();
      expect(typeof per.tools.execute).toBe("function");
    } finally {
      delete process.env["VISION_FAKE"];
    }
  });

  it("无 API key 且无 profiles → 工厂报错（既有守卫不变）", async () => {
    const factory = defaultEngineFactory({}, deps.config, { db: deps.db, app, jwtSecret: "test-secret" });
    await expect(factory({ taskId: "t3", profileId: "default" })).rejects.toThrow("未配置 VIBE_BRIDGE_API_KEY");
  });
});

describe("browse 接线（T4：starter + browser_tools_enabled 设置位 → 注入/可见性）", () => {
  // 工厂返回形状不变（toolSpecs 只进 makeEngine，不外露），27/22 的 schema 计数钉在
  // native-tools.test.ts；本文件按该文件既有方式用 dispatch 行为钉接线三态。
  // 构造 BrowserStarter 无副作用；断言走 BrowseToolkit 参数校验层（先于会话解析），
  // 绝不 spawn Chrome。
  const realStarter = () => new BrowserStarter({ config: deps.config, db: deps.db });
  const setBrowserToolsEnabled = (value: string) => {
    deps.db
      .prepare("INSERT INTO app_settings (key, value) VALUES ('browser_tools_enabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(value);
  };

  it("传 starter 且设置开（缺省 true）→ browse 注入生效：dispatch 命中 BrowseToolkit 校验层（PRD scheme 守卫），而非 disabled 兜底", async () => {
    const factory = defaultEngineFactory(factoryEnv, deps.config, { db: deps.db, app, jwtSecret: "test-secret", starter: realStarter() });
    const per = await factory({ taskId: "t4a", profileId: "default" });
    const r = await per.tools.execute({ name: "vibe_seller_browser_navigate", arguments: { url: "file:///etc/passwd" } } as ToolIntent, new AbortController().signal);
    expect(r.status).toBe("error");
    expect(r.error!.message).toContain("navigate refused");
  });

  it("browser_tools_enabled=false → 22 工具面（browse 隐藏）：dispatch 走 disabled 兜底（starter 在场也不注入）", async () => {
    setBrowserToolsEnabled("false");
    try {
      const factory = defaultEngineFactory(factoryEnv, deps.config, { db: deps.db, app, jwtSecret: "test-secret", starter: realStarter() });
      const per = await factory({ taskId: "t4b", profileId: "default" });
      const r = await per.tools.execute({ name: "vibe_seller_browser_navigate", arguments: { url: "https://example.com" } } as ToolIntent, new AbortController().signal);
      expect(r.error).toEqual({ code: "tool_error", message: "browser tools are disabled or not wired on this server" });
    } finally {
      setBrowserToolsEnabled("true");
    }
  });

  it("不传 starter → 22 工具面：dispatch 走 disabled 兜底（设置开与 starter 缺一不注入）", async () => {
    const factory = defaultEngineFactory(factoryEnv, deps.config, { db: deps.db, app, jwtSecret: "test-secret" });
    const per = await factory({ taskId: "t4c", profileId: "default" });
    const r = await per.tools.execute({ name: "vibe_seller_browser_eval", arguments: { expression: "1+1" } } as ToolIntent, new AbortController().signal);
    expect(r.error).toEqual({ code: "tool_error", message: "browser tools are disabled or not wired on this server" });
  });
});
