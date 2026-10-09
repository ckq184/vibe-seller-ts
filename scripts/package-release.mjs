// 分发打包（PRD §5.1 Task 5.3）：npm run package 一键产出 release/vibe-seller-ts/。
//
// 步骤：
//   1. vendor 哈希清单校验（零改动红线的机器门禁，改过的前端不许进分发产物）；
//   2. 前端构建：corepack pnpm install --frozen-lockfile + build（产物 vite 默认
//      归位 frontend/dist，同时是 e2e 的 FRONTEND_DIST 默认目标）；
//   3. server bundle：scripts/build-server.mjs → dist/server.mjs（单文件全内联）；
//   4. 组装 release/vibe-seller-ts/：
//      { server.mjs, frontend/（dist 内容）, node/node.exe, start.bat, stop.bat,
//        README-UPGRADE.md, package.json（telemetry 根包定位用） }
//      node.exe：NODE_ZIP env 指定官方 win-x64 zip 则解压嵌入；否则复制本机
//      node.exe 并在 README-UPGRADE 注明版本要求（≥22.5，node:sqlite）。
//
// 全程零新运行时依赖：解压用系统 PowerShell Expand-Archive。
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const frontendDir = join(root, "frontend");
const frontendDist = join(frontendDir, "dist");
const releaseDir = join(root, "release", "vibe-seller-ts");
const step = (msg) => console.log(`[package] ${msg}`);
const die = (msg) => {
  console.error(`[package] ${msg}`);
  process.exit(1);
};

function run(cmd, args, opts = {}) {
  // shell 只给 corepack 用（Windows 上是 .cmd shim，必须经 shell 解析）；shell 模式
  // 拼成单条命令字符串（args 数组 + shell 会触发 DEP0190 弃用告警）。直接 spawn
  // node.exe/绝对路径时禁 shell——路径含空格（C:\Program Files\…）会被截断。
  const command = opts.shell ? [cmd, ...args].join(" ") : cmd;
  const r = spawnSync(command, opts.shell ? [] : args, {
    stdio: "inherit",
    cwd: root,
    ...opts,
  });
  if (r.status !== 0) die(`${cmd} ${args.join(" ")} 失败（exit=${r.status}）`);
}

// ── 1. vendor 校验（清单不一致即中止） ──
step("1/4 vendor 哈希清单校验");
run(process.execPath, [join(root, "scripts", "vendor-frontend.mjs"), "--check"]);

// ── 2. 前端构建（corepack pnpm，锁文件冻结） ──
step("2/4 前端构建（corepack pnpm install --frozen-lockfile + build）");
run("corepack", ["pnpm", "install", "--frozen-lockfile"], { cwd: frontendDir, shell: true });
run("corepack", ["pnpm", "run", "build"], { cwd: frontendDir, shell: true });
if (!existsSync(join(frontendDist, "index.html"))) die(`前端构建产物缺 index.html：${frontendDist}`);

// ── 3. server bundle ──
step("3/4 server bundle（esbuild 单文件全内联）");
run(process.execPath, [join(root, "scripts", "build-server.mjs")]);
const serverBundle = join(root, "dist", "server.mjs");

// ── 4. 组装 release ──
step("4/4 组装 release/vibe-seller-ts/");
try {
  rmSync(releaseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
} catch {
  die(
    `无法清空 ${releaseDir}（EPERM）——旧实例还在运行并占住目录` +
      `（node 的 cwd 锁）。先在 release/vibe-seller-ts 里跑 stop.bat 再打包。`,
  );
}
mkdirSync(join(releaseDir, "node"), { recursive: true });
cpSync(serverBundle, join(releaseDir, "server.mjs"));
cpSync(frontendDist, join(releaseDir, "frontend"), { recursive: true });

// node.exe：NODE_ZIP（官方 win-x64 zip）→ 解压嵌入；否则本机 node.exe 复制。
let nodeSource;
const nodeExe = join(releaseDir, "node", "node.exe");
if (process.env.NODE_ZIP) {
  const zip = process.env.NODE_ZIP;
  if (!existsSync(zip)) die(`NODE_ZIP 指定的 zip 不存在：${zip}`);
  const tmp = mkdtempSync(join(root, "node_modules", ".node-zip-"));
  try {
    run("powershell", [
      "-NoProfile", "-Command",
      `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${tmp}' -Force`,
    ]);
    // 官方 zip 顶层带版本目录（node-vX-win-x64/node.exe），递归找 node.exe
    const findNodeExe = (dir) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isFile() && name === "node.exe") return full;
        if (statSync(full).isDirectory()) {
          const hit = findNodeExe(full);
          if (hit) return hit;
        }
      }
      return null;
    };
    const found = findNodeExe(tmp);
    if (!found) die(`NODE_ZIP 解压后未找到 node.exe：${zip}`);
    cpSync(found, nodeExe);
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  nodeSource = `官方 win-x64 zip（NODE_ZIP=${zip}）解压嵌入`;
} else {
  cpSync(process.execPath, nodeExe);
  nodeSource = `本机开发机 node.exe 复制（${process.version}）`;
}
// 内嵌 node 自检（--version）：spawn 失败时 stdout 为 null，直接 .trim() 会以
// TypeError 炸掉——先显式判空给可行动的报错（zip 损坏/解压不完整最常见）。
const nodeProbe = spawnSync(nodeExe, ["--version"], { encoding: "utf8" });
if (nodeProbe.error || typeof nodeProbe.stdout !== "string") {
  die(
    `内嵌 node.exe 自检失败（--version 无输出）：${nodeExe}` +
      (nodeProbe.error ? ` - ${nodeProbe.error.message}` : "") +
      "——检查嵌入来源（官方 zip 是否完整/本机 node 是否可复制）。",
  );
}
const nodeVersion = nodeProbe.stdout.trim();

// telemetry 根包定位（telemetry/core.ts 逐级向上找 name === "vibe-seller-ts" 的
// package.json；release 树无仓库根，随包放一份安装元数据——等价原 Python
// importlib.metadata 的安装态，version 单一事实源 = 本仓根 package.json）。
const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
writeFileSync(
  join(releaseDir, "package.json"),
  JSON.stringify({ name: rootPkg.name, version: rootPkg.version, private: true }, null, 2) + "\n",
);

// ── start.bat / stop.bat（CRLF；模板内嵌避免 git 换行符改写 bat） ──
// 内容必须纯 ASCII：cmd.exe 按系统 OEM 代码页（本机 GBK）解析 bat，UTF-8 中文
// rem/echo 会被错误断行成"命令"实测炸掉 stop.bat（'Lite'/'p.sh' 不是命令）。
// 睡眠用 `ping -n` 而非 `timeout`：timeout 在无控制台 stdin（脚本/重定向）下报错。
const bat = (s) => s.replace(/\n/g, "\r\n");
writeFileSync(
  join(releaseDir, "start.bat"),
  bat(`@echo off
rem vibe-seller start script (shipped with the release package; generated by npm run package).
setlocal
set "APP_DIR=%~dp0"
if "%VIBE_HOME%"=="" set "VIBE_HOME=%USERPROFILE%\\.vibe-seller"
if not exist "%VIBE_HOME%" mkdir "%VIBE_HOME%"
if "%FRONTEND_DIST%"=="" set "FRONTEND_DIST=%APP_DIR%frontend"
if "%BACKEND_PORT%"=="" set "BACKEND_PORT=7777"
set "PID_FILE=%VIBE_HOME%\\vibe-seller.pid"
if not exist "%APP_DIR%node\\node.exe" (
  echo [start.bat] node\\node.exe not found next to this script.
  exit /b 1
)
if exist "%PID_FILE%" (
  echo [start.bat] already running? pid file exists: %PID_FILE% . Run stop.bat first.
  exit /b 1
)
if not exist "%VIBE_HOME%\\logs" mkdir "%VIBE_HOME%\\logs"
echo [start.bat] starting vibe-seller: VIBE_HOME=%VIBE_HOME% BACKEND_PORT=%BACKEND_PORT%
powershell -NoProfile -Command "$p = Start-Process -FilePath '%APP_DIR%node\\node.exe' -ArgumentList 'server.mjs' -WorkingDirectory '%APP_DIR%' -WindowStyle Hidden -PassThru -RedirectStandardOutput '%VIBE_HOME%\\logs\\server-out.log' -RedirectStandardError '%VIBE_HOME%\\logs\\server-err.log'; $p.Id | Set-Content -Path '%PID_FILE%' -NoNewline -Encoding ascii"
if not exist "%PID_FILE%" (
  echo [start.bat] failed to start - see: %VIBE_HOME%\\logs\\server-err.log
  exit /b 1
)
set /p PID_VALUE=<"%PID_FILE%"
echo [start.bat] started in background, pid=%PID_VALUE%
echo [start.bat] logs: %VIBE_HOME%\\logs\\server-err.log / server-out.log
endlocal
`),
);
writeFileSync(
  join(releaseDir, "stop.bat"),
  bat(`@echo off
rem vibe-seller stop script: kill the pid from the pid file, but only after
rem verifying the pid still belongs to node.exe. Tries a soft taskkill first,
rem then force-terminates after 2s. Windows has no cross-process SIGTERM;
rem SQLite transaction atomicity keeps a hard kill safe - same class as the
rem original stop.sh SIGKILL fallback.
rem PID-REUSE GUARD: a stale pid file may name a pid the OS has reassigned to
rem an unrelated process. tasklist /FI "PID eq %PID%" /FO CSV /NH yields the
rem image name; anything other than node.exe (case-insensitive - including the
rem localized INFO line for a dead pid) means: only remove the pid file, never
rem kill. The guard is re-checked before the force kill.
rem NOTE: echo lines inside if-blocks must NOT contain parentheses - an unescaped
rem closing paren terminates the block at parse time and corrupts the script.
rem System32 tools are referenced by absolute path so a polluted PATH (e.g. Git
rem Bash puttying GNU find first) cannot redirect tasklist/taskkill/find.
setlocal
if "%VIBE_HOME%"=="" set "VIBE_HOME=%USERPROFILE%\\.vibe-seller"
set "PID_FILE=%VIBE_HOME%\\vibe-seller.pid"
if not exist "%PID_FILE%" (
  echo [stop.bat] no pid file: %PID_FILE% - not running.
  exit /b 0
)
for /f %%i in (%PID_FILE%) do set "PID=%%i"
echo [stop.bat] stopping vibe-seller pid=%PID%
call :image_of %PID%
if /i not "%IMAGE%"=="node.exe" (
  echo [stop.bat] pid %PID% is not node.exe - stale or reused pid file. Removing pid file without killing.
  del "%PID_FILE%" >nul 2>&1
  echo [stop.bat] stopped.
  exit /b 0
)
%SystemRoot%\\System32\\taskkill.exe /PID %PID% >nul 2>&1
ping -n 3 127.0.0.1 >nul
call :image_of %PID%
if /i "%IMAGE%"=="node.exe" (
  echo [stop.bat] still alive, force killing...
  %SystemRoot%\\System32\\taskkill.exe /F /PID %PID% >nul 2>&1
  ping -n 2 127.0.0.1 >nul
)
del "%PID_FILE%" >nul 2>&1
call :image_of %PID%
if /i "%IMAGE%"=="node.exe" (
  echo [stop.bat] FAILED to stop pid=%PID%
  exit /b 1
)
echo [stop.bat] stopped.
endlocal
exit /b 0

:image_of
rem Sets IMAGE (quotes stripped) to the image name of pid %1, or "none" when the
rem pid has no process. Compare with if /i - CSV first token keeps original case.
set "IMAGE="
for /f "delims=," %%i in ('%SystemRoot%\\System32\\tasklist.exe /FI "PID eq %~1" /FO CSV /NH 2^>nul') do if not defined IMAGE set "IMAGE=%%i"
if not defined IMAGE set "IMAGE=none"
set IMAGE=%IMAGE:"=%
goto :eof
`),
);

// ── README-UPGRADE.md ──
writeFileSync(
  join(releaseDir, "README-UPGRADE.md"),
  `# vibe-seller（TS 版）分发包

本包是 vibe-seller 的 TypeScript 重写版（Phase 5）：单文件 server bundle + 内嵌
Node 运行时 + 构建好的前端，数据目录与原 Python 版完全同位，支持原地升级。

## 包内容

\`\`\`
vibe-seller-ts/
  server.mjs          # 服务端单文件 bundle（入口 packages/server/src/main.ts）
  frontend/           # 前端构建产物（vendor 源构建，server 只读挂载）
  node/node.exe       # 内嵌 Node 运行时（${nodeVersion}，来源：${nodeSource}）
  start.bat           # 后台启动（pid 文件 + 日志落 $VIBE_HOME/logs）
  stop.bat            # 按 pid 停止（先校验映像名仍是 node.exe 才杀；pid 已被复用/
                      # 进程已换时只清 pid 文件、绝不杀）
  package.json        # 安装元数据（遥测版本号解析用，勿删）
  README-UPGRADE.md   # 本文件
\`\`\`

## 环境要求

- Windows 10+（安装器 Windows-first；Linux/Docker 另批）。
- Node 运行时已内嵌，宿主机无需安装 Node。版本要求 **≥ 22.5**（node:sqlite 首次
  可用版本）；本包内嵌为 ${nodeVersion}。

## 启动 / 停止

\`\`\`bat
start.bat   :: 后台启动；默认 VIBE_HOME=%USERPROFILE%\\.vibe-seller，BACKEND_PORT=7777
stop.bat    :: 按 pid 停止（映像名校验：非 node.exe 的 pid 只清文件不杀，防误杀）
\`\`\`

启动后访问 http://127.0.0.1:7777/ 。服务缺省只绑定 127.0.0.1（BACKEND_HOST 可覆盖；
改绑 0.0.0.0 对局域网开放属用户显式决定）。日志在 %VIBE_HOME%\\logs\\server-err.log /
server-out.log（每次启动覆盖）。pid 文件：%VIBE_HOME%\\vibe-seller.pid。

## 从 Python 版原地升级

数据目录（默认 %USERPROFILE%\\.vibe-seller）不动，只换启动器：

1. 停掉原 Python 版（原仓库 stop.sh / uv tool 环境下的停止方式）；
2. 本包解压到任意目录（路径建议不含空格）；
3. 运行 start.bat——首次 TS 启动自动补齐老库缺列（原 \\_ensure\\_added\\_columns
   14 条全量移植 + 既有 2 条 = 16 列，PRAGMA 守卫幂等）、沿用 jwt_secret /
   install_id / 店铺 / 设置 / 用户（bcrypt 直接验证）。

## 回退

数据目录不动，换回原 Python 启动命令（原仓库 start.sh / uv tool install 的
vibe-seller 入口）即可。数据双向兼容范围 = Phase 4 迁移已逐项钉死的格式清单：
SQLite schema（含 16 条补列 = 14 补列 + 2 既有）、bcrypt 密码哈希、Fernet 加密字段、
jwt_secret、install_id、profiles.json、channels.json、email_dbs、workspace git 仓库。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| VIBE_HOME | %USERPROFILE%\\.vibe-seller | 数据根目录（data/ 子目录放库与密钥） |
| BACKEND_PORT | 7777 | 服务监听端口（绑定地址见下行） |
| BACKEND_HOST | 127.0.0.1 | 服务监听地址，缺省仅 loopback；改绑 0.0.0.0 属用户显式决定（暴露面自担） |
| FRONTEND_DIST | <包>\\\\frontend | 前端静态目录（随包，一般不用改） |
| JWT_SECRET | 无 | 覆盖 JWT 密钥（缺省用 data/jwt_secret 文件，首次启动自动生成） |
| ADMIN_USERNAME / ADMIN_PASSWORD / ADMIN_EMAIL | admin / admin / admin@vibe-seller.local | 首启 admin 种子凭据 |
| VIBE_SELLER_TELEMETRY | 未设 | 设为 0 关闭匿名遥测 |
| VIBE_VERSION | 0.1.0 | 版本号上报覆盖（一般不用设） |
`,
);

console.log(`[package] node.exe：${nodeVersion}（${nodeSource}）`);
console.log(`[package] 完成：${releaseDir}`);
