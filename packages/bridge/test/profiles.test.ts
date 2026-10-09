import { describe, expect, it } from "vitest";
import { loadProfiles } from "../src/index";

describe("loadProfiles（密钥不落盘：只存环境变量名引用）", () => {
  const env = { KEY_A: "a-value", KEY_B: "b-value" };

  it("合法配置 → profile 表 + 缺 key 清单为空", () => {
    const loaded = loadProfiles(
      JSON.stringify({
        profiles: {
          default: { provider_id: "stepfun", base_url: "https://a", model: "m1", api_key_env: "KEY_A" },
          deepseek: { base_url: "https://b", model: "m2", api_key_env: "KEY_B", context_window: 64000, max_tokens: 4000 },
        },
      }),
      env,
    );
    expect(loaded.profiles.size).toBe(2);
    expect(loaded.missingKeys.size).toBe(0);
    const deepseek = loaded.profiles.get("deepseek")!;
    expect(deepseek.providerId).toBe("deepseek"); // provider_id 缺省取 profile id
    expect(deepseek.contextWindow).toBe(64_000);
    expect(deepseek.maxTokens).toBe(4_000);
  });

  it("key 环境变量缺失 → 记入 missingKeys（启动可过，run 时快速失败）", () => {
    const loaded = loadProfiles(
      JSON.stringify({ profiles: { kimi: { base_url: "https://k", model: "m", api_key_env: "KEY_KIMI_MISSING" } } }),
      env,
    );
    expect(loaded.profiles.get("kimi")).toBeDefined();
    expect(loaded.missingKeys.get("kimi")).toBe("KEY_KIMI_MISSING");
  });

  it("缺 base_url/model/api_key_env → 配置错误直接抛", () => {
    expect(() => loadProfiles(JSON.stringify({ profiles: { x: { model: "m", api_key_env: "KEY_A" } } }), env)).toThrow(/base_url/);
    expect(() => loadProfiles(JSON.stringify({ profiles: { x: { base_url: "https://a", api_key_env: "KEY_A" } } }), env)).toThrow(/base_url/);
    expect(() => loadProfiles(JSON.stringify({ profiles: { x: { base_url: "https://a", model: "m" } } }), env)).toThrow(/api_key_env/);
  });

  it("空配置 → 抛", () => {
    expect(() => loadProfiles(JSON.stringify({ profiles: {} }), env)).toThrow(/至少一个/);
  });
});

