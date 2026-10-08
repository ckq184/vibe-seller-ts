// 假 MCP 服务器（fixture）：按原仓库 app/mcp_server.py 的线协议说话
// （newline 分帧 JSON-RPC：initialize / tools/list / tools/call），工具结果脚本化。
// 用法：node fake-mcp.mjs <script.json>
// script.json: { "tools": [{name, description, inputSchema}], "results": {tool: {...}} }
//   - results[tool] 为对象 → JSON 串回给客户端（success）
//   - results[tool] 为 {"__error__": "msg"} → {"error": msg}（桥应判 error）

import { createInterface } from "node:readline";

const scriptPath = process.argv[2];
const script = JSON.parse((await import("node:fs")).readFileSync(scriptPath, "utf8"));

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { method, id } = msg;
  if (method === "initialize") {
    respond(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "fake-mcp", version: "0.0.1" },
    });
  } else if (method === "tools/list") {
    respond(id, { tools: script.tools ?? [] });
  } else if (method === "tools/call") {
    const name = msg.params?.name ?? "";
    const result = script.results?.[name];
    const text =
      result && typeof result === "object" && "__error__" in result
        ? JSON.stringify({ error: result.__error__ })
        : JSON.stringify(result ?? { echo: msg.params?.arguments ?? {} });
    respond(id, { content: [{ type: "text", text }] });
  } else if (id !== undefined && id !== null) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } }) + "\n");
  }
});

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
