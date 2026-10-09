# vibe-seller-ts

[vibe-seller](https://github.com/zpoint/vibe-seller)（跨境卖家 AI 自动化框架）向 pi Agent SDK 架构的 TypeScript 迁移基座。原项目用 Claude Code CLI 包装做 agent 内核；本仓库按 **Agent Core / Runtime / 适配器** 三层重建内核，方向即原项目 `DESIGN.md` 规划的长期目标（Own Agent Runtime）。

方法与契约遵循 pi-coding-agent 技能（`@earendil-works/pi-coding-agent@0.84.2` 基线）：

```
Task → Context → 模型决策 → 工具动作 → 观察 → 状态推进 → 结果/下一轮
```

## 结构

```
packages/
  core/        @vibe/core        纯领域契约 + 确定性循环。零 SDK 依赖、零副作用、可独立测试。
  runtime/     @vibe/runtime     执行托管：Session/Run、产品级事件流、JSONL RunLog（唯一事实源）、
                                 预算/超时/取消、awaiting_human → resume 回放续跑、usage 上报、
                                 引擎接缝（RunEngine：Core 引擎 ↔ Pi 引擎可替换）。
  adapters-pi  @vibe/adapters-pi Pi SDK 适配器：SDK 拥有循环（createAgentSession），
                                 事件归一化为产品级事件流；ToolPort ↔ defineTool 桥；
                                 DoD rubric 评审 + 任务后反思 + SKILL.md 加载器。
  bridge/      @vibe/bridge      Python↔TS 绞杀桥（Phase 3）：HTTP+SSE 服务，事件词汇与原
                                 event_bus 逐字段对齐；scripted/pi 双引擎引导；MCP 工具面
                                 每 run 拉起原仓库 app.mcp_server；多供应商 profiles。
  server/      @vibe/server      TS Web 后端（Phase 4）：Hono + node:sqlite 与原库原地共存；
                                 JWT/cookie/bcrypt 与 Python 侧逐字节兼容；SSE 总线契约一致；
                                 批次 4.1 起逐步点亮；4.5 后含 workspace（git 自托管知识库
                                 + skills + CATALOG 桩契约 + knowledge/skills 远端同步）、
                                 profiles（原格式 profiles.json + 保存探针 + 引擎双源派生）
                                 与 workspace assistant（SSE 会话）；4.6 后含外围面：
                                 email（Fernet 跨语言互操作 + 自研最小 IMAP/SMTP + per-account
                                 SQLite + 水位游标）、channels/wecom（打码 + 路径白名单）、
                                 events（状态机 + 事件抽取/同步）、dida365 OAuth、
                                 ziniao/browser（本地 HTTP 请求面 + 外部进程托管）、
                                 vision（确认闸门 + kie.ai + ref-proxy SSRF 防护）。
python/
  ts_agent_backend.py            TsAgentBackend(AIAgentBackend)：stdlib-only 适配器，
                                 直接替换原仓库的 ClaudeCodeBackend，编排器零改动。
  test_ts_agent_backend.py       跨语言契约测试（拉起真桥子进程，stdlib unittest）。
docs/
  migration-plan.md             五阶段迁移路线与状态、等价性红线、架构决定
  adapter-mapping-note.md       Port ↔ Pi SDK 映射笔记（已装机核实 v0.84.2）
  bridge-protocol.md            桥协议 v1：端点、事件映射、已裁决语义
  phase4-backend-inventory.md   原后端表面积盘点（179 端点/19 表/26 SSE 事件）与 Phase 4 批次计划
```

关键不变量（全部有测试锁定）：

- 事件日志是 run 的唯一事实源：先落盘再推消费者；回放重建 AgentState 幂等；
- 取消/超时/失败绝不伪造完成：`run_cancelled` / `run_failed(budget_timeout)` 可区分归因；
- 预算（迭代/工具/重试/超时）由 Runtime 与循环共同执行；同一意图连续失败 3 次判 `no_progress` 空转止损；
- `run_completed` 区分 `complete` / `partial`（partial 必须点名 missingMaterial）；
- 两个 Session 互不共享消息、状态与观察；
- 桥上密钥只走 `VIBE_BRIDGE_API_KEY` 环境变量，绝不入事件/日志/RunLog/SSE 帧。

## 命令

```bash
npm install          # workspaces：core + runtime + adapters-pi + bridge + server
npm test             # vitest run —— 322 例通过（另有 2 例真实 provider 冒烟需 API key）
npm run typecheck    # tsc 严格模式全仓检查
npm run bridge:build # 打包 packages/bridge/dist/bridge.mjs（跨语言测试的前置）
python python/test_ts_agent_backend.py   # 跨语言契约测试（需先 bridge:build）
npm run e2e          # 前端零改动 e2e（需系统 Chrome；原 React dist 只读挂载）
python python/record_replay_fixture.py   # 重录回放 fixture（需 _reference 参考仓库 venv，平日不用）
```

## 金标回放

`packages/runtime/test/golden.test.ts` 用 noon FBN 报表任务（list_reports → download_report → respond）
钉死了 15 条产品级事件的完整 transcript（确定性时钟 + ID）。以后接真实 Pi SDK 适配器时，
fake 与 real 通道必须回放出**同一条** transcript，SDK 升级才不致悄悄改变语义。

## 状态

Phase 1–3 完成（内核/技能闸门/编排绞杀桥：TsAgentBackend + MCP 工具面 + plan 模式 + 多供应商 profiles）。**Phase 4 批次 4.1–4.7 全部完成**（批次 4.1–4.6 摘要见 git 历史与 `docs/migration-plan.md`；`@vibe/server` = Hono + node:sqlite 与原库原地共存，179 端点全点亮，JWT/bcrypt/Fernet 与 Python 逐字节兼容，SSE 总线契约一致，调度/workspace/profiles/email/channels/events/vision/ziniao 全家面齐）。**批次 4.7（验收）**：telemetry 模块移植（PostHog 最小 fetch 传输 + 四重门控 + ~20 事件面接线，零新运行时依赖）；**录制流量回放契约测试**——真 FastAPI（参考仓库 venv 进程内）录制 157 步 fixture 入库，TS 回放逐请求比对（零 Python 依赖、归一化 10 规则、时区钉死、篡改变红验证），对证修正 19 处 TS 契约偏差；**前端零改动 e2e**——`npm run e2e` 用 Playwright + 系统 Chrome 驱动原 React 19 构建产物（sha256 零改动）跑 TS server 关键流 5 用例。双重审查（独立规格审查 + 代码质量审查）后整改收口。测试：TS 322 通过 + 2 真实冒烟按需跳过；e2e 5 通过。**下一步：Phase 5（退役 Python、安装包捆 Node 运行时）或先做切流验收（用户指定延后）**。
