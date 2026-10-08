// 零依赖 MCP stdio 客户端 —— 只实现原仓库 app/mcp_server.py 说的那部分协议：
// initialize → notifications/initialized（无响应）→ tools/list → tools/call。
// newline 分帧 JSON-RPC 2.0；服务器按任务拉起（--task-id 必填），一个 run 一条连接。
// 有意不用完整 MCP SDK：对齐原仓库"minimal implementation"的风格面，减少依赖面。

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { ToolCallResult, ToolPort } from "@vibe/core";
import type { VibeToolSpec } from "@vibe/adapters-pi";

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export interface McpConnectionOptions {
  /** 完整命令行，如 ["python", "-m", "app.mcp_server", "--token", "…", "--port", "8800"]。 */
  command: readonly string[];
  cwd?: string;
}

export class McpServerConnection {
  private proc: ChildProcess | undefined;
  private readonly opts: McpConnectionOptions;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private reader: ReturnType<typeof createInterface> | undefined;
  private exited: Error | undefined;
  private readonly exitWaiters: ((err: Error | undefined) => void)[] = [];
  private stderrTail = "";

  constructor(opts: McpConnectionOptions) {
    this.opts = opts;
  }

  private ensureProcess(): ChildProcess {
    if (this.proc) return this.proc;
    const [cmd, ...args] = this.opts.command;
    if (!cmd) throw new Error("MCP command 为空");
    const proc = spawn(cmd, args, {
      cwd: this.opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc = proc;
    proc.stderr?.on("data", (chunk: Buffer) => {
      // 只留尾部用于报错，绝不透传到 stdout 消费面
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-2000);
    });
    this.reader = createInterface({ input: proc.stdout! });
    this.reader.on("line", (line: string) => this.onLine(line));
    const onExit = (code: number | null) => {
      const err = new Error(`MCP server exited (code=${code})${this.stderrTail ? `: ${this.stderrTail.trim().split("\n").at(-1)}` : ""}`);
      this.exited = err;
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
      for (const w of this.exitWaiters.splice(0)) w(err);
    };
    proc.on("exit", (code) => onExit(code));
    proc.on("error", (err) => {
      const failure = new Error(`MCP server spawn failed: ${err.message}`);
      this.exited = failure;
      for (const [, p] of this.pending) p.reject(failure);
      this.pending.clear();
      for (const w of this.exitWaiters.splice(0)) w(failure);
    });
    return proc;
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // 非 JSON 行（服务器打印污染）直接忽略
    }
    if (typeof msg.id !== "number") return;
    const pendingCall = this.pending.get(msg.id);
    if (!pendingCall) return;
    this.pending.delete(msg.id);
    if (msg.error) pendingCall.reject(new Error(msg.error.message ?? "MCP error"));
    else pendingCall.resolve(msg.result);
  }

  private async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const proc = this.ensureProcess();
    if (this.exited) throw this.exited;
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) };
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    proc.stdin!.write(JSON.stringify(payload) + "\n");
    return promise;
  }

  private notify(method: string): void {
    const proc = this.ensureProcess();
    proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vibe-bridge", version: "0.1.0" },
    });
    this.notify("notifications/initialized");
  }

  async listTools(): Promise<McpToolInfo[]> {
    const result = (await this.request("tools/list")) as { tools?: McpToolInfo[] } | undefined;
    return result?.tools ?? [];
  }

  /** 原服务器把错误也包在成功结果里（content[0].text 为 JSON 串）；这里统一解析。 */
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    try {
      const result = (await this.request("tools/call", { name, arguments: args })) as {
        content?: { type: string; text?: string }[];
        isError?: boolean;
      } | undefined;
      const text = result?.content?.find((c) => c.type === "text")?.text ?? "";
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* 非 JSON 文本原样透出 */
      }
      const looksLikeError =
        (result?.isError === true) ||
        (typeof parsed === "object" && parsed !== null && "error" in parsed && Object.keys(parsed as object).length === 1);
      if (looksLikeError) {
        const message =
          typeof (parsed as { error?: unknown }).error === "string"
            ? (parsed as { error: string }).error
            : JSON.stringify(parsed);
        return { status: "error", error: { code: "tool_error", message } };
      }
      return {
        status: "success",
        result: typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : { text },
      };
    } catch (err: unknown) {
      return {
        status: "error",
        error: { code: "tool_error", message: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  async dispose(): Promise<void> {
    const proc = this.proc;
    if (!proc || proc.exitCode !== null) return;
    const exited = new Promise<Error | undefined>((resolve) => this.exitWaiters.push(resolve));
    proc.stdin?.end();
    const killer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* 已退出 */
      }
    }, 5000);
    try {
      await exited;
    } finally {
      clearTimeout(killer);
    }
  }
}

/** MCP tools/list → VibeToolSpec（inputSchema 即 JSON Schema，TypeBox 同构，直接透传）。 */
export function toVibeToolSpecs(tools: readonly McpToolInfo[]): VibeToolSpec[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    parameters: (t.inputSchema ?? { type: "object", properties: {} }) as VibeToolSpec["parameters"],
  }));
}

/** MCP 连接 → ToolPort。execute 的 signal 语义：连接销毁时 pending 调用一并失败。 */
export function createMcpToolPort(conn: McpServerConnection): ToolPort {
  return {
    execute: async (intent) => conn.callTool(intent.name, intent.arguments),
  };
}
