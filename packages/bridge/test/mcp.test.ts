import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Decision, RunBudget } from "@vibe/core";
import { AgentRuntime, JsonlRunLog, MemorySessionStore } from "@vibe/runtime";
import {
  McpServerConnection,
  TaskRegistry,
  createMcpToolPort,
  createScriptedEngine,
  startBridge,
  toVibeToolSpecs,
} from "../src/index";

const cleanup: string[] = [];
afterAll(async () => {
  await Promise.all(cleanup.map((dir) => rm(dir, { recursive: true, force: true })));
});

const budget: RunBudget = { maxIterations: 24, maxToolCalls: 40, maxRetries: 2, timeoutMs: 10_000 };

const FAKE_MCP = new URL("./fake-mcp.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]):/, "$1:");

async function startFakeMcp(script: object): Promise<McpServerConnection> {
  const dir = await mkdtemp(join(tmpdir(), "vibe-mcp-"));
  cleanup.push(dir);
  const scriptPath = join(dir, "script.json");
  await writeFile(scriptPath, JSON.stringify(script), "utf8");
  const conn = new McpServerConnection({ command: [process.execPath, FAKE_MCP, scriptPath] });
  await conn.initialize();
  return conn;
}

const MCP_SCRIPT = {
  tools: [
    {
      name: "vibe_seller_list_stores",
      description: "List all stores",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "vibe_seller_broken",
      description: "always fails",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
  ],
  results: {
    vibe_seller_list_stores: [{ id: "s1", name: "Noon SG" }],
    vibe_seller_broken: { __error__: "backend unreachable" },
  },
};

describe("MCP 客户端 × ToolPort", () => {
  it("initialize + tools/list → VibeToolSpec（inputSchema 直通）", async () => {
    const conn = await startFakeMcp(MCP_SCRIPT);
    const tools = await conn.listTools();
    expect(tools.map((t) => t.name)).toEqual(["vibe_seller_list_stores", "vibe_seller_broken"]);
    const specs = toVibeToolSpecs(tools);
    expect(specs[0]).toMatchObject({ name: "vibe_seller_list_stores", description: "List all stores" });
    expect((specs[0]!.parameters as { type: string }).type).toBe("object");
    await conn.dispose();
  });

  it("tools/call 成功 → status success + 解析后的 JSON", async () => {
    const conn = await startFakeMcp(MCP_SCRIPT);
    const port = createMcpToolPort(conn);
    const result = await port.execute({ name: "vibe_seller_list_stores", arguments: {} }, new AbortController().signal);
    expect(result.status).toBe("success");
    expect(result.result).toEqual([{ id: "s1", name: "Noon SG" }]);
    await conn.dispose();
  });

  it("原服务器把错误包在成功结果里 → 归一为 status error", async () => {
    const conn = await startFakeMcp(MCP_SCRIPT);
    const port = createMcpToolPort(conn);
    const result = await port.execute({ name: "vibe_seller_broken", arguments: {} }, new AbortController().signal);
    expect(result.status).toBe("error");
    expect(result.error).toMatchObject({ code: "tool_error", message: "backend unreachable" });
    await conn.dispose();
  });

  it("服务器进程死亡 → pending/后续调用失败不悬挂", async () => {
    const conn = await startFakeMcp(MCP_SCRIPT);
    const port = createMcpToolPort(conn);
    await conn.dispose(); // 模拟进程崩溃
    const result = await port.execute({ name: "vibe_seller_list_stores", arguments: {} }, new AbortController().signal);
    expect(result.status).toBe("error");
  });

  it("dispose 幂等", async () => {
    const conn = await startFakeMcp(MCP_SCRIPT);
    await conn.dispose();
    await expect(conn.dispose()).resolves.toBeUndefined();
  });
});

describe("桥 e2e × 真 MCP 工具面（CORE 引擎脚本驱动真端口）", () => {
  it("agent 决策经 ToolPort 落到 MCP 服务器，观察帧携带真实工具结果", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibe-bridge-mcp-"));
    cleanup.push(dir);
    const conn = await startFakeMcp(MCP_SCRIPT);
    const mcpPort = createMcpToolPort(conn);

    const decisions: Decision[] = [
      { kind: "call_tool", intent: { name: "vibe_seller_list_stores", arguments: {} } },
      { kind: "respond", content: "共有 1 家店铺：Noon SG。" },
    ];
    const engineWithScript = createScriptedEngine(
      { decisions, gatedTools: [], toolNames: ["vibe_seller_list_stores"] },
      mcpPort,
    );

    const bridge = await startBridge({
      base: {
        core: { step: async () => ({ kind: "respond", content: "" }) },
        tools: { execute: async () => ({ status: "error", error: { code: "invalid_tool", message: "unused" } }) },
        runLog: new JsonlRunLog(dir),
        sessions: new MemorySessionStore(),
        budget,
        engine: engineWithScript,
      },
      // 演示 runFactory 覆盖：每 run 用 MCP 端口（与静态 engine 同款工具面）
      runFactory: async () => ({
        engine: engineWithScript,
        tools: mcpPort,
        dispose: () => conn.dispose(),
      }),
      registry: new TaskRegistry(),
      maxConcurrent: 4,
      port: 0,
    });
    const post = await fetch(`http://127.0.0.1:${bridge.port}/v1/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task_id: "task-mcp", prompt: "列出所有店铺" }),
    });
    expect(post.status).toBe(202);
    const { run_id } = (await post.json()) as { run_id: string };
    await new Promise((r) => setTimeout(r, 200));

    const res = await fetch(`http://127.0.0.1:${bridge.port}/v1/runs/${run_id}/events`);
    const text = await res.text();
    const frames = text
      .split("\n\n")
      .filter(Boolean)
      .map((block) => {
        const lines = block.split("\n").filter(Boolean);
        return {
          event: lines.find((l) => l.startsWith("event: "))?.slice(7) ?? "",
          data: JSON.parse(lines.find((l) => l.startsWith("data: "))?.slice(6) ?? "{}"),
        };
      });
    const toolUse = frames.find((f) => f.event === "message" && f.data.role === "tool_use");
    expect(toolUse).toBeDefined();
    const observation = frames
      .filter((f) => f.event === "message" && f.data.role === "agent_event")
      .map((f) => JSON.parse(f.data.content));
    expect(observation.some((o) => o.tool === "vibe_seller_list_stores" && o.ok === "success")).toBe(true);
    const done = frames.find((f) => f.event === "done");
    expect(done?.data).toMatchObject({ status: "completed", result_text: "共有 1 家店铺：Noon SG。" });
    await bridge.close();
  });
});
