# 路线 1 前置：真实任务验收启动检查清单

> **文件定位**：`docs/roadmap.md` 路线 1（真实任务验收）的前置侦察结论固化。2026-10-10 由路线 3 执行会话完成侦察并落档，**自包含**——后续任何会话/窗口接手路线 1 时无需重新调查，按本清单执行即可。
> **证据锚**：文中 `文件:行号` 均为落档时 HEAD（`1cb1e43` 一带）的仓库内位置，供复核；行号可能随后续提交漂移，以符号名为准。
> **待用户提供**：① Anthropic Messages 兼容端点的 API key（**必需**，本仓不持有任何 key）；② 真实/测试店铺（可选，可验收时再建）。

---

## 1. 模型 profile 配置

### 主路径：`~/.vibe-seller/profiles.json`（推荐，release 用户主路径）

- 路径：`VIBE_HOME`（默认 `%USERPROFILE%\.vibe-seller`）+ `profiles.json`（`packages/server/src/config.ts:34`、`packages/server/src/profiles/manager.ts:29-31`）。
- 格式示例（GLM）：

```json
{
  "profiles": {
    "glm": {
      "name": "GLM",
      "description": "",
      "load_global_mcp": false,
      "env": {
        "ANTHROPIC_BASE_URL": "https://open.bigmodel.cn/api/anthropic",
        "ANTHROPIC_MODEL": "glm-5.2[1m]",
        "ANTHROPIC_AUTH_TOKEN": "<真实 key>"
      }
    }
  }
}
```

- 派生逻辑 `deriveVibeProfile`（`manager.ts:87-106`）：`ANTHROPIC_BASE_URL` 缺失 → 视为未知 profile，任务报错；模型 id 的 `[1m]` 后缀 = 客户端约定，注册前剥掉并把 contextWindow 放大到 1,000,000（否则 128k）；key 取 `ANTHROPIC_AUTH_TOKEN ?? ANTHROPIC_API_KEY`；maxTokens 固定 8000。
- **key 按原仓库设计明文落盘**（`manager.ts:1-6` 注释），运行时绝不入日志/SSE——但请注意该文件本身的磁盘安全。
- **热更新**：pi bundle 缓存键带 profiles.json 的 mtime（`packages/server/src/agent/engine.ts:72-87`），改文件无需重启。

### 红线：仅支持 Anthropic Messages 兼容端点

- 引擎注册固定 `api: "anthropic-messages"`，baseUrl 后由 SDK 拼 `/v1/messages`（`packages/bridge/src/main.ts:86-102`）。**OpenAI 原生 chat/completions 形状不支持**——保存探针按 Anthropic message 形状裁决，OpenAI 形状会报 "not in Anthropic message format"（`packages/server/src/profiles/validate.ts:63-93`）。
- 内置 preset（仅前端 Settings 页数据，`GET /api/profiles/presets`）：kimi / minimax / glm / glm_intl / deepseek / qwen×4，全部 Anthropic 兼容端点（`packages/server/src/profiles/presets.ts:34-196`；无 stepfun preset，stepfun 只是 env 默认值）。

### 新增 profile 的三条路径

1. UI Settings 页；
2. HTTP：`POST /api/profiles` body `{id, name, env, description?, load_global_mcp?}`，保存前可 `POST /api/profiles/validate` 试探（`routes_profiles.ts:31-57`、`115-120`）；设用户默认 `PATCH /api/profiles/:id/set-default`（L92-113）；
3. 手改 `~/.vibe-seller/profiles.json`（热生效）。

### 备选：default 档走环境变量（仅 profileId=default）

- `VIBE_BRIDGE_API_KEY`（必填）、`VIBE_BRIDGE_BASE_URL`（默认 `https://api.stepfun.com/step_plan`）、`VIBE_BRIDGE_MODEL`（默认 `step-3.7-flash`）、`VIBE_BRIDGE_PROVIDER_ID`（默认 `stepfun`）（`packages/bridge/src/main.ts:33-46`）。
- **两者都不配 → 任务落 failed（`engine_factory_failed`）**（`packages/server/src/agent/orchestrator.ts:171-194`）。

## 2. release 产物现状

- `release/vibe-seller-ts/` = `server.mjs`（12.4MB esbuild 单文件全内联 bundle）+ `frontend/`（vendor 构建产物）+ `node/node.exe`（内嵌运行时 ≥22.5）+ `start.bat`/`stop.bat` + `package.json`（遥测版本定位）。
- 打包于代码提交 `3cd7e45`；此后提交为 docs 与 **dev 侧门禁脚本**（`scripts/check-scope.mjs`、`scripts/verify.mjs`、vitest include、根 package.json 的 verify 项），均不进 server bundle，**运行时等价**。需要产物严格等于 HEAD 时可选 `npm run package` 重打包（数分钟）。
- 启动：release 目录内 `start.bat` → 后台启动写 `%VIBE_HOME%\vibe-seller.pid`（已存在则拒绝重复启动）；日志 `%VIBE_HOME%\logs\server-{out,err}.log`；缺省只绑 `127.0.0.1:7777`（`config.ts:44`）。收尾 `stop.bat`（杀前 tasklist 校验 node.exe 防误杀）。
- **勿与仓库内 `npm start` 双实例混用**（同库同路径）。
- `~/.vibe-seller` 现状（2026-10-10）：仅 `data/jwt_secret`（服务曾初始化过）；无 profiles.json / vibe_seller.db / stores——首次启动自动建库 + 种子 admin 用户 + 补齐目录。

## 3. 闸门白名单（真实店铺验收前建议配置）

- 启动 env `VIBE_BRIDGE_GATED_TOOLS=<逗号分隔工具名>`（`packages/bridge/src/main.ts:41` + `gatePolicyFor` L133-141）；**不设 = 无任何工具被拦截，agent 直接执行**。
- 路线 1 完成条件 ③ 要求"一次确认闸门的人工批准/拒绝真实交互"，因此至少要把一个写操作类工具放进名单再启动。

## 4. 免启动自检（可选前置）

```bash
VIBE_SMOKE_API_KEY=... npx vitest run real-provider   # 仓库内运行,不依赖 release
```

- 位置：`packages/adapters-pi/test/real-provider.smoke.test.ts:40`（`describe.skipIf(!apiKey)`，全套件唯一按需跳过处）。
- 可选 env：`VIBE_SMOKE_BASE_URL`（默认 `https://api.stepfun.com/step_plan`）、`VIBE_SMOKE_MODEL`（默认 `step-3.7-flash`）。key 只走环境变量，不落盘。
- 用例 1：真实模型 × 真实工具链（noon 报表 list/download，断言 tool_started/completed、usage、RunLog 回放）；用例 2：真实模型 × 确认闸门（`update_price` 被拦 → `awaiting_human` → resume(approved) 后恰好执行一次）。

## 5. 真实任务操作序列（HTTP；UI 页面为等价封装）

1. 浏览器开 `http://127.0.0.1:7777/`，`admin`/`admin` 登录（`ADMIN_PASSWORD` 可覆盖，`config.ts:46-48`）；
2. 建店（可选）：`POST /api/stores {"name":"test-store"}`（`routes_tasks.ts:240-300`）——`stores/<slug>/` 档案桩（STORE.md/notes.md/logistics.md/CATALOG.md 桩）自动生成（`workspace/manager.ts:376-414`）；可再手补 `STORE.md` 店铺知识；建店不拉浏览器；
3. 建任务：`POST /api/tasks`（`routes_tasks.ts:439-524`）body `{store_id?, title(必填), description?, plan_mode?, profile_id?, defer_start?}`；无 store 任务恒 plan-only；`task_created` 事件先于 HTTP 返回（SSE 契约）；
4. 启动：`POST /api/tasks/:task_id/start`（L592-612；并发饱和 409）；
5. 观察事件：`GET /api/sse`（`app.ts:531-549`，免认证广播，30s ping）或 UI 会话页；
6. 闸门批复：`GET /api/tasks/:id/questions/pending` → `{pending, request_id, questions:[{kind:"tool_approval"}]}` → `POST /api/tasks/:id/questions/answer` body `{request_id, answers}`（L728-746）；`approved:false` 即拒绝；
7. 终局：SSE `task_update status=completed`；收尾 `stop.bat`。

可选项：`VIBE_SELLER_TELEMETRY=0` 关遥测。

## 6. 完成条件（roadmap 路线 1 原文）

- 至少 3 类真实任务各跑通一次：① 无店铺的 plan-only/设计任务；② 单店铺数据任务（email/wecom/workspace 类工具真实触发）；③ 一次确认闸门的人工批准/拒绝真实交互。
- 产出一份《真实任务验收记录》追加到 `docs/审查记录.md`。
- 交付按工作流：验收产生的文档变更用门禁自查 `npm run verify -- --scope "docs/**" --base <回滚点>`。
