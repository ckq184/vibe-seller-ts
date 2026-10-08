// 供应商预设与模型目录（app/ai/profiles.py 的 PROVIDER_PRESETS/PROVIDER_MODELS
// 原样移植——前端 Settings 页的数据契约，逐字段不动）。

export interface ProviderModel {
  id: string;
  label: string;
  context?: string;
  vision?: boolean;
}

export interface ProviderPreset {
  name: string;
  group?: string;
  variant?: string;
  description: string;
  load_global_mcp: boolean;
  env: Record<string, string>;
  models?: ProviderModel[];
}

export const DEFAULT_PROFILE_ID = "default";

export const DEFAULT_PROFILES: { profiles: Record<string, { name: string; description: string; env: Record<string, string>; load_global_mcp: boolean }> } = {
  profiles: {
    [DEFAULT_PROFILE_ID]: {
      name: "Claude",
      description: "System default configuration",
      env: {},
      load_global_mcp: false,
    },
  },
};

export const PROVIDER_PRESETS: Record<string, Omit<ProviderPreset, "models">> = {
  // Kimi K3（[1m] 后缀选 1M 上下文变体，Claude-Code env 约定；Kimi 无小/快档）
  kimi: {
    name: "Kimi",
    description: "Kimi K3 (1M context) via Moonshot",
    load_global_mcp: false,
    env: {
      ANTHROPIC_BASE_URL: "https://api.kimi.com/coding/",
      API_TIMEOUT_MS: "3000000",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      ENABLE_TOOL_SEARCH: "False",
      ANTHROPIC_MODEL: "k3[1m]",
      ANTHROPIC_SMALL_FAST_MODEL: "k3[1m]",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "k3[1m]",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "k3[1m]",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "k3[1m]",
      CLAUDE_CODE_SUBAGENT_MODEL: "k3[1m]",
    },
  },
  minimax: {
    name: "MiniMax",
    description: "MiniMax-M3 (1M context)",
    load_global_mcp: false,
    env: {
      ANTHROPIC_BASE_URL: "https://api.minimaxi.com/anthropic",
      API_TIMEOUT_MS: "3000000",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      ANTHROPIC_MODEL: "MiniMax-M3[1m]",
      ANTHROPIC_SMALL_FAST_MODEL: "MiniMax-M3[1m]",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "MiniMax-M3[1m]",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "MiniMax-M3[1m]",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "MiniMax-M3[1m]",
    },
  },
  glm: {
    name: "GLM (China)",
    group: "GLM",
    variant: "China",
    description: "GLM-5.2 (1M context) via ZhiPu BigModel",
    load_global_mcp: false,
    env: {
      ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic",
      API_TIMEOUT_MS: "3000000",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      ANTHROPIC_MODEL: "glm-5.2[1m]",
      ANTHROPIC_SMALL_FAST_MODEL: "glm-4.7",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.2[1m]",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.2[1m]",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-4.7",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000",
    },
  },
  glm_intl: {
    name: "GLM (International)",
    group: "GLM",
    variant: "International",
    description: "GLM-5.2 (1M context) via Z.AI",
    load_global_mcp: false,
    env: {
      ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
      API_TIMEOUT_MS: "3000000",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      ANTHROPIC_MODEL: "glm-5.2[1m]",
      ANTHROPIC_SMALL_FAST_MODEL: "glm-4.7",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.2[1m]",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.2[1m]",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-4.7",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000",
    },
  },
  deepseek: {
    name: "DeepSeek",
    description: "DeepSeek V4 Pro (1M context) via DeepSeek API",
    load_global_mcp: false,
    env: {
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      API_TIMEOUT_MS: "3000000",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      ANTHROPIC_MODEL: "deepseek-v4-pro[1m]",
      ANTHROPIC_SMALL_FAST_MODEL: "deepseek-v4-flash",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4-pro[1m]",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-pro[1m]",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4-flash",
      CLAUDE_CODE_SUBAGENT_MODEL: "deepseek-v4-flash",
      CLAUDE_CODE_EFFORT_LEVEL: "max",
    },
  },
  qwen: {
    name: "Qwen (Pay-as-you-go, China)",
    group: "Alibaba Cloud",
    variant: "Pay-as-you-go (China)",
    description: "Qwen3.7-Max via Alibaba Cloud Bailian, pay-as-you-go billing (Beijing region)",
    load_global_mcp: false,
    env: {
      ANTHROPIC_BASE_URL: "https://dashscope.aliyuncs.com/apps/anthropic",
      API_TIMEOUT_MS: "3000000",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      ANTHROPIC_MODEL: "qwen3.7-max",
      ANTHROPIC_SMALL_FAST_MODEL: "qwen3.6-flash",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "qwen3.7-max",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "qwen3.7-max",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "qwen3.6-flash",
      CLAUDE_CODE_SUBAGENT_MODEL: "qwen3.7-max",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1000000",
    },
  },
  qwen_intl: {
    name: "Qwen (Pay-as-you-go, International)",
    group: "Alibaba Cloud",
    variant: "Pay-as-you-go (International)",
    description: "Qwen3.7-Max via Alibaba Cloud Model Studio, pay-as-you-go (Singapore). Replace {WorkspaceId} in the Base URL.",
    load_global_mcp: false,
    env: {
      ANTHROPIC_BASE_URL: "https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/apps/anthropic",
      API_TIMEOUT_MS: "3000000",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      ANTHROPIC_MODEL: "qwen3.7-max",
      ANTHROPIC_SMALL_FAST_MODEL: "qwen3.6-flash",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "qwen3.7-max",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "qwen3.7-max",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "qwen3.6-flash",
      CLAUDE_CODE_SUBAGENT_MODEL: "qwen3.7-max",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1000000",
    },
  },
  qwen_coding: {
    name: "Qwen (Coding Plan)",
    group: "Alibaba Cloud",
    variant: "Coding Plan",
    description: "Qwen3.7-Plus via Alibaba Cloud Bailian Coding Plan (monthly subscription)",
    load_global_mcp: false,
    env: {
      ANTHROPIC_BASE_URL: "https://coding.dashscope.aliyuncs.com/apps/anthropic",
      API_TIMEOUT_MS: "3000000",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      ANTHROPIC_MODEL: "qwen3.7-plus",
      ANTHROPIC_SMALL_FAST_MODEL: "qwen3.7-plus",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "qwen3.7-plus",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "qwen3.7-plus",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "qwen3.7-plus",
      CLAUDE_CODE_SUBAGENT_MODEL: "qwen3.7-plus",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1000000",
    },
  },
  qwen_token: {
    name: "Qwen (Token Plan)",
    group: "Alibaba Cloud",
    variant: "Token Plan",
    description: "Qwen3.8-Max-Preview via Alibaba Cloud Bailian Token Plan (个人版 / 团队版)",
    load_global_mcp: false,
    env: {
      ANTHROPIC_BASE_URL: "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic",
      API_TIMEOUT_MS: "3000000",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      ANTHROPIC_MODEL: "qwen3.8-max-preview",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "qwen3.6-flash",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "qwen3.8-max-preview",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "qwen3.8-max-preview",
      CLAUDE_CODE_SUBAGENT_MODEL: "qwen3.7-max",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "983616",
    },
  },
};

export const PROVIDER_MODELS: Record<string, ProviderModel[]> = {
  kimi: [
    { id: "k3[1m]", label: "K3 (1M context)", context: "1M", vision: true },
    { id: "k3", label: "K3 (256K)", context: "256K", vision: true },
    { id: "kimi-for-coding", label: "Kimi for Coding", vision: true },
    { id: "kimi-for-coding-highspeed", label: "Kimi for Coding — high-speed", vision: true },
  ],
  minimax: [
    { id: "MiniMax-M3[1m]", label: "M3 (1M context)", context: "1M", vision: true },
    { id: "MiniMax-M2.7", label: "M2.7", context: "200K", vision: false },
    { id: "MiniMax-M2.5", label: "M2.5", context: "200K", vision: false },
    { id: "MiniMax-M2.1", label: "M2.1", context: "200K", vision: false },
  ],
  glm: [
    { id: "glm-5.2[1m]", label: "GLM-5.2 (1M context)", context: "1M", vision: false },
    { id: "glm-4.7", label: "GLM-4.7", context: "200K", vision: false },
    { id: "glm-5.1", label: "GLM-5.1", context: "200K", vision: false },
    { id: "glm-4.6", label: "GLM-4.6", context: "200K", vision: false },
  ],
  glm_intl: [
    { id: "glm-5.2[1m]", label: "GLM-5.2 (1M context)", context: "1M", vision: false },
    { id: "glm-4.7", label: "GLM-4.7", context: "200K", vision: false },
    { id: "glm-5.1", label: "GLM-5.1", context: "200K", vision: false },
    { id: "glm-4.6", label: "GLM-4.6", context: "200K", vision: false },
  ],
  deepseek: [
    { id: "deepseek-v4-pro[1m]", label: "V4 Pro (1M context)", context: "1M", vision: false },
    { id: "deepseek-v4-flash", label: "V4 Flash (fast)", context: "1M", vision: false },
  ],
  qwen: [
    { id: "qwen3.7-max", label: "Qwen3.7-Max (flagship)", context: "1M", vision: false },
    { id: "qwen3.7-plus", label: "Qwen3.7-Plus (vision)", context: "1M", vision: true },
    { id: "qwen3.6-flash", label: "Qwen3.6-Flash (fast, vision)", context: "1M", vision: true },
    { id: "qwen3-vl-plus", label: "Qwen3-VL-Plus (vision)", vision: true },
  ],
  qwen_intl: [
    { id: "qwen3.7-max", label: "Qwen3.7-Max (flagship)", context: "1M", vision: false },
    { id: "qwen3.7-plus", label: "Qwen3.7-Plus (vision)", context: "1M", vision: true },
    { id: "qwen3.6-flash", label: "Qwen3.6-Flash (fast, vision)", context: "1M", vision: true },
    { id: "qwen3-vl-plus", label: "Qwen3-VL-Plus (vision)", vision: true },
  ],
  qwen_coding: [{ id: "qwen3.7-plus", label: "Qwen3.7-Plus (vision)", context: "1M", vision: true }],
  qwen_token: [
    { id: "qwen3.8-max-preview", label: "Qwen3.8-Max-Preview (flagship)", context: "1M" },
    { id: "qwen3.7-max", label: "Qwen3.7-Max", context: "1M", vision: false },
    { id: "qwen3.7-plus", label: "Qwen3.7-Plus (vision)", context: "1M", vision: true },
    { id: "qwen3.6-flash", label: "Qwen3.6-Flash (fast, vision)", context: "1M", vision: true },
  ],
};

/** 模型能否吃图片输入：catalog 明示 text-only → false；未知 → null（调用方不得无据限制）。 */
export function modelSeesImages(modelId: string | null | undefined): boolean | null {
  const base = (mid: string) => mid.split("[", 1)[0]!.trim().toLowerCase();
  if (!modelId || !base(modelId)) return null;
  const want = base(modelId);
  for (const models of Object.values(PROVIDER_MODELS)) {
    for (const m of models) {
      if (base(m.id) === want && "vision" in m) return Boolean(m.vision);
    }
  }
  return null;
}

/** 拿 env 里的 ANTHROPIC_BASE_URL 比对预设 → 隐私安全的供应商枚举（telemetry 用，绝不发 env 本身）。 */
export function profileKind(profile: Record<string, unknown> | null | undefined): string {
  if (!profile) return "default";
  const env = (profile.env ?? {}) as Record<string, string>;
  const baseUrl = (env.ANTHROPIC_BASE_URL ?? "").trim();
  if (!baseUrl) return "default";
  for (const preset of Object.values(PROVIDER_PRESETS)) {
    const presetUrl = (preset.env.ANTHROPIC_BASE_URL ?? "").trim();
    if (presetUrl && presetUrl === baseUrl) {
      for (const [pid, p] of Object.entries(PROVIDER_PRESETS)) {
        if (p === preset) return pid;
      }
    }
  }
  return "custom";
}
