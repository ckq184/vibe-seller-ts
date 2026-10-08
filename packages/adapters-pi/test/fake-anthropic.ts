import { createServer, type Server } from "node:http";

/**
 * 假 Anthropic Messages LLM：本地 HTTP 服务器，按 Anthropic Messages SSE 流式协议
 * 回放脚本化响应（官方 @anthropic-ai/sdk 客户端直连它）。
 * 用途：真实 SDK + 真实 provider 客户端 + 确定性"大脑" = 无需 API key 的集成测试。
 */

export interface ScriptedResponse {
  toolUse?: { id: string; name: string; input: unknown };
  text?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface FakeAnthropicServer {
  url: string;
  /** 收到的请求体（按序），供断言真实的模型往返次数与内容。 */
  requests: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

export function startFakeAnthropicServer(responses: readonly ScriptedResponse[]): Promise<FakeAnthropicServer> {
  const requests: Array<Record<string, unknown>> = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(body || "{}") as Record<string, unknown>;
      } catch {
        parsed = { _raw: body };
      }
      requests.push(parsed);

      const script = responses[Math.min(requests.length - 1, responses.length - 1)] ?? { text: "script exhausted" };
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const send = (event: string, data: unknown) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      send("message_start", {
        type: "message_start",
        message: {
          id: `msg_${requests.length}`,
          type: "message",
          role: "assistant",
          model: "scripted-1",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: script.inputTokens ?? 100, output_tokens: 1 },
        },
      });

      let stopReason = "end_turn";
      if (script.toolUse) {
        stopReason = "tool_use";
        send("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: script.toolUse.id, name: script.toolUse.name, input: {} },
        });
        send("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(script.toolUse.input) },
        });
        send("content_block_stop", { type: "content_block_stop", index: 0 });
      }
      if (script.text !== undefined) {
        const textIndex = script.toolUse ? 1 : 0;
        send("content_block_start", {
          type: "content_block_start",
          index: textIndex,
          content_block: { type: "text", text: "" },
        });
        send("content_block_delta", {
          type: "content_block_delta",
          index: textIndex,
          delta: { type: "text_delta", text: script.text },
        });
        send("content_block_stop", { type: "content_block_stop", index: textIndex });
      }

      send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: script.outputTokens ?? 10 },
      });
      send("message_stop", { type: "message_stop" });
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}
