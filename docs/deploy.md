# 部署文档：安装 / 从 Python 版原地升级 / 回退

> 适用：vibe-seller TypeScript 版（Phase 5 起，Python 运行时已退役）。
> Windows-first（本页安装器为 Windows；Linux/Docker 对齐另批）。

---

## 1. 构建分发包

```bash
npm run package
```

一键执行（`scripts/package-release.mjs`）：

1. vendor 哈希清单校验（`scripts/vendor-frontend.mjs --check`——前端源零改动红线的机器门禁，不一致即中止）；
2. 前端构建：corepack pnpm `install --frozen-lockfile` + `build`（产物归位 `frontend/dist`）；
3. server bundle：esbuild 单文件全内联（`scripts/build-server.mjs` → `dist/server.mjs`）；
4. 组装 `release/vibe-seller-ts/`。

产物结构：

```
release/vibe-seller-ts/
  server.mjs          # 服务端单文件 bundle（入口 packages/server/src/main.ts；
                      #   @vibe/* 与 npm 真依赖全内联，node:sqlite 用运行时内置）
  frontend/           # 前端构建产物（vendor 源构建，server 只读挂载）
  node/node.exe       # 内嵌 Node 运行时（≥22.5；NODE_ZIP 指定官方 win-x64 zip
                      #   则解压嵌入，否则复制本机 node.exe）
  start.bat           # 后台启动（pid 文件 + 日志）
  stop.bat            # 按 pid 停止
  package.json        # 安装元数据（遥测版本号解析用，勿删）
  README-UPGRADE.md   # 包内速览（升级/回退要点）
```

`node.exe` 来源两种（打包脚本自动选择并在 README-UPGRADE 注明）：

- 设 `NODE_ZIP=<官方 node win-x64 zip 路径>` 再打包 → 解压嵌入官方 zip 内的 node.exe；
- 未设 → 复制打包机的 `process.execPath`（本机 node）。

## 2. 安装与启动 / 停止

安装 = 把 `release/vibe-seller-ts/` 整目录放到目标机器任意目录（建议路径不含空格），无需预装 Node。

```bat
start.bat   :: 后台启动
stop.bat    :: 停止
```

- 启动后访问 `http://127.0.0.1:7777/`（端口见下表）。
- pid 文件：`%VIBE_HOME%\vibe-seller.pid`；日志：`%VIBE_HOME%\logs\server-err.log` / `server-out.log`（每次启动覆盖）。
- `start.bat` 幂等保护：pid 文件已存在则拒绝重复启动（先 `stop.bat`）。
- `stop.bat` 先温和 taskkill，2 秒不退则强制终止（Windows 无跨进程 SIGTERM 等价物；SQLite 事务原子性保证强杀数据安全，与原 stop.sh 的 SIGKILL 兜底同级）；无 pid 文件时为 no-op。

开发形态（非分发）：`npm start`（仓库内 esbuild 临时 bundle 后进程内 import，仅本机开发）。

## 3. 从 Python 版原地升级

数据目录（默认 `%USERPROFILE%\.vibe-seller`）不动，只换启动器：

1. 停掉原 Python 版（原仓库 `stop.sh` / uv tool 环境下的停止方式）；
2. 把本包解压/复制到任意目录；
3. 运行 `start.bat`。

首次 TS 启动自动完成（无需手工迁移）：

- 老库补列：原 `_ensure_added_columns` 15 条全量移植（`packages/server/src/db.ts`），PRAGMA 守卫幂等；
- 沿用 `data/jwt_secret`、`data/install_id`、`profiles.json`、`channels.json`、`email_dbs`、workspace git 仓库；
- 用户密码：老 Python bcrypt 哈希直接验证（TS 登录链路 `bcryptjs` 兼容 `$2b$` 哈希）；
- admin 种子凭据沿用 `ADMIN_USERNAME` / `ADMIN_PASSWORD` / `ADMIN_EMAIL` 环境变量语义（与原实现一致）。

升级验收：`npm run package && npm run smoke:package`——场景 A（全新安装五步断言 + start/stop.bat 生命周期）与场景 B（参考仓库 venv 用真 FastAPI lifespan 造老数据 → 同一 VIBE_HOME 换捆绑 TS server → 老凭据登录 / 老店铺 / 老设置 / install_id 不变 / 无 ERROR 日志）全绿。

## 4. 回退

数据目录不动，换回原 Python 启动命令（原仓库 `start.sh` / `uv tool` 安装的 `vibe-seller` 入口）即可。

数据双向兼容范围 = Phase 4 迁移已逐项钉死的格式清单：SQLite schema（含 15 条补列，TS 侧只补列不破坏）、bcrypt 密码哈希、Fernet 加密字段、jwt_secret 文件、install_id、profiles.json、channels.json、email_dbs、workspace git 仓库。

## 5. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `VIBE_HOME` | `%USERPROFILE%\.vibe-seller` | 数据根目录（`data/` 子目录放库、密钥、install_id） |
| `BACKEND_PORT` | `7777` | 服务监听端口（127.0.0.1） |
| `FRONTEND_DIST` | `<包>\frontend` | 前端静态目录（随包，一般不用改） |
| `JWT_SECRET` | 无 | 覆盖 JWT 密钥；缺省用 `data/jwt_secret` 文件（首次启动自动生成，0600） |
| `ADMIN_USERNAME` | `admin` | 首启 admin 种子用户名 |
| `ADMIN_PASSWORD` | `admin` | 首启 admin 种子密码 |
| `ADMIN_EMAIL` | `admin@vibe-seller.local` | 首启 admin 种子邮箱 |
| `VIBE_SELLER_TELEMETRY` | 未设 | 设为 `0` 关闭匿名遥测 |
| `VIBE_VERSION` | `0.0.0+dev` | `/api/version` 上报覆盖（一般不用设；遥测 app_version 取包内 `package.json` 的 `0.1.0`） |
| `NODE_ZIP`（仅打包时） | 无 | 指定官方 node win-x64 zip，解压嵌入 `node/node.exe` |

## 6. 相关脚本速查

| 命令 | 作用 |
|---|---|
| `npm run vendor` | 从参考仓库重新 vendor 前端（唯一合法的前端变更路径） |
| `npm run vendor:check` | 校验 `frontend/` 与哈希清单一致 |
| `npm run build:server` | 仅产出 `dist/server.mjs` bundle |
| `npm run package` | 一键分发包（含 vendor 校验 + 前端构建 + bundle + release 组装） |
| `npm run smoke:package` | 分发包两场景冒烟（需先 `npm run package`；场景 B 需参考仓库 venv） |
| `npm run e2e` | Playwright 前端 e2e（FRONTEND_DIST 默认本仓 `frontend/dist`） |
