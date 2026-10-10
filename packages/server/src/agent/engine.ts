// server 的默认引擎工厂：pi 引擎构建 + 原生 ToolPort。
// Phase 5.1：VIBE_BRIDGE_MCP_COMMAND 分支已删除——22 个工具改由进程内 app.request
// 自调（native-tools.ts，逐语义移植原 app/mcp_server.py），env 设了也不再拉起任何
// Python 子进程（engine-factory.test.ts 钉死）。
// env 复用 VIBE_BRIDGE_* 命名（同一套配置同时驱动桥进程与 TS server）：
//   VIBE_BRIDGE_API_KEY / BASE_URL / MODEL / PROVIDER_ID / SKILLS_DIR / GATED_TOOLS
// 多供应商 profile 两个来源（按 profileId 解析）：
//   1. 桥 profiles.json（api_key_env 引用格式，密钥只走环境变量）；
//   2. UI 管理的 ~/.vibe-seller/profiles.json（原仓库格式，env 内含密钥）——
//      deriveVibeProfile 在内存里派生 pi profile；密钥值进 buildPi 后绝不打印、
//      绝不入事件/日志/RunLog/SSE 帧。default 恒走单供应商环境变量。
// 测试注入 engineFactory 覆盖（scripted 引擎，零网络）。

import {
  buildPi,
  gatePolicyFor,
  loadProfiles,
  readEnv,
  toVibeToolSpecs,
  type PiBundle,
  type VibeProfile,
} from "@vibe/bridge";
import type { GatePolicy } from "@vibe/core";
import { readFileSync, statSync } from "node:fs";
import type { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { BrowseToolkit } from "../browser/browse";
import type { BrowserStarter } from "../browser/starter";
import { getSetting } from "../db";
import { ProfileManager } from "../profiles/manager";
import { VisionConfig, catalogPublic, DEFAULT_MODEL, isFake, modelIds } from "../vision/vision";
import {
  buildNativeToolSchemas,
  createNativeToolPort,
  filterVisibleTools,
  imageModelGuide,
  mintServiceToken,
} from "./native-tools";
import type { EngineFactory } from "./orchestrator";
import type { ServerConfig } from "../config";

export function defaultEngineFactory(
  env: NodeJS.ProcessEnv,
  config: ServerConfig,
  loopback: { db: DatabaseSync; app: Hono; jwtSecret: string; starter?: BrowserStarter },
): EngineFactory {
  const bridgeEnv = readEnv(env);
  const gates: GatePolicy | undefined = gatePolicyFor(bridgeEnv.gatedTools);
  const uiProfiles = new ProfileManager(ProfileManager.defaultPath(config.homeDir));
  const piBundles = new Map<string, Promise<PiBundle>>();

  const hasBridgeProfiles = Boolean(bridgeEnv.profilesPath && exists(bridgeEnv.profilesPath));

  /** profileId → pi 运行时 profile；default → undefined（单供应商 env）；未知 → null。 */
  const resolveProfile = (profileId: string): VibeProfile | undefined | null => {
    if (profileId === "default") return undefined;
    if (hasBridgeProfiles) {
      try {
        const loaded = loadProfiles(readFileSync(bridgeEnv.profilesPath!, "utf8"), env);
        const p = loaded.profiles.get(profileId);
        if (p) return p;
      } catch {
        /* 桥 profiles 损坏/缺 key → 落 UI 档案 */
      }
    }
    const derived = uiProfiles.deriveVibeProfile(profileId);
    if (!derived) return null; // 两处都没有
    if (!derived.model) throw new Error(`profile ${profileId} 未配置 ANTHROPIC_MODEL`);
    if (!derived.apiKey) {
      throw new Error(`profile ${profileId} 未配置 API key（env 需要 ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY）`);
    }
    return derived;
  };

  const getPi = (profileId: string, profile: VibeProfile | undefined): Promise<PiBundle> => {
    // 缓存键带 profiles.json mtime：UI 改档后新 run 取新配置，无需重启
    let mtime = 0;
    try {
      mtime = statSync(uiProfiles.path).mtimeMs;
    } catch {
      /* 无 UI profiles 文件 */
    }
    const cacheKey = `${profileId}:${mtime}`;
    let bundle = piBundles.get(cacheKey);
    if (!bundle) {
      bundle = buildPi(bridgeEnv, gates, profile);
      piBundles.set(cacheKey, bundle);
    }
    return bundle;
  };

  return async ({ taskId, profileId }) => {
    const hasAnyProfiles = hasBridgeProfiles || exists(uiProfiles.path);
    if (!env.VIBE_BRIDGE_API_KEY && !hasAnyProfiles) {
      throw new Error("未配置 VIBE_BRIDGE_API_KEY：TS server 无可用模型引擎（测试可注入 engineFactory）");
    }
    const profile = resolveProfile(profileId);
    if (profile === null) {
      const known = ["default"];
      if (hasBridgeProfiles) {
        try {
          known.push(...loadProfiles(readFileSync(bridgeEnv.profilesPath!, "utf8"), env).profiles.keys());
        } catch {
          /* 忽略 */
        }
      }
      known.push(...uiProfiles.listProfiles().map((p) => String(p.id)));
      throw new Error(`未知 profile：${profileId}（可用：${[...new Set(known)].join(", ")}）`);
    }
    const pi = await getPi(profileId, profile);

    // 原生工具面每 run 组装：能力门此刻判定，等价原 MCP 每 run _visible_tools()
    // （mcp_server.py:40-47：无 KIE key 且非 fake → 隐藏 vibe_seller_generate_image）。
    // 隐藏 ≠ 不可调用：dispatch 与可见性无关（原 tools/call 同样不查可见性）。
    // T4 browse 位（路线 2 PRD §六.9）：browser_tools_enabled 缺省 true，false 时
    // 五个 browse 工具从 schema 隐藏；缺省语义 = 容错解析，仅 SELECT（getSetting）。
    const browseEnabled = getSetting(loopback.db, "browser_tools_enabled") !== "false";
    const visionCapability = Boolean(new VisionConfig(config.homeDir).getKieApiKey()) || isFake();
    const schemas = filterVisibleTools(
      buildNativeToolSchemas({ imageModelIds: modelIds(), imageModelGuide: imageModelGuide(catalogPublic(), DEFAULT_MODEL) }),
      visionCapability,
      browseEnabled,
    );
    const starter = loopback.starter;
    const tools = createNativeToolPort({
      app: loopback.app,
      taskId,
      // 服务令牌每 run 签发（原 claude_backend.py:498-545 注册 MCP 时签发同构：
      // sub/role 取 ai_bot 用户、缺省 ('system','admin')、7 天 TTL；原实现以 cookie
      // 附带——见 native-tools.ts 头注的实读裁决）。secret 用 app 解析后的同一把，
      // 令牌必须能被本进程 auth 校验。
      authToken: mintServiceToken(loopback.db, loopback.jwtSecret),
      // browse 注入 = starter 与设置位缺一不可；未注入时 dispatch 走 disabled 兜底
      //（native-tools.ts）。headless 读取对齐 routes_browser.ts readHeadless 的同款语义：
      // CI=true 强制 headless；否则读设置缺省 false（不为此重构该文件）。
      browse:
        starter && browseEnabled
          ? new BrowseToolkit(
              {
                db: loopback.db,
                starter,
                headless: () => process.env["CI"] === "true" || getSetting(loopback.db, "browser_headless") === "true",
              },
              taskId,
            )
          : undefined,
    });
    const toolSpecs = toVibeToolSpecs(schemas);
    // 无进程可清 → dispose 恒空（返回件形状 tools/toolSpecs/dispose 不变）
    return { engine: pi.makeEngine(tools, toolSpecs), tools, gates, dispose: undefined };
  };
}

function exists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}
