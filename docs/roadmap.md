# 后续路线图（Roadmap）

> **文件定位**：迁移完成后的候选方向清单与推进建议。五阶段迁移（见 `docs/migration-plan.md`）已全部完成，本文档列出接下来可走的四条路——按价值排序，**均为可选方向，启动哪个由用户决定**，启动时按工作流（PRD → 子代理实现 → 双重审查 → 交付）执行。
> **状态基线**：Phase 5 收官（HEAD 见 git log）。测试 TS 411 通过 / 2 真实冒烟跳过；e2e 5/5；打包冒烟 23/23。Python 已退役，产品运行时 = 捆绑 Node + `server.mjs` + 前端 dist，`~/.vibe-seller` 原地升级双向兼容。

---

## 路线 1：真实任务验收（推荐首选）

**做什么**：跳过的"切流验收"的现代等价物。配一个真实模型 profile（如 StepFun/GLM key）→ 从 release 产物（`npm run package` 后的 `release/vibe-seller-ts/start.bat`）启动 → 对真实店铺建一个真实任务，观察 pi 引擎 + 22 个原生工具 + 确认闸门 + SSE 前端在真实模型驱动下的完整闭环。

**为什么 first**：全部 357 个测试都是脚本引擎/注入模型跑的，真实 LLM 的工具调用习惯、多轮行为、budget/no_progress 在真实负载下的表现没有任何测试覆盖过（仅有 2 个按需跳过的真实 provider 冒烟）。这是投入最小、信息量最大的一步：有问题暴露问题，没问题就可以开始日常使用。

**完成条件（建议）**：至少 3 类真实任务各跑通一次——① 无店铺的 plan-only/设计任务；② 单店铺数据任务（邮件/wecom/workspace 类工具真实触发）；③ 一次确认闸门的人工批准/拒绝真实交互。产出一份《真实任务验收记录》追加到 `docs/审查记录.md`。

**前置**：一个可用模型 profile 的 API key；一个真实店铺（或先用测试店铺）。

> **状态（2026-10-10，完成）**：用户已提供 StepFun 兼容端点 key（step-3.7-flash），三类完成条件全部真实跑通——① plan-only 设计任务（`/design` → planned + plan 落库）、② 单店铺 workspace 写入（闸门批准后 notes.md 实盘落盘 + git 自动提交 + set_task_result）、③ 确认闸门**双向**交互（批准=工具恰好执行一次；拒绝=工具零执行+模型明确复述拒绝）。免启动自检 2/2、打包冒烟 23/23、release 已重打包至 HEAD（含路线 2 的 27 工具）。验收记录见 `docs/审查记录.md`「真实任务验收记录」节；过程观察项（Windows curl GBK 编码、plan/start 两条路径语义、拒绝后 GUI 结果为空）已入台账。日常使用可直接 `release/vibe-seller-ts/start.bat` + 已配置的 stepfun profile。

## 路线 2：浏览器自动化工具（唯一的功能性缺口）

**做什么**：给 TS agent 补 browse 类工具（基于 CDP 连 `BrowserStarter` 已管的 Chrome 会话，Playwright 或裸 CDP 待 PRD 裁决），让 agent 能真正操作店铺页面（原产品的核心场景：紫鸟/Shopee 卖家中心操作走 browser-use 链，按既定架构决定从未迁入 TS）。

**为什么可选**：这是**既有边界不是缺陷**——Phase 3 起就裁决"浏览器层外部进程托管，不当源码移植"。路线 1 跑完就知道日常任务是否真的需要 agent 摸浏览器；不需要则可无限期搁置。

**量级**：中到大。wrapper 会话隔离、CDP 多客户端复用、卡死恢复是原实现的深水区（`app/browser/wrapper.py`、`cdp_mux_proxy.py`），TS 侧最小等价物（单会话 navigate/act/extract 工具 + 现有启动锁/空闲清扫）需要一份独立 PRD。

**完成条件（建议）**：agent 在真实店铺页面上完成一次"导航 → 读取数据 → 回填 workspace/任务结果"的闭环，且与既有 BrowserStarter 启动锁/清扫语义不冲突。

> **状态（2026-10-10，双重审查通过）**：实现完成——commit 链 `0e85f94`（CDP 连接层）→`9b67185`（starter 懒启动入口）→`22ecdd6`（browse 五工具执行器）→`e391ef4`（注册/开关/引擎装配）→`86bfe5b`（真 Chrome 冒烟暴露的 flatten 事件顶层 sessionId 缺陷修复）→`ab16054`（按需真实冒烟，`VIBE_BROWSER_SMOKE=1 npx vitest run packages/server/test/browser-real.smoke.test.ts`）→`8005a03`/`b67963a`（规格审查修复：CI headless 对齐 + touch↔清扫直接证据 + 闭环单链）→`ec65422`（审查 Major1：传输 open 前失败 settle，防会话键砖化）→`05713ca`（审查 Major2：慢路径就绪等待，消冷启动 kill/respawn churn）→`506f8c2`（冒烟清理抗 Windows 句柄时序）。PRD 见 `docs/route2-browser-tools-prd.md`（裸 CDP 裁决），审查落档见 `docs/审查记录.md` 路线 2 节。27 工具面（新增 `vibe_seller_browser_navigate/tabs/read/act/eval`）+ `browser_tools_enabled` 开关（缺省开，Settings 可关）；闭环由假 CDP 级测试 + 真 Chrome 冒烟双重实证，全量测试 496 通过 / 3 skipped。完成条件中"真实店铺页面闭环"待用户真实任务人工验收；ziniao 后端店铺暂不支持（PRD §5.1 边界：结构化错误，绝不 spawn 无登录态替代 Chrome）。冷启动竞态已由就绪等待消除；其余遗留台账见审查记录路线 2 节。

> **增量（2026-10-12，共享浏览器组）**：`share_group` 入组店铺共用一个 Chrome（方案甲：共享 user-data-dir + tab 级所有权防串店；cookie 按域名隔离，同域店铺禁同组）——`7150be4`（路由层校验）→`8be2d51`（starter 共享会话 key/slug/sweep 组粒度）→`5c4ff47`（browse 双 key 与标签所有权）。**方案A 追加（同日）**：chrome 建店缺省入组 `main` + PUT 缺 share_group 键保留现值（防 vendor 表单整包回传静默退组）。PRD 修订见 `docs/route2-browser-tools-prd.md` §4.1/§4.3/§七.1/§九.5。真实多店场景人工验收待用户执行。

## 路线 2.5：紫鸟店铺接入 browse 五工具（待立项）

**做什么**：让 browse 五工具覆盖 ziniao 后端店铺（现在返回结构化错误）。下一步产出 `docs/route25-ziniao-next.md`（立项要点，参照 `docs/route3-gates-34-next.md` 的写法），**只立项不实施**。

**前置**：实施前须用户确认本机有紫鸟客户端和可用测试店铺。纯离线只能做假 HTTP 层测试，SBP、稳定性这些真实行为无法离线验证。

**已备机制要点**（提炼自 2026-10-10 对参考实现的概览研究；深挖 `app/browser/ziniao.py` 还没做，立项时先补细节）：

1. **startBrowser 假成功**：客户端返回 statusCode==0，但端口永远不监听，要探活重试才能确认真的起来了（ziniao.py:429-515 一带）。
2. **SBP 注入层探测**：`Runtime.evaluate navigator.webdriver===true` 只认阳性，为什么放弃阴性判定要从注释里挖出来；判定失败的处置是重试 startBrowser。
3. **target 稳定性检查**：建 target 后观察 5 秒，看是否被杀（ziniao.py:517-631）。
4. **debuggingPort 每次轮换**（ziniao.py:203）：不能缓存旧端口，每次 startBrowser 后都要重新拿。TS 侧 starter 现在只落 `status=running`、不记 cdp_port（`startStoreSession` 的 ziniao 分支），**这是打通的第一块**。
5. **keep_last_page**：关掉最后一个 tab 就杀掉整个环境（ziniao.py:277-284）；停止要用 stopBrowser，`closeBrowser` 是 404。
6. **WSL 网络回退**：127.0.0.1 探活失败就回退到网关 IP（`ziniao.ts` 已移植 tryConnectZiniao 的双回退）。
7. **RelaunchBudget**：原版对 ziniao 有重启熔断（600 秒内最多 3 次），TS 侧没有。路线 2 曾裁决靠 run 预算兜底，立项时要重议：ziniao 重启比 chrome 贵得多。
8. **TS 可复用面**：`browser/ziniao.ts`（本地 HTTP 客户端的请求面已完整移植）+ `browser/cdp.ts`（裸 CDP 连接层）+ `browser/browse.ts`（五工具执行器）。理论上只缺"startBrowser → 拿端口 → 落表 → 复用 ensure 语义"这一段粘合，加上可靠性检查。共享组已裁决 ziniao 永不入组（`7150be4`），身份语义不冲突。
9. **立项文档须含**：分阶段方案（P1 端口捕获 + attach 打通 / P2 可靠性三件套 / P3 keep_last_page 与防呆）、开放问题清单（测试环境、风控姿态、预算参数）、不做清单（wrapper/daemon、mux 等，沿用路线 2 的裁决）。

> **状态（2026-10-21）**：未开工。以上要点由 2026-10-21 交接文档迁入（原文见提交 `407aaa8` 的 `docs/handoff-2026-10-21.md` §四）。

## 路线 3：宪法门禁建设

**做什么**：把 `docs/constitution.md` 第二节落地表里仍为"待建设"的四项建成机器门禁——① `verify` 一键脚本（测试+类型+构建+diff 范围四门禁合成一条命令，替代交付报告里的手工四门禁）→ ② 范围检查脚本（`git diff` 文件清单 vs 任务声明范围）→ ③ commit-msg hook（Conventional Commits 校验）→ ④ secret 扫描（gitleaks 或等价）。每建成一项把落地表状态改为脚本路径并删除过渡期安排。

**为什么**：宪法第 9 条"规范代码化"的红线——现在四门禁靠每个子代理自觉执行 + 审查代理核对，机器门禁能让不符合规范的产出自动失败。量级半天到一天。

**注意**：宪法明示"CI/lint 配置变更需用户单独批准"——hook 与扫描器的引入本身要在启动时获得确认。

> **状态（2026-10-10，四项全部建成）**：用户批准启动 ③④（"开始路线三"即宪法第 6 条要求的启动确认）。① ② 此前已建成（`6a47a74`/`aa7a3ab`，规格 `docs/route3-gates-prd.md`）；③④ 本轮建成——③ commit-msg hook（`12031c6`：类型白名单机审 + Merge/Revert/fixup 豁免 + `npm run hooks:install`，33 测试，dogfood 双向实证）+ ④ pre-commit secret 扫描（`f075ac4`：七模式 + 可审查 allowlist + staged 面扫描，39 测试，全仓基线审计 375 文件 0 命中），PRD 见 `docs/route3-gates-34-prd.md`（方案裁决：两门均取零依赖自写，gitleaks/commitlint 留待真实需要再评估）。宪法落地表四行全部为脚本路径、过渡期安排删除；`--no-verify` 绕过为明示取舍（AGENTS.md 禁令）。审查落档见 `docs/审查记录.md`。

## 路线 4：遗留台账清理

**做什么**：集中清掉 `docs/审查记录.md` 两批台账（4.7 批次 5 项 + Phase 5 批次若干项）里仍值得做的小项，典型：

- storeSlug 逻辑 5 份拷贝统一到 `workspace/storeData.ts` 导出版（含旧 `-id8` 目录迁移说明）；
- users PUT 的 username 校验与唯一性检查（对照原实现核）；
- days>1/N 周 schedule 的 trigger 字符串形状、pyJsonDumps 的 ensure_ascii 长尾；
- vendor-frontend.mjs 开发机路径参数化、start.bat 并发 TOCTOU、/api/version 缺省值对齐。

**为什么放最后**：全部是低风险小改动，真实使用（路线 1）会告诉你哪些真的重要、哪些永远没人碰——用一个月后再清更划算。

> **状态（2026-10-21，第一批完成，双重审查通过）**：用户选择提前清（不等真实使用一个月），PRD `docs/route4-ledger-prd.md` v1.2 裁决只做确定性可验的小项，共 16 项（标题"15 项"为计数笔误）。三个实现提交：`b473797`（T1，browse/starter/smoke 侧）→ `eff3085`（T2，server 契约与脚本侧，PRD 升 v1.1）→ `b654a21`（T3，githooks 侧，PRD 升 v1.2，hooks 改动经用户单独批准）；T4 收尾提交含审查整改 M1、M4 与本次落档。结果：修了 14 项（含 v1.0 误并入 S10 的路线 2 台账 #11），闭项 3 项（S8 已被 `8be2d51` 覆盖、S9 查实非缺陷、G2 的修法关不掉竞态故不改）；顺带修掉两个真实缺陷：4.7.2 之后新建店铺的 STORE.md 读不到（S1）、GUI 里清空用户邮箱无效（S2）。规格审查通过，代码质量审查可交付（无 Critical / Major），四门禁全绿（全量测试 640 passed / 3 skipped）。处置表、口径注记与新增 14 条台账见 `docs/审查记录.md`；未纳入本批的项（性能类、假 CDP 夹具提取、pyJsonDumps ensure_ascii、days>1/N 周 trigger 形状等）原位保留，攒下一批。

---

## 建议的推进顺序

**1 → （按需）2 → 3 → （攒批）4**。路线 1 完成后回看本文档修订 2 的取舍；路线 3 可与路线 1 并行（互不 touching 面）。路线 2.5 要等用户确认本机有紫鸟客户端和可用测试店铺，确认后先立项（产出 `docs/route25-ziniao-next.md`），只立项不实施。

> 维护规则：任一路线启动后，把状态/结论回写本文档；新方向出现时追加路线并重排建议顺序。
