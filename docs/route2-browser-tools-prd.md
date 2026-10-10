# 路线 2 PRD：浏览器自动化工具（browse 类原生工具）

> **版本**：v1.0（2026-10-10）
> **规格来源**：`docs/roadmap.md` 路线 2（唯一的功能性缺口）+ `docs/phase5-prd.md`（浏览器链未接入的边界记录）+ 参考仓库 `_reference/vibe-seller-src` 浏览器层深水区（`app/browser/wrapper.py`、`cdp_mux_proxy.py`、`launch_guards.py`、`idle_sweep.py`）。
> **启动依据**：用户指令"开始执行路线二"。roadmap 明示"Playwright 或裸 CDP 待 PRD 裁决"——本 PRD 行使该裁决（见 §二）。
> **需求采访说明**：目标 / 上下文 / 约束 / 完成条件取自 roadmap 路线 2 原文（做什么 / 为什么 / 量级 / 完成条件四段俱全）；本 PRD 不引入新决策面，仅做工程化展开与既定边界内的技术裁决。实现中发现 Spec 缺陷或不可行时按工作流变更授权停报，不得代码变通。

---

## 〇、需求采访结论（四类信息）

- **目标**：给 TS agent 补 browse 类原生工具，让 agent 能真正操作浏览器页面（原产品的核心场景），完成"导航 → 读取数据 → 回填 workspace/任务结果"的闭环。
- **上下文**：`BrowserStarter`（`packages/server/src/browser/starter.ts`）已托管 Chrome spawn（持久 profile + 随机 `--remote-debugging-port` + 启动锁 + 空闲清扫）；22 个原生工具走 `native-tools.ts` 单注册表经 ToolPort 喂 Pi SDK；参考实现浏览器层约 1700 行 mux + wrapper 生成 + 守护进程管理，其复杂度全部源于"多个 browser-use daemon 共享一个 Chrome"与独立 CLI 进程模型——TS 侧单会话形态不存在这两个前提。
- **约束**：宪法第 4 条（运行时依赖冻结零新增，新增依赖须说明理由）；宪法第 2 条（API 向后兼容）；`frontend/` 零改动红线；DB schema 原地升级兼容；与既有 BrowserStarter 启动锁 / 空闲清扫语义不冲突（roadmap 完成条件原文）。
- **完成条件**：agent 能在受控页面完成"导航 → 读取 → 回填"闭环（自动化测试钉死）；真实店铺页面的人工验收由用户执行（本 PRD 提供按需真实冒烟 + 人工验收建议清单）；与启动锁 / 清扫语义不冲突有测试证据。

---

## 一、技术路线裁决：裸 CDP（零新依赖）

**裁决：裸 CDP——Node ≥22.5 内建全局 `WebSocket`（undici）+ `fetch`（`/json/version`、`/json/list` HTTP 面），不引入 Playwright / puppeteer / chrome-remote-interface / ws。**

理由（对照落选方案）：

1. **依赖纪律**：运行时依赖 Phase 4 预裁决冻结；`@playwright/test` 现为 e2e devDep，转运行时 import 属新增第三方库，须过宪法第 4 条且无充分必要（见下）。esbuild 单文件 bundle 也会因 playwright-core 体积与动态 require 面临打包风险，release 打包脚本须连带改动。
2. **参考实现的现行驱动模型本身就是薄 CDP 原语**：原版 0.13 起弃用 browser-use 高层 API，agent 面向面是 `js()` + `click_at_xy` + `cdp()` 三原语（`app/skills_v2/browser-harness/SKILL.md:125-135`）。裸 CDP 不是降级，而是与参考语义对齐。
3. **重量级驱动的核心价值是 auto-wait 与选择器引擎**，而原版纪律（SKILL.md:57-81）恰恰是"一次调用一个工作单元、轮询跨多次工具调用"——agent 驱动的轮询取代深度 auto-wait，单工具保持简单、有界、可观测。
4. **单客户端形态消解 mux 存在理由**：CDP browser 级 ws 端点一次只服务一个客户端，原版为此建了 1700 行多路复用代理；TS 侧每浏览器会话恰好单客户端（工具执行器独占连接），Target/session 所有权路由整体不需要。

**代价与对策**（诚实地写进方案）：

- 无 auto-wait → 以显式 `wait` 动作（选择器轮询）+ agent 跨调用轮询纪律替代；工具 description 写明。
- 坐标点击需自行 scrollIntoView + getBoundingClientRect → 封装进 `act(click)` 单处实现，测试钉死。
- React 受控组件输入 → `type` 用 CDP `Input.insertText`（经真实输入管线，触发框架监听）；`select` 用原生 setter + 事件派发的标准做法，单处实现。

---

## 二、功能目标

给 agent 新增 **5 个 `vibe_seller_browser_*` 原生工具**（22 → 27），服务端直连 BrowserStarter 已管 Chrome 会话的 CDP 端点执行：

| 工具 | 语义 |
|---|---|
| `vibe_seller_browser_navigate` | 在当前 tab（或 `new_tab:true` 新开）导航到 URL，等 load 事件（30s 上限），返回 `{tab_id, url, title}` |
| `vibe_seller_browser_tabs` | `action: list/switch/close`；list 返回 `[{tab_id,url,title,active}]`；close 永不关最后一个 tab |
| `vibe_seller_browser_read` | `mode: info/text/html` + 可选 `selector`，读取页面信息 / innerText / outerHTML，`max_chars` 截断（防上下文爆炸） |
| `vibe_seller_browser_act` | 单动作：`click/type/press/select/scroll/hover/wait`，一次一个工作单元 |
| `vibe_seller_browser_eval` | 在页面上下文执行 JS 表达式，`returnByValue` 取 JSON 结果（截断），是 act/read 覆盖不到场景的逃生舱 |

通用参数：`session: "store" | "web"`（缺省 `"store"`）。`store` = 当前任务绑定店铺的浏览器（服务端从 taskId 查 tasks.store_id 解析，**agent 永远不传 URL/端口/连接端点**——原版"会话身份双写、端点不可表示"防串店语义的 TS 等价物）；`web` = 店铺无关 `_web` 会话。

## 三、用户故事

- **店铺任务 agent**：接到"读取店铺后台 X 数据并整理进 workspace"任务 → `browser_navigate` 打开页面 → `browser_read`/`browser_eval` 取数 → 既有 `vibe_seller_write_workspace_file` / `set_task_result` 回填。全程无需人工逐步操作。
- **用户**：新能力默认可用（`browser_tools_enabled` 缺省 true），可在 Settings 一键关闭（工具从 schema 隐藏，同 `generate_image` 能力门先例）；谨慎用户可经既有 `VIBE_BRIDGE_GATED_TOOLS` env 把 `browser_act`/`browser_eval` 加入确认闸门（既有通用机制，本 PRD 不改默认闸门面）。

## 四、核心流程

### 4.1 会话解析与懒启动（对齐原版幂等懒启动 + 启动锁语义）

```
工具调用 → 解析 session：
  "web"  → key '_web'
  "store"→ taskId → tasks.store_id → stores 行
             ├─ browser_backend === 'ziniao' → 结构化错误（见 5.1）
             └─ 否则 → key = store_id
→ starter 存活探查（进程内 Map + cdpAlive 2s 超时）
   ├─ 存活 → touch lastUsedAt，复用 cdpPort（不加锁，快路径）
   └─ 不存活 → withLaunchLock 懒启动 Chrome（同 startChrome 参数与 profile）
        ├─ 锁被占 → BrowserBusyError 语义透传为工具错误（点名持有者/时长，agent 稍后重试）
        └─ 启动成功 → 落 browser_sessions 行（现 markSessionRow 语义不变）
→ 取（或建）该会话 key 的 CDP 连接（模块级连接表，浏览器级 ws 端点 + flatten attach）
→ 执行命令 → 返回
```

### 4.2 CDP 连接层（单客户端，无 mux）

- 连接 = `GET /json/version` 取浏览器级 `webSocketDebuggerUrl` → 一条 ws；命令经 `Target.attachToTarget {flatten:true}` 取 sessionId，后续命令带 sessionId 作用域到 tab。
- 请求 id 自增关联响应；事件（`Page.loadEventFired` 等）按 sessionId 分发订阅。
- **每命令超时默认 20s**（navigate 等载入 30s；`wait` 动作上限 120s）；**单次工具调用硬预算 120s**（原版 wrapper alarm 120s 语义）。
- ws 断连/出错 → 该连接作废并从连接表驱逐；**下次调用**走 4.1 懒恢复（连接属会话级状态，不跨断连恢复——原版"session 永不恢复"教训同源）。**绝不自动重试已发出的变异命令**（原版铁律：重跑 heredoc = 双击双填）。

### 4.3 Tab 管理

- 每会话内存态：`activeTabId` + tab LRU。`new_tab` 超过上限 **12**（原版 VIBE_TAB_CAP）→ 关最久未用的非活跃 tab；**永不关最后一个 tab**（原版 ziniao keep_last_page 教训在 chrome 后端同样成立）。
- `navigate/act/read/eval` 缺省作用于 activeTab；`read/act/eval` 接受可选 `tab_id` 显式寻址（并发同店任务的已知干扰见 §九）。
- navigate 成功后更新 `browser_sessions.current_url`（列已存在，纯 UPDATE，无 schema 变更）。

### 4.4 动作语义（act）

| 动作 | 实现 |
|---|---|
| `click` | `Runtime.evaluate` 取 `getBoundingClientRect` + `scrollIntoView` → `Input.dispatchMouseEvent`（pressed/released，中心点） |
| `type` | 聚焦目标（click 同路径）→ `Input.insertText` |
| `press` | `Input.dispatchKeyEvent`（rawKeyDown/keyUp，`key` 如 Enter/Tab） |
| `select` | 原生 setter 设 value + 派发 `input`/`change` 事件（React 兼容） |
| `scroll` | `Input.dispatchMouseEvent` type=mouseWheel（dx/dy） |
| `hover` | `Input.dispatchMouseEvent` type=mouseMoved |
| `wait` | 选择器轮询（`Runtime.evaluate` 每 250ms，默认上限 10s，`ms` 可到 120s）或纯延时 |

选择器：CSS selector（`document.querySelector` 语义）；找不到元素 → 结构化错误（含动作与 selector），agent 自行重读页面调整。

## 五、异常流程

### 5.1 ziniao 后端店铺（边界裁决）

**结构化错误，不降级实现**：`该店铺浏览器后端为 ziniao（反检测浏览器），浏览器工具暂不支持；CDP 直连仅覆盖 chrome 后端与 web 会话。` 依据：紫鸟浏览器由紫鸟客户端拉起、debuggingPort 每次轮换、SBP 注入层属浏览器层红线（`starter.ts:1-5` 头注既定边界）；原版对应能力（SBP 探测 / startBrowser 重试 / keep_last_page）整体留待后续 PRD。**禁止**为 ziniao 店 spawn 一个无登录态的替代 Chrome（会静默产出错误数据）。

### 5.2 其他错误面

| 场景 | 行为 |
|---|---|
| 任务未绑定店铺且 session="store" | 结构化错误：说明须绑定店铺或改用 session="web" |
| 设置 `browser_tools_enabled=false` 时调用 | 结构化错误（可见性已隐藏，此为直调兜底） |
| 浏览器进程死 / ws 断 | 下次调用懒恢复（4.2）；本次返回连接错误 |
| 启动锁被占 | BrowserBusyError 原文案透传（agent 稍后重试） |
| URL scheme 非 http/https | 拒绝（`file://`/`chrome://` 等不进导航——本地文件内容不得经浏览器读入模型上下文） |
| 命令超时 / 页面无响应 | 结构化超时错误；不自动重试（4.2 铁律） |

## 六、验收条件（全部可测）

1. 5 个工具 schema 出现在 `MCP_TOOL_SCHEMAS` 之外的新段并进入 `toVibeToolSpecs` 面向 Pi 的工具面；既有 22 工具 fixture 对账（`toEqual(FIXTURE)`）保持通过。
2. `browser_navigate` → `browser_read` → `browser_eval` → 既有 `write_workspace_file` 回填的闭环在测试内走通（本地 http 静态页 + 注入式假 CDP/真 Chrome 按需冒烟两级）。
3. 会话解析：taskId→store 绑定、`_web` 会话、ziniao 结构化错误、未绑定店铺错误，各有断言。
4. 懒启动与锁：会话不存活时经启动锁拉起（快路径不加锁）；锁被占时错误文案含持有者信息。
5. touch 语义：每次工具调用刷新 `lastUsedAt`（断言 starter 侧时间戳被刷新——与 `sweepIdleBrowsers` 不冲突的直接证据）。
6. Tab：`new_tab` 第 13 个触发 LRU 关闭且不关活跃/最后一个 tab；`tabs close` 拒绝关最后一个。
7. act 语义：click/type/press/select/scroll/hover/wait 各有假 CDP 断言（命令序列与参数形状）；真实冒烟（按需）验证 click 后 DOM 变化可被 read 读到。
8. 连接层：请求-响应关联、sessionId 作用域、每命令超时、断连驱逐、断连后下次调用懒恢复，各有断言。
9. 设置开关：`browser_tools_enabled` 进白名单 + BOOL_KEYS + 缺省 true + PUT 归一化；false 时 5 工具从可见 schema 隐藏且 dispatch 返回结构化错误。
10. 四门禁：`npm run verify -- --scope <本任务范围> --base <回滚点>` 全绿；既有 411 测试无回归。
11. 人类验收建议（不属于本 PRD 自动验收）：用户在真实店铺（chrome 后端）建真实任务跑一次闭环——列入交付报告。

## 七、非目标

1. **不做** CDPMuxProxy / 多客户端复用（单客户端形态不存在该问题；原版 1700 行不移植）。
2. **不做** wrapper bash 生成 / browser-use daemon / pid reaper / worker slots（无独立进程模型）。
3. **不做** ziniao CDP 驱动（SBP 注入、startBrowser 重试、稳定性检查——浏览器层红线，见 5.1）。
4. **不做** aux 双浏览器分流（`_web` 会话已承载"店铺无关网页"场景；更细分流是 prompt 级规则，原版亦然）。
5. **不做** 截图工具（原版实证：两代模型都对完好 PNG 幻觉出不存在的表格，SKILL.md:101-114"严禁当数据源"；TS 已有独立 vision 链路）。
6. **不做** RelaunchBudget 熔断（run 预算 24 迭代/40 工具/30min 兜底重启风暴；观察真实使用后再议）。
7. **不做** 下载管理 / 文件上传 / cookie 导入导出 / 多登录身份隔离。
8. **不做** URL 白名单路由（原版代码层亦无，store/web 分流靠 prompt 级规则 + 本 PRD 的 scheme 守卫）。
9. **不做** 前端改动（`frontend/` 零改动红线；闸门 UI 已存在且本批不新增闸门）。
10. **不做** DB schema 变更（browser_sessions 既有列够用）。

## 八、Plan（技术方案）

### 8.1 文件范围

**新增**
- `packages/server/src/browser/cdp.ts`——CDP 连接层：`CdpTransport` 接口（生产 = 全局 WebSocket；测试 = 内存假传输）、`CdpConnection`（命令关联 / sessionId 作用域 / 事件订阅 / 每命令超时 / 断连驱逐）。
- `packages/server/src/browser/browse.ts`——会话解析（taskId→store/web、ziniao 守卫）、连接表（key→CdpConnection）、tab LRU 与 activeTab、5 工具执行器。
- `packages/server/test/browser-cdp.test.ts`、`packages/server/test/browser-browse.test.ts`——内存假传输 / 假 starter 注入测试。

**修改**
- `packages/server/src/browser/starter.ts`——新增存活性快查 + touch + 懒启动入口（复用 withLaunchLock/startChrome，不改既有方法签名）。
- `packages/server/src/agent/native-tools.ts`——生成段**之后**新增 `BROWSE_TOOL_SCHEMAS`（手写段，附注释声明来源为本 PRD 而非 Python ast 抽取）；`NativeToolPortDeps.browse?` 分支；`filterVisibleTools` 扩展 `browserEnabled` 位。
- `packages/server/src/agent/engine.ts`——每 run 组装 browse 执行器（闭包取 starter/db）。
- `packages/server/src/app.ts`——`ALLOWED_KEYS`/`BOOL_KEYS`/缺省值加 `browser_tools_enabled`；`defaultEngineFactory` loopback 参数传 `starter`（可选键，向后兼容）。
- `packages/server/test/native-tools.test.ts`——fixture 对账改为"22 原段对账 + browse 段单独钉"；可见性开关测试。
- `packages/server/test/engine-factory.test.ts`——browse 注入接线断言。
- `packages/server/test/fixtures/` 不动（22 原段保持字节级）。
- 文档：`AGENTS.md`（22→27 工具数与新增能力一行）、`docs/roadmap.md`（路线 2 状态回写）、本 PRD 落盘。

### 8.2 依赖与兼容

- **零新增运行时依赖**（本 PRD §一裁决）；`@types/node ^24` 已含全局 WebSocket 类型，若 lib 窄缺以 `CdpTransport` 接口收口，不放宽 tsconfig。
- API 兼容：HTTP 端点零变更（browse 不走 HTTP 路由）；工具面纯增量；engine factory 新参数为可选键；DB 零 schema 变更。
- 闸门：`VIBE_BRIDGE_GATED_TOOLS` 机制零改动，browse 工具名天然可入列。

### 8.3 测试方案

- **单测/集成**：内存假 CDP 传输（可脚本化响应序列与事件）+ 假 starter（可注入端口/存活/锁状态）覆盖 §六 1-9；全部 `app.request` / 进程内，零真网。
- **按需真实冒烟**：`packages/server/e2e` 外新文件 `packages/server/test/browser-real.smoke.test.ts`，`describe.skipIf(!process.env.VIBE_BROWSER_SMOKE)`（对齐 real-provider.smoke 先例）：真 Chrome（headless）+ node:http 本地静态页，走 navigate→read→act(click 翻转 DOM)→eval→写 workspace 全闭环，零外网依赖。
- **风险**：真 Chrome 在 CI 不可用 → 冒烟按需跳过（既有先例，非绕过：闭环逻辑已被假传输级测试钉死）；Windows 下 spawn Chrome 路径解析已有 `findChromeExecutable` 兜底。

### 8.4 任务拆分与回滚点

| 任务 | 内容 | 依赖 | 回滚点 |
|---|---|---|---|
| T1 | `cdp.ts` 连接层 + `browser-cdp.test.ts` | — | T0 = PRD 提交 commit |
| T2 | `starter.ts` 扩展（peek/touch/懒启动入口）+ 测试 | — | T1 commit |
| T3 | `browse.ts` 会话解析 + tab LRU + 5 工具执行器 + 测试 | T1、T2 | T2 commit |
| T4 | 注册/可见性/设置开关/引擎装配接线 + 测试 | T3 | T3 commit |
| T5 | 真实冒烟（按需）+ 文档回写（AGENTS/roadmap） | T4 | T4 commit |

每任务独立提交（Conventional Commits），提交前跑该任务范围 verify；双重审查（阶段 6）覆盖 T1-T5 全量 diff。规格符合性审查与代码质量审查均由未参与实现的独立代理执行，结论落档 `docs/审查记录.md`。

---

## 九、已知限制（诚实声明，随交付转用户）

1. **同店并发任务的 tab 干扰**：单浏览器单客户端单 activeTab，两个任务同时操作同一店铺浏览器会互相看到对方的 tab 切换（原版以 mux per-client target 隔离，本批不做；`tab_id` 显式寻址可缓解）。产品常态是一店一活跃任务，风险低；真实使用遇到再立项。
2. **无 auto-wait**：SPA 异步渲染需 agent 用 `wait` 动作或跨调用轮询（原版同款纪律，写入工具 description）。
3. **浏览器崩溃页状态丢失**：懒恢复后是干净 tab（profile 登录态在，页面状态不在），agent 需重新导航。
4. **run 预算约束**：重浏览任务（>40 次工具调用）会被既有 run 预算截停——这是全局既有约束，非本批引入。
