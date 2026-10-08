// knowledge/skills 远端同步（app/workspace/knowledge_sync.py、skills_sync.py 移植）。
// 差异：TS 侧没有 pip 包内置的 app/knowledge、app/skills_v2 源树（不迁移清单），
// 所以本地包同步（fetch）诚实返回 {synced:false, reason:...}，sync-status 恒
// {available:false,...}；远端同步（MANIFEST.txt + 文件下载）完整保留。
// 技能 Python 依赖安装（_install_skill_deps）属 CLI/venv 世界，不移植。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

const COOLDOWN_SECONDS = 24 * 3600;
const AUTO_SYNC_KEY = "skills_auto_sync_enabled";
const AI_BOT_USER_ID = "00000000-0000-0000-0000-000000000002";
const SKILLS_SUBDIR = "skills_v2";

export interface SyncManagerDeps {
  homeDir: string;
  db: DatabaseSync;
  knowledgeRepoUrl?: string;
  skillsRepoUrl?: string;
  /** GitHub commit API 基址（默认 zpoint/vibe-seller）；测试指向本地 server。 */
  commitApiBase?: string;
  /** 测试注入（本地 http server）；缺省全局 fetch。 */
  fetchImpl?: typeof fetch;
}

type SyncResult = { status: "success" | "failed"; copied?: number; skipped?: number; error?: string; commit?: string };

/** 同步结果落 system Event（原 _log_sync_event；events 表，AI_BOT 创建）。 */
function logSyncEvent(db: DatabaseSync, title: string, details: string, status: string): void {
  try {
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO events (id, title, description, status, platform, created_by, priority, created_at, updated_at) VALUES (?, ?, ?, ?, 'system', ?, 0, ?, ?)",
    ).run(randomUUID(), title, details, status === "success" ? "resolved" : "open", AI_BOT_USER_ID, now, now);
  } catch (e) {
    console.warn(`[vibe-sync] failed to log sync event: ${e instanceof Error ? e.message : e}`);
  }
}

function readJson(p: string): Record<string, unknown> {
  try {
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    /* 损坏 → 空 */
  }
  return {};
}

function writeJson(p: string, meta: Record<string, unknown>): void {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(meta, null, 2), "utf8");
}

function parseManifestLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

async function fetchWithTimeout(fetchImpl: typeof fetch, url: string): Promise<Response> {
  return fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
}

/** GitHub API：main 上该路径的最新提交；不可达 → null。 */
async function fetchRemoteCommit(fetchImpl: typeof fetch, gitPath: string, apiBase: string): Promise<string | null> {
  const apiUrl = `${apiBase}/commits?path=${gitPath}&per_page=1&sha=main`;
  try {
    const resp = await fetchImpl(apiUrl, { signal: AbortSignal.timeout(15_000) });
    if (resp.status === 200) {
      const commits = (await resp.json()) as { sha?: string }[];
      if (commits.length > 0) return commits[0]!.sha ?? null;
    }
  } catch {
    /* 不可达 → null */
  }
  return null;
}

/** MANIFEST.txt → 逐文件下载（本地包优先；TS 无本地包 → 全量下载）。
 * onFailed：异常分支与原实现一致——当场写 meta + 落 failed 事件（外层随后还会写一次 meta）。 */
async function doRemoteSync(
  fetchImpl: typeof fetch,
  baseUrl: string,
  destDir: string,
  localSource: string | null,
  onManifestSkills?: (dirs: string[]) => void,
  onFailed?: (err: string) => void,
): Promise<SyncResult> {
  try {
    const manifestResp = await fetchWithTimeout(fetchImpl, `${baseUrl}/MANIFEST.txt`);
    if (manifestResp.status !== 200) {
      const err = `Failed to fetch MANIFEST.txt: HTTP ${manifestResp.status}`;
      console.warn(`[vibe-sync] ${err}`);
      return { status: "failed", error: err };
    }
    const files = parseManifestLines(await manifestResp.text());

    mkdirSync(destDir, { recursive: true });
    let copied = 0;
    let skipped = 0;
    for (const relPath of files) {
      // 路径穿越校验（resolve 跟随符号链接，与原实现同款防护）
      const resolved = resolve(destDir, relPath);
      if (!resolved.startsWith(resolve(destDir) + sep)) {
        console.warn(`[vibe-sync] path traversal in MANIFEST: ${relPath}`);
        continue;
      }
      // 本地包优先：装包里的文件在该版本生命周期内是权威，远端不覆盖
      if (localSource && existsSync(join(localSource, relPath))) {
        skipped += 1;
        continue;
      }
      try {
        const fileResp = await fetchWithTimeout(fetchImpl, `${baseUrl}/${relPath}`);
        if (fileResp.status !== 200) {
          console.warn(`[vibe-sync] failed to fetch ${relPath}: HTTP ${fileResp.status}`);
          continue;
        }
        const destFile = join(destDir, relPath);
        mkdirSync(join(destFile, ".."), { recursive: true });
        const newContent = Buffer.from(await fileResp.arrayBuffer());
        if (existsSync(destFile)) {
          try {
            if (readFileSync(destFile).equals(newContent)) {
              skipped += 1;
              continue;
            }
          } catch {
            /* 读不了就当不同，覆盖 */
          }
        }
        writeFileSync(destFile, newContent);
        copied += 1;
      } catch (e) {
        console.warn(`[vibe-sync] error downloading ${relPath}: ${e instanceof Error ? e.message : e}`);
      }
    }

    if (onManifestSkills) {
      const dirs = new Set<string>();
      for (const relPath of files) {
        const top = relPath.split(/[\\/]/)[0];
        if (top) dirs.add(top);
      }
      onManifestSkills([...dirs].sort());
    }
    console.info(`[vibe-sync] remote: ${copied} copied, ${skipped} unchanged`);
    return { status: "success", copied, skipped };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    onFailed?.(message);
    return { status: "failed", error: message };
  }
}

function cooldownElapsed(meta: Record<string, unknown>): boolean {
  const lastSync = meta.last_sync_at;
  if (typeof lastSync !== "string" || !lastSync) return true;
  const last = Date.parse(lastSync);
  if (Number.isNaN(last)) return true;
  return (Date.now() - last) / 1000 >= COOLDOWN_SECONDS;
}

// ── Knowledge 同步 ──

export class KnowledgeSyncManager {
  private readonly destDir: string;
  private readonly metaPath: string;
  private readonly repoUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly commitApiBase: string;

  constructor(private readonly deps: SyncManagerDeps) {
    this.destDir = join(deps.homeDir, "knowledge", "project");
    this.metaPath = join(deps.homeDir, "knowledge", ".sync_meta.json");
    this.repoUrl = (
      deps.knowledgeRepoUrl ?? process.env.KNOWLEDGE_REPO_URL ?? "https://raw.githubusercontent.com/zpoint/vibe-seller/main/app/knowledge"
    ).replace(/\/+$/, "");
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.commitApiBase = deps.commitApiBase ?? "https://api.github.com/repos/zpoint/vibe-seller";
  }

  /** 本地包同步：TS 无内置 knowledge 树（诚实返回，与原"包缺目录"分支一致）。 */
  fetch(): { synced: false; reason: string } {
    return { synced: false, reason: "No knowledge/ in installed package" };
  }

  getSyncMeta(): Record<string, unknown> {
    return readJson(this.metaPath);
  }

  /** 与包内源比对——无包 → 恒不可用（原 get_sync_status 的 no-package 分支）。 */
  getSyncStatus(): { available: false; reason: string } {
    return { available: false, reason: "No knowledge/ in package" };
  }

  /** 强制远端同步（无视冷却）。 */
  async fetchRemote(): Promise<SyncResult> {
    const meta = this.getSyncMeta();
    const remoteCommit = await fetchRemoteCommit(this.fetchImpl, "app/knowledge", this.commitApiBase);
    const result = await doRemoteSync(this.fetchImpl, this.repoUrl, this.destDir, null, undefined, (err) => {
      const now = new Date().toISOString();
      writeJson(this.metaPath, { ...this.getSyncMeta(), last_sync_at: now, status: "failed", error: `Remote sync error: ${err}` });
      logSyncEvent(this.deps.db, "Knowledge sync: failed", `Remote sync error: ${err}`, "failed");
    });
    const commit = remoteCommit ?? (typeof meta.last_commit === "string" ? meta.last_commit : "");
    result.commit = commit;
    const now = new Date().toISOString();
    writeJson(this.metaPath, {
      last_sync_at: now,
      last_commit: commit,
      status: result.status ?? "success",
      error: result.error,
      copied: result.copied ?? 0,
      skipped: result.skipped ?? 0,
    });
    if (result.status === "success" && (result.copied ?? 0) > 0) {
      logSyncEvent(this.deps.db, "Knowledge sync: success", `Synced ${result.copied} files from remote (commit ${commit.slice(0, 8)})`, "success");
    }
    return result;
  }

  /** 冷却 + 远端提交变化才同步；boot 后台任务用。 */
  async checkAndSyncRemote(): Promise<SyncResult | null> {
    const meta = this.getSyncMeta();
    if (!cooldownElapsed(meta)) return null;
    const fetchImpl = this.fetchImpl;
    const remoteCommit = await fetchRemoteCommit(fetchImpl, "app/knowledge", this.commitApiBase);
    if (!remoteCommit) return null;
    if (meta.last_commit === remoteCommit) return null;
    const result = await doRemoteSync(fetchImpl, this.repoUrl, this.destDir, null, undefined, (err) => {
      const now = new Date().toISOString();
      writeJson(this.metaPath, { ...this.getSyncMeta(), last_sync_at: now, status: "failed", error: `Remote sync error: ${err}` });
      logSyncEvent(this.deps.db, "Knowledge sync: failed", `Remote sync error: ${err}`, "failed");
    });
    result.commit = remoteCommit;
    const now = new Date().toISOString();
    writeJson(this.metaPath, {
      last_sync_at: now,
      last_commit: remoteCommit,
      status: result.status ?? "success",
      error: result.error,
      copied: result.copied ?? 0,
      skipped: result.skipped ?? 0,
    });
    if (result.status === "success") {
      logSyncEvent(this.deps.db, "Knowledge sync: success", `Synced ${result.copied ?? 0} files from remote (commit ${remoteCommit.slice(0, 8)})`, "success");
    }
    return result;
  }
}

// ── Skills 同步 ──

export class SkillsSyncManager {
  private readonly destDir: string;
  private readonly repoUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly commitApiBase: string;

  constructor(private readonly deps: SyncManagerDeps) {
    this.destDir = join(deps.homeDir, ".claude", "skills");
    this.repoUrl = (
      deps.skillsRepoUrl ?? process.env.SKILLS_REPO_URL ?? `https://raw.githubusercontent.com/zpoint/vibe-seller/main/app/${SKILLS_SUBDIR}`
    ).replace(/\/+$/, "");
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.commitApiBase = deps.commitApiBase ?? "https://api.github.com/repos/zpoint/vibe-seller";
  }

  fetch(): { synced: false; reason: string } {
    return { synced: false, reason: "No skills/ in installed package" };
  }

  get syncMetaPath(): string {
    return join(this.destDir, ".sync_meta.json");
  }

  getSyncMeta(): Record<string, unknown> {
    return readJson(this.syncMetaPath);
  }

  isGwsInstalled(): boolean {
    return Boolean(this.getSyncMeta().gws_installed);
  }

  markGwsInstalled(installed: boolean): void {
    const meta = this.getSyncMeta();
    if (installed) meta.gws_installed = true;
    else delete meta.gws_installed;
    writeJson(this.syncMetaPath, meta);
  }

  getSyncedSkills(): Set<string> {
    const v = this.getSyncMeta().synced_skills;
    return new Set(Array.isArray(v) ? (v as string[]) : []);
  }

  private updateSyncedSkills(names: string[]): void {
    const meta = this.getSyncMeta();
    const existing = new Set(Array.isArray(meta.synced_skills) ? (meta.synced_skills as string[]) : []);
    for (const n of names) existing.add(n);
    meta.synced_skills = [...existing].sort();
    writeJson(this.syncMetaPath, meta);
  }

  /** 原端点 POST /workspace/skills/sync 的 {**fetch(), remote}。 */
  async fetchRemote(): Promise<SyncResult> {
    const meta = this.getSyncMeta();
    const remoteCommit = await fetchRemoteCommit(this.fetchImpl, `app/${SKILLS_SUBDIR}`, this.commitApiBase);
    const result = await doRemoteSync(
      this.fetchImpl,
      this.repoUrl,
      this.destDir,
      null,
      (dirs) => this.updateSyncedSkills(dirs),
      (err) => {
        const now = new Date().toISOString();
        writeJson(this.syncMetaPath, {
          ...this.getSyncMeta(),
          last_sync_at: now,
          status: "failed",
          error: `Remote skills sync error: ${err}`,
        });
        logSyncEvent(this.deps.db, "Skills sync: failed", `Remote skills sync error: ${err}`, "failed");
      },
    );
    const commit = remoteCommit ?? (typeof meta.last_commit === "string" ? meta.last_commit : "");
    result.commit = commit;
    const now = new Date().toISOString();
    writeJson(this.syncMetaPath, {
      last_sync_at: now,
      last_commit: commit,
      status: result.status ?? "success",
      error: result.error,
      copied: result.copied ?? 0,
      skipped: result.skipped ?? 0,
    });
    if (result.status === "success" && (result.copied ?? 0) > 0) {
      logSyncEvent(this.deps.db, "Skills sync: success", `Synced ${result.copied} skill files from remote (commit ${commit.slice(0, 8)})`, "success");
    }
    return result;
  }

  /** 冷却 + 开关（app_settings，缺省开）+ 提交变化才同步。 */
  async checkAndSyncRemote(): Promise<SyncResult | null> {
    const meta = this.getSyncMeta();
    if (!cooldownElapsed(meta)) return null;
    if (!autoSyncEnabled(this.deps.db)) return null;
    const remoteCommit = await fetchRemoteCommit(this.fetchImpl, `app/${SKILLS_SUBDIR}`, this.commitApiBase);
    if (!remoteCommit) return null;
    if (meta.last_commit === remoteCommit) return null;
    const result = await doRemoteSync(
      this.fetchImpl,
      this.repoUrl,
      this.destDir,
      null,
      (dirs) => this.updateSyncedSkills(dirs),
      (err) => {
        const now = new Date().toISOString();
        writeJson(this.syncMetaPath, {
          ...this.getSyncMeta(),
          last_sync_at: now,
          status: "failed",
          error: `Remote skills sync error: ${err}`,
        });
        logSyncEvent(this.deps.db, "Skills sync: failed", `Remote skills sync error: ${err}`, "failed");
      },
    );
    result.commit = remoteCommit;
    const now = new Date().toISOString();
    writeJson(this.syncMetaPath, {
      last_sync_at: now,
      last_commit: remoteCommit,
      status: result.status ?? "success",
      error: result.error,
      copied: result.copied ?? 0,
      skipped: result.skipped ?? 0,
    });
    if (result.status === "success") {
      logSyncEvent(this.deps.db, "Skills sync: success", `Synced ${result.copied ?? 0} skill files from remote (commit ${remoteCommit.slice(0, 8)})`, "success");
    }
    return result;
  }
}

function autoSyncEnabled(db: DatabaseSync): boolean {
  try {
    const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(AUTO_SYNC_KEY) as { value: string } | undefined;
    if (!row) return true;
    return row.value === "true";
  } catch {
    return true; // 瞬态故障宁可多同步一次也不静默停更
  }
}
