// pi 引擎装配面（server 进程内复用）：env/profile → ModelRuntime → createPiEngine。
// Phase 5.2 起 @vibe/bridge 不再是独立桥进程——HTTP+SSE 桥服务（server.ts）、
// scripted 引擎（scripted.ts）、MCP stdio 客户端（mcp.ts）、活 run 注册表
// （registry.ts）随 Python 编排路径退役；本模块保留 server 仍消费的装配件：
// readEnv / defaultBudget / buildPi，以及三件迁入的小件（来源见各自注释）。
// 密钥红线：VIBE_BRIDGE_API_KEY 只在本进程内注入 ModelRuntime，绝不打印、
// 绝不入事件/RunLog/SSE 帧。

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { GatePolicy, RunBudget, ToolIntent, ToolPort } from "@vibe/core";
import type { RunEngine } from "@vibe/runtime";
import { buildSkillPromptSection, createPiEngine, loadVibeSkills, type VibeToolSpec } from "@vibe/adapters-pi";
import type { VibeProfile } from "./profiles";

export interface BridgeEnv {
  apiKey?: string;
  baseUrl: string;
  modelId: string;
  providerId: string;
  skillsDir?: string;
  gatedTools: string[];
  dataDir: string;
  /** 多供应商 profile 配置路径；缺省探测 dataDir/profiles.json，存在即启用。 */
  profilesPath?: string;
}

/** env 复用 VIBE_BRIDGE_* 命名（同一套配置驱动 TS server 的引擎装配）。
 * 原 VIBE_BRIDGE_PORT/TOKEN/MAX_CONCURRENT（桥 HTTP 服务）、ENGINE/SCRIPT（scripted
 * 引擎）、MCP_COMMAND/MCP_CWD（Python MCP 进程）随 Phase 5.2 退役，不再读取。 */
export function readEnv(env: NodeJS.ProcessEnv = process.env): BridgeEnv {
  const dataDir = env.VIBE_BRIDGE_DATA_DIR ?? join(homedir(), ".vibe-seller-ts");
  return {
    apiKey: env.VIBE_BRIDGE_API_KEY || undefined,
    baseUrl: env.VIBE_BRIDGE_BASE_URL ?? "https://api.stepfun.com/step_plan",
    modelId: env.VIBE_BRIDGE_MODEL ?? "step-3.7-flash",
    providerId: env.VIBE_BRIDGE_PROVIDER_ID ?? "stepfun",
    skillsDir: env.VIBE_BRIDGE_SKILLS_DIR || undefined,
    gatedTools: (env.VIBE_BRIDGE_GATED_TOOLS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    dataDir,
    profilesPath:
      env.VIBE_BRIDGE_PROFILES ?? (existsSync(join(dataDir, "profiles.json")) ? join(dataDir, "profiles.json") : undefined),
  };
}

export function defaultBudget(): RunBudget {
  return { maxIterations: 24, maxToolCalls: 40, maxRetries: 3, timeoutMs: 30 * 60 * 1000 };
}

export interface PiBundle {
  makeEngine: (toolPort: ToolPort, toolSpecs: readonly VibeToolSpec[]) => RunEngine;
  gates?: GatePolicy;
}

const SYSTEM_PROMPT_BASE = [
  "你是 vibe-seller 的执行 agent，负责跨境电商卖家的运营任务。",
  "规则：需要数据时调用工具；拿到足够信息后，用一段简短文字作为最终答复，不再调用工具。",
].join("\n");

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

// 原 scripted.ts（scripted 引擎）随 Phase 5.2 退役；闸门策略构造仍被 server 引擎
// 工厂（agent/engine.ts）使用，迁入本模块（实现逐字未改）。
export function gatePolicyFor(toolNames: readonly string[]): GatePolicy | undefined {
  if (toolNames.length === 0) return undefined;
  const gated = new Set(toolNames);
  return {
    requiresApproval: (intent: ToolIntent) => gated.has(intent.name),
    question: (intent: ToolIntent) =>
      `工具 ${intent.name} 需要人工确认后才能执行。参数：${JSON.stringify(intent.arguments)}`,
  };
}

/** 工具 schema 行的最小结构面（原 mcp.ts 的 McpToolInfo）。 */
export interface ToolSchemaInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

// 原 mcp.ts（MCP stdio 客户端）随 Phase 5.2 退役；schema→VibeToolSpec 的纯映射仍被
// server 引擎工厂使用（native 工具 schema → pi toolSpecs），迁入本模块（实现逐字未改）。
/** inputSchema 即 JSON Schema，TypeBox 同构，直接透传。 */
export function toVibeToolSpecs(tools: readonly ToolSchemaInfo[]): VibeToolSpec[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    parameters: (t.inputSchema ?? { type: "object", properties: {} }) as VibeToolSpec["parameters"],
  }));
}

// 原 registry.ts（活 run 注册表）随 Phase 5.2 退役；TaskRegistry/RunEntry 等只服务
// 桥 HTTP 路径一并删除，仅此类型仍被 server 编排器（orchestrator/assistant 的
// EngineFactoryResult 由它派生）使用，迁入本模块（形状逐字未改）。
/** 每 run 定制执行面：engine/tools/gates/budget 按任务组装（工具面无进程 → dispose 缺省）。 */
export interface RunFactoryResult {
  engine: RunEngine;
  tools: ToolPort;
  gates?: GatePolicy;
  budget?: RunBudget;
  dispose?: () => Promise<void>;
}
