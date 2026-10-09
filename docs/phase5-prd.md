# Phase 5 PRD：退役 Python（原生 ToolPort + 退役清理 + 原地升级 + Node 捆绑分发）

> 本文档是 Phase 5 的自足交接文档：目标、范围、参考实现地图、已预裁决的语义决定、落地约定与验收标准。
> 面向一个**全新会话窗口**执行，不依赖本文档之外的会话记忆。
> **状态：✅ 已完成**（5.1=46216f4 原生 ToolPort / 5.2=30cecfa 退役清理+补列+启动 / 5.3=37adc44 分发打包 / 整改=3cd7e45）。双重审查结论见 docs/审查记录.md。规格修订记录：§3.2 "Bearer 头"按原实现（mcp_server.py:82-83 cookie auth_token）修正；§4.3 strip-types 启动按实测改 esbuild 临时 bundle（三处硬阻塞证据在 scripts/dev-start.mjs 头注）；"15 列"实数为 14+2=16 并超集移植 _backfill_finalize_enabled_at。前序状态：Phase 4 批次 4.1–4.7 全部完成（TS 322 测试 + e2e 5 用例，切流验收用户指定延后并已由用户裁决跳过——直接进 Phase 5）。

---

## 1. 背景与任务

迁移计划 Phase 5 原文：**退役 Python；安装包改捆 Node 运行时；`~/.vibe-seller` 数据目录不变、原地升级**。

前期调查（2026-10-09，证据见 git 历史 PRD 引用）已查明运行时的 Python 残留全貌：

1. **原 MCP 服务器是纯 HTTP loopback 代理**（`app/mcp_server.py` 390 行，22 个工具全部转发到 FastAPI 端点，无 DB/文件/子进程操作）——这些端点在 TS server 已 100% 存在。TS 现状：每 run 拉起一个 Python MCP 进程（`VIBE_BRIDGE_MCP_COMMAND`）做工具面，这是最大的 Python 运行时残留。
2. **浏览器自动化链（browser-use/wrapper/CDP mux）从未接入 TS 运行时**：pi 引擎工具面 = 仅 MCP 工具、无 Bash 工具，TS 的 BrowserStarter 只管 Chrome 会话端点。该链按既定架构决定属"外部进程托管、不当源码移植"。
3. **原地升级数据格式已逐项验证兼容**（DB/jwt_secret/profiles.json/channels.json/email_dbs/install_id/workspace git/bcrypt/Fernet）；唯一缺口：TS `ensureSchema` 只补 2 列，原 `_ensure_added_columns` 有 15 列（"很老 Python 版本直跳 TS"场景缺列）。
4. **分发**：原安装 = uv tool install（PyPI wheel 内带前端 dist）；TS 侧无任何启动/打包脚本，前端 dist 目前借参考仓库产物。

**本 Phase 三个批次**：

| 批次 | 内容 | 状态 |
|---|---|---|
| 5.1 | 原生 ToolPort：22 工具进程内替换 Python MCP 进程 | ✅ |
| 5.2 | 退役清理（python/、桥的 Python 编排路径）+ 原地升级补列 + server 启动脚本 | ✅ |
| 5.3 | 分发打包：vendor 前端 + esbuild 单文件 bundle + Node 运行时捆绑安装器 + 原地升级验收 | ✅ |

工作方式沿用前批：先读参考实现再动手；TDD；每个语义决定注释"对应原实现何处/有何差异/为何"；测试禁真网。

## 2. 路径与命令

| 项 | 路径 |
|---|---|
| 本仓库（TS） | `D:\CKQ\workplace\vibe-seller-ts`（基线 = Phase 4 完成态，HEAD 见 git log；每任务单独提交） |
| 参考实现（只读） | `D:\CKQ\workplace\_reference\vibe-seller-src\`（app/mcp_server.py、mcp_tool_schemas.py、mcp_ad_tool_schemas.py、ai/claude_backend.py:498-545 服务令牌、database.py:36-60 补列、frontend/） |
| 命令 | `npx vitest run`（322 基线）；`npm run typecheck`；`npm run e2e`（涉 SPA/前端时必跑） |
| 环境 | Windows + Git Bash；Node 24（node:sqlite 需 ≥22.5）；测试零真网 |

## 3. Task 5.1：原生 ToolPort（MCP 进程退役的核心替换）

### 3.1 原实现地图

- **工具 schema**：`app/mcp_tool_schemas.py`（717 行，`TOOLS = [*AD_TOOLS, 其余 21 个]`，每个含 name/description/inputSchema）+ `app/mcp_ad_tool_schemas.py`（133 行，`declare_ad_task` 的 audit/investigate 判别契约**写在 description 里**——每次决策都在模型上下文中，必须原文移植）。schema 是纯数据。
- **代理逻辑**：`app/mcp_server.py`——`tools/call` 全部 `call_api()`（httpx 直连 loopback，`trust_env=False`）拼 URL 转发；`_visible_tools()`（:40-47）无 KIE key 且非 fake 模式时隐藏 `vibe_seller_generate_image`；`send_email`（:163-186）MCP 进程内先 `GET /api/email-accounts` 按邮箱地址查账户 ID 再发信；`sanitize_json`（:79）序列化前清洗孤立代理对；错误包在**成功结果** `content[0].text` 的 JSON 里单键 `{"error": ...}`（TS 侧 `packages/bridge/src/mcp.ts:124-158` 已有该判别可参照）。
- **服务令牌身份**：原 `app/ai/claude_backend.py:498-545` 注册 MCP 时签发的服务令牌（sub/role/exp 裁决以实读为准，实现时必须先读这段再定身份）。
- **TS 注入点**：`packages/server/src/agent/engine.ts:96-113`——`if (mcpCommand) { spawn McpServerConnection → listTools → createMcpToolPort }`，整块替换为原生 ToolPort；`tools`/`toolSpecs`/`dispose` 三个返回件的形状不变。

### 3.2 实现要求

1. **`packages/server/src/agent/native-tools.ts`（命名可调）**：
   - 22 个工具 schema 移植为 TS 常量（`mcp_tool_schemas.py` + `mcp_ad_tool_schemas.py` 逐字段，含 description 全文——那是审计契约）；
   - 执行器：**进程内 `app.request()` 自调 Hono app**（与原 MCP→HTTP loopback 逐语义同构：同 auth 判定树、同错误形状、同 SSE 侧效应、同遥测接线）。请求身份 = 按原服务令牌裁决移植（Bearer 头 + sub/role/exp 同构）；路径/查询/body 的拼装逐工具对照 `mcp_server.py` 的 URL 构造；
   - 语义保真三件：`generate_image` 无超时（服务端阻塞等人工确认）+ 能力门（无 KIE key 且非 VISION_FAKE → 从 tools 列表隐藏）；`send_email` 先查账户 ID 的两段式；孤立代理对清洗（sanitize_json 等价——JS 字符串容忍 lone surrogate，但 JSON 序列化/HTTP 层要注意，行为以"合法 JSON 输出"为准绳）；
   - 错误包装：工具执行失败 → 结果 content 里 `{"error": ...}` 单键（不是 MCP 协议层 error），与原约定逐字对齐。
2. **engine 切换**：`engine.ts` 删除 `VIBE_BRIDGE_MCP_COMMAND` 分支，默认走原生 ToolPort；`dispose` 相应调整（无进程则清空）。env 读取与注释一并清理。
3. **可见性缓存**：能力门在引擎工厂组装时判定一次（原 MCP 是每 run `_visible_tools()`，等价时机=每 run 工厂）。
4. **测试**（TDD）：
   - schema 移植钉子：22 个工具名集合与 inputSchema 关键字段（required/类型）与原 Python 逐一对账（可把原 JSON 抽成 fixture 比对，或抽最少 8 个关键字段断言 + 全集名単精确相等）；
   - 每个工具至少一条"调用 → 正确端点被以正确 method/path/body 命中 → 结果形状"测试（可用 app.request spy 或注入 fetch 记录器；已有 server 契约测试基建照用）；
   - 能力门两态、send_email 两段式（账户不存在→错误包装）、generate_image 阻塞无超时语义（fake 短路路径）、错误包装形状、孤立代理对清洗单测；
   - engine 工厂测试更新：不再有 MCP 分支（env 设了也不生效→已删除），原生工具面默认存在。
5. **验收标准**：全量 vitest 绿（322 基线 ± 本任务增删）；typecheck 零诊断；`VIBE_BRIDGE_MCP_COMMAND` 在 packages/server 内零引用。

## 4. Task 5.2：退役清理 + 原地升级补列 + 启动脚本

### 4.1 退役清理（删除边界）

原则：**删"只为 Python 编排路径存在"的代码，保留仍被 server 进程内复用的**。动手前先画出精确依赖边（`grep from "@vibe/bridge"` 全仓 + 逐导出核对），用 typecheck 证明删除后无悬空引用。

- **删除**：`python/`（ts_agent_backend.py、test_ts_agent_backend.py——服务对象是 Python 编排器，随退役删除；跨语言桥协议测试随之退役，桥协议本身不复存在）；`packages/bridge` 的 Python 编排路径：HTTP+SSE 桥服务引导（main.ts 的服务器部分）、scripted 引擎、MCP stdio 客户端（mcp.ts，5.1 后无消费方）、`VIBE_BRIDGE_MCP_COMMAND`/`VIBE_BRIDGE_MCP_CWD` env 面、对应的桥 e2e/协议测试；根 `bridge:build` script（产物只为跨语言测试存在）。
- **保留**（server 进程内复用）：translate.ts（事件翻译）、profiles.ts（桥 profiles.json 双源解析）、registry.ts 等仍被 `@vibe/bridge` 导入面引用的部分；`packages/bridge/package.json` 相应瘦身。
- **文档同步**：README/AGENTS 命令段、migration-plan Phase 3 状态注记"编排桥已随 Phase 5 退役，translator/profiles 并入 server 进程内使用"。

### 4.2 原地升级补列（老版本直跳 TS 兜底）

把原 `app/database.py:36-60` `_ensure_added_columns` 的 **15 条补列全量**移植进 `packages/server/src/db.ts` 的 ensureSchema（现有 2 条 `schedules.plan_mode/ai_profile_id` 已在内，逐条对照列名/表名/类型；SQLite 无类型强校验，ALTER TABLE ADD COLUMN 文本对齐原实现）。测试：建一个"缺全部 15 列"的老 schema 库 → openDb 后列全在、老数据行不丢（插入老形状行再读回）。

### 4.3 启动脚本

根 package.json 补 `"start"`（`node packages/server/src/main.ts`——Node 24 直接跑 TS？不行，main.ts 是 TS 源码；用 `npm run server:build` + `node dist/…` 或 tsx？**预裁决**：5.2 先加 `"start": "node --experimental-strip-types packages/server/src/main.ts"`（Node 24 支持类型剥离，仅限本机开发用；5.3 的 bundle 才是分发形态），5.3 视 bundle 产物替换。附带优雅关闭：SIGINT/SIGTERM → scheduler 排水 + db close（对照原 stop.sh 的清理语义做 TS 等价最小集：停调度、关 DB；浏览器会话复位已有 boot 逻辑）。

### 4.4 验收标准

1. 全仓 `grep -r "VIBE_BRIDGE_MCP_COMMAND\|ts_agent_backend\|mcp_server" packages/ python/` 零运行时引用（文档/历史注释除外，逐一注记"已退役"）；
2. `npm run typecheck` 零诊断；全量 vitest 绿（删除代码时同步删其测试，净减数在报告说明）；
3. 老库补列测试绿；`npm start` 可启动（health 200 后手动停）。

## 5. Task 5.3：分发打包（vendor 前端 + bundle + Node 捆绑安装器）

### 5.1 设计

1. **vendor 前端**：`D:\CKQ\workplace\_reference\vibe-seller-src\frontend`（源码 src/ + 配置，**不含 node_modules/dist**）字节级复制进本仓库 `frontend/`（记录来源与文件数/哈希清单；零改动红线继续有效——vendor 后本仓也不改它，需要改前端 = 回原仓库改后重新 vendor，这是架构决定）。
2. **构建管线**：`scripts/build.mjs`（esbuild）→ `dist/server.mjs` 单文件 bundle（server 入口 + node:sqlite 内置 + 全部依赖内联；CJS/ESM 注意事项参照 bridge/build.mjs 的既有经验）+ `pnpm build` 前端 → `dist/frontend/`；`npm run package` = build + 组装 `release/vibe-seller-ts/`：`{ server.mjs, frontend/, node.exe（下载官方 win-x64 zip 或 NODE_ZIP env 指定）, start.bat, stop.bat, README-UPGRADE.md }`。
3. **start/stop**：`start.bat`（后台起 server.mjs，pid 文件，FRONTEND_DIST 指向随包 frontend，VIBE_HOME 默认 `~/.vibe-seller`）、`stop.bat`（按 pid 终止）；环境变量传递保持 server 既有约定（JWT_SECRET/BACKEND_PORT/ADMIN_*）。
4. **原地升级验收**（本批核心验收，脚本化冒烟 `scripts/smoke-package.mjs` 或等价）：
   - 用 bundled node 在**全新临时 VIBE_HOME** 启动 → health/version 200 → 登录 → 首页 HTML 200 → 任一 API 面（stores 列表）200；
   - **原地升级场景**：先用参考 Python 仓库 venv 造一个带数据的 VIBE_HOME（建用户/店铺/设置，或直接用 4.7 录制器的种子序列），停掉 → 捆绑 TS server 对同一 VIBE_HOME 启动 → 老用户可登录（bcrypt 兼容）、老店铺/设置在、遥测 install_id 不变、无报错日志；
   - 全程不联网（node.exe 可 NODE_ZIP 预置）。

### 5.2 验收标准

1. `npm run package` 一键产出 release 目录；`scripts/smoke-package.mjs` 两场景全绿；
2. vendor 的 frontend 与参考仓库源码 diff 为空（哈希清单入提交信息或脚本断言）；
3. e2e 仍绿（FRONTEND_DIST 指向 vendor 后新构建的 dist——e2e server.ts 的默认路径切换到本仓 frontend/dist，这是对 4.7 遗留台账第 8 项"硬编码路径"的顺手收口）；
4. 安装/升级文档 `docs/deploy.md`：从 Python 版原地升级的操作序列 + 回退方式（数据目录不动，换回旧启动命令即可）。

## 6. 已预裁决的语义决定（实现时不得自行变更）

1. **浏览器能力不在本 Phase 补**：TS 阶段 agent 工具面 = 22 个数据工具，无浏览器操作——这是 Phase 3 既定架构决定（浏览器层外部进程托管）的延续，不是 Phase 5 的回归；文档明示。增量 browse 工具留待用户提出需求。
2. 原生 ToolPort 走 **app.request 进程内自调**（不是直调 service 函数）——保持与原 loopback 同构的 auth/错误/侧效应语义；身份按原服务令牌实读裁决（claude_backend.py:498-545）。
3. `generate_image` 保留无超时阻塞 + 能力门；`send_email` 两段式账户查找进原生层；错误包装 `{"error":...}` 单键在成功结果里。
4. 桥的 Python 编排路径（HTTP 服务/scripted/MCP 客户端/跨语言测试）随 Phase 5 删除；translator/profiles 保留并入 server。
5. Node 捆绑 = node.exe + esbuild 单文件 bundle + bat 脚本（**不做 SEA 单可执行实验特性**）。
6. dida365（ticktick）第三方 Python MCP 保持"装了 uv 才可用"的外部化声明，不迁移。
7. Windows-first（安装器/bat）；Linux/Docker 对齐另批。
8. 版本号维持 0.1.0 不动（telemetry app_version 数据连续性）。

## 7. 非目标

- 不实现 TS 浏览器工具/不移植 browser-use；
- 不做 Linux/Docker 安装器、Inno Setup 图形安装包、系统服务/托盘；
- 不迁移原仓库的 `installer/windows`（tray.py 等 Python 附属物随 Python 退役）；
- 不改前端任何源码；不动 `~/.vibe-seller` 数据格式（无 schema 破坏性变更）；
- 不做切流验收（用户已裁决跳过）。

## 8. 文档更新（完成后）

1. `docs/migration-plan.md`：Phase 5 行 ✅ + 摘要；Phase 3 状态注记桥退役。
2. `README.md`：结构（frontend/ vendor 说明）、命令（start/package/smoke）、状态段（Python 已退役、原地升级方式）。
3. `docs/deploy.md` 新建（安装/升级/回退）。
4. `docs/审查记录.md` 追加本 Phase 两轮审查结论。
5. 本 PRD 状态标注。

## 9. 任务拆解与回滚点

| 任务 | 内容 | 依赖 | 回滚点 |
|---|---|---|---|
| 5.1 原生 ToolPort | §3 全部 | 无（Phase 4 完成态基线） | 基线 HEAD |
| 5.2 退役清理 + 补列 + 启动 | §4 全部 | 5.1（mcp.ts 无消费方后才删） | 5.1 提交 |
| 5.3 分发打包 | §5 全部 | 5.2（bundle 入口 = 最终形态） | 5.2 提交 |
