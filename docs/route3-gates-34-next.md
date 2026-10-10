# 路线 3 下一阶段：③ commit-msg hook + ④ secret 扫描（立项要点，待批准）

> **文件定位**：`docs/roadmap.md` 路线 3 剩余两项（宪法落地方式表建成顺序 ③④）的立项要点固化。2026-10-10 由路线 3 ①② 执行会话落档。
> **前置状态：均未获批准**。宪法第 6 条"CI/lint 配置变更需用户单独批准"、roadmap 路线 3 注意项"hook 与扫描器的引入本身要在启动时获得确认"。**本文件只固化要点、不构成启动**；用户批准（可只批其中一项）后方可立项。

---

## 共同约束

- 宪法第 4 条：引入新第三方依赖须在 PRD 显式列出并说明理由——下方两案各自涉及。
- 宪法第 9 条落地方式表：每建成一项，把 `docs/constitution.md` 对应行状态改为脚本路径并删过渡期安排（同 ①② 惯例）。
- 工作流：批准后按 `docs/route3-gates-prd.md` 同套流程执行（PRD → 子代理 TDD → 双重审查 → verify 交付）；新门禁须与 verify 既有四门禁不冲突、定义不扩大。
- roadmap 量级参考：路线 3 全部四项合计半天到一天，③④ 为剩余小项。

## ③ commit-msg hook

- **目标**：宪法第 8 条提交格式机器校验——`feat|fix|docs|chore|refactor|test|perf|build|ci|style|revert: 范围 - 摘要`（Conventional Commits），不符合自动失败。
- **方案 A（倾向，待 PRD 裁决）**：自写零依赖校验脚本（如 `scripts/githooks/commit-msg.mjs`：正则校验 + 空/超长摘要拒绝）+ `git config core.hooksPath scripts/githooks`——沿用 verify/check-scope 的零依赖 TDD 模式，零新依赖。
- **方案 B**：commitlint + husky（业界标准、规则生态全；代价 = 新 devDependencies ×2，宪法第 4 条须理由）。
- **开放问题（立项 PRD 裁决）**：
  1. 历史提交不追溯，只校验新提交；
  2. Windows 下 hook 生效方式（`core.hooksPath` 相对路径语义、hook 文件可执行位/解释器指向 node）；
  3. "范围 - 摘要"是否收紧为词表校验（当前格式较宽）；
  4. merge / revert / fixup 提交的豁免规则。
- **验收思路**：TDD 正则用例（合法各类型 / 缺类型 / 缺`: ` / 非法类型 / 空摘要）；hook 被绕过（`--no-verify`）的行为要明示取舍；hook 拒绝时错误信息可定位到具体格式条款。

## ④ secret 扫描

- **目标**：宪法第 3 条"用户隐私数据、敏感信息不得写入普通日志与控制台输出"的提交前拦截面（防密钥入仓库/历史）。
- **方案 A**：gitleaks（外部单二进制、规则库全；立项需定安装与版本锁定方式：npm 包 / 原生二进制下载 / 包管理器）挂 pre-commit 扫 staged。
- **方案 B**：等价自写模式扫描（零依赖但覆盖面窄；已知模式起步：`ANTHROPIC_AUTH_TOKEN=`、`sk-`、`AKIA`、webhook 带密钥 URL 等）。
- **关键设计约束：必须挂在提交前（pre-commit）**——`verify` 是提交后门禁，密钥一旦 commit 已入历史，post-hoc 扫描拦不住泄漏，只能辅助审计。
- **开放问题**：
  1. 测试假密钥白名单（fixture/测试里有假 key 形状，需 allowlist 机制且 allowlist 本身可审查）；
  2. 检出后处置：阻断提交 + 输出修复指南（不算密钥轮换指南的替代）；
  3. 与 verify 的关系：独立 pre-commit 面，**不并入 verify 四门禁**（四门禁定义不扩大，见 `route3-gates-prd.md` §六）。
- **验收思路**：staged 文件含假密钥 → commit 被拒并列出位置；allowlist 文件放行；对历史全量扫描作一次性审计（另行决定，非门禁常态）。

## 启动方式

用户批准（明示批准 ③、④ 或两者）→ 新会话以本文件为输入写 PRD（建议命名 `docs/route3-gates-34-prd.md`，模板沿用 `route3-gates-prd.md`：验收条件全部可测、非目标显式、任务拆分含回滚点）→ 工作流执行。
