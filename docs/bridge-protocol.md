# vibe-seller 桥接协议（Python FastAPI ↔ TS Agent Runtime）v1

> 绞杀者接缝。原仓库 `app/ai/base.py::AIAgentBackend` 是作者预留的抽象（docstring：
> "Future: OwnAgentRuntime"）。本协议让 `TsAgentBackend(AIAgentBackend)` 通过
> HTTP+SSE 把 agent 执行切到 `@vibe/runtime`，FastAPI / task_runner / orchestrator
> 零改动。CLI 后端（ClaudeCodeBackend）与桥后端按任务并存 —— 逐任务切流，随时可回。

## 安全边界

- 桥只监听 `127.0.0.1`（与本机 FastAPI 同机进程间通信），可选 `VIBE_BRIDGE_TOKEN`
  （Bearer）双向核对；
- 模型 API key 只经 `VIBE_BRIDGE_API_KEY` 环境变量进入桥进程，绝不入事件、日志、
  RunLog、SSE 报文 —— 与 v1 以来的密钥红线一致；
- `message_history` / prompt 属业务数据，只进该 run 的 RunLog（`~/.vibe-seller-ts/runs/`）。

## 端点

### POST /v1/runs → 202

请求体（对齐 `AIAgentBackend.run` 参数，缺省同 Python 侧）：

```json
{
  "task_id": "…",            // 必填；同一 task 已有活 run → 409
  "prompt": "…",             // 必填
  "system_extra": "",
  "mode": "execute",         // execute|auto|chat|plan_then_execute（v2：plan 走 execute 语义，
                             // plan 落库在适配器 save_plan 钩子）
  "profile_id": "default",   // 多供应商档位（对应原 task.ai_profile_id）；见下方 profiles 章节
  "message_history": [],     // 非空时内联为历史上下文前缀（同 CLI 死会话恢复路径）
  "no_store": false,
  "store_slug": null,
  "workspace_dir": null,     // 任务工作区绝对路径（agent cwd）；缺省用桥 cwd
  "skills_dir": null,        // SKILL.md 目录；缺省 VIBE_BRIDGE_SKILLS_DIR
  "persist_prompt": true,
  "skip_reflection": true,   // 反思由 Python 侧 DoD/reflection 钩子承担时置 true
  "resume": false,           // v1 语义：带历史上下文的新 run（非 CLI --resume）
  "gated_tools": []          // 需人工确认的工具名清单（默认取桥启动配置）
}
```

响应 `202 {"run_id","session_id"}`；`409 {"error":"already_running"}`；
`429 {"error":"at_capacity"}`（并发饱和；Python 侧信号量先挡，此处兜底）；
`503 {"error":"run_factory_failed"}`（每 run 工厂失败，如 MCP 服务器拉起失败）。

**plan_then_execute（v2）**：按 execute 语义接受。plan 文本 = run 的 result_text，
落库走 Python 适配器的 `save_plan` 钩子（复刻 `_save_design_plan`：plan_history 追加 +
`task.plan` + PLANNED + `task_update`；fanout 结构校验被拒 → run 带 `plan_invalid` 失败）。
plan 保存后 `session.plan_saved_event` 置位，`execute_planned_task` 的会话结束等待照常工作；
活会话审批不存在（run 已结束）→ `approve_plan` 返回 False → 走编排器既有的
dead-session 回退（全新 execute 会话）。与 CLI 计划模式的已知差异：桥内 plan run
不做成只读工具沙箱（靠设计提示词 + 确认闸门约束），fanout 违规是终局失败而非会话内重规划。

### GET /v1/runs/:run_id/events → SSE（text/event-stream）

事件帧：`event: <name>\ndata: <json>\n\n`；每 15s 一帧 `event: ping`。
`done` 之后服务端关闭流。帧词汇与原 CLI 后端 emit 到 `event_bus` 的形状逐字段对齐：

| SSE event | data | Python 适配器动作 |
|---|---|---|
| `message` | `{"task_id","role","content"}`，role ∈ user/assistant/thinking/tool_use/result/system/agent_event | `_emit_message`：SSE + DB（`tool_use` content 是 `{"tool","input"}` JSON 串；`agent_event` 是诊断 JSON 串） |
| `questions` | `{"task_id","request_id","questions"}` | `event_bus.emit('task_questions',…)` + 记入 pending questions |
| `todos` | `{"task_id","todos"}` | `task_todos` 事件 + `task.todos` 落库 |
| `status` | `{"task_id","status"}`（bridge 内部状态，供轮询/排障） | 仅记录，不发 event_bus |
| `done` | `{"task_id","status","result_text","error_code","interrupted","usage"}`，status ∈ completed/partial/failed/cancelled | `agent_done` 事件 + `_save_result` 等价落库 + 关闭 watcher |

事件语义映射（AgentEvent → SSE）：

- `run_started` →（无 UI 帧；`persist_prompt=true` 时补一帧 `message{role:"user"}`）
- `decision_made(call_tool)` → `message{role:"tool_use", content:JSON{tool,input}}`
- `decision_made(respond)` → 最终答复；进 `done.result_text`，`run_completed` 时补
  `message{role:"result"}`
- `tool_started` → 无帧（工具隔离，失败信息走 observation）
- `observation_added` → `message{role:"agent_event", content:JSON{event:"observation",tool,ok}}`
  （CLI 后端本就不向 UI 透出 tool_result；此处保留可观测性）
- `human_input_requested`（确认闸门挂起）→ `questions`；**run 保持活连接**
  （awaiting_human），无需 CLI 的停进程 WAITING 停靠
- `usage_reported` → 无 UI 帧，进 `done.usage`
- `run_completed` → `message{role:"result"}` + `done{status:"completed"|partial}`
  （partial 携带 `missing_materials`）
- `run_failed` → `message{role:"system"}` + `done{status:"failed", error_code}`
- `run_cancelled` → `done{status:"cancelled", interrupted:true}`

### POST /v1/runs/:run_id/answers → 202

`{"request_id","answers":{...}}`。对应 `submit_answer`：闸门批复
（`{"kind":"tool_approval","approved":bool}` 由桥按 `answers` 组装：answers 含
`approved:false` 即拒绝）。未知/已消费 request_id → `409`。

### POST /v1/runs/:run_id/stop

对应 `stop()`：取消活 run → `done{status:"cancelled"}`。幂等，run 不存在 → `404`。

### POST /v1/runs/:run_id/messages → 202 | 409

`{"message":"…"}`。v1 一律 `409 {"error":"not_live"}`：TS runtime 无"活会话插话"，
Python 侧现有 fallback（fresh run + resume + message_history）接管 —— 与 CLI
死管道路径同语义。后续批次实现活会话续话。

### GET /v1/runs/:run_id → 200

`{"run_id","task_id","status","result_text","error_code","pending_questions"}`。

### GET /v1/health → 200

`{"ok":true,"runs_in_flight":N,"max_concurrent":M}`。

## Python 侧适配器（`python/ts_agent_backend.py`）

`TsAgentBackend(AIAgentBackend)`，stdlib-only（asyncio + 手写 HTTP/SSE 解析）：

- `run(...)`：POST /v1/runs → 后台 watcher 消费 SSE 翻译进 `event_bus` + DB；
  返回 True（同 ClaudeCodeBackend.launch-then-watch 结构）；
- `get_session(task_id)` → `TsSessionHandle`：`.done`（asyncio.Event）、
  `.plan_saved_event`、`.running`、`.session_id`、`.result_text`、
  `.error_category`、`._last_pending_questions`（WAITING 停靠兼容）、
  `._loaded_skills`/`._catalog_read`（跨 run 记忆透传）；
- `retry_without_resume(task_id)`：以原参数重启 fresh run（编排器重试路径不变）；
- `submit_answer / send_message / approve_plan / reject_plan / is_running / stop /
  stop_all / get_pending_questions / interrupt_pending_question` 全部对齐基类；
- 钩子对象 `TsBackendHooks(emit, persist_message, save_result, persist_todos)`
  可注入；生产接线函数（懒 import `app.events.bus`/`app.database`）复刻
  `_emit_message`/`_save_result`/`_persist_todos` 语义（含 `transcript_tail`
  而非 `task.result` 的红线：prose 永不自动成为交付物）。

## 工具面（v2：MCP）

原仓库工具实现不移植：桥每 run 拉起**同一个** `python -m app.mcp_server --token T --port P
--task-id <taskId>`（其工具经 loopback HTTP 代理回 FastAPI，全部原样复用）。桥内置零依赖
MCP stdio 客户端（`packages/bridge/src/mcp.ts`），只实现原服务器说的那部分协议：

- `initialize` → `notifications/initialized`（无响应）→ `tools/list` → `tools/call`；
- `tools/list` 结果直接成为模型工具面（inputSchema 即 JSON Schema，TypeBox 同构直通）；
- `tools/call` 的 `content[0].text`（JSON 串）解析为 ToolCallResult；原服务器把错误包在
  成功结果里（`{"error": "..."}`），客户端归一为 `status: error`；
- 一个 run 一条连接：run 真终局（completed/failed/cancelled）时 dispose 杀进程；
  挂起（awaiting_human）期间连接保持，resume 段继续用同一工具面；
- 进程死亡 → 后续/在途调用失败为 `tool_error` 观察（工具隔离，不反噬 run）。

配置：`VIBE_BRIDGE_MCP_COMMAND="python -m app.mcp_server --token T --port 8000"`
（空白分词，引号成对；`--task-id` 由桥按 run 追加）、`VIBE_BRIDGE_MCP_CWD`（app 可导入的目录）。
未配置 = 空工具面（聊天形任务可用）。

## 桥进程启动（TS 侧）

```
npm run bridge:build   # esbuild 打包 packages/bridge/dist/bridge.mjs（见 packages/bridge/build.mjs）
VIBE_BRIDGE_ENGINE=scripted VIBE_BRIDGE_SCRIPT=script.json \
VIBE_BRIDGE_PORT=8765 VIBE_BRIDGE_TOKEN=... \
VIBE_BRIDGE_DATA_DIR=~/.vibe-seller-ts \
node packages/bridge/dist/bridge.mjs
```

- 打包必须 ESM：pi-coding-agent 依赖 `import.meta.url`，CJS 产物会启动即崩；banner 注入
  `createRequire` 让 CJS 依赖（cross-spawn 等）能加载内置模块（别名避开 esbuild 自身注入）。
- scripted 引擎脚本 JSON：`{ "decisions": [...], "tool_names": [...], "gated_tools": [...] }`
  ——对齐原仓库 `Options.MOCK_CLI` 的假后端模式，测试/CI 用，绝不冒充真模型。
- pi 引擎：`VIBE_BRIDGE_API_KEY`（只经环境变量）/ `VIBE_BRIDGE_BASE_URL` /
  `VIBE_BRIDGE_MODEL` / `VIBE_BRIDGE_PROVIDER_ID`；v1 未接 MCP 工具面（批次 2）。

## 已裁决的实现语义（测试钉死）

- **tool_use 消息帧在门拦截之前发出**——与 CLI 契约同构（工具卡片先于权限提示）；
  执行证据看 `agent_event` 的 observation（`ok: success` / `denied`）。
- **stop 与门挂起的竞态**：stop 走 abort 分支后 run 以 awaiting_human 收尾时，桥直接
  登记 cancelled 终局（等价 CLI 停掉停在 AskUserQuestion 的进程），消费方必收 done 帧。
- **done 帧恰好一帧**：终局事件由 translate 正常发出时不再补发；无终局事件才合成
  （挂起且未 stop → 保持 feed 开放等 resume，不合成）。
- **runId 同源**：桥接管 `newRunId`，注册表外部 runId = RunLog runId，resume/answers
  才能路由到真 run（曾因双 ID 走样导致 resume "unknown run"）。
- Python 客户端 SSE 用 HTTP/1.0 close 定界（免 chunked 解码）；事件词汇翻译与
  DB 写入在 `TsBackendHooks` 后可注入。

## 多供应商 profiles（v3）

`VIBE_BRIDGE_PROFILES` 指向配置 JSON（缺省探测 `~/.vibe-seller-ts/profiles.json`，存在即启用）：

```json
{
  "profiles": {
    "default":  { "provider_id": "stepfun",  "base_url": "https://api.stepfun.com/step_plan",  "model": "step-3.7-flash",    "api_key_env": "VIBE_KEY_STEPFUN" },
    "deepseek": { "base_url": "https://api.deepseek.com/anthropic", "model": "deepseek-v4-pro", "api_key_env": "VIBE_KEY_DEEPSEEK", "context_window": 128000, "max_tokens": 8000 }
  }
}
```

- **密钥红线变体**：配置文件只存环境变量**名字**（`api_key_env`），密钥值在该 profile
  首次被用到时才从进程环境读取并注入 ModelRuntime —— 密钥永不落盘（比原仓库
  profile 直接存 env 覆盖更严格）；
- 请求体 `profile_id` 决定 run 用哪个 provider；未知 profile → run 工厂失败（503）；
  key 环境变量缺失 → 该 run 快速失败并点名缺失变量（启动不拦，其他 profile 不受影响）；
- pi 上下文按 profile 惰性构建缓存；与 MCP 工具面正交组合（每 run：profile 引擎 ×
  按任务拉起的 MCP 连接）；
- 未配置 profiles 文件 = 单供应商模式（`VIBE_BRIDGE_API_KEY` 等环境变量）。

## 活会话续话的裁决（为什么 `messages` 恒 409）

桥的会话语义是"新会话 + recap 交接"（与确认闸门 resume 同款取舍）：每个 run 一条
全新 SDK 会话，上下文由 prompt/历史内联携带。CLI 的活会话插话价值在共享上下文窗口
与在途进程，而桥里 follow-up 的语义等价物（fresh run + message_history）已经存在，
且编排器**两条路径都有现成回退**：活 run 时 `messages` 409 → 路由器 fresh-spawn；
死会话时路由器本来就 spawn fresh。为此把 in-flight 打断续话判定为低价值高风险
（CLI 自身在该路径就有 turn-terminator 竞态），`POST /v1/runs/:id/messages` 维持
恒 409 `not_live`。若未来需要真·活会话，落点是 runtime 增加"同 Session 新 Run"
（replay 上一个 run 的状态起新 episode），而不是在桥上保持进程。

## 版本与兼容

- 协议版本：`GET /v1/health` 返回 `"protocol": 1`；不兼容变更升号并在两端同时支持；
- 双端契约测试钉死本文件：TS 侧真 HTTP e2e（`packages/bridge/test/`），
  Python 侧 stdlib unittest 起真桥进程（`python/test_ts_agent_backend.py`）。
