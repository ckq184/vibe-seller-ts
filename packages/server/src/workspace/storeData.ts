// workspace 的店铺数据面：布局迁移 + 结构化条目 + slug + 写一次模板。
// 逐条移植 app/workspace/store_data_migrate.py、structured_stores.py、
// store_seed.py、templates.py 与 browser/wrapper.py::store_slug。

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeTextSync } from "./textio";

// ── 写一次模板（templates.py） ──

export const WORKSPACE_CLAUDE_MD =
  "# Vibe Seller Workspace\n\n" +
  "## Symlinked directories\n\n" +
  "`knowledge/`, `stores/` and `store-data/` are symlinks. The Glob and Grep" +
  " tools use ripgrep which cannot follow symlinks; use" +
  ' `Bash("find ...")` / `Bash("grep -r ...")` for them.\n' +
  "- `stores/<slug>/` holds curated store KNOWLEDGE only" +
  " (profiles, notes, rules). Run artifacts (reports," +
  " captures, exports) go to `store-data/<slug>/...` —" +
  " never into `stores/` or `knowledge/`.\n" +
  "- For `.claude/` and other directories: Glob and Grep" +
  " work normally.\n\n" +
  "## browser-use\n\n" +
  "`browser-use` is a Bash CLI tool (v0.13: no subcommands —" +
  " pipe Python helpers via a quoted heredoc, e.g." +
  " `Bash(\"browser-use <<'PY'\\nnew_tab(url)\\nPY\")`).\n" +
  "Run the `browser-use` CLI itself via Bash — do NOT invoke it through" +
  " the Skill tool. (Its syntax reference lives in the `browser-harness`" +
  " skill, which you DO load via `/browser-harness`.)\n\n" +
  "The session and CDP endpoint are managed by the per-store" +
  " wrapper via env (`BU_NAME`, `BU_CDP_WS`); do NOT set them" +
  " or pass `--cdp-url`/`--profile`/`--connect`/`--mcp`" +
  " manually.\n\n" +
  "## Authenticated Pages\n\n" +
  "Pages requiring login or JavaScript (seller center, email" +
  " providers, admin panels) MUST be accessed via" +
  " `browser-use`, not WebFetch or curl.\n";

// ── store_slug（browser/wrapper.py）──
// ASCII-only slug（BU_NAME 约束 [A-Za-z0-9_-]{1,64}）；非中文名 ASCII 归约为空时
// 回退 store-<id 前 8 位>。

export function storeSlug(name: string, storeId?: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/_/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug) return slug;
  if (!storeId) {
    throw new Error(
      `store_slug: name ${JSON.stringify(name)} reduces to an empty ASCII slug and no store_id was provided for fallback`,
    );
  }
  return `store-${storeId.slice(0, 8)}`;
}

// ── store-data 布局迁移（store_data_migrate.py）──

const LAYOUT_VERSION = 1;
const MARKER_NAME = ".store-data-layout-version";
const MONTH_DIR = /^\d{4}-\d{2}$/;
const FILE_DATE = /(20\d{2})[-_]?(\d{2})[-_]?(\d{2})/;
const SKIP_PARTS = new Set([".git", "__pycache__"]);

function fileMonth(name: string): string | null {
  const m = FILE_DATE.exec(name);
  if (!m) return null;
  const [, year, month, day] = m;
  if (!(1 <= Number(month) && Number(month) <= 12 && 1 <= Number(day) && Number(day) <= 31)) return null;
  return `${year}-${month}`;
}

/** stores/<slug>/<subdir>/ → store-data/<slug>/<subdir>/（目标存在则逐文件合并，已有文件获胜）。 */
function relocateStoreSubdirs(root: string, moved: string[]): void {
  const stores = join(root, "stores");
  if (!existsSync(stores)) return;
  for (const slugDir of readdirSync(stores)) {
    const slugPath = join(stores, slugDir);
    if (!statSync(slugPath).isDirectory() || slugDir.startsWith(".")) continue;
    for (const sub of readdirSync(slugPath)) {
      const subPath = join(slugPath, sub);
      if (!statSync(subPath).isDirectory() || SKIP_PARTS.has(sub)) continue;
      const dest = join(root, "store-data", slugDir, sub);
      if (existsSync(dest)) {
        mergeTree(subPath, dest);
        rmSync(subPath, { recursive: true, force: true });
      } else {
        mkdirSync(join(root, "store-data", slugDir), { recursive: true });
        renameSync(subPath, dest);
      }
      moved.push(`${join("stores", slugDir, sub)} -> ${join("store-data", slugDir, sub)}`);
    }
  }
}

function mergeTree(src: string, dest: string): void {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(d, { recursive: true });
      mergeTree(s, d);
    } else if (entry.isFile() && !existsSync(d)) {
      mkdirSync(join(dest), { recursive: true });
      copyFileSync(s, d);
    }
  }
}

/** 松散的带日期文件 → 按自身日期归入同级 <YYYY-MM>/（绝不归入当前月）。 */
function bucketDatedFiles(storeData: string, moved: string[]): void {
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_PARTS.has(entry.name)) continue;
        walk(p);
        continue;
      }
      if (!entry.isFile()) continue;
      if (MONTH_DIR.test(dir.split(/[\\/]/).pop() ?? "")) continue; // 已归桶
      const month = fileMonth(entry.name);
      if (!month) continue; // 无日期工作文件 —— 留在 area 根
      const destDir = join(dir, month);
      const dest = join(destDir, entry.name);
      if (existsSync(dest)) continue;
      mkdirSync(destDir, { recursive: true });
      renameSync(p, dest);
      moved.push(`${entry.name} -> ${dir.split(/[\\/]/).pop()}/${month}/`);
    }
  };
  walk(storeData);
}

export function migrateStoreData(root: string): { migrated: boolean; moved: string[] } {
  const marker = join(root, MARKER_NAME);
  try {
    if (Number.parseInt(readFileSync(marker, "utf8").trim(), 10) >= LAYOUT_VERSION) {
      return { migrated: false, moved: [] };
    }
  } catch {
    /* 不存在/损坏 → 执行迁移 */
  }
  const moved: string[] = [];
  const storeData = join(root, "store-data");
  mkdirSync(storeData, { recursive: true });
  relocateStoreSubdirs(root, moved);
  bucketDatedFiles(storeData, moved);
  writeTextSync(marker, `${LAYOUT_VERSION}\n`);
  return { migrated: moved.length > 0, moved };
}

// ── 结构化店铺条目（structured_stores.py）──
// 磁盘两个根：stores/<slug>/（知识）+ store-data/<slug>/（run 产物），slug 在后端 join。

export interface StoreFileEntry {
  path: string;
  name: string;
  size: number;
  mtime: number;
  has_content: boolean;
}

export interface StoreEntry {
  slug: string;
  path: string;
  files: StoreFileEntry[];
  file_count: number;
  has_content: boolean;
  /** join 后填充；无 run 数据时 data_files 为空数组、data_path 回落 store-data/<slug> */
  data_path?: string;
  data_files?: StoreFileEntry[];
  data_file_count?: number;
}

function collectStoreTree(root: string, baseDir: string): StoreEntry[] {
  const entries: StoreEntry[] = [];
  if (!existsSync(baseDir)) return entries;
  for (const storePath of readdirSync(baseDir)) {
    const storeDir = join(baseDir, storePath);
    if (!statSync(storeDir).isDirectory() || storePath.startsWith(".")) continue;
    const files: StoreFileEntry[] = [];
    walkFiles(storeDir, (f) => {
      const rel = f.slice(root.length + 1);
      const st = statSync(f);
      files.push({ path: rel, name: f.split(/[\\/]/).pop()!, size: st.size, mtime: st.mtimeMs, has_content: st.size > 50 });
    });
    entries.push({
      slug: storePath,
      path: join(baseDir, storePath).slice(root.length + 1),
      files,
      file_count: files.length,
      has_content: files.some((f) => f.has_content),
    });
  }
  return entries;
}

/** 与 Python `'.git' not in f.parts` 对齐：只排除恰名为 .git 的路径段。 */
function walkFiles(dir: string, cb: (f: string) => void): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".git") continue;
      walkFiles(p, cb);
    } else if (entry.isFile()) {
      cb(p);
    }
  }
}

export function collectStoreEntries(root: string): StoreEntry[] {
  const storeProfiles = collectStoreTree(root, join(root, "stores"));
  const storeData = collectStoreTree(root, join(root, "store-data"));
  // run 数据最新在前（知识保持稳定名序）
  for (const d of storeData) d.files.sort((a, b) => b.mtime - a.mtime);
  const dataBySlug = new Map(storeData.map((d) => [d.slug, d]));
  for (const entry of storeProfiles) {
    const d = dataBySlug.get(entry.slug);
    dataBySlug.delete(entry.slug);
    entry.data_path = d ? d.path : `store-data/${entry.slug}`;
    entry.data_files = d ? d.files : [];
    entry.data_file_count = d ? d.file_count : 0;
  }
  for (const d of dataBySlug.values()) {
    // 无 stores/ 档案的 run 数据也要浮出
    storeProfiles.push({
      slug: d.slug,
      path: `stores/${d.slug}`,
      files: [],
      file_count: 0,
      has_content: false,
      data_path: d.path,
      data_files: d.files,
      data_file_count: d.file_count,
    });
  }
  return storeProfiles;
}

// ── CATALOG.md 桩（store_seed.py）──
// 新店第 1 轮 catalog-first 钩子可成功；幂等：已有真 catalog 就跳过。

export function writeCatalogStub(storeDir: string, slug: string, name: string): string {
  const catalogMd = join(storeDir, "CATALOG.md");
  if (existsSync(catalogMd)) return catalogMd;
  writeTextSync(
    catalogMd,
    `# Store Catalog — ${name} (stub)\n\n` +
      "| File | Relevance | Summary |\n|---|---|---|\n" +
      `| stores/${slug}/STORE.md | profile | Store profile |\n`,
  );
  return catalogMd;
}
