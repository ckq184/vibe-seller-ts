// ProfileManager：~/.vibe-seller/profiles.json 的读写（app/ai/profiles.py 移植）。
// 存储格式与原仓库逐字段一致（{profiles: {id: {name, description, env, load_global_mcp}}}），
// 原地升级后老用户的 profiles 直接可用；env 里的密钥按原设计落盘（原仓库行为，
// 前端 Settings 页需要回读）。
// 运行时派生（deriveVibeProfile）只在内存里把 env 转成 pi 引擎的 profile——密钥
// 值进 buildPi 后绝不打印、绝不入事件/日志/RunLog/SSE 帧。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { VibeProfile } from "@vibe/bridge";
import { DEFAULT_PROFILE_ID, DEFAULT_PROFILES, PROVIDER_MODELS, PROVIDER_PRESETS } from "./presets";

export interface UiProfile {
  name?: string;
  description?: string;
  env?: Record<string, string>;
  load_global_mcp?: boolean;
  [key: string]: unknown;
}

export interface ProfilesFile {
  profiles: Record<string, UiProfile>;
}

export class ProfileManager {
  constructor(readonly path: string) {}

  static defaultPath(homeDir: string): string {
    return join(homeDir, "profiles.json");
  }

  load(): ProfilesFile {
    if (existsSync(this.path)) {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as ProfilesFile;
      if (!parsed.profiles || typeof parsed.profiles !== "object") return structuredClone(DEFAULT_PROFILES);
      return parsed;
    }
    return structuredClone(DEFAULT_PROFILES);
  }

  save(profiles: ProfilesFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(profiles, null, 2), "utf8");
  }

  getProfile(profileId: string): UiProfile | undefined {
    return this.load().profiles[profileId];
  }

  listProfiles(): Record<string, unknown>[] {
    return Object.entries(this.load().profiles).map(([id, v]) => ({ id, ...v }));
  }

  createProfile(profileId: string, data: { name?: string; env?: Record<string, string>; description?: string; load_global_mcp?: boolean }): Record<string, unknown> {
    const profiles = this.load();
    const profileData: UiProfile = {
      name: data.name,
      description: data.description ?? "",
      env: data.env ?? {},
      load_global_mcp: data.load_global_mcp ?? false,
    };
    profiles.profiles[profileId] = profileData;
    this.save(profiles);
    return { id: profileId, ...profileData };
  }

  updateProfile(profileId: string, updates: Record<string, unknown>): Record<string, unknown> {
    const profiles = this.load();
    if (!(profileId in profiles.profiles)) throw new Error(`Profile ${profileId} not found`);
    profiles.profiles[profileId] = { ...profiles.profiles[profileId], ...updates };
    this.save(profiles);
    return { id: profileId, ...profiles.profiles[profileId] };
  }

  deleteProfile(profileId: string): void {
    if (profileId === DEFAULT_PROFILE_ID) throw new Error("Cannot delete default profile");
    const profiles = this.load();
    delete profiles.profiles[profileId];
    this.save(profiles);
  }

  /** UI profiles.json → pi 引擎 profile。env 无 ANTHROPIC_BASE_URL 的（default 形状）返回
   * undefined——落回单供应商环境变量。模型 id 的 `[1m]` 是客户端约定，注册前剥掉，
   * 并据此放大上下文窗口（与原 Claude Code 语义一致）。 */
  deriveVibeProfile(profileId: string): VibeProfile | undefined {
    const profile = this.getProfile(profileId);
    if (!profile) return undefined;
    const env = profile.env ?? {};
    const baseUrl = (env.ANTHROPIC_BASE_URL ?? "").trim();
    if (!baseUrl) return undefined;
    const rawModel = (env.ANTHROPIC_MODEL ?? "").trim();
    const model = rawModel.replace(/\[1m\]$/i, "");
    const apiKey = (env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? "").trim() || undefined;
    return {
      profileId,
      providerId: profileId,
      baseUrl,
      model,
      apiKeyEnv: "",
      apiKey,
      contextWindow: /\[1m\]$/i.test(rawModel) ? 1_000_000 : 128_000,
      maxTokens: 8_000,
    };
  }

  /** 预设目录（UI 用）：每个预设附 models 下拉选项；不改动模块常量。 */
  getProviderPresets(): Record<string, ProviderPresetWithModels> {
    const out: Record<string, ProviderPresetWithModels> = {};
    for (const [pid, preset] of Object.entries(PROVIDER_PRESETS)) {
      out[pid] = { ...preset, models: PROVIDER_MODELS[pid] ?? [] };
    }
    return out;
  }
}

export interface ProviderPresetWithModels {
  name: string;
  group?: string;
  variant?: string;
  description: string;
  load_global_mcp: boolean;
  env: Record<string, string>;
  models: ProviderModelSafe[];
}

type ProviderModelSafe = { id: string; label: string; context?: string; vision?: boolean };
