// 生产引导：环境变量 → AgentRuntime（pi 或 scripted 引擎）→ 桥 HTTP 服务。
// 密钥红线：VIBE_BRIDGE_API_KEY 只在本进程内注入 ModelRuntime，绝不打印、
// 绝不入事件/RunLog/SSE 帧。
//
// 工具面：
//  - VIBE_BRIDGE_MCP_COMMAND 未设：空工具集（聊天形任务）；
//  - 设置后每 run 拉起原仓库 app.mcp_server（--task-id 由桥追加），tools/list 即
//    模型可见工具面，tools/call 走 ToolPort —— Python 工具实现原样复用，零移植。

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fakeTools, type GatePolicy, type RunBudget, type ToolPort } from "@vibe/core";
import { JsonlRunLog, MemorySessionStore, type RunEngine } from "@vibe/runtime";
import { buildSkillPromptSection, createPiEngine, loadVibeSkills, type VibeToolSpec } from "@vibe/adapters-pi";
import { startBridge, type BridgeServer } from "./server";
import { createScriptedEngine, gatePolicyFor, parseScriptedConfig } from "./scripted";
import { TaskRegistry, type RunFactory } from "./registry";
import { createMcpToolPort, McpServerConnection, toVibeToolSpecs } from "./mcp";
import { loadProfiles, type LoadedProfiles, type VibeProfile } from "./profiles";
import type { RunFactoryResult } from "./registry";

export interface BridgeEnv {
  port: number;
  token?: string;
  maxConcurrent: number;
  engine: "pi" | "scripted";
  apiKey?: string;
  baseUrl: string;
  modelId: string;
  providerId: string;
  skillsDir?: string;
  gatedTools: string[];
  scriptPath?: string;
  dataDir: string;
  /** 每任务 MCP 服务器命令（不含 --task-id，桥按 run 追加），如 "python -m app.mcp_server --token T --port 8000"。 */
  mcpCommand?: string[];
  mcpCwd?: string;
  /** 多供应商 profile 配置路径；缺省探测 dataDir/profiles.json，存在即启用。 */
  profilesPath?: string;
}

/** 简单空白分词（引号成对包裹）；MCP 命令形如 python -m app.mcp_server --token T。 */
export function splitCommand(raw: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | "" = "";
  for (const ch of raw) {
    if (quote) {
      if (ch === quote) quote = "";
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === " " || ch === "\t") {
      if (current) parts.push(current);
      current = "";
    } else current += ch;
  }
  if (current) parts.push(current);
  return parts;
}

export function readEnv(env: NodeJS.ProcessEnv = process.env): BridgeEnv {
  const engine = env.VIBE_BRIDGE_ENGINE === "scripted" ? "scripted" : "pi";
  const mcpRaw = env.VIBE_BRIDGE_MCP_COMMAND || "";
  const dataDir = env.VIBE_BRIDGE_DATA_DIR ?? join(homedir(), ".vibe-seller-ts");
  const profilesPath =
    env.VIBE_BRIDGE_PROFILES ?? (existsSync(join(dataDir, "profiles.json")) ? join(dataDir, "profiles.json") : undefined);
  return {
    port: Number.parseInt(env.VIBE_BRIDGE_PORT ?? "8765", 10),
    token: env.VIBE_BRIDGE_TOKEN || undefined,
    maxConcurrent: Number.parseInt(env.VIBE_BRIDGE_MAX_CONCURRENT ?? "4", 10),
    engine,
    apiKey: env.VIBE_BRIDGE_API_KEY || undefined,
    baseUrl: env.VIBE_BRIDGE_BASE_URL ?? "https://api.stepfun.com/step_plan",
    modelId: env.VIBE_BRIDGE_MODEL ?? "step-3.7-flash",
    providerId: env.VIBE_BRIDGE_PROVIDER_ID ?? "stepfun",
    skillsDir: env.VIBE_BRIDGE_SKILLS_DIR || undefined,
    gatedTools: (env.VIBE_BRIDGE_GATED_TOOLS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    scriptPath: env.VIBE_BRIDGE_SCRIPT || undefined,
    dataDir,
    mcpCommand: mcpRaw ? splitCommand(mcpRaw) : undefined,
    mcpCwd: env.VIBE_BRIDGE_MCP_CWD || undefined,
    profilesPath,
  };
}

const SYSTEM_PROMPT_BASE = [
  "你是 vibe-seller 的执行 agent，负责跨境电商卖家的运营任务。",
  "规则：需要数据时调用工具；拿到足够信息后，用一段简短文字作为最终答复，不再调用工具。",
].join("\n");

export function defaultBudget(): RunBudget {
  return { maxIterations: 24, maxToolCalls: 40, maxRetries: 3, timeoutMs: 30 * 60 * 1000 };
}

export interface PiBundle {
  makeEngine: (toolPort: ToolPort, toolSpecs: readonly VibeToolSpec[]) => RunEngine;
  gates?: GatePolicy;
}

/**
 * pi 上下文（ModelRuntime/模型/系统提示词）按 profile 惰性构建并复用；
 * 无 profile 时用单供应商环境变量（VIBE_BRIDGE_API_KEY 等）。
 * 密钥只在构建时从进程环境取值注入，绝不打印、绝不落盘。
 */
export async function buildPi(env: BridgeEnv, gates?: GatePolicy, profile?: VibeProfile): Promise<PiBundle> {
  const providerId = profile?.providerId ?? env.providerId;
  const baseUrl = profile?.baseUrl ?? env.baseUrl;
  const modelId = profile?.model ?? env.modelId;
  const contextWindow = profile?.contextWindow ?? 128_000;
  const maxTokens = profile?.maxTokens ?? 8_000;
  let apiKey = env.apiKey;
  if (profile) {
    // apiKey 值优先（server 从 UI profiles 派生时内存携带）；否则按环境变量名读取
    apiKey = profile.apiKey ?? process.env[profile.apiKeyEnv];
    if (!apiKey) throw new Error(`profile ${profile.profileId} 的密钥环境变量 ${profile.apiKeyEnv} 未设置`);
  } else if (!apiKey) {
    throw new Error("pi 引擎需要 VIBE_BRIDGE_API_KEY（只经环境变量进入本进程）");
  }
  const modelRuntime = await ModelRuntime.create({
    authPath: join(env.dataDir, "bridge-auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider(providerId, {
    name: `bridge-${providerId}`,
    baseUrl, // 官方 SDK 在 baseURL 后拼 /v1/messages，故不带 /v1
    api: "anthropic-messages",
    models: [
      {
        id: modelId,
        name: modelId,
        api: "anthropic-messages",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens,
      },
    ],
  });
  await modelRuntime.setRuntimeApiKey(providerId, apiKey);

  let systemPrompt = SYSTEM_PROMPT_BASE;
  if (env.skillsDir) {
    const loaded = await loadVibeSkills(env.skillsDir);
    if (loaded.missingRequires.length > 0) {
      throw new Error(`技能依赖缺失：${loaded.missingRequires.join(", ")}`);
    }
    systemPrompt = [systemPrompt, "", buildSkillPromptSection(loaded.skills, loaded.skills.map((s) => s.name))].join("\n");
  }
  const model = modelRuntime.getModel(providerId, modelId);
  if (!model) throw new Error(`provider ${providerId} 上未注册模型 ${modelId}`);
  return {
    makeEngine: (toolPort, toolSpecs) =>
      createPiEngine({
        modelRuntime,
        model,
        systemPrompt,
        toolPort,
        toolSpecs,
        gates,
        cwd: process.cwd(),
        agentDir: join(env.dataDir, "agent"),
      }),
    gates,
  };
}

export async function startFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<BridgeServer> {
  const cfg = readEnv(env);
  const budget = defaultBudget();
  const gates = gatePolicyFor(cfg.gatedTools);
  let staticEngine: RunEngine | undefined;
  let runFactory: RunFactory | undefined;

  /** 组装一个 run 的执行面：pi 引擎 × 工具面（MCP 按任务拉起，或空）。 */
  const assembleRun = async (pi: PiBundle, taskId: string): Promise<RunFactoryResult> => {
    if (!cfg.mcpCommand) {
      const tools = fakeTools({});
      return { engine: pi.makeEngine(tools, []), tools, gates, budget };
    }
    const conn = new McpServerConnection({ command: [...cfg.mcpCommand, "--task-id", taskId], cwd: cfg.mcpCwd });
    try {
      await conn.initialize();
      const toolsInfo = await conn.listTools();
      const toolPort = createMcpToolPort(conn);
      return {
        engine: pi.makeEngine(toolPort, toVibeToolSpecs(toolsInfo)),
        tools: toolPort,
        gates,
        budget,
        dispose: () => conn.dispose(),
      };
    } catch (err: unknown) {
      await conn.dispose();
      throw err;
    }
  };

  if (cfg.engine === "scripted") {
    if (!cfg.scriptPath) throw new Error("VIBE_BRIDGE_ENGINE=scripted 需要 VIBE_BRIDGE_SCRIPT 指向脚本 JSON");
    const config = parseScriptedConfig(readFileSync(cfg.scriptPath, "utf8"));
    const gatedTools = config.gatedTools.length ? config.gatedTools : cfg.gatedTools;
    staticEngine = createScriptedEngine({ ...config, gatedTools });
  } else if (cfg.profilesPath) {
    // 多供应商：profile 上下文按需惰性构建（首次用到才要求对应密钥环境变量）并缓存
    const loaded: LoadedProfiles = loadProfiles(readFileSync(cfg.profilesPath, "utf8"));
    const missingAtStartup = [...loaded.missingKeys.entries()];
    if (missingAtStartup.length > 0) {
      console.warn(`[vibe-bridge] 以下 profile 的密钥环境变量未设置（run 时将快速失败）：${missingAtStartup.map(([id, v]) => `${id}→${v}`).join(", ")}`);
    }
    const piCache = new Map<string, Promise<PiBundle>>();
    runFactory = async ({ taskId, request }) => {
      const profileId = request.profileId && request.profileId !== "default" ? request.profileId : "default";
      const profile = loaded.profiles.get(profileId);
      if (!profile) {
        throw new Error(`未知 profile：${profileId}（可用：${[...loaded.profiles.keys()].join(", ")}）`);
      }
      let pi = piCache.get(profileId);
      if (!pi) {
        pi = buildPi(cfg, gates, profile);
        piCache.set(profileId, pi);
      }
      return assembleRun(await pi, taskId);
    };
  } else {
    const pi = await buildPi(cfg, gates);
    if (cfg.mcpCommand) {
      runFactory = async ({ taskId }) => assembleRun(pi, taskId);
    } else {
      staticEngine = pi.makeEngine(fakeTools({}), []);
    }
  }

  const bridge = await startBridge({
    base: {
      core: { step: async () => ({ kind: "respond", content: "" }) }, // 引擎自带模型驱动时 core 不被用到
      tools: fakeTools({}),
      runLog: new JsonlRunLog(join(cfg.dataDir, "runs")),
      sessions: new MemorySessionStore(),
      budget,
      ...(staticEngine ? { engine: staticEngine } : {}),
      gates,
    },
    runFactory,
    registry: new TaskRegistry(),
    maxConcurrent: cfg.maxConcurrent,
    token: cfg.token,
    port: cfg.port,
    host: "127.0.0.1",
    log: (msg) => console.log(`[vibe-bridge] ${msg}`),
  });
  console.log(
    `[vibe-bridge] listening on 127.0.0.1:${bridge.port} (engine=${cfg.engine}, mcp=${cfg.mcpCommand ? "on" : "off"}, profiles=${cfg.profilesPath ? "on" : "off"}, protocol=1)`,
  );
  return bridge;
}

const argv1 = process.argv[1]?.replace(/\\/g, "/") ?? "";
if (argv1.endsWith("bridge.mjs") || argv1.endsWith("bridge.cjs") || argv1.endsWith("main.ts")) {
  startFromEnv().catch((err: unknown) => {
    console.error("[vibe-bridge] failed to start:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
