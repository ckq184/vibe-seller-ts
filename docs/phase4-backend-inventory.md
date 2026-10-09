# vibe-seller 原后端表面积盘点（Phase 4 基线，2026-09-24）

> 参考实现：`_reference/vibe-seller-src`（FastAPI + SQLAlchemy(async) + aiosqlite + APScheduler + sse-starlette）。
> 本文是移植的契约基准：路由/表/SSE/auth 全部以此为对齐目标。

**总量**：routers 目录 31 个 .py 文件，其中 28 个含路由，共 **176 个端点**；`app/main.py` 直定义 3 个（`/api/health`、`/api/version`、`/api/plugins`）。**端点总计 179**。数据库 **19 张表**（SQLAlchemy）+ 每邮箱账户 1 个独立 SQLite 文件。

## 1. 完整路由清单

### main.py（无 prefix）
| 方法 | 路径 | 响应 |
|---|---|---|
| GET | /api/health | `{status:'ok', version}` |
| GET | /api/version | `{version}` |
| GET | /api/plugins | `[]`（OSS） |

### /api/auth（8）
| 方法 | 路径 | 认证 | 响应 |
|---|---|---|---|
| GET | /api/auth/status | 免 | `{auth_required: bool}` |
| POST | /api/auth/login | 免 | `{id,username,email,role,default_profile_id,debug_mode,plan_mode_default,sync_profile_to_schedules}` + Set-Cookie；identifier 含 @ 走 email 否则 username 小写；ai_bot 拒绝；401 `{detail:'Invalid credentials'}` |
| POST | /api/auth/refresh | 是 | `{ok:true}` + 滚动续期 cookie（24h） |
| POST | /api/auth/logout | 免 | `{ok:true}`（删 cookie） |
| GET | /api/auth/me | 是 | UserResponse |
| PATCH | /api/auth/me/debug-mode | 是 | `{ok, debug_mode}` |
| PATCH | /api/auth/me/password | 是 | `{ok:true}` |
| PATCH | /api/auth/me/profile | 是 | `{ok:true}` |

UserResponse：`id, username, email, role, is_active, avatar_url, plan_mode_default, debug_mode, default_profile_id, sync_profile_to_schedules, created_at`。

### /api/settings（5）
| 方法 | 路径 | 响应 |
|---|---|---|
| GET | /api/settings | settings dict：`auth_required, browser_headless, max_agent_concurrency, default_schedule_phase_mode, default_schedule_timezone, telemetry_enabled, skills_auto_sync_enabled, task_retention_days, max_upload_size, install_id`（缺省回填：并发=env 默认 2、时区=服务器时区、telemetry='true'、headless='false'、skills_sync='true'、retention='30'、max_upload_size='104857600'） |
| PUT | /api/settings | admin；bool 归一 true/false、int 钳制（并发 1-10、retention 0-3650）、phase_mode 枚举、未知键忽略 |
| GET | /api/settings/google-workspace/status | gws 状态 dict |
| POST | /api/settings/google-workspace/enable | `{ok, installed, count, subskills}` |
| POST | /api/settings/google-workspace/disable | `{ok, removed}` |

（首批只移植 GET/PUT；gws 三个属 workspace 批次。）

### /api/users（4，全 admin）
list / create(`UserCreate{username,email?,password,role='member'}`) / update(`PUT /{id}`) / delete。非 admin → 403 `{detail:'Admin access required'}`。

### /api/stores（7）
list(按最近任务排序) / create(`StoreCreate{name,browser_backend='chrome',browser_config={},platforms,countries,platform_countries,…}`) / update / get / delete(`?delete_files=`) / bookmarks / `POST /{id}/browser/start?force=`。StoreResponse：`id,name,browser_backend,browser_config,ziniao_account_id,browser_oauth,platforms,countries,platform_countries,created_at,updated_at`。

### /api/tasks（tasks.py 13 + conversation 5 + files 7 + schedule_state 4 + ad_declaration 2 = 31）
- tasks.py：list(`?store_id=&parent_task_id=&include_archived=`，store_id 可 `__none__`) / create(`TaskCreate{store_id?,parent_task_id?,title,description?,platform?,country?,plan_mode?,skip_reflection?,profile_id?,schedule_id?,defer_start=false}`，emit task_created) / get / delete(运行中 409) / start / steps / `agent/start`(409 已跑) / design / `review-plan`(PATCH) / execute-plan / `agent/stop` / result(MCP) / wake。
- TaskResponse 字段全集：`id, parent_task_id, store_id, schedule_id, title, description, platform, country, status, plan, plan_history, result, submitted_result, review_gaps, submission_count, todos, error, error_category, wait_condition, batch_id, plan_mode, is_plan_only, ai_profile_id, session_id, started_at, completed_at, created_by_name, created_at, updated_at`。
- conversation：`POST messages`(`{content,attachment_ids?,profile_id?}`) / `GET questions/pending`(`{pending:false}` 或 `{pending,request_id,questions}`) / `POST questions/answer` / `POST retry` / `GET messages`（排除 delta/thinking_delta）。
- files：list / files-zip / download(拒点文件/.claude/symlink) / staged(multipart) / staged get / staged delete / error(MCP)。
- schedule_state：register-finalize / schedule-state GET/PUT（key 校验 `[A-Za-z0-9_.-]{1,64}`，email_watermark epoch±90d）/ new-emails。
- ad_declaration：list / declare（409 同 turn 重声明）。

### 其他路由组（后续批次移植）
- /api/telemetry/locale（1，免认证）
- browser（3）：ziniao launcher / web browser start / aux start
- /api/sse（1，免认证）
- /api/events（13）：CRUD + 状态机 + activities + backends
- /api/screenshots/{id}（1）
- /api/attachments（3）
- /api/workspace（19）：tree/structured/file CRUD/skills CRUD/skill save/store-profile/git 历史/knowledge sync/skills sync
- /api/channels（7）
- /api/cron（5）
- /api/schedules（11）：ScheduleResponse 28 字段；plan_version 乐观锁（412）；trigger 409 plan 未 ready
- /api/ziniao-accounts（6）
- /api/email-accounts（16 + poll 1）
- /api/profiles（7）
- /api/dida365（7）
- /api/workspace/assistant（3）
- /api/wecom-bots（8）
- /api/system（2）：info / update-check
- vision（7）：config / image generate（阻塞等确认）/ confirm / pending / upload-reference / ref-proxy（SSRF 防护）

## 2. 数据库（19 表，SQLite，无 Alembic——boot 时 create_all + PRAGMA-guarded ALTER）

主键几乎全为 `id TEXT PK (uuid4)`；`created_at/updated_at` 为 ISO-8601 UTC 字符串。

| 表 | 要点 |
|---|---|
| app_settings | `key TEXT PK, value TEXT NOT NULL` |
| users | `id PK, username UNIQUE NOT NULL, email UNIQUE NULL, password_hash NOT NULL(bcrypt), role NOT NULL default 'member', is_active NOT NULL default 1, avatar_url, plan_mode_default default 0, debug_mode default 0, default_profile_id VARCHAR(50) default 'default', sync_profile_to_schedules default 0, created_at, updated_at` |
| stores | `id PK, name NOT NULL, browser_backend default 'chrome', browser_config(JSON), ziniao_account_id, browser_oauth, platforms(JSON), countries(JSON), platform_countries(JSON), capabilities(JSON), config, created_at, updated_at` |
| schedules | 28 列；`plan_version NOT NULL default 0`；FK store_id/created_by |
| schedule_state | 复合 PK `(schedule_id, store_id, key)`；`updated_by_task_id → tasks SET NULL` |
| tasks | 30+ 列；status 状态机(pending/queued/designing/planned/running/waiting/completed/failed)；`transcript_tail`（prose 永不自动成为 result）；FK parent/store/schedule/created_by |
| task_steps | task_id/step_index/name/action_type/status/screenshot_id |
| task_messages | `task_id(indexed 无 FK), role, content, seq, profile_id`；role ∈ user/assistant/system/tool_use/result/delta/thinking/thinking_delta/generated_image/agent_event |
| task_logs | task_id/log_type/content/timestamp_ms |
| task_attachments | task_id/file_name/file_path/file_type/file_size |
| screenshots | task_id/step_id/file_path/thumbnail_path |
| ad_task_declarations | task_id/seq/kind/scope(JSON append-only)/user_turn |
| ziniao_accounts | username/password(Fernet, key=JWT_SECRET)/socket_port/client_path |
| events | status 状态机(draft/open/in_progress/waiting/resolved/closed/dismissed)；assignees(JSON) |
| event_activities | event_id/user_id/actor_type/action/content/extra_data(JSON) |
| email_accounts | email UNIQUE/encrypted_password(Fernet)/imap_*/smtp_* |
| store_email_links | UNIQUE(store_id,email_account_id)；seen_message_ids(JSON) |
| wecom_bots | name/webhook_url/created_by |
| browser_sessions | store_id UNIQUE/cdp_port/proxy_*/chrome_pid/status |

注意：SQLAlchemy 的 Python 侧 default 不进 DDL——create_all 的表没有 DEFAULT 子句；外键约束在 DDL 里存在但 SQLite 默认不启用 `PRAGMA foreign_keys`（原实现也未启用），TS 侧保持一致（不开 FK 强制）。

## 3. 认证

- Cookie `auth_token`：HttpOnly、SameSite=lax、max_age=86400；`/api/auth/refresh` 滚动续期。
- JWT HS256，payload `{sub, role, exp}`（exp=epoch 秒）；交互 24h，服务令牌 7 天。
- 密钥：`$JWT_SECRET` 或 `data/jwt_secret`（token_urlsafe(48)，0600）。
- 无 cookie 回退 `Authorization: Bearer`。
- 开关：`app_settings.auth_required ∈ ('true','1')`（首启种子 **'true'**）。
- `get_current_user` 判定树：带 token 且有效+active → 该用户；带 token 但无效/过期/用户没了 → auth_on 时 401 'Invalid token'，否则落到默认 admin；无 token → auth_on 401 'Not authenticated'，否则 DEFAULT_USER_ID。
- 种子：DEFAULT_USER_ID=`…0001`（admin，env ADMIN_USERNAME/EMAIL/PASSWORD，每次启动重置凭据）；AI_BOT_USER_ID=`…0002`（不可登录、不可被 admin API 改删）。
- 密码 bcrypt（72 字节截断）；邮箱/紫鸟密码 Fernet（key=JWT_SECRET）。
- 免认证端点：auth/status、login、logout、health、version、plugins、sse、system/info、system/update-check、settings(GET)、telemetry/locale、dida365/callback、ziniao/launcher。

## 4. SSE 契约

`GET /api/sse`（免认证）广播；每条 `data: {"type":…,…}`（无自定义 event 名）；空闲 30s `{"type":"ping"}`。前端单例 EventSource + `JSON.parse(e.data)` 按 `type` 分发。

事件全集（26 + ping）：task_created{task_id,store_id,task}；task_update{task_id,status,error?,plan?}；task_message{task_id,role,content}；task_todos{task_id,todos}；task_questions{task_id,request_id,questions}；task_question_interrupted；agent_done{task_id,return_code,mode,interrupted?}；task_failed{task_id,error,error_category}；schedule_triggered；schedule_skipped；schedule_waiting_cancelled；fanout_triggered；fanout_finalize_triggered；schedule_plan_ready；schedule_plan_timeout；schedule_plan_stale；event_created；event_updated；event_activity；image_request；image_request_expired；image_request_interrupted；image_generating；image_generated；ws_assistant_message；ws_assistant_done。前端还监听 task_steps_created/step_update/task_log（遗留契约，后端已无 emit 点）。

## 5. 静态资源与上传

- FRONTEND_DIST：dev `frontend/dist/`（有 index.html）→ 打包 `app/static/`；`mount('/', html=True)` + SPA fallback（非 api/ 前缀 404 回 index.html）。
- CORS：FRONTEND_URL + localhost/127.0.0.1:5173 + 本端口，allow_credentials。
- 上传：≤100MB（流式计数 413），仅 png/jpeg/gif/webp/pdf；附件入 `~/.vibe-seller/tasks/<id>/uploads/`；聊天暂存 `chat_staging/<task_id>/<32hex>/`（24h TTL）；vision 参考图 tasks/<id>/generated_images/refs/。

## 6. 后台任务与调度（lifespan）

init_db（种子 auth_required='true'、admin 每次启动重置凭据、ai_bot、系统 catalog schedule）→ 插件 → 持久化设置应用 → 浏览器会话清理 → APScheduler（7 个周期作业：waiting_checker 15m、email_sync 5m、plan_reaper 5m、stall_reaper 1m、finalize_reaper 1m、idle_browser_sweeper 1m、task_cleanup 每日 03:30）→ schedule 作业重建 → dida365 token → task_queue（per-store FIFO + 全局并发）→ workspace/knowledge/skills sync → daemon reaper(300s)。关闭：停队列/scheduler、agent_manager.stop_all()。

调度模型：Schedule（minutes/hours/days→Interval，weekly/monthly→Cron）到点 fanout（每 active store 一 task 共享 batch_id）或 single；plan-mode 先 plan-only task 产计划（plan_status none→planning→ready/failed + plan_version 乐观锁）；waiting 轮询唤醒；stall/plan/finalize reaper 兜底。

## 7. 配置与路径

`VIBE_HOME`(默认 ~/.vibe-seller)；`data/`（vibe_seller.db、jwt_secret、screenshots、attachments、email_dbs）；`BACKEND_PORT` 默认 7777；`tasks/`、`chat_staging/`、`downloads/`、`bin/`、`r/`、`bh-tmp/`、`stores/<slug>/`、`browser_profiles/`、`config/channels.json`；ADMIN_EMAIL=admin@vibe-seller.local、ADMIN_PASSWORD=admin；MAX_AGENT_CONCURRENCY 默认 2；版本 setuptools-scm（无安装时 `0.0.0+dev`）。

## Phase 4 批次划分（按依赖与风险排序）

| 批次 | 内容 | 状态 |
|---|---|---|
| 4.1 地基 | Hono + node:sqlite + JWT/cookie/bcrypt（与现有 DB 兼容）+ SSE 总线 + SPA 托管 + 首批端点（health/version/plugins/system/auth/settings/users/telemetry/sse = 21 端点）+ 契约测试 16 例（含 Python bcrypt 哈希跨语言验证钉子） | ✅ |
| 4.2 任务 CRUD | stores(7) + tasks(13) + TaskResponse/TaskCreate 契约 + task_messages 读 | ✅（DB 面 13 端点：stores 5 + bookmarks/browser/start 留 4.6、tasks 6 + 消息读 + pending questions 空响应；agent 执行类 10 端点 501 占位，批次 4.3 接管。任务状态机 TRANSITIONS 逐字移植。扩展 DDL：stores/tasks/task_steps/task_messages/task_logs/task_attachments/ad_task_declarations/schedules/events/event_activities/browser_sessions/store_email_links，删除流依赖表先建避免 no such table） |
| 4.3 会话编排 | agent 执行接入 @vibe/runtime（进程内复用 @vibe/bridge：translator/MCP 客户端/profiles）；TaskOrchestrator（per-store FIFO + 全局并发 + 排水）；outcome 裁决移植（accepted>submitted>prose>FAILED，INCOMPLETE 也算完成，agent 自报错误降级 caveat）；10 个 agent 端点 + result/error MCP 入口全部点亮；conversation 的 result/error 已含，schedule-state/ad-declaration/new-emails 留 4.4；门问答走 runtime.resume 活挂起。测试：脚本引擎 e2e 7 例（启动→事件→落库→裁决、门批准/拒绝、stop→stopped_by_user、retry 清 run 状态、follow-up、engine_factory_failed 守卫） | ✅ |
| 4.4 调度 | schedules(11) + cron(5) + 规划生命周期 + schedule-state/register-finalize/ad-declaration MCP 入口 + 调度器（触发器数学/七系统作业/启动恢复）+ reapers（waiting/plan/stall/finalize/cleanup） | ✅（`schedule/triggers.ts` 移植 build_trigger 六种语义 + APScheduler cron 解析（dom/dow 受限 OR、`*`=null 不受限、dow Mon=0..Sun=6、7 归一）；interval 网格锚在 schedule.created_at 重启不漂移；`VibeScheduler`（max_instances=1+coalesce：在跑跳过、next_run 先置防自旋）+ startScheduler（7 系统作业，email_sync/idle_browser_sweeper 为 4.6 占位）+ recoverTasksFromDb（accepted_result→COMPLETED 传输断≠失败、其余 server_restart、queued/pending/调度 PLANNED 重排队、浏览器会话复位 idle）；fire 路径 store/fanout/single + cancelPriorWaiting（WAITING 被下一发取消 superseded_by_next_fire）；规划生命周期 spawn/abort/replan 幂等 + prompt 规范化比较→stale + plan_version 乐观锁 412 + plan_mode 不可变 400 + 发闸 409；orchestrator 新增 design→plan 落库（plan_history+task.plan，fanout 违禁结构→plan_invalid 失败）、plan-only 提交即 ready（schedule.plan/plan_version+1/清指针/schedule_plan_ready）、messages 跟进按原 plan_phase_active 判定树分流、stop 对挂起 run 直接终局 + settle 闸门锁存不变量（gateHeld 在 human_input_requested 时刻锁存，stopRequested 跟随补终局）、resume 前等 prev.done（RunLog 单写者）+ resume 同步 throw 兜底 FAILED；schedule_state 表 DDL + schedules 补 plan_mode/ai_profile_id 列；deleteTaskCascade 子树级联替换单任务删除；测试 +43 例（triggers 19/schedules 15/reapers 9+2）。**收敛性简化**：two_phase 的 L2 不做 catalog staleness 检查（knowledge_sync 属 4.5）；fanout 提交保守串行 per-store（RUN_IN_NEW_TAB 国家冲突维度属浏览器层 4.6）；email 策略匹配与水位下限（_email_watermark_floor）挂起至 4.6（无 email_accounts 表时恒走通用 KV 语义，与原实现无账户分支一致）；telemetry 未接（4.7） |
| 4.5 workspace | workspace(19) + profiles(7) + assistant(3) | ✅（`workspace/manager.ts` 移植 WorkspaceManager+SkillsMixin（git 自托管：ensure_init/文件 CRUD/L1 只读/skills lockfile/store-profile/structured 五段视图；git 历史 history/version/reset 走 git 子进程锁内串行；venv 构建属 CLI 世界不移植）；`workspace/catalog.ts` CATALOG 桩契约写边界强制（有内容文件标 Empty/stub → 400）；`workspace/storeData.ts` 布局迁移+结构化店铺条目+store_slug+写一次模板；`workspace/sync.ts` knowledge/skills 远端同步（MANIFEST+逐文件下载+失败 meta/system event；本地包缺位诚实 `synced:false`——TS 无 pip 源树；boot 冷却门控同步，commitApiBase/fetch 可注入）；`profiles/manager.ts` ProfileManager 原格式 `~/.vibe-seller/profiles.json`（原地升级兼容）+ `deriveVibeProfile` 内存派生 pi profile（剥 `[1m]` 放大窗口、密钥仅内存）；`profiles/presets.ts` 9 供应商预设+models 目录原样；`profiles/validate.ts` 保存探针（env→header 认证映射镜像、`[1m]` 剥离、恒 200 ok 裁决）；`workspace/assistant.ts` 每用户会话 SSE（ws_assistant_message/done，无闸门=bypassPermissions 等价，多轮排队+fresh-run+history 交接）；`external_config` no-op（`~/.claude` 覆盖路径在 TS 运行时不存在，已记录）；引擎工厂双源 profile 解析（桥 api_key_env 优先 → UI env 派生），bundle 缓存按 profiles.json mtime。测试 +25 例（workspace 16/profiles 9），全量 176 过，Python 10/10） |
| 4.6 外围 | email(17) + channels(7) + wecom(8) + events(13) + dida365(7) + ziniao/browser(9) + vision/screenshots/attachments(11) | ✅（Fernet 纯 node:crypto 双向互操作钉子（email/紫鸟/dida365 凭据原地升级兼容）；最小自研 IMAP/SMTP 客户端（连接层可注入）+ 最小 MIME 解析 + per-account SQLite（received_epoch epoch 轴，TEXT-date 泄漏教训钉死）；sync-now 30s 冷却 + 链接 poll 60s 冷却 + seen_ids 截尾；channels 注册表 + 进程内 Map + poll→LLM 事件抽取→Event 落库/SSE（extractor 实况是 Anthropic 调用非纯规则，已按参考移植并注释）；wecom 列表打码/单查全量 + send-file 白名单（/tmp、/private/tmp、downloads）+ URL 永不回显；events 7 态状态机逐字 + backends（google_calendar 按 ImportError 语义抛错桩）；dida365 OAuth 单次 state/两套 URL/token Fernet/401→refresh→重试（setup-mcp 的 uv venv 环节按不迁移外部化）；ziniao HTTP 请求面 + credentials_error 结构化 400 + 新终端登录/-10003 结构化映射 + restart 409 守卫；BrowserStarter 外部进程托管（spawn Chrome + browser_sessions 推进 + 启动锁 BrowserBusyError→503——PRD 写 409 参考是 503 从参考）；vision 确认闸门（image_request 阻塞等 confirm/superseded/interrupted，单任务单挂起）+ kie.ai 客户端（按分辨率档轮询预算 + GenerationTimeout 句柄续收 + VISION_FAKE）+ ref-proxy SSRF（DNS 全地址判私网 + 重定向逐跳复检）；遗留收回：stores bookmarks/browser-start、gws 3 端点（auth status JSON 判 usable + 原子换入）、email 水位下限 + new-emails（floor SQL MAX 原子单调）、调度器 email_sync/idle_browser_sweeper 接入。测试 +75 例，全量 251 过连跑 3 轮全绿，零新增运行时依赖） |
| 4.7 验收 | 录制流量回放契约测试 + 前端零改动 e2e + telemetry 收尾（切流验收用户指定延后） | ✅（telemetry：PostHog 最小 fetch 传输零新依赖 + 门控链四门 + ~20 事件接同语义点 + locale 422 对齐 + settings GET 补 install_id/env 门；录制回放：record_replay_fixture.py 真 FastAPI 录 157 步（19 家族成功+错误形状，401/403/404/409/412/422 全有）→ fixture 入库，TS 回放逐请求比对零 Python 依赖，归一化 10 规则 + TZ 钉死 + 篡改变红验证，**对证修正 19 处契约偏差**（users 判定树/username 422/跨列唯一性、locale 422、CRLF 写盘、cron trigger 形状、storeSlug、ai_bot 种子等）；前端 e2e：npm run e2e（playwright 仅 devDep + 系统 Chrome）原 React dist sha256 零改动 5 用例（SPA/登录/数据/设置/SSE），顺带修 SPA 前缀守卫正斜杠白屏；双重审查后整改。测试 322+2skip，e2e 5 过） |
