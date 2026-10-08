# Pi Agent SDK 适配器映射笔记（Port ↔ SDK）

> **验证状态：已装机核实（2026-09-24，`@earendil-works/pi-coding-agent@0.84.2`，本仓库 node_modules）。**
> 下表所有签名读自 `dist/**/*.d.ts` 与官方 `examples/sdk/12-full-control.ts`，并经
> `packages/adapters-pi/test/pi-engine.test.ts`（真实 SDK × 假 Anthropic SSE 服务器）跑通验证。
> 升级 SDK 前先按技能版本基线协议重核本表。

## 已核实的 SDK 表面（v0.84.2）

| 表面 | 签名（摘自 d.ts） | 出处 |
|---|---|---|
| 组装入口 | `createAgentSession(options?: CreateAgentSessionOptions): Promise<CreateAgentSessionResult>` | `dist/core/sdk.d.ts` |
| 会话选项 | `{ cwd?, agentDir?, modelRuntime?, model?, thinkingLevel?, noTools?, tools?(allowlist), excludeTools?, customTools?: ToolDefinition[], sessionManager?, settingsManager?, resourceLoader? }` | 同上 |
| 会话方法 | `prompt(text, options?): Promise<void>`、`subscribe(listener): () => void`、`abort(): Promise<void>`、`dispose()`、`getSessionStats()`、`isStreaming`/`isIdle` | `dist/core/agent-session.d.ts` |
| 底层事件 | `agent_start/agent_end{messages}`、`turn_start/turn_end{message,toolResults}`、`message_start/update/end`、`tool_execution_start{toolCallId,toolName,args}`、`tool_execution_end{toolCallId,toolName,result,isError}` | `pi-agent-core/dist/types.d.ts` |
| 工具定义 | `defineTool({ name, label, description, parameters: TSchema(TypeBox), prepareArguments?, execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult> })` | `dist/core/extensions/types.d.ts` |
| Provider 注册 | `ModelRuntime.create({ authPath?, modelsPath?: string\|null, refreshOnCreate? })`；`registerProvider(providerId, { baseUrl, api: "anthropic-messages"\|"openai-completions", apiKey, models: [...] })`；`setRuntimeApiKey(providerId, key)`；`getModel(providerId, modelId)` | `dist/core/model-runtime.d.ts` |
| 完全受控姿势 | `SessionManager.inMemory(cwd)` + `SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } })` + 自定义 `ResourceLoader`（`getSystemPrompt` 等 11 个方法） | `examples/sdk/12-full-control.ts` |
| 传输层 | 官方 `@anthropic-ai/sdk`，`client.messages.create({ ...params, stream: true })` → POST `{baseUrl}/v1/messages`，SSE：`message_start → content_block_start/delta/stop → message_delta(stop_reason) → message_stop` | `pi-ai/dist/api/anthropic-messages.js` |
| TypeBox | 依赖为新包 `typebox@1.3.7`（`import { Type } from "typebox"`），不是 `@sinclair/typebox` | `pi-coding-agent/package.json` |
| 技能原语 | `loadSkillsFromDir({ dir, source })`（含 SKILL.md 发现规则：目录含 SKILL.md 即为技能根，不再下钻）；`parseFrontmatter<T>(content) → { frontmatter: T, body: string }`；`formatSkillsForPrompt`（XML 格式，本项目用自建 `buildSkillPromptSection` 以兼容 vibe frontmatter 的 requires/review） | `dist/core/skills.d.ts`、`dist/utils/frontmatter.d.ts` |
| 单次 LLM 调用 | `ModelRuntime.complete(model, context: Context, options?)`；`Context { systemPrompt?, messages: Message[], tools? }`；UserMessage 必须带 `timestamp`；`AssistantMessage.stopReason` 为 `error`/`aborted` 时看 `errorMessage`。`PiReviewer`（DoD rubric 评审与反思共用）基于此实现 | `pi-ai/dist/types.d.ts`、`dist/core/model-runtime.d.ts` |

## 本项目 Port → SDK 落点（已实现于 `packages/adapters-pi`）

| 本项目契约 | 实现落点 |
|---|---|
| RunEngine（`packages/runtime` 引擎接缝） | `createPiEngine(config)` —— SDK 拥有循环，一次 `prompt()` = 一整段 episode |
| 事件归一化 | `turn_start`→`model_requested`；`tool_execution_start`→`decision_made(call_tool)`+`tool_started`；`tool_execution_end`→`tool_completed`+`observation_added`；收尾 assistant 文本→`decision_made(respond)` |
| ToolPort ↔ SDK 工具 | `defineVibeTools(toolPort, specs)` —— `execute` 调 ToolPort，`ToolCallResult` 全量藏 `details`，返回 `{ content, details }` |
| 取消 | `deps.signal → session.abort()`；预算超限（toolCalls/turns）→ 主动 abort 并归因 `budget_tools`/`budget_iterations` |
| usage | `session.getSessionStats().tokens` → `usage_reported`（真机集成测试已见 token 到账） |
| 会话隔离 | 每 Run 一个全新 `AgentSession`（`SessionManager.inMemory`） |

## 金标语义一致性（已验证）

`pi-engine.test.ts` 断言 Pi 引擎事件类型序列 ≡ Core 引擎 fake 金标（`golden.test.ts`）：
`run_started, model_requested, [decision_made, tool_started, tool_completed, observation_added]×2, model_requested, decision_made, usage_reported, run_completed`。

## 已知缺口（真实存在，不要假装没有）

1. ~~**真实 provider 冒烟未跑**~~ → **已关闭（2026-09-24）**：StepFun `step-3.7-flash`（Anthropic 兼容端点 `https://api.stepfun.com/step_plan`，官方 SDK 在 baseURL 后拼 `/v1/messages`，故注册 baseUrl 不带 `/v1`）真实跑通 noon 报表任务：3 轮网络 LLM 往返、2 次工具调用参数正确、终局答复引用工具数据、usage 856 in / 466 out tokens、事件序列与金标逐字一致。用例：`packages/adapters-pi/test/real-provider.smoke.test.ts`（key 只从 `VIBE_SMOKE_API_KEY` 环境变量读，未设置时自动跳过）。
2. ~~**ask_human 门未接**~~ → **已关闭（2026-09-24）**：双引擎闸门齐备。Core 引擎原生挂起；Pi 引擎 episode 内命中门即中止会话挂起，恢复时批复在 SDK 之外消费（批准→引擎执行工具并以 recap 交回模型；拒绝→交回拒绝说明），闸门判定统一用 core 的 `resolvePendingGate`（唯一裁判）。真实模型（StepFun）验证通过：调价请求被拦截→批准→恰好执行一次→收尾。已知取舍：resume 后是新会话 + recap 交接，模型此前 episode 的中间自言自语不保留（工具调用与结果全量保留在事件日志里）。
3. **部分 provider 不回报 token**（技能验证日志观察 2）：usage 为尽力而为，成本追踪可能需第二来源。
4. **prompt 敏感**：小模型可能不调工具直接作答（技能真机记录），测试措辞需显式"第 1 步必须调用工具 X"。

## Phase 3 桥接事实（2026-09-24 核实，来源：原仓库源码通读 + 双端联调）

| 事实 | 依据 |
|---|---|
| 绞杀点即原作者预留接缝：`AIAgentBackend` 抽象（run/stop/submit_answer/send_message/approve_plan/reject_plan/is_running），docstring 明言 "Future: OwnAgentRuntime" | `app/ai/base.py` |
| 事件词汇（SSE→前端）：`task_message{task_id,role,content}`（role: user/assistant/thinking/tool_use( JSON串)/result/system/agent_event(JSON串)/delta）、`task_questions{request_id,questions}`、`task_todos`、`task_update`、`agent_done{return_code,mode,interrupted?}`、`task_question_interrupted` | `claude_backend_stream.py`、`claude_backend_hooks.py`、`events/bus.py` |
| tool_use 消息在权限/闸门拦截**之前**发出（工具卡片先于权限提示）；tool_result 不透出 UI | `_handle_event` assistant 分支 |
| 结果落库红线：`_save_result` 只写 `task.transcript_tail`，prose 永不自动成为交付物；deliverable 由 finalize 的 `task_outcome` 统一裁决 | `claude_backend_persist.py` |
| 编排器只依赖：`session.done`（asyncio.Event）、`get_session`、`_last_pending_questions`（WAITING 停靠）、`on_start`（并发槽内状态迁移） | `task_session_lifecycle.py`、`claude_backend_manager.py` |
| 桥 v1 语义升级：确认闸门以活连接挂起（run 保持 awaiting_human，HTTP 不断），不需要 CLI 的"停进程 → WAITING 停靠 → resume 拉新进程"三段式 | `docs/bridge-protocol.md` |
| 打包约束：esbuild 必须出 ESM——CJS 产物会把 pi-coding-agent 的 `import.meta.url` 变 undefined 启动即崩；banner 注入 `createRequire`（别名）供 CJS 依赖 require 内置模块 | `packages/bridge/build.mjs` |
| runId 必须同源：桥接管 `AgentRuntime` 的 `newRunId`，注册表外部 runId = RunLog runId | `packages/bridge/src/server.ts` |
