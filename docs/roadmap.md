# 后续路线图（Roadmap）

> **文件定位**：迁移完成后的候选方向清单与推进建议。五阶段迁移（见 `docs/migration-plan.md`）已全部完成，本文档列出接下来可走的四条路——按价值排序，**均为可选方向，启动哪个由用户决定**，启动时按工作流（PRD → 子代理实现 → 双重审查 → 交付）执行。
> **状态基线**：Phase 5 收官（HEAD 见 git log）。测试 TS 411 通过 / 2 真实冒烟跳过；e2e 5/5；打包冒烟 23/23。Python 已退役，产品运行时 = 捆绑 Node + `server.mjs` + 前端 dist，`~/.vibe-seller` 原地升级双向兼容。

---

## 路线 1：真实任务验收（推荐首选）

**做什么**：跳过的"切流验收"的现代等价物。配一个真实模型 profile（如 StepFun/GLM key）→ 从 release 产物（`npm run package` 后的 `release/vibe-seller-ts/start.bat`）启动 → 对真实店铺建一个真实任务，观察 pi 引擎 + 22 个原生工具 + 确认闸门 + SSE 前端在真实模型驱动下的完整闭环。

**为什么 first**：全部 357 个测试都是脚本引擎/注入模型跑的，真实 LLM 的工具调用习惯、多轮行为、budget/no_progress 在真实负载下的表现没有任何测试覆盖过（仅有 2 个按需跳过的真实 provider 冒烟）。这是投入最小、信息量最大的一步：有问题暴露问题，没问题就可以开始日常使用。

**完成条件（建议）**：至少 3 类真实任务各跑通一次——① 无店铺的 plan-only/设计任务；② 单店铺数据任务（邮件/wecom/workspace 类工具真实触发）；③ 一次确认闸门的人工批准/拒绝真实交互。产出一份《真实任务验收记录》追加到 `docs/审查记录.md`。

**前置**：一个可用模型 profile 的 API key；一个真实店铺（或先用测试店铺）。

> **状态（2026-10-10）**：前置侦察完成，启动检查清单见 `docs/route1-prep.md`（profile 机制 / release 现状 / 操作序列 / 免启动自检）；待用户提供 Anthropic 兼容端点 API key（必需）与店铺（可选）。

## 路线 2：浏览器自动化工具（唯一的功能性缺口）

**做什么**：给 TS agent 补 browse 类工具（基于 CDP 连 `BrowserStarter` 已管的 Chrome 会话，Playwright 或裸 CDP 待 PRD 裁决），让 agent 能真正操作店铺页面（原产品的核心场景：紫鸟/Shopee 卖家中心操作走 browser-use 链，按既定架构决定从未迁入 TS）。

**为什么可选**：这是**既有边界不是缺陷**——Phase 3 起就裁决"浏览器层外部进程托管，不当源码移植"。路线 1 跑完就知道日常任务是否真的需要 agent 摸浏览器；不需要则可无限期搁置。

**量级**：中到大。wrapper 会话隔离、CDP 多客户端复用、卡死恢复是原实现的深水区（`app/browser/wrapper.py`、`cdp_mux_proxy.py`），TS 侧最小等价物（单会话 navigate/act/extract 工具 + 现有启动锁/空闲清扫）需要一份独立 PRD。

**完成条件（建议）**：agent 在真实店铺页面上完成一次"导航 → 读取数据 → 回填 workspace/任务结果"的闭环，且与既有 BrowserStarter 启动锁/清扫语义不冲突。

> **状态（2026-10-10，双重审查通过）**：实现完成——commit 链 `0e85f94`（CDP 连接层）→`9b67185`（starter 懒启动入口）→`22ecdd6`（browse 五工具执行器）→`e391ef4`（注册/开关/引擎装配）→`86bfe5b`（真 Chrome 冒烟暴露的 flatten 事件顶层 sessionId 缺陷修复）→`ab16054`（按需真实冒烟，`VIBE_BROWSER_SMOKE=1 npx vitest run packages/server/test/browser-real.smoke.test.ts`）→`8005a03`/`b67963a`（规格审查修复：CI headless 对齐 + touch↔清扫直接证据 + 闭环单链）→`ec65422`（审查 Major1：传输 open 前失败 settle，防会话键砖化）→`05713ca`（审查 Major2：慢路径就绪等待，消冷启动 kill/respawn churn）→`506f8c2`（冒烟清理抗 Windows 句柄时序）。PRD 见 `docs/route2-browser-tools-prd.md`（裸 CDP 裁决），审查落档见 `docs/审查记录.md` 路线 2 节。27 工具面（新增 `vibe_seller_browser_navigate/tabs/read/act/eval`）+ `browser_tools_enabled` 开关（缺省开，Settings 可关）；闭环由假 CDP 级测试 + 真 Chrome 冒烟双重实证，全量测试 496 通过 / 3 skipped。完成条件中"真实店铺页面闭环"待用户真实任务人工验收；ziniao 后端店铺暂不支持（PRD §5.1 边界：结构化错误，绝不 spawn 无登录态替代 Chrome）。冷启动竞态已由就绪等待消除；其余遗留台账见审查记录路线 2 节。

## 路线 3：宪法门禁建设

**做什么**：把 `docs/constitution.md` 第二节落地表里仍为"待建设"的四项建成机器门禁——① `verify` 一键脚本（测试+类型+构建+diff 范围四门禁合成一条命令，替代交付报告里的手工四门禁）→ ② 范围检查脚本（`git diff` 文件清单 vs 任务声明范围）→ ③ commit-msg hook（Conventional Commits 校验）→ ④ secret 扫描（gitleaks 或等价）。每建成一项把落地表状态改为脚本路径并删除过渡期安排。

**为什么**：宪法第 9 条"规范代码化"的红线——现在四门禁靠每个子代理自觉执行 + 审查代理核对，机器门禁能让不符合规范的产出自动失败。量级半天到一天。

**注意**：宪法明示"CI/lint 配置变更需用户单独批准"——hook 与扫描器的引入本身要在启动时获得确认。

> **状态（2026-10-10）**：① ② 已建成并通过双重审查——`npm run verify` 四门禁一键编排（`scripts/verify.mjs`）+ `scripts/check-scope.mjs` 范围检查门禁，提交 `6a47a74`/`aa7a3ab`，规格见 `docs/route3-gates-prd.md`，审查落档见 `docs/审查记录.md`；宪法落地表第 1/7/1.5 行已改为脚本路径。③ commit-msg hook 与 ④ secret 扫描按宪法需用户启动时单独批准，待批准后立项；立项要点（方案取舍与开放问题）已固化于 `docs/route3-gates-34-next.md`。

## 路线 4：遗留台账清理

**做什么**：集中清掉 `docs/审查记录.md` 两批台账（4.7 批次 5 项 + Phase 5 批次若干项）里仍值得做的小项，典型：

- storeSlug 逻辑 5 份拷贝统一到 `workspace/storeData.ts` 导出版（含旧 `-id8` 目录迁移说明）；
- users PUT 的 username 校验与唯一性检查（对照原实现核）；
- days>1/N 周 schedule 的 trigger 字符串形状、pyJsonDumps 的 ensure_ascii 长尾；
- vendor-frontend.mjs 开发机路径参数化、start.bat 并发 TOCTOU、/api/version 缺省值对齐。

**为什么放最后**：全部是低风险小改动，真实使用（路线 1）会告诉你哪些真的重要、哪些永远没人碰——用一个月后再清更划算。

---

## 建议的推进顺序

**1 → （按需）2 → 3 → （攒批）4**。路线 1 完成后回看本文档修订 2 的取舍；路线 3 可与路线 1 并行（互不 touching 面）。

> 维护规则：任一路线启动后，把状态/结论回写本文档；新方向出现时追加路线并重排建议顺序。
