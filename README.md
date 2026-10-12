# vibe-seller-ts

本地优先的电商卖家 AI Agent 工作台 —— [vibe-seller](https://github.com/zpoint/vibe-seller)（Python 跨境卖家自动化框架）向 pi Agent SDK 架构的 TypeScript 重写版，完成原项目 `DESIGN.md` 规划的长期目标（Own Agent Runtime）。单机运行（默认只绑 `127.0.0.1:7777`），数据全部落在 `~/.vibe-seller/`，前端字节级继承原版 React 界面。

```
Task → Context → 模型决策 → 工具动作 → 观察 → 状态推进 → 结果/下一轮
```

## 功能

- **真实模型驱动的任务 Agent**：接一个 Anthropic Messages 兼容端点（StepFun / GLM / Kimi / DeepSeek 等 9 家预设），对店铺建任务，agent 用原生工具完成"调研 → 计划 → 执行 → 回填结果"闭环；plan-only 设计任务、cron 定时调度、多店 fanout 均支持。
- **27 个原生工具**：任务/店铺/日程管理、workspace 读写、邮件（自研 IMAP/SMTP）、企业微信机器人、事件（dida365 / Google Calendar）、图片生成（vision，人工确认卡）、以及 **5 个浏览器工具**（navigate / tabs / read / act / eval——裸 CDP 驱动本机 Chrome，操作卖家中心页面完成"导航 → 读取 → 回填"）。
- **确认闸门**：把任意工具名加入 `VIBE_BRIDGE_GATED_TOOLS`，agent 调用即挂起等人工批准/拒绝（默认拒绝），前端一键批复；图片生成天然带确认卡。
- **多供应商 profiles**：UI 管理多套模型配置，改档免重启热切换，密钥不出本机、绝不入日志/事件。
- **workspace 自托管**：店铺档案 / 知识库 / 技能落在 `~/.vibe-seller/`，git 自动提交历史，文件级版本与回滚。
- **工程纪律内置**：`npm run verify` 四门禁（类型 / 测试 / 构建 / diff 范围）+ commit-msg 格式门禁 + pre-commit 密钥扫描（七模式 + 可审查 allowlist）。

## 快速开始（Windows）

**双击 `start.bat`** —— 自动完成环境检查 → 首次 `npm install` → 新窗口启动服务 → 等就绪 → 打开浏览器。

默认账号 `admin / admin`，**首次登录后请到设置页修改密码**。

手动等价命令（任意平台，Node ≥ 22.5）：

```bash
npm install
npm start          # 开发形态：esbuild 临时 bundle + 进程内启动，Ctrl+C 停止
# 浏览器打开 http://127.0.0.1:7777/
```

### 配置模型（必需）

任选其一：

1. **UI**：设置 → AI → 模型 profiles，新增 profile，填 Anthropic 兼容端点 + 模型 id + API key；
2. **文件**：编辑 `~/.vibe-seller/profiles.json`（热生效，免重启）：

```json
{
  "profiles": {
    "my-model": {
      "name": "My Model",
      "description": "",
      "load_global_mcp": false,
      "env": {
        "ANTHROPIC_BASE_URL": "https://<你的兼容端点>/anthropic",
        "ANTHROPIC_MODEL": "<模型 id>",
        "ANTHROPIC_AUTH_TOKEN": "<你的 API key>"
      }
    }
  }
}
```

> 只支持 Anthropic Messages 兼容端点（OpenAI 原生 chat/completions 形状不支持）。key 按原版设计明文存于该文件，请自行保证磁盘安全。

## 浏览器工具（操作店铺页面）

给店铺建档（chrome 后端）→ 启动店浏览器 → 在弹出的 Chrome 窗口里**登录一次**卖家中心（登录态持久保存）→ 建任务让 agent 操作；店铺无关的通用网页用 `session: "web"`。

**多店铺共用一个 Chrome（共享浏览器组）**：缺省一店一个 Chrome 进程；把多个**不同域名**的店铺建店/改店时配上同一 `browser_config.share_group`（如 `{"share_group":"main"}`，字符集 `[a-zA-Z0-9_-]`），它们就会共用一个 Chrome（一个窗口多标签，每店只能看到/操作自己的标签）。cookie 按域名隔离，不同域名的店铺登录态互不影响；**同域名的店严禁入同一组**（登录会互踢）。入组店铺需在共享 profile 里重新登录一次；退组（`share_group` 置空串）即回原独立 profile 的旧登录态。

已知边界：**紫鸟（ziniao）后端的店铺暂不支持 agent 驱动**（返回结构化错误，绝不拉起无登录态的替代浏览器，且禁入共享组）；同店并发任务共享浏览器；每店 profile 只隔离 cookie，不隔离浏览器指纹与出口 IP——多账号隔离需求请自行评估关联风险。

## 分发与升级

```bash
npm run package                      # 产出 release/vibe-seller-ts/（捆绑 Node 运行时 + 前端，目标机无需装 Node）
release\vibe-seller-ts\start.bat     # 分发形态一键启动
npm run smoke:package                # 打包冒烟：全新安装 + Python→TS 原地升级两场景 23 断言
```

`~/.vibe-seller/` 数据目录跨版本**原地升级双向兼容**——含从 Python 原版直接升级：老用户 bcrypt 哈希可登录、店铺数据 / 加密凭据（Fernet 跨语言互操作）/ install_id 原样接管，详见 `docs/deploy.md`。

## 开发者指南

```bash
npm install                                  # workspaces：core + runtime + adapters-pi + bridge + server
npm test                                     # 全量测试（单测 + 集成；真实 provider/浏览器冒烟按需跳过）
npm run typecheck                            # tsc 严格模式全仓检查
npm run verify -- --scope <任务范围> --base <回滚点>   # 四门禁一键：类型→测试→构建→diff 范围
npm run hooks:install                        # 启用 commit-msg 格式门禁 + pre-commit 密钥扫描（克隆后执行一次）
npm run e2e                                  # 前端零改动 e2e（系统 Chrome；本仓 vendor 的前端 dist）
npm run vendor:check                         # 前端 vendor 清单校验（必须与参考仓库字节级一致）
```

提交遵循 Conventional Commits（`feat|fix|docs|chore|refactor|test|perf|build|ci|style|revert: 描述`，commit-msg hook 机审）；**禁止 `git commit --no-verify`**。开发流程（PRD → TDD → 双重审查 → 四门禁交付）见 `AGENTS.md` 与 `docs/workflow.md`。

## 结构

```
packages/
  core/        @vibe/core        纯领域契约 + 确定性循环。零 SDK 依赖、零副作用、可独立测试。
  runtime/     @vibe/runtime     执行托管：Session/Run、产品级事件流、JSONL RunLog（唯一事实源）、
                                 预算/超时/取消、awaiting_human → resume 回放续跑、usage 上报。
  adapters-pi  @vibe/adapters-pi Pi SDK 适配器：SDK 拥有循环，事件归一化为产品级事件流；
                                 ToolPort ↔ defineTool 桥；确认闸门；DoD 评审 + 任务后反思。
  bridge/      @vibe/bridge      server 进程内复用的 agent 装配面：事件翻译（event_bus 逐字段
                                 词汇表）、多供应商 profiles 解析、pi 引擎装配。
  server/      @vibe/server      TS Web 后端：Hono + node:sqlite，179 端点 / 26 SSE 事件；
                                 workspace（git 自托管）、profiles、email、channels/wecom、
                                 events、dida365、ziniao/browser、vision、27 原生工具面、
                                 浏览器层（BrowserStarter + 裸 CDP 连接层 + browse 五工具）。
frontend/                     原版 React 19 前端（181 文件 sha256 字节级 vendor，零改动红线）
scripts/                      构建/打包/冒烟/宪法门禁（verify、check-scope）/git hooks
docs/                         宪法、工作流、路线图、各期 PRD、审查记录
```

关键不变量（全部有测试锁定）：事件日志是 run 的唯一事实源（先落盘再推消费者，回放幂等）；取消/超时/失败绝不伪造完成；预算由 Runtime 与循环共同执行，同意图连续 3 次失败判 `no_progress` 止损；`run_completed` 区分 `complete`/`partial`（partial 必须点名 missingMaterial）；密钥绝不入事件/日志/RunLog/SSE 帧。

## 与原版（Python）的关系

绞杀者模式逐模块迁移已完成：REST/SSE 契约与原版**录制级对账**（真 FastAPI 录制 157 步流量回放 + 篡改变红）、工具 schema 与原实现 ast 抽取逐字节对账、前端 sha256 字节级一致、数据目录原地升级互认。有意边界：原版的紫鸟 / browser-use 浏览器链未迁入（"浏览器层外部进程托管"架构裁决），TS 以原生浏览器工具覆盖 chrome 后端 + web 会话场景。详见 `docs/migration-plan.md` 与 `docs/route2-browser-tools-prd.md`。

## 文档

| 文档 | 内容 |
|---|---|
| [AGENTS.md](AGENTS.md) | AI 编码代理入口手册（架构速览 / 纪律 / Golden Path） |
| [docs/constitution.md](docs/constitution.md) | 项目宪法（强制工程原则 + 机器门禁落地表） |
| [docs/workflow.md](docs/workflow.md) | 9 阶段标准开发工作流 |
| [docs/roadmap.md](docs/roadmap.md) | 路线图与各路线状态（真实任务验收 / 浏览器工具 / 门禁建设 / 台账清理） |
| [docs/deploy.md](docs/deploy.md) | 安装 / 升级 / 回退 |
| [docs/migration-plan.md](docs/migration-plan.md) | 五阶段迁移路线、等价性红线、架构决定 |
| [docs/审查记录.md](docs/审查记录.md) | 每任务双重审查结论与遗留台账 |

## 状态

迁移与后续建设全部完成：Phase 1–5（内核 / 闸门 / 编排 / Web 后端 / Python 退役）+ 路线 1 真实任务验收（真实模型 × 工具 × 闸门 × workspace 闭环）+ 路线 2 浏览器工具（27 工具面）+ 路线 3 宪法四门禁（verify / check-scope / commit-msg / secret 扫描）。测试 568+ 通过；打包冒烟 23/23；e2e 5/5。运行时 = 捆绑 Node + server.mjs + 前端 dist，`~/.vibe-seller` 原地升级双向兼容。后续方向见 `docs/roadmap.md`。
