# 批次 4.6 PRD：外围端点移植（email / channels / wecom / events / dida365 / ziniao / browser / vision）

> 本文档是批次 4.6 的自足交接文档：目标、范围、参考实现地图、已预裁决的语义决定、落地约定与验收标准。
> 面向一个**全新会话窗口**执行，不依赖本文档之外的会话记忆。参考代码库与本仓库路径见 §2。

---

## 1. 背景与任务

项目：`D:\CKQ\workplace\vibe-seller-ts` —— vibe-seller（跨境卖家 AI 自动化框架，原 Python FastAPI 后端）向 pi Agent SDK 架构的 TypeScript 迁移，绞杀者模式逐模块替换。**当前进度：Phase 4 批次 4.1–4.5 已完成**（`packages/server` = `@vibe/server`：Hono + node:sqlite，与原库同一 `vibe_seller.db` 原地共存；JWT/bcrypt 与 Python 逐字节兼容；SSE 总线契约一致；179 端点中已移植 21+13+10+16+29 = 见 `docs/migration-plan.md` 状态表）。

**本批任务 = Phase 4 批次 4.6「外围」**，外加前四批显式延后到 4.6 的遗留项（§3 末）。完成本批后 Phase 4 仅剩 4.7（验收：录制流量回放 + 前端零改动 e2e + 切流验收，用户指定延后）。

工作方式沿用前批（务必先读）：

1. **先通读参考实现再动手**，逐端点对齐契约；错误形状恒 `{"detail": "..."}`（FastAPI HTTPException）；
2. 契约测试用 Hono `app.request()` 直测（不占端口），形状按 `docs/phase4-backend-inventory.md` 钉死；
3. 每个语义决定在代码注释里写明"对应原实现何处、有何差异、为何"；
4. 完成后更新三份文档（§7）。

## 2. 路径与命令

| 项 | 路径 |
|---|---|
| 本仓库（TS） | `D:\CKQ\workplace\vibe-seller-ts` |
| 参考实现（Python，只读） | `D:\CKQ\workplace\_reference\vibe-seller-src\app\` |
| 契约基准 | `docs/phase4-backend-inventory.md`（§1 路由清单、§2 表、§3 auth、§4 SSE） |
| 迁移状态与红线 | `docs/migration-plan.md` |
| 前批同构模块（照抄模式） | `packages/server/src/workspace/`、`profiles/`、`routes_tasks.ts`、`routes_schedules.ts`、`agent/orchestrator.ts` |

命令：`npm run typecheck`；`npx vitest run`（全仓）；`npm run bridge:build` 后 `python python/test_ts_agent_backend.py`（跨语言，改动 packages/bridge 时必跑）。

环境：Windows + Git Bash；Node 24（`node:sqlite` 内置）；测试禁真网（外部 HTTP 用本地 `node:http` 假服务器，见 `test/workspace.test.ts` 的 `commitApiBase`/`fetchImpl` 注入模式）。

## 3. 范围：端点清单（76 = 72 + 前批遗留 4）

> 各路由文件全部挂 `Depends(get_current_user)`——**每个端点都必须 `getCurrentUser(c, auth)`**（4.5 曾漏，测试补的）。免认证例外仅 `GET /api/dida365/callback`、`GET /api/ziniao/launcher`（对照原实现装饰器参数）。

### 3.1 email_accounts.py（16 端点，691 行）+ email_polling.py（1，224 行）

| 方法 | 路径 |
|---|---|
| GET | `/api/email-accounts/discover?email=`（IMAP 设置发现） |
| GET | `/api/email-accounts/discover-smtp?email=`（SMTP 设置发现） |
| POST | `/api/email-accounts/test`（未落库配置连通性测试） |
| POST | `/api/email-accounts`（创建；密码 Fernet 加密落库） |
| GET | `/api/email-accounts`（列表） |
| PUT | `/api/email-accounts/{account_id}` |
| DELETE | `/api/email-accounts/{account_id}` |
| POST | `/api/email-accounts/{account_id}/test`（IMAP 连通） |
| POST | `/api/email-accounts/{account_id}/test-smtp` |
| POST | `/api/email-accounts/{account_id}/send`（SMTP 发信） |
| POST | `/api/email-accounts/sync-now`（全账户立即同步） |
| GET | `/api/email-accounts/info-by-store/{store_id}` |
| GET | `/api/email-accounts/{account_id}/links` |
| GET | `/api/stores/{store_id}/emails`（店铺-邮箱链接列表） |
| POST | `/api/stores/{store_id}/emails`（建立链接；`store_email_links` 表 + seen_message_ids JSON） |
| DELETE | `/api/stores/{store_id}/emails/{link_id}` |
| POST | `/api/stores/{store_id}/emails/poll`（email_polling.py：拉新信 + 事件抽取入口） |

### 3.2 其余路由

| 模块 | 文件（行数） | 端点 |
|---|---|---|
| channels（7） | `routers/channels.py`（264） | `GET /api/channels/types`；`POST /api/channels/configure`；`GET /configs`；`GET /active`；`POST /{channel_id}/poll`；`POST /{channel_id}/send`；`DELETE /{channel_id}`。配置持久化 `~/.vibe-seller/config/channels.json` |
| wecom（8） | `routers/wecom_bots.py`（284） | `GET /api/wecom-bots`（webhook URL **打码**）+ `GET /{bot_id}`（完整）+ `POST` + `PUT /{bot_id}` + `DELETE /{bot_id}` + `POST /{bot_id}/test` + `POST /{bot_id}/send` + `POST /{bot_id}/send-file`（文件路径白名单校验，见 §4.4） |
| events（13） | `routers/events.py`（498） | `GET/POST /api/events`；`GET /backends`；`POST /backends/configure`；`GET/PUT /{event_id}`；`POST /{event_id}/status`（状态机见 §4.5）；`POST /{event_id}/confirm`；`GET /{event_id}/activities`（注意是 GET，行 342）；`POST /{event_id}/activities`；`POST /{event_id}/dismiss`；`POST /{event_id}/sync`；`DELETE /{event_id}`。发 SSE `event_created`/`event_updated`/`event_activity` |
| dida365（7） | `routers/dida365_oauth.py`（497） | `GET /api/dida365/status`；`POST /setup-mcp`；`POST /authorize`；`GET /callback`（HTML 响应，免认证，single-use state）；`GET /projects`；`POST /configure`；`DELETE /disconnect`。token Fernet 加密存 `config/channels.json` 同款后端配置（`events_system/syncer.py` 的 load/save_backend_config） |
| ziniao（6） | `routers/ziniao_accounts.py`（304） | `GET/POST /api/ziniao-accounts`；`PUT/DELETE /{account_id}`；`GET /{account_id}/browsers`（调紫鸟客户端本地 HTTP API）；`POST /{account_id}/restart`。密码 Fernet（JWT_SECRET 派生）；解密失败 → 400 `{"detail": "{\"status\": \"credentials_error\"}"}`（结构化，前端 Sidebar 渲染） |
| browser（3） | `routers/browser.py`（97） | `GET /api/ziniao/launcher`（下载 `BASE_DIR/ziniao_webdriver.bat`，免认证）；`POST /api/browser/web/start?force=`；`POST /api/stores/{store_id}/browser/aux/start` |
| vision（7） | `routers/vision.py`（483） | `GET /api/vision/config`（key 打码，任意用户）；`PUT /api/vision/config`（admin）；`POST /api/tasks/{task_id}/image/generate`（MCP 工具入口 + 确认闸门，见 §4.6）；`POST /api/tasks/{task_id}/image/confirm`；`GET /api/tasks/{task_id}/image/pending`；`POST /api/tasks/{task_id}/image/upload-reference`；`GET /api/vision/ref-proxy`（SSRF 防护，见 §4.6） |
| screenshots（1） | `routers/screenshots.py`（27） | `GET /api/screenshots/{screenshot_id}`（文件流） |
| attachments（3） | `routers/attachments.py`（118） | `POST /api/attachments/{task_id}`（multipart；限额见 §5 settings 键）+ `GET /api/attachments/{task_id}` + `GET /api/attachments/file/{attachment_id}` |

### 3.3 前批遗留（本批必须收掉）

1. **stores 2 端点**（4.2 延后）：`GET /api/stores/{store_id}/bookmarks`（读店铺浏览器 profile 的书签文件，`app/browser/bookmarks.py`）+ `POST /api/stores/{store_id}/browser/start?force=`（见 `routers/stores.py:378,395`）。加入 `routes_tasks.ts` 的 stores 段。
2. **settings gws 3 端点**（4.1 延后，`routers/app_settings.py:270,297,351`）：`GET /api/settings/google-workspace/status`、`POST .../enable`、`POST .../disable`。依赖 `workspace/gws_integration.py`（408 行）与 skills sync meta 的 `gws_installed` 标记（TS 侧 `SkillsSyncManager.isGwsInstalled/markGwsInstalled` 已就位）。gws enable/disable 的本体是"把 gws 子技能包复制进工作区/删除"——移植时按 `gws_integration.py` 实测语义走文件操作；若发现依赖 venv/pip 环节，按 venv 不迁移原则剥除并在注释记录。
3. **email 水位下限**（4.4 延后）：`routers/tasks_schedule_state.py` 的 `_email_watermark_floor` / email 策略匹配分支——当时在无 `email_accounts` 表时恒走通用 KV 语义。本批补齐 email 账户面后，把该判定树的 email 分支移植完整。
4. **调度器系统作业**（4.4 占位）：`scheduler/email_sync.py`（5 分钟，信号量并发 3，同步全部账户 IMAP → per-account SQLite）接进 `startScheduler` 的 `email_sync` 占位；`idle_browser_sweeper`（1 分钟）——先读原实现定位（浏览器层），若纯依赖 wrapper 进程状态则按外部进程托管语义移植，发现深耦合 CLI 的部分按不迁移清单记录。

## 4. 关键语义与坑（预裁决，执行时逐条核对参考实现）

### 4.1 Fernet 跨语言互操作（本批最高风险项，先做）

email 密码、紫鸟密码、dida365 token 都用 Fernet 加密落库：`key = urlsafe_b64(sha256(JWT_SECRET))`（`app/utils/crypto.py`，JWT_SECRET 解析规则与 TS `config.ts` 的 `resolveJwtSecret` 一致）。**原地升级后 TS 必须能解 Python 加密的老数据，TS 新写的数据 Python 侧也要能解。**

- 预裁决：在 `packages/server/src/crypto/fernet.ts` 用纯 `node:crypto` 实现 Fernet（格式：`\x80` 版本字节 + 8 字节时间戳大端 + AES-128-CBC（PKCS7，IV 16B）+ HMAC-SHA256(msg)（URL-safe base64）；解密时先常量时间验 HMAC）。Python `cryptography` 的默认轮数 200000 不参与格式，无需 KDF——密钥就是 sha256 派生，直接可用。
- **钉子测试**：用固定 JWT_SECRET，预录 1 条 Python `Fernet.encrypt` 生成的密文（执行会话现场用参考库生成一条即可，写死进测试）验证 TS 解密；TS 加密一条，写一个 10 行 Python 脚本（临时，不进仓库）验证 Python 能解，然后在测试注释里记录向量。加/解密各一条双向钉子。

### 4.2 email：per-account SQLite + 最小 IMAP/SMTP 客户端

- **per-account SQLite**（`app/email/db.py`，350 行）：每邮箱账户一个独立 SQLite 文件（`EMAIL_DBS_DIR = data/email_dbs/`，路径函数 `db_path_for_account` 原样移植），schema SQL 原样抄（注意 `received_epoch` 列的注释：水位游标的轴是 `COALESCE(fetched_at, date)` 的 epoch 秒，绝不能用 ISO 字符串 `date` 比——TEXT vs INTEGER 在 SQLite 里恒真泄漏全表）。TS 用 `node:sqlite` 直接开同一文件，全同步调用（原实现 `asyncio.to_thread` 包裹，TS 无需）。
- **IMAP/SMTP**：Python 用 `imaplib/smtplib`，TS 无内置等价物。预裁决：**自研最小客户端**（`packages/server/src/email/imap.ts` + `smtp.ts`，零依赖，`node:tls`/`node:net`）：
  - IMAP 只实现 `email_poller.py`（522 行）实际用到的命令面（先通读圈定，预计：LOGIN、SELECT（INBOX/文件夹）、SEARCH（UID/未读/日期）、FETCH（UID、FLAGS、BODY[HEADER]、BODY[TEXT]）、STORE/EXPUNGE 若有）、未读/UID 轮询、消息解析（头折叠、multipart/text 提取——`email_poller.py` 里 Python 用 `email` 标准库解析，TS 需要最小 MIME 解析；若过于复杂，text/html 提取按原实现的实际使用面裁剪并记录）。
  - SMTP 最小面：EHLO/STARTTLS/AUTH LOGIN/MAIL FROM/RCPT TO/DATA（对齐 `app/email/sender.py`，151 行）。
  - 连通性测试端点（discover/test/test-smtp）只需连接+握手+登录，最先实现并测通。
  - 若某个深度 MIME 场景（如 base64 附件逐个保存）超出原实现 email 表的实际消费面（`attachments` JSON 列），按消费面裁剪并在注释记录差异。
- **水位与去重**：`store_email_links.seen_message_ids`（JSON）、`email_watermark` epoch 游标、`maybe_seed_sync_state`（`app/scheduler/email_sync.py`）语义逐条移植；schedule_state 的 email 键校验（epoch ±90d 窗口）4.4 已做，本批只接 email 分支。
- **事件抽取链路**：`POST /api/stores/{store_id}/emails/poll` → `channels/email_poller` 拉新信 → `events_system/extractor.py`（72 行，规则抽取）→ event 落库 + `event_created` SSE。extractor 是纯规则，直接移植。

### 4.3 channels 与 wecom

- channels：`BaseChannel/CHANNEL_REGISTRY`（`channels/base.py`，93 行）——注册表 + poll/send 协议；配置落 `config/channels.json`；活动实例是**进程内 Map**（`_active_channels`），TS 同构（模块级 Map）。`auto_create_events` 标志按 channel 存。
- wecom：webhook 是企业微信群机器人 HTTP 回调（`notifiers/wecom.py`，161 行：send_webhook/send_file_webhook，纯 httpx POST）。**列表打码/单查完整**的契约（文件头注释）必须保真。`send-file` 的文件路径白名单：agent 给路径 → 展开 `~`、realpath、必须落在 `downloads/` 或任务 workspace 等已知安全根内（`wecom_bots.py` 文件头有完整说明）→ 否则 400。

### 4.4 events

- 状态机（`routers/events.py` 头部）：`VALID_STATUSES` 7 态 + `VALID_TRANSITIONS`（draft→open/dismissed；open→in_progress/waiting/resolved/closed/dismissed；in_progress→waiting/resolved/closed；waiting→in_progress/resolved/closed；resolved→closed/open；closed→open；dismissed→open）。逐字移植，非法转移 400。
- `assignees` JSON 列、`event_activities` 追加、backends configure（`events_system/syncer.py`，161 行：后端配置读写 + `EVENT_BACKEND_REGISTRY`：dida365 等）。
- `POST /{event_id}/sync` → `event_syncer` 推送外部后端（dida365 用 token 调其 Open API）。测试用本地假后端。

### 4.5 dida365 OAuth

- 单次 state 字典（进程内）、两套服务 URL（dida365/ticktick）、callback 回 HTML、token Fernet 加密进 backend config。
- `setup-mcp`：先通读（行 220-240）。它涉及 clone/安装 `ticktick-mcp`（外部 Node 工具）——**预裁决**：clone/安装环节若走 git+npm 则 shell 调用移植；若走 Python venv（`venv_python`），该环节按 venv 不迁移原则改为直接记录"TS 侧以 npx 方式运行 ticktick-mcp"或诚实 501 + 注释，取决于通读后的实际命令面。status/projects/configure/disconnect 完整移植。
- 免认证的 `/callback` 与其余端点的 auth 分界要对齐。

### 4.6 vision 与 screenshots/attachments

- **generate = MCP 工具入口 + 确认闸门**：无 key → 立即 400（agent 工具调用当场报错）；有 key → 落 `task_messages`（role 按 `claude_backend_utils.get_next_seq` 语义）、发 SSE `image_request`、**阻塞等待**用户 confirm（带可编辑 prompt/model）或取消。TS 等价：进程内 pending Map（request_id → resolver）+ `confirm`/`pending` 端点结算；超时后发 `image_request_expired`（对齐 `app/vision.py` 的过期语义，通读后对齐时长）。确认后调 kie.ai（测试用本地假服务器）、PNG 存 `tasks/<id>/generated_images/`、发 `image_generated`、把路径返回给 agent。取消发 `image_request_interrupted`。
- **ref-proxy 的 SSRF 防护**（`vision.py` + `ai/image_guards.py`，209 行）：解析 URL → 拒绝内网/环回/链路本地地址（ipaddress 判断）、重定向逐跳复检——逐条移植，这是安全红线。
- `upload-reference` 走 `app/uploads.py` 的 save_upload（流式限额 100MB、仅 png/jpeg/gif/webp/pdf、413）。attachments 三端点同款（`chat_staging/<task_id>/<32hex>/` 24h TTL 的暂存语义如果在这三个端点内出现就一并移植；确认参考实现里 staged 文件端点实际在 tasks_files.py——已移植过与否以 `routes_tasks.ts` 现状为准，勿重复实现）。
- screenshots 单端点：按 id 查 `screenshots` 表 → FileResponse 文件流（表已在 4.2 DDL 建）。

### 4.7 browser / ziniao 启动类

- ziniao_accounts CRUD + links 是纯 DB + Fernet，直接移植；`browsers`/`restart` 调紫鸟客户端本地 HTTP API（`browser/ziniao_utils.py`，通读后按实际请求面移植，进程外 HTTP 调用，非源码移植）。
- `browser/web/start`、`aux/start`、`stores/{id}/browser/start`：进程编排（spawn Chrome / 调 wrapper）。预裁决：按"外部进程托管"移植——spawn 参数、`browser_sessions` 表状态推进（表已建）、`BrowserBusyError` 409 语义逐条对齐；wrapper 的 PATH 三层防逃逸等红线属浏览器层自身，不在本批重写，只负责调用面。
- `ziniao/launcher`：读 `BASE_DIR/ziniao_webdriver.bat` 返回文件流；BASE_DIR 对应原仓库根，TS 侧以 `VIBE_TS_ROOT`/环境变量解析（对照 `config.ts` 现有做法），文件缺失 404。

## 5. 通用契约（与前批一致，勿再发明）

- **auth**：全部端点 `getCurrentUser`；admin 门按原实现（vision PUT config、events backends configure 若原实现要求 admin 则 `requireAdmin`，逐个核对）。
- **SSE 事件**：本批新增 emit：`event_created`/`event_updated`/`event_activity`、`image_request`/`image_request_expired`/`image_request_interrupted`/`image_generating`/`image_generated`（26 事件词汇表已定，`bus.emit` 直接用）。
- **DB**：`email_accounts`、`wecom_bots` 表**尚未在 TS DDL 中**——按 `docs/phase4-backend-inventory.md` §2 的列定义加进 `db.ts` ensureSchema（`screenshots`/`events`/`event_activities`/`store_email_links`/`browser_sessions` 已建，查重后补缺）。Python 侧 default 不进 DDL 的约定保持。
- **密码/密钥红线**：秘密永不进事件、日志、trace；日志打码 webhook URL（wecom 列表打码契约）。
- **telemetry.send**：维持 no-op（4.7）。
- **multipart**：`c.req.parseBody()`（Hono）+ 流式大小限制对齐 `max_upload_size` settings 键（默认 104857600）。
- **错误**：`HttpError(status, msg)` → `{"detail"}`；pydantic 422 语义用 422；原实现 `except Exception → 400` 的宽捕获逐个对齐（如 `file/version`）。

## 6. 文件布局建议与测试

```
packages/server/src/
  crypto/fernet.ts          # §4.1，先做 + 双向钉子测试
  email/{imap.ts,smtp.ts,db.ts,sender.ts}   # 最小客户端 + per-account SQLite
  channels/{registry.ts,wecom.ts,emailPoller.ts,discovery.ts}
  events/{syncer.ts,extractor.ts}
  dida365/oauth.ts
  browser/{ziniao.ts,starter.ts}
  vision/vision.ts
  routes_email.ts routes_channels.ts routes_wecom.ts routes_events.ts
  routes_dida365.ts routes_ziniao.ts routes_vision.ts
  （stores 2 端点并入 routes_tasks.ts；gws 3 端点并入 app.ts settings 段）
packages/server/test/
  fernet.test.ts email.test.ts channels.test.ts events.test.ts
  vision.test.ts dida365-ziniao.test.ts
```

测试约定：`app.request` 直测 + `node:http` 本地假服务器（IMAP/SMTP 用真实 `node:tls` 对 `127.0.0.1` 假服务器握手可以，但更稳的做法是：IMAP 客户端把"连接层"抽象成可注入的 duplex 流，测试喂脚本化字节流——参考 `test/workspace.test.ts` 的注入模式与 `packages/adapters-pi/test/fake-anthropic.ts` 的假服务器风格）。每模块一个 describe，端点形状断言到键名级。目标：本批新增 ≥40 例。

**DoD（验收标准）**：
1. `npm run typecheck` 0 错误；
2. 全仓 `npx vitest run` 全绿（现 176 例 + 本批新增），连跑 3 轮无 flaky；
3. Fernet 双向互操作钉子通过（Python 老密文可解）；
4. 本批 76 端点全部点亮（含遗留 4），无 501 占位残留；
5. 三份文档更新（§7）；
6. 不新增任何运行时 npm 依赖（零依赖红线，`node:crypto/tls/net/sqlite` + 既有 hono/bcryptjs/@vibe/*）。

## 7. 完成后文档更新（不可省）

1. `docs/migration-plan.md`：Phase 4 行追加"批次 4.6 已完成"段（仿 4.5 段的密度：模块 → 移植要点 → 差异决定 → 测试数）；
2. `docs/phase4-backend-inventory.md`：批次表 4.6 行 ⬜ → ✅（括号内写实现要点）；
3. `README.md`：结构注释与状态段（批次号、端点数、测试数、下一步 = 4.7）。

## 8. 明确不在本批

- 4.7 验收（录制回放 / 前端 e2e / FastAPI×TsAgentBackend 切流）——用户指定延后；
- telemetry 事件上报本体；
- 浏览器层（wrapper/CDP 代理）源码 TS 化；
- `app/skills/` 冻结技能树与 Python venv 相关环节（gws 安装、ticktick-mcp 的 venv 部分）。
