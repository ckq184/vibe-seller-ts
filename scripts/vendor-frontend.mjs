// vendor 前端：把参考仓库 frontend/（源码+配置+锁文件，绝不含 node_modules/dist）
// 字节级复制进本仓库 frontend/，并生成 sha256 哈希清单（scripts/frontend-vendor-manifest.json）。
//
// 零改动红线（PRD §5.1/§7 架构决定）：vendor 后本仓也不改 frontend/ —— 需要改前端 =
// 回参考仓库改后重新 vendor。清单是这条红线的机器门禁：
//   - `node scripts/vendor-frontend.mjs --check`：校验本仓 frontend/ 与清单一致（退出码非 0 = 有人改过）；
//   - packages/server/test/frontend-vendor.test.ts 在 vitest 门禁里跑同一校验；
//   - npm run package 组装前强制 --check（改过的前端不允许进分发产物）。
//
// 用法：
//   node scripts/vendor-frontend.mjs            # 复制 + 生成清单 + 自校验
//   node scripts/vendor-frontend.mjs --check    # 仅校验，不复制
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// vendor 唯一来源（Phase 5 PRD §2 钉死的参考实现仓库）；--source 可覆盖（仅备用）。
const sourceArgIdx = process.argv.indexOf("--source");
const source = resolve(
  sourceArgIdx > 0 ? process.argv[sourceArgIdx + 1] : "D:/CKQ/workplace/_reference/vibe-seller-src/frontend",
);
const dest = join(root, "frontend");
const manifestPath = join(root, "scripts", "frontend-vendor-manifest.json");
const EXCLUDED_DIRS = new Set(["node_modules", "dist"]); // 绝不进 vendor：依赖与构建产物

if (!existsSync(join(source, "package.json"))) {
  console.error(`[vendor] 来源不是前端目录（缺 package.json）：${source}`);
  process.exit(1);
}

/** 相对路径（posix 斜杠）→ sha256；跳过排除目录（任意深度）。 */
export function hashTree(dir, relPrefix = "") {
  const files = {};
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const rel = relPrefix ? `${relPrefix}/${name}` : name;
    if (statSync(full).isDirectory()) {
      if (EXCLUDED_DIRS.has(name)) continue;
      Object.assign(files, hashTree(full, rel));
    } else {
      files[rel] = createHash("sha256").update(readFileSync(full)).digest("hex");
    }
  }
  return files;
}

function diff(manifest, actual) {
  const problems = [];
  for (const rel of Object.keys(manifest.files)) {
    if (!(rel in actual)) problems.push(`缺失：${rel}`);
    else if (manifest.files[rel] !== actual[rel]) problems.push(`内容不一致：${rel}`);
  }
  for (const rel of Object.keys(actual)) {
    if (!(rel in manifest.files)) problems.push(`多出（不在清单内）：${rel}`);
  }
  return problems;
}

function check() {
  if (!existsSync(manifestPath)) {
    console.error(`[vendor] 清单不存在：${manifestPath}（先跑不带 --check 的 vendor）`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const actual = hashTree(dest);
  const problems = diff(manifest, actual);
  if (problems.length > 0) {
    console.error(`[vendor] frontend/ 与清单不一致（${problems.length} 处）——零改动红线被破坏：`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error("[vendor] 需要改前端 = 回参考仓库改后重新 vendor（PRD §5.1 架构决定）");
    process.exit(1);
  }
  console.log(`[vendor] check OK：${manifest.fileCount} 个文件与清单逐一 sha256 一致（来源 ${manifest.source}）`);
}

if (process.argv.includes("--check")) {
  check();
} else {
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
  cpSync(source, dest, {
    recursive: true,
    filter: (src) => {
      // cpSync 的 filter 收到每个源路径：排除目录整棵剪掉
      const rel = relative(source, src);
      return !rel.split(sep).some((seg) => EXCLUDED_DIRS.has(seg));
    },
  });
  const files = hashTree(dest);
  const manifest = { source, fileCount: Object.keys(files).length, files };
  // 相对路径 + 排序键 + 2 空格缩进：同源重跑产出字节稳定的清单（diff 友好）
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`[vendor] 复制 ${manifest.fileCount} 个文件：${source} -> ${dest}`);
  console.log(`[vendor] 清单已写：${manifestPath}`);
  check();
}
