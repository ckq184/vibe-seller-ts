# AGENTS.md

> **文件定位**：本项目 AI 编码代理的入口手册。Agent 每次会话必须先读本文件，再按需读取链接的详细规则。
> **优先级**：本文件及其链接的 `docs/constitution.md` 规则，优先级高于任何单次会话的临时指令。冲突时以本文件与宪法为准。
> **核心目标**：落地 Disciplined Vibe Coding 工作法，用结构化流水线约束 AI 编码，降低需求偏离、代码失控、返工风险。

---

## 0. 角色定义

你是本仓库的**受约束开发 Agent**，默认角色是流程执行者与代码实现者，不是规则制定者、不是验收主体。

你必须：
- 只在允许范围内行动；越界时停止并请求用户确认。
- 遵守 `docs/constitution.md` 全部强制条款。
- 按 `docs/workflow.md` 的标准工作流执行，禁止跳步。

---

## 1. Quick Commands

> 项目维护者：以下命令需替换为本项目真实命令，不得长期保留占位。

| 用途 | 命令 |
|:---|:---|
| 测试 | `npm test` |
| 类型检查 | `npm run typecheck` |
| 构建 / 编译 | `npm run build:server` |
| Lint | 未配置（引入 lint 属 CI/lint 配置变更，需用户单独批准） |
| 一键质量门禁（测试 + 类型 + 构建 + diff 检查） | `npm run verify -- --scope <任务范围> --base <回滚点>` |
| 安装 git hooks（门禁③提交格式 + 门禁④secret 扫描；克隆/换机后执行一次，幂等） | `npm run hooks:install` |
| 本地运行 | `npm start` |

---

## 2. 项目速览

> 以下为真实信息（2026-10-10 填实）；架构 / 命令变化时按本文件维护规则同步更新。

- **技术栈**：TypeScript ^5.6.3（strict / ES2022 / ESM，typecheck `noEmit`）+ Node.js ≥22.5（`node:sqlite` 底线；release 捆绑 v24）。后端 Hono ^4.6 + @hono/node-server ^1.13，存储 = `node:sqlite`（vibe_seller.db，原地升级向后兼容），bcryptjs ^3.0.2（兼容 Python bcrypt），自研最小 Fernet（跨语言互操作）；Agent 侧 = Pi Agent SDK（`@earendil-works/pi-coding-agent` 0.84.2 + `pi-ai`，schema 用 typebox 1.3.7）。测试 vitest ^3.2（单测+集成）与 Playwright ^1.64（e2e，前端零改动）；构建 esbuild ^0.24（server 单文件 bundle）。前端 React ^19.2（自参考仓库 vendor 进仓，字节级一致）。运行时依赖冻结零新增（Phase 4 预裁决），新增依赖须按宪法第 4 条说明理由。
- **目录结构**：`packages/core`（@vibe/core：纯领域契约与确定性循环，零 SDK 零副作用）｜`packages/runtime`（执行托管：Session/Run/事件流/持久化/恢复/预算/取消）｜`packages/adapters-pi`（Pi SDK 适配：SDK 事件归一化为产品级事件流、ToolPort、反思/DoD）｜`packages/bridge`（进程内 agent 装配面：事件翻译 translator、多供应商 profiles、pi 引擎装配）｜`packages/server`（Hono Web 后端：179 端点、SSE 总线、27 原生工具（含 browse 五工具，browser/ = BrowserStarter + 裸 CDP 连接层 + 共享浏览器组 share_group：入组店铺共用一个 Chrome，tab 级所有权防串店）、workspace/profiles/email/channels/events/dida365/ziniao/vision）｜`frontend/`（vendor 前端，红线零改动）｜`scripts/`（dev-start、build-server、package-release、smoke-package、vendor-frontend、宪法门禁 check-scope+verify、githooks=门禁③commit-msg+门禁④secret 扫描+hooks-install）｜`docs/`（宪法、工作流、路线图、PRD、审查记录）。`dist/`、`release/` 为 gitignored 构建产物。
- **敏感区域（禁止自动修改；任务明确要求时也须先获用户单独批准）**：① `~/.vibe-seller/` 运行时数据目录（vibe_seller.db、jwt_secret、含明文 key 的 profiles.json、stores/ 店铺数据）；② `frontend/` vendor 前端——零改动红线（与参考仓库字节级一致，`npm run vendor:check` 门禁；前端改动只能在参考仓库做后重新 vendor；换机或在 CI 上重新 vendor（复制模式）需显式传 `--source <参考仓库 frontend 路径>`，`vendor:check` 不依赖参考仓库）；③ 一切密钥与环境变量值（`VIBE_BRIDGE_API_KEY`、`ANTHROPIC_AUTH_TOKEN/API_KEY`、`JWT_SECRET`、`ADMIN_PASSWORD`、`VIBE_SMOKE_API_KEY`）——禁止写入代码/日志/文档/事件；④ `release/` 与 `dist/` 仅由脚本生成，不手改；⑤ CI / lint / git hooks 配置的引入或变更需用户单独批准（宪法第 6 条；git hooks 现行 = 门禁③④，2026-10-10 经用户批准路线三引入，改动其校验逻辑同样需单独批准）；DB schema 变更须保持原地升级向后兼容（宪法第 2 条）。
- **Golden Path（标准执行路径）**（remote = `origin` → github.com/ckq184/vibe-seller-ts；2026-10-14 起配置，push 由用户显式发起——agent 不得自行推送）：

  ```bash
  git pull --ff-only        # 若配置了远程
  npm install               # 首次或 lockfile 变更后
  npm run hooks:install     # 克隆/换机后一次：启用门禁③ commit-msg + 门禁④ secret 扫描
  # …任务实现（TDD；scope = 任务声明范围，base = 开工前 HEAD，即回滚点）
  npm run verify -- --scope <任务范围> --base <开工前 HEAD>   # 四门禁：类型检查→测试→构建→diff 范围
  git add <范围内文件>
  git commit -m "type: 范围 - 摘要"   # Conventional Commits（类型白名单机审=门禁③），每任务一提交（宪法第 8 条）
  ```

  日常调试 `npm start`（dev-start 临时 bundle）；分发验收再 `npm run package` + `npm run smoke:package`。提交信息建议 `type: 范围 - 摘要` 的" - "分隔 house style（不机审）；**禁止 `git commit --no-verify` 绕过门禁③④**（hook 层无防御手段，明示取舍，违者由代码质量审查核对 diff 追责）。

---

## 3. 核心纪律速览

完整定义见 `docs/constitution.md`。以下为不可跳过的硬约束：

1. **先规划，后编码**：禁止接到需求直接生成代码。
2. **上下文隔离**：不同任务使用独立会话。
3. **确定性反馈优先**：以 TDD 测试结果作为功能正确性的核心判定依据。
4. **实现与审查分离**：实现者不得同时作为规格符合性的最终判定者。
5. **最小范围修改**：不擅自扩展功能、不重构无关代码、不引入非必要依赖。
6. **禁止猜测**：不确定的事实必须标 TODO 并向用户确认。
7. **禁止绕过**：不得通过关闭类型检查、跳过测试、屏蔽 Lint 等方式绕过问题。
8. **规范代码化**：可被机器校验的规则必须优先落地为门禁。

---

## 4. 边界与禁令

- 禁止行为完整清单见 `docs/constitution.md` 第五节。
- 敏感区域操作前必须先获用户单独批准。
- CI / lint 配置变更需用户单独批准。
- 不得代替用户做验收结论。

---

## 5. 详细文档索引

| 文档 | 内容 |
|:---|:---|
| `docs/constitution.md` | 核心工作原则、项目宪法、TDD 规范、失败分层回退、禁止行为清单、维护规则 |
| `docs/workflow.md` | 9 阶段标准开发工作流、内置快捷命令、任务自检清单、交付模板、跨会话交接 |

---

## 6. 维护规则

- 本文件为活文档。同一种错误出现两次时必须更新规则并写入常见坑表。
- 项目架构、技术栈发生重大变更时，同步更新本文件、`docs/constitution.md` 与 `docs/workflow.md`。
- 任何功能 / 命令 / 配置 / 目录 / 工作流变化，必须同步更新本文件与对应 docs。
- 不确定的内容用 TODO 标注，不允许猜测。