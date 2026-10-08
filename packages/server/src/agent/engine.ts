// server 的默认引擎工厂：进程内复用 @vibe/bridge 的 pi 引擎构建 + MCP 工具面。
// env 复用 VIBE_BRIDGE_* 命名（同一套配置同时驱动桥进程与 TS server）：
//   VIBE_BRIDGE_API_KEY / BASE_URL / MODEL / PROVIDER_ID / SKILLS_DIR / GATED_TOOLS
//   VIBE_BRIDGE_MCP_COMMAND（每任务拉起 app.mcp_server，--task-id 由编排器追加）
// 多供应商 profile 两个来源（按 profileId 解析）：
//   1. 桥 profiles.json（api_key_env 引用格式，密钥只走环境变量）；
//   2. UI 管理的 ~/.vibe-seller/profiles.json（原仓库格式，env 内含密钥）——
//      deriveVibeProfile 在内存里派生 pi profile；密钥值进 buildPi 后绝不打印、
//      绝不入事件/日志/RunLog/SSE 帧。default 恒走单供应商环境变量。
// 测试注入 engineFactory 覆盖（scripted 引擎，零网络）。

import {
  buildPi,
  createMcpToolPort,
  gatePolicyFor,
  loadProfiles,
  McpServerConnection,
  readEnv,
  toVibeToolSpecs,
  type PiBundle,
  type VibeProfile,
} from "@vibe/bridge";
import { fakeTools, type GatePolicy } from "@vibe/core";
import { readFileSync, statSync } from "node:fs";
import { ProfileManager } from "../profiles/manager";
import type { EngineFactory } from "./orchestrator";
import type { ServerConfig } from "../config";

export function defaultEngineFactory(env: NodeJS.ProcessEnv, config: ServerConfig): EngineFactory {
  const bridgeEnv = readEnv(env);
  const gates: GatePolicy | undefined = gatePolicyFor(bridgeEnv.gatedTools);
  const mcpCommand = bridgeEnv.mcpCommand;
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

    let dispose: (() => Promise<void>) | undefined;
    let tools = fakeTools({});
    let toolSpecs: ReturnType<typeof toVibeToolSpecs> = [];
    if (mcpCommand) {
      const conn = new McpServerConnection({ command: [...mcpCommand, "--task-id", taskId], cwd: bridgeEnv.mcpCwd });
      try {
        await conn.initialize();
        const toolsInfo = await conn.listTools();
        tools = createMcpToolPort(conn);
        toolSpecs = toVibeToolSpecs(toolsInfo);
        dispose = () => conn.dispose();
      } catch (err: unknown) {
        await conn.dispose();
        throw err;
      }
    }
    return { engine: pi.makeEngine(tools, toolSpecs), tools, gates, dispose };
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
