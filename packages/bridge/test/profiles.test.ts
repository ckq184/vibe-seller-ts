import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { JsonlRunLog, MemorySessionStore } from "@vibe/runtime";
import { TaskRegistry, createScriptedEngine, loadProfiles, startBridge } from "../src/index";

const cleanup: string[] = [];
afterAll(async () => {
  await Promise.all(cleanup.map((dir) => rm(dir, { recursive: true, force: true })));
});

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

describe("桥 e2e：profile 路由到不同引擎", () => {
  it("profile_id 决定引擎行为；未知 profile → 503 快速失败", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibe-profiles-"));
    cleanup.push(dir);
    const engineA = createScriptedEngine({ decisions: [{ kind: "respond", content: "来自 A" }], gatedTools: [], toolNames: [] });
    const engineB = createScriptedEngine({ decisions: [{ kind: "respond", content: "来自 B" }], gatedTools: [], toolNames: [] });

    const bridge = await startBridge({
      base: {
        core: { step: async () => ({ kind: "respond", content: "" }) },
        tools: { execute: async () => ({ status: "error", error: { code: "invalid_tool", message: "unused" } }) },
        runLog: new JsonlRunLog(dir),
        sessions: new MemorySessionStore(),
        budget: { maxIterations: 8, maxToolCalls: 8, maxRetries: 1, timeoutMs: 10_000 },
      },
      runFactory: async ({ request }) => {
        if (request.profileId === "a") return { engine: engineA, tools: { execute: async () => ({ status: "success", result: {} }) } };
        if (request.profileId === "b") return { engine: engineB, tools: { execute: async () => ({ status: "success", result: {} }) } };
        throw new Error(`未知 profile：${request.profileId ?? "(缺省)"}`);
      },
      registry: new TaskRegistry(),
      maxConcurrent: 4,
      port: 0,
    });

    const runWith = async (profileId: string, taskId: string) => {
      const post = await fetch(`http://127.0.0.1:${bridge.port}/v1/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task_id: taskId, prompt: "hi", profile_id: profileId }),
      });
      return post;
    };

    // profile a
    const ra = await runWith("a", "task-a");
    expect(ra.status).toBe(202);
    const { run_id: idA } = (await ra.json()) as { run_id: string };
    // profile b
    const rb = await runWith("b", "task-b");
    expect(rb.status).toBe(202);
    const { run_id: idB } = (await rb.json()) as { run_id: string };
    // 未知 profile → 503
    const rBad = await runWith("nope", "task-bad");
    expect(rBad.status).toBe(503);
    const badBody = (await rBad.json()) as { error: string };
    expect(badBody.error).toBe("run_factory_failed");

    await new Promise((r) => setTimeout(r, 120));
    const readResult = async (runId: string) => {
      const res = await fetch(`http://127.0.0.1:${bridge.port}/v1/runs/${runId}`);
      return (await res.json()) as { result_text: string };
    };
    expect((await readResult(idA)).result_text).toBe("来自 A");
    expect((await readResult(idB)).result_text).toBe("来自 B");
    await bridge.close();
  });
});
