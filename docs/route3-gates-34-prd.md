# 路线 3 PRD：宪法门禁 ③ commit-msg hook + ④ secret 扫描

> **版本**：v1.0（2026-10-10）
> **规格来源**：`docs/constitution.md` 第二节落地方式表（第 8、3 条，"待建设"）+ `docs/roadmap.md` 路线 3 + 立项要点固化 `docs/route3-gates-34-next.md`。
> **启动依据**：用户指令"开始路线三"——即宪法第 6 条与 roadmap 注意项所要求的"hook 与扫描器的引入在启动时获得确认"的**用户批准**（③④ 两项一并批准）。
> **需求采访说明**：目标 / 约束 / 验收思路取自上述三份文档原文；两项的技术方案取舍（③ 方案 A/B、④ 方案 A/B）由本 PRD 按 roadmap 授权裁决（§二）。实现中发现 Spec 缺陷或不可行时按工作流变更授权停报。

---

## 一、功能目标

1. **③ commit-msg hook**：`git commit` 的提交信息经机器校验——不符合宪法第 8 条格式（Conventional Commits）即拒绝提交，错误信息指明具体格式问题。替代落地表第 8 条的"过渡期人工核对"。
2. **④ secret 扫描（pre-commit）**：`git commit` 前扫描 staged 变更内容，命中密钥模式即拒绝提交并列出文件与行号，附修复指引。拦截"密钥入仓库历史"——`verify` 是提交后门禁拦不住泄漏，故必须挂在提交前。替代落地表第 3 条的"过渡期人工审查"。

## 二、技术路线裁决

- **③ 取方案 A（零依赖自写）**：`scripts/githooks/commit-msg.mjs`（校验模块）+ `scripts/githooks/commit-msg`（hook 入口）+ `git config core.hooksPath scripts/githooks`。理由：沿用 verify/check-scope 已验证的零依赖 TDD 模式（宪法第 4 条）；commitlint+husky 的规则生态价值对本仓单一格式需求过剩，且引入 2 个 devDependencies 须过第 4 条且无充分必要。
- **④ 取方案 B（零依赖自写模式扫描）**：`scripts/githooks/scan-secrets.mjs` + `scripts/githooks/pre-commit` + `scripts/githooks/secret-allowlist.json`。理由：gitleaks 是外部单二进制（npm 包/原生下载/包管理器三选一都有安装与版本锁定成本，且违背运行时依赖冻结纪律）；自写扫描覆盖面窄但确定性强、完全 TDD 可钉、离线可用。**gitleaks 留待真实泄漏风险出现时再评估升级**——本门禁的诚实边界是"已知模式 + 可审查 allowlist"，不是全模式库。
- **两 hook 共用 hooksPath**：`core.hooksPath` 指向 `scripts/githooks`（相对路径，git ≥2.29 语义 = 相对仓库根；本机 git 2.55 实证支持）。安装 = `npm run hooks:install`（幂等，读回确认）。hook 文件本体 `#!/usr/bin/env node`（Git for Windows 的 sh 尊重 shebang）。

## 三、③ 行为规格（commit-msg）

- 校验对象：commit-msg 文件（`$1`）的**首行**（subject）。多行 message 只看首行。
- 合法格式：`^(feat|fix|docs|chore|refactor|test|perf|build|ci|style|revert)(\([^)]+\))?: \S.*$`——类型白名单（宪法第 8 条九类 + 全部）、可选 parenthetical scope、冒号后必须有空格 + 非空 subject。
- **"范围 - 摘要"的 " - " 分隔符不机审**（裁决）：宪法原文含此形状，但仓内存量提交存在 " - " 与 " + " 两种风格并存（如 `067072a` vs `cbf8e5e`），机审会误拒合法风格；门禁钉的是 Conventional Commits 的类型纪律核心，" - " 分隔作为 house style 写入 AGENTS.md 建议。此裁决记入审查记录供用户复核。
- 豁免（首行匹配即放行）：`Merge ` 开头（git 自动生成）、`Revert "` 开头（git revert 自动生成）、`fixup! `/`squash! ` 前缀（交互式 rebase 中间态）。
- 拒绝输出：逐条列出违规点（未知类型（并列出白名单）/缺 `: `/空 subject/空消息），exit 1。
- **`--no-verify` 绕过是明示取舍**：git hook 层无防御手段，写入 AGENTS.md 禁令与审查记录；防绕过靠代码质量审查核对 diff，不由本门禁承担。

## 四、④ 行为规格（pre-commit secret 扫描）

- 扫描对象：`git diff --cached --name-only` 中 **Added/Modified** 的 staged 文件（Deleted 跳过；二进制文件跳过——numstat 为 `-` 或解码失败）。
- 模式表（首版，全部显式写在 `scan-secrets.mjs` 常量中，逐条带注释说明针对的密钥形状）：
  - `sk-[A-Za-z0-9]{16,}`（StepFun/OpenAI 形）
  - `ANTHROPIC_(AUTH_TOKEN|API_KEY)` 赋值行且值 ≥16 位连续密钥字符
  - `AKIA[0-9A-Z]{16}`（AWS AccessKey）
  - `-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----`
  - `ghp_[A-Za-z0-9]{30,}` / `github_pat_[A-Za-z0-9_]{20,}`（GitHub token）
  - `xox[baprs]-[A-Za-z0-9-]{10,}`（Slack token）
  - `qyapi.weixin.qq.com/cgi-bin/webhook/send\?key=[0-9a-f]{32}`（企业微信 webhook 带密钥）
- **allowlist 机制**：`scripts/githooks/secret-allowlist.json`——`{"allowlines": ["<正则串>", ...]}`，命中密钥模式的行若匹配任一 allowlist 正则则放行。文件入仓可审查；每个条目必须带注释字段 `{"re": "...", "note": "为什么放行"}`。初始条目 = 对存量仓库全量扫描命中的合法假密钥（测试 fixture 等），交付时逐一核对。
- 拒绝输出：逐条列出 `文件:行号 + 命中模式名 + 行内容（密钥本体打码，只留前 4 后 2 字符）`，附修复指引（从源移除/入 env/若已泄漏先轮换再清理），exit 1。**输出绝不完整回显密钥**（宪法第 3 条）。
- 与 verify 关系：独立 pre-commit 面，**不并入 verify 四门禁**（四门禁定义不扩大）。
- 一次性历史基线审计：交付时对全仓 HEAD 跑一次扫描（非门禁常态），命中清单入审查记录——确认存量无真密钥、并产出 allowlist 初始条目。

## 五、验收条件（全部可测）

1. ③ 合法样例全过：九类各一条（含带 scope 一条）；豁免三类各一条。
2. ③ 非法样例全拒：未知类型 / 缺冒号空格 / 空 subject / 空消息；错误信息含白名单提示。
3. ④ 每个模式一条命中用例（假密钥）+ allowlist 放行用例 + 二进制/删除文件跳过用例 + 输出打码断言。
4. **真仓集成测试**（temp git repo + `core.hooksPath` 指向仓内 `scripts/githooks`）：staged 假密钥 → `git commit` 非零退出且输出含位置；干净内容 + 合法 message → 提交成功；非法 message → commit-msg 拒绝；Merge 信息豁免通过。
5. `npm run hooks:install` 幂等：重复执行无害，读回 `core.hooksPath` 确认；未安装时 hook 不生效（temp 仓对照）。
6. 宪法落地表第 8、3 行状态改为脚本路径并删除过渡期安排；AGENTS.md Golden Path 含 `hooks:install` 一步与"禁止 --no-verify"禁令。
7. 安装后本仓真实提交走双 hook（实现提交即 dogfood 证据）；四门禁 verify 不受影响（既有测试全绿）。
8. 一次性历史审计跑完并入审查记录（存量命中 = allowlist 初始条目来源，无真密钥）。

## 六、非目标

1. 不追溯历史提交的格式与密钥（仅一次性基线审计，非门禁）。
2. 不做 CI 端强制（本仓无 CI）；不防 `--no-verify` 绕过（明示取舍）。
3. 不引入 gitleaks/commitlint/husky 等任何新依赖。
4. 不改 verify 四门禁定义与既有脚本行为。
5. 不做密钥轮换自动化、不扫描 unstaged/未跟踪文件（pre-commit 只看 staged）。
6. 不做高熵启发式（误报面不可控，首版只做显式模式）。

## 七、Plan（技术方案）

### 7.1 文件范围

**新增**：`scripts/githooks/commit-msg`、`scripts/githooks/commit-msg.mjs`、`scripts/githooks/pre-commit`、`scripts/githooks/scan-secrets.mjs`、`scripts/githooks/secret-allowlist.json`、`scripts/hooks-install.mjs`、`scripts/githooks/commit-msg.test.mjs`、`scripts/githooks/scan-secrets.test.mjs`（含 temp 真仓集成用例）。
**修改**：`package.json`（+`hooks:install` 一行）、`docs/constitution.md`（落地表第 8、3 行）、`AGENTS.md`（Golden Path + 禁令）、`docs/roadmap.md`（路线 3 状态）、本 PRD 落盘。

### 7.2 任务拆分与回滚点

| 任务 | 内容 | 依赖 | 回滚点 |
|---|---|---|---|
| T0 | 本 PRD 提交 | — | 12602a8 |
| T1 | ③ commit-msg（模块+hook+install+测试，安装后 dogfood 提交） | T0 | T0 commit |
| T2 | ④ secret 扫描（模块+hook+allowlist+测试+全仓基线审计） | T1（共用 hooksPath 已装） | T1 commit |
| T3 | 文档落地（宪法表/AGENTS/roadmap） | T2 | T2 commit |

每任务独立提交、verify 四门禁（T1 起提交本身走新 hook = dogfood）。
