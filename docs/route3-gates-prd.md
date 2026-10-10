# 路线 3 PRD：宪法门禁 ① verify 一键脚本 + ② 范围检查脚本

> **版本**：v1.0（2026-10-10）
> **规格来源**：`docs/constitution.md` 第二节落地方式表（第 1、7、1.5 条，"建成顺序与截止"注）与 `docs/roadmap.md` 路线 3。两份文档均经用户批准，本 PRD 不引入新决策，只做工程化展开。
> **启动依据**：用户指令"开始执行 roadmap.md"。路线图明示路线 3 可与路线 1 并行、互不 touching 面；③ commit-msg hook 与 ④ secret 扫描按宪法（"CI/lint 配置变更需用户单独批准"）与路线图（"hook 与扫描器的引入本身要在启动时获得确认"）**不在本 PRD 范围内**，待用户单独批准后另行立项。
> **需求采访说明**：目标/上下文/约束/完成条件全部取自上述两份文档原文，无新增模糊点需要澄清；实现中发现本 Spec 缺陷或不可行时按工作流变更授权停报，不得代码变通。

---

## 一、功能目标

1. **② 范围检查脚本**：`node scripts/check-scope.mjs` 把"git 变更文件清单 vs 任务声明范围"做成机器门禁——变更越出声明范围即非零退出并列出越界文件，替代交付自检第 8 项的人工核对。
2. **① verify 一键脚本**：`npm run verify` 把四门禁（① 测试 ② 类型检查 ③ 构建 ④ diff 范围检查）合成一条命令，任一门禁失败即非零退出并指明失败门禁，替代交付报告里的手工四门禁。

## 二、用户故事

- **交付代理**：任务完成时执行 `npm run verify -- --scope <任务声明范围> --base <任务回滚点>`，一条命令取得四门禁证据，直接嵌入交付模板。
- **审查代理**：亲跑同一条命令复核交付声明，机器结果取代"四门禁逐项人工核对"；越界文件清单直接给出规格符合性审查的 diff 范围判定依据。

## 三、核心流程

### 3.1 check-scope.mjs

**CLI**：

```
node scripts/check-scope.mjs --scope <pattern>[,<pattern>...] [--scope <pattern>...] [--base <git-ref>]
```

- `--scope`：**必填**，可重复、可逗号分隔，匹配仓库根相对路径。一个文件命中任意模式即在范围内。
- `--base`：可选，git ref（任务回滚点 commit）。给出时，变更集 = `git diff --name-only <base>..HEAD` ∪ 工作区变更（含未跟踪）；缺省时，变更集 = 仅工作区变更。

**变更文件收集**：

- `git -c core.quotepath=off status --porcelain -z` 解析工作区变更（含未跟踪 `??`）；rename/copy 的 `old -> new` 两侧路径都算变更文件。
- `--base` 给定时叠加 `git -c core.quotepath=off diff --name-only <base>..HEAD`。
- 路径一律归一为正斜杠（Windows git 输出本为正斜杠，防御性归一）。

**匹配语义**（scope glob，锚定仓库根）：

| 模式形态 | 含义 |
|---|---|
| 无通配符（`*?` 均不出现） | 精确路径相等，或作为目录前缀匹配其整棵子树（`scripts` 匹配 `scripts/a.mjs` 与 `scripts/sub/b.mjs`） |
| `**` | 跨目录段任意字符（含 `/`） |
| `*` | 单段内任意字符，不跨 `/` |
| `?` | 恰好一个字符，不跨 `/` |
| 其余字符 | 字面匹配 |

**输出与退出码**：

- 通过：报告变更文件总数、命中情况，退出码 `0`。
- 失败：逐行列出全部越界文件相对路径，退出码 `1`。
- 变更集为空：**判失败**（防已全部提交时静默通过），提示两种修正方式（传 `--base <回滚点>`，或确认确有未提交改动），退出码 `1`。
- 用法/运行错误（缺 `--scope`、非 git 仓库、git 命令失败、非法参数）：stderr 给原因，退出码 `2`。

### 3.2 verify.mjs

**CLI**：

```
npm run verify -- --scope <pattern>[,...] [--base <git-ref>]
```

`--scope`/`--base` 原样透传给 check-scope（`--scope` 支持重复；`--scope` 缺失 → 门禁④失败并打印用法。四门禁缺一不可，不提供跳过开关）。

**门禁顺序**（失败即短序，后续门禁不执行）：

| # | 门禁 | 命令 |
|---|---|---|
| ① | 类型检查 | `npm run typecheck` |
| ② | 测试 | `npm test` |
| ③ | 构建 | `npm run build:server` |
| ④ | diff 范围检查 | `node scripts/check-scope.mjs <透传参数>` |

- 子进程 stdio inherit，门禁实时输出可见；每门禁打印开始横幅（含实际命令）与结束结论（含耗时）。
- 全部通过：打印四门禁摘要与总耗时，退出码 `0`。任一失败：打印失败门禁名与命令，退出码 `1`。
- 子进程 spawn 方式沿用 `scripts/package-release.mjs` 的 shell 处理先例（win32 拼单条命令字符串避免 DEP0190）；对 check-scope 用 `process.execPath` + 参数数组直spawn（不经 shell，glob 模式免引号转义）。

## 四、异常流程

1. 非 git 仓库 / git 命令非零退出 → check-scope 退出码 `2`，stderr 说明。
2. verify 中某门禁命令不存在（package.json script 被删）→ 该门禁失败，报门禁名与原因，退出码 `1`。
3. `--scope` 值为空字符串 / 逗号全空 → 用法错误退出码 `2`。
4. check-scope 在 Windows 与路径含中文（`core.quotepath=off` + `-z` 保证）均正确解析。

## 五、验收条件（全部可测）

1. 仅 `scripts/**` 下有变更时，`--scope "scripts/**"` 退出 `0` 并报告命中数。
2. 存在 scope 外变更文件时退出 `1`，stdout 逐行列出**全部**越界文件。
3. 变更集为空时退出 `1`，提示 `--base` 与未提交改动两种修正方式。
4. `--base <ref>` 时已提交变更（`<ref>..HEAD`）与工作区未提交变更合并判定（测试用临时 git 仓提交后再造工作区变更验证并集）。
5. 未跟踪文件（`??`）参与判定。
6. glob 语义逐条可测：`**` 跨段、`*`/`?` 不跨 `/`、目录前缀子树匹配、反斜杠归一为正斜杠、多模式"命中任一即可"。
7. rename 的 old/new 两侧路径都参与判定（临时 git 仓真实 rename 验证）。
8. `npm run verify`（缺 `--scope`）非零退出并提示用法。
9. `npm run verify -- --scope ... --base ...` 顺序执行四门禁；全过打印摘要退出 `0`；注入失败时短序——失败门禁之后的门禁不执行，退出非零并指明失败门禁。
10. check-scope 的收集/匹配/解析纯函数与临时 git 仓集成场景均有测试；verify 的参数解析、门禁编排、短序行为以注入 fake runner 的单测覆盖；全部测试随 `npm test` 运行。
11. 运行时依赖零新增（package.json `dependencies`/`devDependencies` 除现有外不变）；唯一配置文件改动 = `vitest.config.ts` include 增补 `"scripts/**/*.test.mjs"`（交付报告向用户明示）。

## 六、非目标

- 不建 ③ commit-msg hook 与 ④ secret 扫描（需用户单独批准）。
- 不引入任何新第三方依赖（无 minimatch/globby/gitleaks/commitlint）。
- verify 不纳入 e2e、`smoke:package`、`vendor:check`（四门禁定义不扩大；vendor:check 是否并入另行决定）。
- 不做彩色输出、`--json` 输出、门禁并行。
- 不改 `docs/workflow.md` 的四门禁定义文本；不填 AGENTS.md"项目速览"其余 TODO。
- 不改任何 packages/ 业务代码。

## 七、Plan（技术方案）

### 7.1 文件范围

| 文件 | 动作 | 说明 |
|---|---|---|
| `scripts/check-scope.mjs` | 新增 | 纯 ESM 零依赖；导出 `parseArgs` / `globToRegExp` / `matchScope` / `parseStatusZ` / `collectChangedFiles` 供测试 |
| `scripts/check-scope.test.mjs` | 新增 | vitest；纯函数单测 + 临时 git 仓（`git init` 于 tmpdir）集成场景 |
| `scripts/verify.mjs` | 新增 | 纯 ESM；导出 `parseVerifyArgs` / `buildGates` / `runGates`（runner 可注入） |
| `scripts/verify.test.mjs` | 新增 | fake runner 测编排：顺序、短序、透传、缺 scope 失败 |
| `vitest.config.ts` | 修改 | `include` 增补 `"scripts/**/*.test.mjs"`（单行） |
| `package.json` | 修改 | `scripts` 增 `"verify": "node scripts/verify.mjs"`（单行） |
| `AGENTS.md` | 修改 | Quick Commands 六行 TODO 填实（见 7.3） |
| `docs/constitution.md` | 修改 | 落地表第 1、7、1.5 行：状态改脚本路径、删过渡期安排（见 7.4） |

### 7.2 接口与数据流

- check-scope 内部：argv → `parseArgs`（exit 2 路径）→ `collectChangedFiles`（git 两次调用，-z 解析，去重并集）→ `matchScope` 逐文件判定 → 报告渲染 + exit code。
- verify 内部：argv → `parseVerifyArgs` → `buildGates`（四门禁命令表 + 透传参数）→ `runGates` 顺序执行（fake runner 可注入）→ 摘要/短序退出。
- 向后兼容：纯新增脚本与 npm script；既有 scripts、vitest include 既有条目不动一字。

### 7.3 AGENTS.md Quick Commands 填实

| 用途 | 值 |
|---|---|
| 测试 | `npm test` |
| 类型检查 | `npm run typecheck` |
| 构建 / 编译 | `npm run build:server` |
| Lint | 未配置（引入 lint 属 CI/lint 配置变更，需用户单独批准） |
| 一键质量门禁 | `npm run verify -- --scope <任务范围> --base <回滚点>` |
| 本地运行 | `npm start` |

### 7.4 constitution.md 落地表更新

- 第 1 条：状态 `待建设` → `scripts/verify.mjs（①测试门禁；逐文件无测试检测未建）`，删过渡期安排。
- 第 7 条：状态 → `scripts/verify.mjs`，删过渡期安排。
- 第 1.5 条：状态 → `scripts/check-scope.mjs`，删过渡期安排。
- "建成顺序与截止"注保留（③④仍待建，截止确认仍归用户）。

### 7.5 测试方案与风险

- TDD 全程；check-scope 集成场景用真实 git（tmpdir `git init` + `config user.email/name` 内联），覆盖验收 1–7；verify 编排用注入 runner，覆盖验收 8–9（真实 verify 由交付步骤 dogfood）。
- 风险①：Windows npm 透传引号——缓解：`--scope` 可重复 + verify→check-scope 走 `process.execPath` 参数数组不经 shell；测试覆盖含 `**` 模式。
- 风险②：git rename 解析歧义——缓解：`status --porcelain -z` + `old -> new` 双侧收录，临时仓真实 rename 测试钉住。
- 风险③：非 ASCII 文件名被 git 转义——缓解：`-c core.quotepath=off` + `-z`。

### 7.6 任务拆分与回滚点

| 任务 | 内容 | 文件范围 | 回滚点 |
|---|---|---|---|
| Task 1 | 范围检查脚本（含 vitest include 增补） | check-scope.mjs + 其测试 + vitest.config.ts | `006b3aa`（当前 HEAD） |
| Task 2 | verify 脚本 + npm script + AGENTS/宪法落地表同步 | verify.mjs + 其测试 + package.json + AGENTS.md + constitution.md | Task 1 提交 |

两任务各自 TDD、各自跑当时可用的四门禁（Task 1 手工四门禁，Task 2 dogfood `npm run verify`）、各自按 Conventional Commits 提交（宪法第 8 条）。
