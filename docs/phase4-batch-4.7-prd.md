# 批次 4.7 PRD：验收（telemetry 收尾 + 录制流量回放契约测试 + 前端零改动 e2e）

> 本文档是批次 4.7 的自足交接文档：目标、范围、参考实现地图、已预裁决的语义决定、落地约定与验收标准。
> 面向一个**全新会话窗口**执行，不依赖本文档之外的会话记忆。参考代码库与本仓库路径见 §2。

---

## 1. 背景与任务

项目：`D:\CKQ\workplace\vibe-seller-ts` —— vibe-seller（跨境卖家 AI 自动化框架，原 Python FastAPI 后端）向 pi Agent SDK 架构的 TypeScript 迁移，绞杀者模式逐模块替换。**当前进度：Phase 4 批次 4.1–4.6 已完成**（179 端点全部点亮；测试 251 通过 + 2 真实冒烟按需跳过；基线 commit `17e3498`）。

**本批任务 = Phase 4 批次 4.7「验收」**，三件事 + 一件前批遗留：

1. **telemetry 模块移植**（4.4/4.6 两批显式挂起到 4.7 的遗留：`telemetry.send` 一直是 no-op，locale 端点是形状桩）；
2. **录制流量回放契约测试**：真 FastAPI（进程内 ASGI）录制 → TS 回放逐请求比对（迁移计划 §批次 4.7 验收项）；
3. **前端零改动 e2e**：原 React 19 前端构建产物挂在 TS server 上，真实浏览器跑关键流；
4. 文档收尾（§8）。

**非本批**：原 FastAPI×TsAgentBackend 端到端切流验收——用户指定延后（迁移计划已记录），本批不启动。

工作方式沿用前批（务必先读）：

1. **先通读参考实现再动手**，逐事件/逐请求对齐契约；错误形状恒 `{"detail": "..."}`；
2. 契约测试零真网：外部 HTTP 一律注入（本地假服务器 / 注入 fetch）；telemetry 传输同理可注入；
3. 每个语义决定在代码注释里写明"对应原实现何处、有何差异、为何"；
4. TDD：先写失败测试再实现（Red → Green → Refactor）。

## 2. 路径、命令与环境（本批已就绪）

| 项 | 路径/命令 |
|---|---|
| 本仓库（TS） | `D:\CKQ\workplace\vibe-seller-ts`（git 已有基线 commit，每任务单独提交） |
| 参考实现（Python，只读源码） | `D:\CKQ\workplace\_reference\vibe-seller-src\app\` |
| 参考实现运行环境（**已建好**） | `D:\CKQ\workplace\_reference\vibe-seller-src\.venv`（Python 3.11，`uv` 管理，全部依赖已装，`import fastapi...` 已验证）。解释器：`.venv/Scripts/python.exe` |
| 前端构建产物（**已建好**） | `D:\CKQ\workplace\_reference\vibe-seller-src\frontend\dist\`（React 19.2 + Vite 7 构建成功）。重建命令：`corepack pnpm install && corepack pnpm run build` |
| 契约基准 | `docs/phase4-backend-inventory.md` |
| 迁移状态与红线 | `docs/migration-plan.md` |
| 测试 | 根目录 `npx vitest run`（251 基线全绿）；`npm run typecheck` |

环境：Windows + Git Bash；Node 24（`node:sqlite` 内置）；测试禁真网（外部 HTTP 用本地 `node:http` 假服务器，见 `packages/server/test/workspace.test.ts` 的注入模式）。系统装有 Chrome（Playwright 走 `channel:'chrome'` 免下载浏览器）。

## 3. Task 4.7.1：telemetry 模块移植

### 3.1 原实现地图

核心文件（都在 `_reference\vibe-seller-src\app\`）：

- `telemetry.py`（320 行）：PostHog 封装。客户端 `Posthog(project_api_key='phc_NP0E…', host='https://t.vibe-sellers.com', disable_geoip=True)`（默认异步队列：flush_at=20、定时 flush，capture 只入队）；`send()` 全量吞异常只 debug 日志；`shutdown()` 只 flush 且异常裸吞。
- `telemetry_events.py`（78 行）：事件名常量 + `BrowserFailureReason`。
- `telemetry_tasks.py`（110 行）：`send_task_completed`（async，另开 DB 会话统计 tool_use 消息数与 skills，失败静默降级仍发送）/ `send_task_failed`（同步）。
- `routers/telemetry.py`（37 行）：`POST /api/telemetry/locale`（免认证，白名单 {en,zh} 否则 'unknown'，payload locale ≤16 字符，返回 `{'ok': True, 'locale': locale}`）。
- 生命周期（`main.py`）：`init_db` → `_apply_persisted_telemetry_flag`（读 settings 行 `telemetry_enabled`，`value=='false'` → `set_db_disabled(True)`；DB 异常只 debug）→ `telemetry.init()` → 统计 store/task/active schedule/user 数 → `send('app_started', 计数)`（统计失败发空 props）→ 退出时 `telemetry.shutdown()`。

### 3.2 门控链（逐条移植）

`send()` 生效当且仅当全部满足：① `init()` 建过 client；② 环境变量 `VIBE_SELLER_TELEMETRY` strip 后 ≠ '0'；③ 非 pytest/CI 环境（原：`'pytest' in sys.modules` / `PYTEST_CURRENT_TEST`；CI 变量 `CI|GITHUB_ACTIONS|BUILDKITE|GITLAB_CI|CIRCLECI|JENKINS_URL` 任一非空时 init 直接不建客户端）。TS 等价：vitest 检测用 `process.env.VITEST` 或 `NODE_ENV==='test'`；CI 变量同名移植；④ `set_db_disabled(False)`（即 settings 未关闭）。

**settings 热更新顺序怪癖（必须保真）**：`PUT /api/settings` 写库后**先**重读 `telemetry_enabled` 行调 `set_db_disabled(...)`，**再**发 `setting_changed` 事件——否则 false→true 重新启用的那次事件本身发不出去（原 `app_settings.py:213-218` 注释）。

**settings GET 契约补齐**（原 `app_settings.py:122-131`）：env 禁用时向前端回报 `telemetry_enabled='false'`；响应含 `install_id` 供前端 PostHog 复用同一 distinct_id。TS 侧 app.ts 现状缺这两点，本批补齐。

### 3.3 事件清单（接线点 = 原实现同语义点）

所有事件叠加 base properties：`{app_version, os, os_release, python_version, is_docker, app_locale}`，caller 键覆盖 base。TS 侧 `python_version` 无运行时事实，**预裁决**：删去该键、新增 `node_version`（`process.version`），代码注释记录此差异；`app_version` 取根 package.json version（`0.1.0`）；`os` 移植 `runtime_os()`（mac/windows/wsl/linux/other，WSL 靠 `/proc/version` 含 'microsoft'）；`is_docker` 查 `/.dockerenv` 存在性。

| 事件 | 触发点（TS 侧接线处） | caller properties |
|---|---|---|
| `app_started` | server 启动（index/main 启动序列，测试不触发） | `store_count`/`total_task_count`/`active_schedule_count`/`user_count` 裸 int |
| `store_created` | POST /api/stores commit 后 | `browser_backend`、`platform_count`、`country_count`、`is_first_store`(≤1) |
| `store_deleted` | DELETE /api/stores/{id}（**计数快照在级联删除前**） | `browser_backend`、`task_count_at_deletion_bucket`、`age_bucket` |
| `task_created` | POST /api/tasks（注意与 SSE 总线 `task_created` 同名不同物，两链路分开建模） | `is_store_task`、`plan_mode`(非店铺任务强制 True 后的实际值)、`has_schedule`、`has_parent`、`ai_profile_kind`、`description_length_bucket`、`created_by_role` |
| `task_completed` | orchestrator 终局裁决 COMPLETED 处 | `is_store_task`、`was_planned`、`duration_bucket`、`duration_seconds`、`is_scheduled`、`ai_profile_kind`、`tool_use_count_bucket`、`tool_use_count`、`skills_used`(≤20)；统计失败静默降级仍发送 |
| `task_failed` | orchestrator 终局裁决 FAILED 处（原 8 分支 phase 映射：running/pre_running/pipeline，error_category 优先 DB 字段） | `is_store_task`、`was_planned`、`phase`、`error_category`、`is_scheduled`、`ai_profile_kind` |
| `task_resumed` | orchestrator 唤醒入口（原实现硬编码字符串，非常量） | `is_store_task`、`wait_duration_bucket`、`wake_reason`、`ai_profile_kind` |
| `schedule_fired` | 调度器 fire 实际建任务前（跳过的不发） | `schedule_type`、`phase_mode`、`fanout_target_count_bucket`、`is_catalog` |
| `setting_changed` | PUT /api/settings 每个接受 key 一条（在 set_db_disabled 之后！） | `key`、`to_value`（`_bucket_setting_value`：4 bool 键→bool、max_agent_concurrency→int、default_schedule_timezone→tz_continent_bucket、task_retention_days→retention_days_bucket、default_schedule_phase_mode→原值、其余→None） |
| `user_pref_changed` | PATCH /api/auth/me/debug-mode、profile（plan_mode_default / sync_profile_to_schedules 变更分支） | `key`、`to_value` |
| `ai_profile_created`/`deleted`/`default_set` | profiles 路由同语义点（default_set 不含 schedules_synced） | `provider_kind`、`is_first_profile`(≤1)/`has_global_mcp` 等 |
| `email_account_added`/`removed` | email-accounts POST/DELETE | `provider_kind`(email_provider_kind)、`has_smtp`、`use_ssl` / `{}` |
| `ziniao_account_added`/`removed` | ziniao-accounts POST/DELETE（removed 仅账号存在才发） | `account_count_after_bucket` / `{}` |
| `integration_gws_enabled`/`disabled` | settings gws enable/disable（admin，技能装完才发 enabled） | `success`+`skill_count_bucket` / `{}` |
| `admin_user_created`/`deleted` | users POST/DELETE（commit 后；deleted 角色删除前取） | `role` |
| `browser_session_attempted`/`started`/`failed` | browser/ziniao 探测与启动等价点（started 的判定=连通即成功，statusCode≠0 仍算；failed 的 error_category ∈ BrowserFailureReason） | `backend`='ziniao'、`os`、`attempt_number`/`attempts_to_success`+`auto_launched`/`attempts_total`+`error_category` |

**bucket 函数逐字段移植**（含边界）：`count_bucket`（0/1-5/6-20/21-100/100+）、`duration_bucket`（unknown/<30s/30s-2m/2m-10m/10m-30m/>30m，负数钳 0）、`length_bucket`（0 单列、<50 覆盖 1-49）、`age_bucket_days`、`retention_days_bucket`、`tz_continent_bucket`（空→UTC；无 `/`→字面 UTC 或 other；9 洲白名单）、`email_provider_kind`（11 域名映射表）、`duration_seconds_from_iso`（解析失败→None）。死代码不移植：`daily_heartbeat`（无发送点）；`task_resumed` 按实际硬编码字符串。

### 3.4 PostHog 传输：最小 fetch 客户端（零新依赖）

不引入 posthog SDK。`telemetry/transport.ts`：内存队列 + `flushAt=20` + 定时 flush（10s）+ `flush()` 排空 + `shutdown()`；批量 POST `{host}/batch/`，body `{"api_key": key, "batch": [{event, distinct_id, properties, timestamp, type:"capture"}]}`；**传输函数可注入**（测试注入捕获函数，绝不真网）。send 永不抛出，失败 debug 级。install_id：`<VIBE_HOME>/data/install_id`，init 时解析一次（读不到生成 uuid4 写入；IO 失败→一次性 uuid 不落盘，与原一致）。

### 3.5 验收标准

1. locale 端点：白名单/截断/返回形状与原逐字节一致；上报后 `base_properties().app_locale` 跟随。
2. 门控链单测：env=0 / vitest / CI 变量 / db_disabled 任一 → send 为 no-op；全开 → transport 收到事件且 base properties 合入、caller 覆盖 base（原 unit test 的三个断言照搬）。
3. 事件面：上表每个事件至少一条"触发点 → transport 收到正确事件名与 properties"的测试（注入 transport，直测路由/orchestrator）。
4. settings PUT 顺序怪癖有专门测试：telemetry_enabled false→true 那次 setting_changed 事件必须发出。
5. settings GET：env 禁用回报 'false' + 含 install_id。
6. 全部现有测试保持绿；`npm run typecheck` 通过。

## 4. Task 4.7.2：录制流量回放契约测试

### 4.1 设计

- **录制器** `python/record_replay_fixture.py`（本仓库内，用参考仓库 venv 跑）：
  - env 隔离：`VIBE_HOME=<tmp>`、`LOG_DIR=<tmp>`、`VIBE_SELLER_TELEMETRY=0`、固定 `JWT_SECRET`、`ADMIN_USERNAME/ADMIN_PASSWORD` 已知值；确保没有 CI 变量泄漏导致行为分叉。
  - 进程内拉起真 FastAPI app：httpx `ASGITransport` + lifespan（参考原仓库 `tests/workflow/conftest.py` 的成熟模式；若用 asgi-lifespan 需确认 venv 里是否可用，没有就手动 `async with app.router.lifespan_context(app)`）。
  - **种子 + 采集一条序列**：登录 admin → 按家族走 CRUD/配置/错误分支（settings、users、stores、tasks、schedules、cron、events、channels/wecom、email 账户 CRUD（不真连 IMAP）、profiles、workspace、vision catalog、telemetry/locale、dida365 状态、ziniao（探活失败的确定性错误形状也是契约）、screenshots/attachments 错误分支、401/404/409/412/422 守卫）。**排除**：agent 执行类、SSE 长流、真实网络端点（knowledge 远程同步指到不可达端口取失败形状即可）、调度会真实触发的 schedule（seed 用远期 start_date 防止录制窗口内 fire）。
  - 产物 `packages/server/test/fixtures/replay/traffic.jsonl`：每行 `{name, method, path, body, status, json}`，其中创建类响应中的动态 id 由录制器登记为**逻辑名占位**（后续步骤的 path/body 引用 `{{store_1}}` 这类占位）；响应 JSON 原样保存（回放侧比对前做归一化）。
  - fixture **提交进仓库**，回放测试不依赖 Python 环境即可跑。
- **回放测试** `packages/server/test/replay.test.ts`：
  - 全新 tmp VIBE_HOME + 空 DB 启动 TS app（app.request 模式，端口 0，同现有契约测试），**按序重放同一序列**（种子请求 + 采集请求），占位符从 TS 侧自己的 POST 响应解析。
  - 每步断言：status 逐字节一致；JSON 经归一化后 deep-equal。**归一化规则**（TS 侧共享模块）：UUID 形状字符串→`<uuid>`、ISO 日期时间→`<iso>`、版本号字段（如 version/install 路径里的绝对路径）→`<ver>`/`<path>`；两侧同规则，归一化器有单测。
  - 差异输出：首个不一致字段的可读 diff（path + 期望 vs 实际）。
- **红线上限**：回放若因 fixture 过时失败，禁止改 TS 代码迁就 fixture 之外的东西；判定是 fixture 缺陷时重新录制并在提交信息说明。

### 4.2 验收标准

1. `python python/record_replay_fixture.py` 可重复执行（幂等重建临时环境），产出 fixture。
2. `npx vitest run packages/server/test/replay.test.ts` 全绿；覆盖 ≥60 个请求步骤、含每一路由家族至少一个成功形状与一个错误形状。
3. 故意篡改一处 TS 响应字段（临时改动）回放必须变红（人工验证后还原）——证明比对真的在比对。
4. 回放测试不依赖 Python/参考仓库/真网。

## 5. Task 4.7.3：前端零改动 e2e

### 5.1 设计

- 前端 dist **零改动**（React 19 构建产物原样）；TS server 以 `FRONTEND_DIST=<参考仓库>/frontend/dist` 启动真端口（`@hono/node-server` serve，测试基建首次真监听）。
- Playwright 以 **devDependency** 加入根 package.json（`零新增运行时依赖`红线不变——dist 构建与 e2e 都不进运行时）；浏览器用系统 Chrome（`channel:'chrome'`），不下载浏览器。
- e2e 套件 `packages/server/e2e/frontend.e2e.ts`，由独立脚本跑（**不进默认 vitest run**）：`npm run e2e` = 前置检查 dist 存在 → 起 TS server（临时 VIBE_HOME、auth on、已知 admin 凭据）→ Playwright 驱动：
  1. 打开 `/` 返回 index.html 且 JS/CSS 资产 200（SPA fallback 生效：直接访问深链路径也回 index.html）；
  2. 登录流：表单提交 admin 凭据 → 进入主界面（登录后任一特征元素/路由）；
  3. 数据面：店铺列表页加载真实端点数据（空态渲染或建一个店后可见）；
  4. 设置页：telemetry 开关与语言切换可见可交互（触发 telemetry/locale 上报，服务端断言收到）；
  5. SSE：页面建立 `/api/sse` EventSource（服务端断言有订阅者；或触发一条事件页面无崩溃）。
- 断言以**用户可见结果**为准（元素出现/接口 200），禁止对前端内部实现做脆弱选择器断言；选择器尽量用语义角色/text。
- 跳过条件：dist 不存在或 Chrome 不可用时 skip 并输出明确原因（CI 无头环境友好）。

### 5.2 验收标准

1. `npm run e2e` 一键可跑，全绿；前端源码与 dist 零改动（diff 范围检查项）。
2. 登录 → 主界面 → 店铺/设置页数据渲染 → SSE 建立，五步各有断言。
3. e2e 不影响 `npx vitest run` 默认套件（文件分离或 exclude）。

## 6. 已预裁决的语义决定（实现时不得自行变更）

1. PostHog 走最小 fetch 客户端（零新依赖）；posthog SDK 不移植。
2. base properties：删 `python_version`、增 `node_version`（唯一一处事件面差异，注释+本 PRD 记录）。
3. `task_completed` 的统计查询失败→静默降级仍发送；`task_failed` 同步无统计——两条失败语义分开保真。
4. settings PUT 的 set_db_disabled 先于 setting_changed 的顺序是红线（有专门测试）。
5. 回放 fixture 提交进仓库；录制器只要求"可重新录制"，不进 CI。
6. playwright 仅 devDependency；e2e 不进默认测试命令。
7. 切流验收（FastAPI×TsAgentBackend）本批不做，用户指定延后。

## 7. 非目标

- 不实现前端任何改动（零改动是硬约束）；
- 不移植 posthog-python 的完整特性（person identify 之外的 API、本地队列持久化、重试策略等按最小需求实现）；
- 不录制/回放 agent 执行与 SSE 长流（已有 Phase 3 桥 e2e 与契约测试覆盖）;
- 不做 CI 集成（宪法门禁落地表的 CI 建设另批）；
- 不动 `packages/bridge`（跨语言测试不涉本批改动时不重跑）。

## 8. 文档更新（完成后）

1. `docs/migration-plan.md`：批次 4.7 状态 ✅ + 摘要（录制回放步骤数、e2e 断言数、telemetry 事件数）；Phase 4 状态改"批次 4.1–4.7 完成（切流验收延后）"。
2. `docs/phase4-backend-inventory.md`：批次表 4.7 行 ✅ + telemetry 端点/事件说明。
3. `README.md`：状态段更新（测试数、e2e 命令、下一步 = Phase 5 或切流验收）。
4. 本 PRD 状态标注。

## 9. 任务拆解与回滚点

| 任务 | 内容 | 依赖 | 回滚点 |
|---|---|---|---|
| 4.7.1 telemetry | §3 全部 | 无（基线 commit） | 基线 commit；失败回滚到基线 |
| 4.7.2 录制回放 | §4 全部 | 4.7.1（locale/settings 契约变更影响 fixture）；venv 就绪 | 4.7.1 的提交 |
| 4.7.3 前端 e2e | §5 全部 | 无强依赖（settings 页断言与 4.7.1 的 install_id 字段弱相关，安排在其后） | 4.7.2 的提交 |
| 4.7.4 收尾 | 独立审查 + 文档更新 + 交付 | 全部 | — |
