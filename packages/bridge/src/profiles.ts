// 多供应商 profile：配置文件只存环境变量名引用（api_key_env），密钥值运行时才从
// 进程环境读取 —— 密钥永不落盘（比原仓库 profile 直接存 env 覆盖更严格）。
// 纯函数，可独立单测。

export interface VibeProfile {
  profileId: string;
  providerId: string;
  baseUrl: string;
  model: string;
  /** 密钥所在环境变量的名字；运行时读取，缺失则该 profile 的 run 快速失败。 */
  apiKeyEnv: string;
  /**
   * 密钥值本身——仅供 server 从 UI 管理的 profiles.json（原仓库格式，env 内含密钥）
   * 派生运行时 profile 时在内存里携带；本模块的 loadProfiles 绝不设置它。
   * 密钥永不打印、永不入事件/日志/RunLog/SSE 帧（与 apiKeyEnv 同一条红线）。
   */
  apiKey?: string;
  contextWindow: number;
  maxTokens: number;
}

export interface LoadedProfiles {
  profiles: Map<string, VibeProfile>;
  /** 配置存在但 key 环境变量缺失的 profile（启动可用，run 时快速失败并点名缺失变量）。 */
  missingKeys: Map<string, string>;
}

export interface RawProfile {
  provider_id?: string;
  base_url?: string;
  model?: string;
  api_key_env?: string;
  context_window?: number;
  max_tokens?: number;
}

export function loadProfiles(raw: string, env: NodeJS.ProcessEnv = process.env): LoadedProfiles {
  const parsed = JSON.parse(raw) as { profiles?: Record<string, RawProfile> };
  const entries = Object.entries(parsed.profiles ?? {});
  if (entries.length === 0) throw new Error("profiles 配置为空：需要至少一个 profile");
  const profiles = new Map<string, VibeProfile>();
  const missingKeys = new Map<string, string>();
  for (const [profileId, rawProfile] of entries) {
    const providerId = rawProfile.provider_id ?? profileId;
    const baseUrl = rawProfile.base_url;
    const model = rawProfile.model;
    const apiKeyEnv = rawProfile.api_key_env ?? "";
    if (!baseUrl || !model) {
      throw new Error(`profile ${profileId} 缺少 base_url/model`);
    }
    if (!apiKeyEnv) {
      throw new Error(`profile ${profileId} 缺少 api_key_env（配置文件只存环境变量名，绝不存密钥本身）`);
    }
    const profile: VibeProfile = {
      profileId,
      providerId,
      baseUrl,
      model,
      apiKeyEnv,
      contextWindow: rawProfile.context_window ?? 128_000,
      maxTokens: rawProfile.max_tokens ?? 8_000,
    };
    profiles.set(profileId, profile);
    if (!env[apiKeyEnv]) missingKeys.set(profileId, apiKeyEnv);
  }
  return { profiles, missingKeys };
}
