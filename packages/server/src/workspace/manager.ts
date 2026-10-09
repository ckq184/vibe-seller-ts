// WorkspaceManager：~/.vibe-seller/ 的文件操作 + git 自动提交。
// 逐条移植 app/workspace/manager.py + skills_manager.py。差异（均有第一性理由）：
//  - 不建共享 Python venv（_ensure_venv）——那是 Claude Code CLI 的运行前提，pi 运行时无此依赖；
//  - git 一律走 PATH 上的 git 子进程（原实现 GitPython 与子进程混用；语义一致：锁内串行）。

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
// 文本 IO 走 textio（win32 CRLF 对齐，见 textio.ts 注释）；二进制/git 走原 fs。
import { normalizeNewlines, readTextSync, writeTextSync } from "./textio";
import { execFile } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { HttpError } from "../types";
import { rejectWrongStubs } from "./catalog";
import { WORKSPACE_CLAUDE_MD, collectStoreEntries, migrateStoreData, storeSlug, writeCatalogStub } from "./storeData";

/** 落盘前替换孤立代理对（U+D800-U+DFFF）为 U+FFFD（app/text_utils.sanitize_text）。 */
export function sanitizeText(text: string): string {
  let hasSurrogate = false;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) {
      hasSurrogate = true;
      break;
    }
  }
  if (!hasSurrogate) return text;
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    out += code >= 0xd800 && code <= 0xdfff ? "\uFFFD" : ch;
  }
  return out;
}

/** markdown 文件的 --- 分隔 YAML frontmatter（平键值解析，原实现同款简化）。 */
export function parseYamlFrontmatter(text: string): Record<string, string> {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("---", 3);
  if (end === -1) return {};
  const frontmatter = text.slice(3, end).trim();
  const result: Record<string, string> = {};
  for (const line of frontmatter.split("\n")) {
    const idx = line.indexOf(":");
    if (idx !== -1) result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return result;
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class WorkspaceManager {
  readonly root: string;
  private gitChain: Promise<unknown> = Promise.resolve(); // git 子进程串行（index.lock 竞态）

  constructor(root: string) {
    this.root = root;
  }

  /** 目录存在且为 git repo；写一次 CLAUDE.md；首启 git init + 初始提交。 */
  async ensureInit(): Promise<void> {
    mkdirSync(join(this.root, ".claude", "skills"), { recursive: true });
    mkdirSync(join(this.root, "knowledge"), { recursive: true });
    mkdirSync(join(this.root, "stores"), { recursive: true });
    // 每店 RUN 数据在 stores/ 之外（不浮成知识，但仍被 git 跟踪）；旧布局一次性搬迁
    migrateStoreData(this.root);

    const claudeMd = join(this.root, "CLAUDE.md");
    if (!existsSync(claudeMd)) writeTextSync(claudeMd, WORKSPACE_CLAUDE_MD);

    const gitDir = join(this.root, ".git");
    if (!existsSync(gitDir)) {
      await this.runGit("init");
      const gitignore = join(this.root, ".gitignore");
      if (!existsSync(gitignore)) {
        writeTextSync(
          gitignore,
          "*.pyc\n__pycache__/\n.DS_Store\n.venv/\nnode_modules/\nconfig/\ntask_history/\ndata/\n*.db-journal\n*.db-wal\n*.db-shm\n",
        );
      }
      await this.runGit("add", "-A");
      await this.runGit("commit", "-m", "Initial workspace setup");
    }

    // 瞬态/生成路径确保在 .gitignore 里
    const gitignore = join(this.root, ".gitignore");
    if (existsSync(gitignore)) {
      const content = readTextSync(gitignore);
      const additions: string[] = [];
      for (const entry of ["task_history/", "data/", "*.db-journal", "tasks/", "node_modules/"]) {
        if (!content.includes(entry)) additions.push(entry);
      }
      if (additions.length > 0) {
        writeTextSync(gitignore, `${content.replace(/\s+$/, "")}\n${additions.join("\n")}\n`);
      }
    }
  }

  // ── 文件面 ──

  async listTree(): Promise<{ path: string; is_dir: boolean; size: number }[]> {
    await this.ensureInit();
    const items: { path: string; is_dir: boolean; size: number }[] = [];
    const walk = (dir: string): void => {
      const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        const full = join(dir, entry.name);
        const rel = full.slice(this.root.length + 1);
        const parts = rel.split(sep);
        if (parts.includes(".git") || parts.includes(".venv") || parts.includes("tasks")) continue;
        if (entry.isDirectory()) {
          items.push({ path: rel, is_dir: true, size: 0 });
          walk(full);
        } else if (entry.isFile()) {
          items.push({ path: rel, is_dir: false, size: statSync(full).size });
        }
      }
    };
    walk(this.root);
    // 原 sorted(rglob('*')) 比较 PureWindowsPath——Windows 路径比较大小写不敏感
    // （'bh-tmp' 排在 'CLAUDE.md' 前）。JS 字符串比较是 case-sensitive，显式折叠。
    items.sort((a, b) => {
      const la = a.path.toLowerCase();
      const lb = b.path.toLowerCase();
      return la < lb ? -1 : la > lb ? 1 : 0;
    });
    return items;
  }

  /** 技能读（.claude/skills/<slug>）用宽检（跟随符号链接）；其余树一律 _safePath 严检。 */
  resolveFile(relPath: string): string {
    const parts = relPath.split(/[\\/]/).filter((p) => p.length > 0);
    let filePath: string;
    if (parts[0] === ".claude" && parts[1] === "skills") {
      if (isAbsolute(relPath) || parts.some((p) => p === "..")) {
        throw new HttpError(400, `Path traversal not allowed: ${relPath}`);
      }
      filePath = join(this.root, ...parts);
    } else {
      filePath = this.safePath(relPath);
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      throw new HttpError(404, `File not found: ${relPath}`);
    }
    return filePath;
  }

  async readFile(relPath: string): Promise<string> {
    const filePath = this.resolveFile(relPath);
    const bytes = readFileSync(filePath);
    // 严格 utf-8（对应 Python UnicodeDecodeError）；平台导出（csv/tsv）可能是 GB18030
    try {
      return normalizeNewlines(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      try {
        return new TextDecoder("gb18030", { fatal: true }).decode(bytes);
      } catch {
        throw new HttpError(400, `Binary file (use /api/workspace/file/raw): ${relPath}`);
      }
    }
  }

  private rejectL1Write(relPath: string): void {
    const resolved = this.safePath(relPath);
    const l1 = resolve(this.root, "knowledge", "project");
    if (resolved === l1 || resolved.startsWith(l1 + sep)) {
      throw new HttpError(
        400,
        `Cannot modify read-only L1 path: ${relPath}. Write to knowledge/ (L2) or stores/<slug>/ (L3).`,
      );
    }
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    await this.ensureInit();
    const filePath = this.safePath(relPath);
    this.rejectL1Write(relPath);
    mkdirSync(dirname(filePath), { recursive: true });
    // 写边界执行 catalog 桩契约：把有内容的文件标 Empty/stub 的 CATALOG.md 直接拒绝
    if (relPath.endsWith("CATALOG.md")) {
      rejectWrongStubs(content, (rel) => {
        try {
          return readFileSync(this.resolveFile(rel), "utf8");
        } catch {
          return null;
        }
      });
    }
    writeTextSync(filePath, sanitizeText(content));
    await this.autoCommit(`Update ${relPath}`);
  }

  async deleteFile(relPath: string): Promise<void> {
    const filePath = this.safePath(relPath);
    this.rejectL1Write(relPath);
    if (!existsSync(filePath)) throw new HttpError(404, `Not found: ${relPath}`);
    if (statSync(filePath).isFile()) unlinkSync(filePath);
    else rmSync(filePath, { recursive: true, force: true });
    await this.autoCommit(`Delete ${relPath}`);
  }

  private safePath(relPath: string): string {
    const resolved = resolve(this.root, relPath);
    const rootResolved = resolve(this.root);
    if (resolved !== rootResolved && !resolved.startsWith(rootResolved + sep)) {
      throw new HttpError(400, `Path traversal not allowed: ${relPath}`);
    }
    return resolved;
  }

  // ── git 面 ──

  private async runGit(...args: string[]): Promise<GitResult> {
    const task = this.gitChain.then(
      () =>
        new Promise<GitResult>((done) => {
          // GIT_*_NAME/EMAIL setdefault：无全局身份的机器也能产初始提交（#181）
          execFile(
            "git",
            args,
            {
              cwd: this.root,
              maxBuffer: 64 * 1024 * 1024,
              encoding: "utf8",
              env: {
                ...process.env,
                GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "Vibe Seller",
                GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "agent@vibe-seller.local",
                GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "Vibe Seller",
                GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "agent@vibe-seller.local",
              },
            },
            (err, stdout, stderr) =>
              done({
                code: err ? ((err as { code?: number }).code ?? 1) : 0,
                stdout: typeof stdout === "string" ? stdout : "",
                stderr: String(stderr ?? (err ? err.message : "")),
              }),
          );
        }),
    );
    this.gitChain = task.catch(() => undefined);
    return task;
  }

  private async autoCommit(message: string): Promise<void> {
    try {
      await this.runGit("add", "-A");
      const diff = await this.runGit("diff", "--cached", "--quiet");
      if (diff.code !== 0) await this.runGit("commit", "-m", message);
    } catch (e) {
      console.warn(`[vibe-workspace] auto-commit failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  async fileHistory(relPath: string, maxCount = 50): Promise<{ sha: string; message: string; date: string; author: string }[]> {
    this.safePath(relPath); // 路径校验
    const gitPath = relPath.replace(/\\/g, "/");
    const out = await this.runGit("log", `--max-count=${maxCount}`, "--pretty=format:%H%x1f%s%x1f%aI%x1f%an%x1e", "--", gitPath);
    if (out.code !== 0) throw new HttpError(400, `git log failed: ${out.stderr}`);
    return decodeGitLog(out.stdout);
  }

  async fileAtCommit(relPath: string, commitSha: string): Promise<string> {
    this.safePath(relPath);
    const gitPath = relPath.replace(/\\/g, "/");
    const out = await this.runGit("show", `${commitSha}:${gitPath}`);
    if (out.code !== 0) throw new HttpError(400, `git show failed: ${out.stderr}`);
    return out.stdout;
  }

  async resetFileToCommit(relPath: string, commitSha: string): Promise<void> {
    this.rejectL1Write(relPath);
    const content = await this.fileAtCommit(relPath, commitSha);
    const filePath = this.safePath(relPath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, "utf8");
    await this.autoCommit(`Revert ${relPath} to ${commitSha.slice(0, 12)}`);
  }

  // ── 结构化视图（manager.get_structured）──

  async getStructured(): Promise<Record<string, unknown>> {
    await this.ensureInit();
    const knowledgeDir = join(this.root, "knowledge");
    const skillsDir = join(this.root, ".claude", "skills");

    const skills: Record<string, unknown>[] = [];
    if (existsSync(skillsDir)) {
      const lockfile = this.readLockfile();
      const synced = readSyncedSkills(skillsDir);
      for (const name of readdirSync(skillsDir).sort()) {
        const skillPath = join(skillsDir, name);
        if (!statSync(skillPath).isDirectory() || name.startsWith(".")) continue;
        const lockEntry = (lockfile.skills[name] ?? {}) as Record<string, unknown>;
        let source: string;
        let originUrl = "";
        if (synced.has(name)) {
          source = "builtin";
        } else if (lockEntry.source === "url") {
          source = "imported";
          originUrl = String(lockEntry.origin_url ?? "");
        } else {
          source = "custom";
        }
        const files: { path: string; name: string; size: number }[] = [];
        let description = "";
        walkSkillFiles(skillPath, (f) => {
          const rel = f.slice(this.root.length + 1);
          const fname = basename(f);
          files.push({ path: rel, name: fname, size: statSync(f).size });
          if (fname === "SKILL.md") {
            try {
              const fm = parseYamlFrontmatter(readTextSync(f));
              description = fm.description ?? "";
            } catch {
              /* frontmatter 解析失败不致命 */
            }
          }
        });
        skills.push({
          slug: name,
          path: relative(this.root, skillPath),
          files,
          file_count: files.length,
          description,
          source,
          origin_url: originUrl,
        });
      }
    }

    const storeProfiles = collectStoreEntries(this.root);

    const projectKnowledgeDir = join(knowledgeDir, "project");
    const projectKnowledge: { path: string; name: string; size: number }[] = [];
    const localKnowledge: { path: string; name: string; size: number }[] = [];
    if (existsSync(knowledgeDir)) {
      const collected: { path: string; name: string; size: number; full: string }[] = [];
      walkKnowledgeFiles(knowledgeDir, (f) => {
        collected.push({ path: f.slice(this.root.length + 1), name: basename(f), size: statSync(f).size, full: f });
      });
      collected.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      for (const entry of collected) {
        const { full, ...item } = entry;
        if (existsSync(projectKnowledgeDir) && (full === projectKnowledgeDir || full.startsWith(projectKnowledgeDir + sep))) {
          projectKnowledge.push(item);
        } else {
          localKnowledge.push(item);
        }
      }
    }

    const rootFiles: { path: string; name: string; size: number }[] = [];
    for (const name of readdirSync(this.root).sort()) {
      const full = join(this.root, name);
      if (existsSync(full) && statSync(full).isFile() && name !== ".DS_Store") {
        rootFiles.push({ path: name, name, size: statSync(full).size });
      }
    }

    return {
      skills,
      store_profiles: storeProfiles,
      project_knowledge: projectKnowledge,
      local_knowledge: localKnowledge,
      root_files: rootFiles,
    };
  }

  // ── 店铺档案脚手架（create_store_profile）──

  async createStoreProfile(slug: string, name: string, platform = "", country = "", backend = "chrome"): Promise<string> {
    void platform;
    void country;
    await this.ensureInit();
    const storeDir = join(this.root, "stores", slug);
    mkdirSync(storeDir, { recursive: true });

    const storeMd = join(storeDir, "STORE.md");
    if (!existsSync(storeMd)) {
      writeTextSync(storeMd, `---\nbrowser: ${backend}\n---\n\n# Store: ${name}\n\n`);
    }
    const notesMd = join(storeDir, "notes.md");
    if (!existsSync(notesMd)) writeTextSync(notesMd, `# Notes for ${name}\n\n`);
    const logisticsMd = join(storeDir, "logistics.md");
    if (!existsSync(logisticsMd)) writeTextSync(logisticsMd, `# Logistics for ${name}\n\n`);

    writeCatalogStub(storeDir, slug, name);

    if (backend === "ziniao") {
      const routingMd = join(storeDir, "browser-routing.md");
      if (!existsSync(routingMd)) {
        writeTextSync(
          routingMd,
          "# Browser Routing Rules\n\n" +
            "<!-- Custom routing rules for this store. " +
            "These override the default dual-browser " +
            "routing. -->\n\n" +
            "## Examples\n\n" +
            "<!-- Uncomment and edit as needed:\n" +
            "- logistics.example.com → Chrome aux\n" +
            "- sellercentral.amazon.* → Ziniao\n" +
            "-->\n",
        );
      }
    }

    await this.autoCommit(`Create store profile: ${name}`);
    return join("stores", slug);
  }

  // ── 技能 CRUD（skills_manager.py）──

  private get lockfilePath(): string {
    return join(this.root, ".claude", "skills", "skills.lock.json");
  }

  private readLockfile(): { version: number; skills: Record<string, Record<string, unknown>> } {
    const fallback = { version: 1, skills: {} as Record<string, Record<string, unknown>> };
    try {
      if (existsSync(this.lockfilePath)) {
        const data = JSON.parse(readFileSync(this.lockfilePath, "utf8")) as Record<string, unknown>;
        if (typeof data !== "object" || data === null) return fallback;
        return {
          version: typeof data.version === "number" ? data.version : 1,
          skills: typeof data.skills === "object" && data.skills !== null ? (data.skills as Record<string, Record<string, unknown>>) : {},
        };
      }
    } catch {
      console.warn("[vibe-workspace] corrupt skills lockfile, using default");
    }
    return fallback;
  }

  private writeLockfile(data: { version: number; skills: Record<string, unknown> }): void {
    mkdirSync(dirname(this.lockfilePath), { recursive: true });
    const tmp = join(dirname(this.lockfilePath), `.tmp-${randomBytes(6).toString("hex")}`);
    writeTextSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, this.lockfilePath);
  }

  async createSkill(name: string, description = "", originUrl = ""): Promise<string> {
    if (name.startsWith("_")) throw new HttpError(400, `Skill names starting with _ are reserved: ${name}`);
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/^-+|-+$/g, "");
    const skillDir = join(this.root, ".claude", "skills", slug);
    mkdirSync(skillDir, { recursive: true });
    const skillMd = join(skillDir, "SKILL.md");
    // 原实现：无 content 时模板总是覆写（create 语义就是重建脚手架）
    const template =
      `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${description}\n\n## Instructions\n\n<!-- Add skill instructions here -->\n`;
    writeTextSync(skillMd, template);
    const lockfile = this.readLockfile();
    const now = new Date().toISOString();
    lockfile.skills[slug] = { source: originUrl ? "url" : "local", name, origin_url: originUrl, created_at: now, updated_at: now };
    this.writeLockfile(lockfile);
    await this.autoCommit(`Create skill: ${name}`);
    return join(".claude", "skills", slug);
  }

  async deleteSkill(slug: string): Promise<void> {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new HttpError(400, `Invalid skill slug: ${slug}`);
    if (slug.startsWith("_")) throw new HttpError(400, "Cannot delete built-in skills");
    const skillDir = join(this.root, ".claude", "skills", slug);
    if (!existsSync(skillDir) || !statSync(skillDir).isDirectory()) throw new HttpError(404, `Skill not found: ${slug}`);
    rmSync(skillDir, { recursive: true, force: true });
    const lockfile = this.readLockfile();
    delete lockfile.skills[slug];
    this.writeLockfile(lockfile);
    await this.autoCommit(`Delete skill: ${slug}`);
  }

  private classifySkill(slug: string, synced: Set<string>, lockfile: { skills: Record<string, Record<string, unknown>> }): string {
    if (synced.has(slug)) return "builtin";
    if (lockfile.skills[slug]?.source === "url") return "imported";
    return "custom";
  }

  async listSkills(): Promise<Record<string, unknown>[]> {
    await this.ensureInit();
    const skillsDir = join(this.root, ".claude", "skills");
    if (!existsSync(skillsDir)) return [];
    const lockfile = this.readLockfile();
    const synced = readSyncedSkills(skillsDir);
    const out: Record<string, unknown>[] = [];
    for (const name of readdirSync(skillsDir).sort()) {
      const skillPath = join(skillsDir, name);
      if (!statSync(skillPath).isDirectory() || name.startsWith(".")) continue;
      const source = this.classifySkill(name, synced, lockfile);
      let skillName: string = name;
      let description = "";
      const skillMd = join(skillPath, "SKILL.md");
      if (existsSync(skillMd)) {
        try {
          const fm = parseYamlFrontmatter(readFileSync(skillMd, "utf8"));
          skillName = fm.name || name;
          description = fm.description ?? "";
        } catch {
          /* 解析失败回退 slug */
        }
      }
      out.push({ slug: name, name: skillName, description, source, updatable: source === "custom" || source === "imported" });
    }
    return out;
  }

  /** 建/扩展用户技能（upsert）；内置（同步来的）slug 硬拒——只读。 */
  async saveSkill(slug: string, skillMd: string, files?: Record<string, string>): Promise<{ slug: string; path: string; action: string }> {
    await this.ensureInit();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug ?? "")) {
      throw new HttpError(400, `Invalid skill slug: ${JSON.stringify(slug)} (use lowercase letters, digits, hyphens)`);
    }
    const skillsDir = join(this.root, ".claude", "skills");
    const synced = readSyncedSkills(skillsDir);
    if (synced.has(slug)) {
      throw new HttpError(
        400,
        `${JSON.stringify(slug)} is a built-in skill (maintainer-owned, read-only). Create a new user-space skill with a ` +
          "different slug instead — it may reference the built-in.",
      );
    }
    const skillDir = join(skillsDir, slug);
    const existed = existsSync(skillDir);
    mkdirSync(skillDir, { recursive: true });
    writeTextSync(join(skillDir, "SKILL.md"), sanitizeText(skillMd));
    for (const [rel, content] of Object.entries(files ?? {})) {
      const parts = rel.split(/[\\/]/).filter((p) => p.length > 0);
      if (isAbsolute(rel) || parts.length === 0 || parts.some((p) => p === "..") || parts[parts.length - 1] === "SKILL.md") {
        throw new HttpError(400, `Invalid skill file path: ${JSON.stringify(rel)}`);
      }
      const dest = join(skillDir, ...parts);
      mkdirSync(dirname(dest), { recursive: true });
      writeTextSync(dest, sanitizeText(content));
    }
    const lockfile = this.readLockfile();
    const now = new Date().toISOString();
    const fm = parseYamlFrontmatter(skillMd);
    const entry = (lockfile.skills[slug] ?? {}) as Record<string, unknown>;
    entry.source = entry.source ?? "local";
    entry.origin_url = entry.origin_url ?? "";
    entry.created_at = entry.created_at ?? now;
    entry.name = fm.name || entry.name || slug;
    entry.updated_at = now;
    lockfile.skills[slug] = entry;
    this.writeLockfile(lockfile);
    await this.autoCommit(`${existed ? "Update" : "Create"} skill: ${slug}`);
    return { slug, path: join(".claude", "skills", slug), action: existed ? "updated" : "created" };
  }
}

// ── 辅助 ──

/** git log --pretty 输出（\x1e 记录分隔、\x1f 字段分隔）→ 提交条目。 */
function decodeGitLog(out: string): { sha: string; message: string; date: string; author: string }[] {
  return out
    .split("\x1e")
    .map((s) => s.replace(/^\n/, ""))
    .filter((s) => s.trim().length > 0)
    .map((record) => {
      const [sha, message, date, author] = record.trim().split("\x1f");
      return { sha: (sha ?? "").slice(0, 12), message: (message ?? "").trim(), date: date ?? "", author: author ?? "" };
    });
}

function readSyncedSkills(skillsDir: string): Set<string> {
  const metaPath = join(skillsDir, ".sync_meta.json");
  try {
    if (existsSync(metaPath)) {
      const data = JSON.parse(readFileSync(metaPath, "utf8")) as { synced_skills?: string[] };
      return new Set(data.synced_skills ?? []);
    }
  } catch {
    /* 损坏 → 视为空 */
  }
  return new Set();
}

function walkSkillFiles(dir: string, cb: (f: string) => void): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    return;
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === ".venv" || entry.name === "__pycache__") continue;
      walkSkillFiles(p, cb);
    } else if (entry.isFile()) {
      if (entry.name === ".pyc" || entry.name.endsWith(".pyc")) continue;
      cb(p);
    }
  }
}

function walkKnowledgeFiles(dir: string, cb: (f: string) => void): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === "__pycache__") continue;
      walkKnowledgeFiles(p, cb);
    } else if (entry.isFile()) {
      cb(p);
    }
  }
}
