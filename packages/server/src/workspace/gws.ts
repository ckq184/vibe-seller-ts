// Google Workspace CLI (`gws`) 可选技能包（app/workspace/gws_integration.py 移植）。
// enable 流程：`gws --version`/`gws auth status` 预检 → `gws generate-skills` 到
// OS 临时目录 → 按 GWS_SUBSET 白名单拷子技能并重写交叉引用 → 写伞 SKILL.md →
// 原子换入 ~/.vibe-seller/.claude/skills/gws/。无 venv/pip 环节（gws 是外部 Rust
// CLI，不在 venv 不迁移范围）；未安装/未认证 → 400（与原实现一致）。

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, mkdtempSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 源技能名（gws generate-skills 输出）→ 伞下子目录名（去 gws- 前缀）。
 * 兼作白名单：不在表内的目录一律丢弃。 */
export const GWS_SUBSET: Record<string, string> = {
  "gws-shared": "shared",
  "gws-sheets": "sheets",
  "gws-sheets-append": "sheets-append",
  "gws-sheets-read": "sheets-read",
  "gws-drive": "drive",
  "gws-drive-upload": "drive-upload",
  "gws-gmail": "gmail",
  "gws-gmail-forward": "gmail-forward",
  "gws-gmail-read": "gmail-read",
  "gws-gmail-reply": "gmail-reply",
  "gws-gmail-reply-all": "gmail-reply-all",
  "gws-gmail-send": "gmail-send",
  "gws-gmail-triage": "gmail-triage",
  "gws-gmail-watch": "gmail-watch",
  "gws-docs": "docs",
  "gws-docs-write": "docs-write",
  "gws-calendar": "calendar",
  "gws-calendar-agenda": "calendar-agenda",
  "gws-calendar-insert": "calendar-insert",
};

const UMBRELLA_BODY = `---
name: gws
description: "Google Workspace (Sheets, Drive, Gmail, Docs, Calendar) via the gws CLI. Read ./shared/SKILL.md first for auth and global flags; then open the specific sub-skill you need."
allowed-tools: Bash(gws:*), Read
---

# Google Workspace CLI (umbrella)

All commands run through the \`gws\` binary. Before using any sub-skill,
read \`./shared/SKILL.md\` for authentication, global flags, and
output-format rules.

## Sub-skills (read via the Read tool when needed)

| Purpose | File |
|---------|------|
| Shared auth, flags, security | \`./shared/SKILL.md\` |
| Sheets — full API reference | \`./sheets/SKILL.md\` |
| Sheets — append a row | \`./sheets-append/SKILL.md\` |
| Sheets — read values | \`./sheets-read/SKILL.md\` |
| Drive — files/folders/shared drives | \`./drive/SKILL.md\` |
| Drive — upload a file | \`./drive-upload/SKILL.md\` |
| Gmail — full API reference | \`./gmail/SKILL.md\` |
| Gmail — send | \`./gmail-send/SKILL.md\` |
| Gmail — read a message | \`./gmail-read/SKILL.md\` |
| Gmail — reply | \`./gmail-reply/SKILL.md\` |
| Gmail — reply-all | \`./gmail-reply-all/SKILL.md\` |
| Gmail — forward | \`./gmail-forward/SKILL.md\` |
| Gmail — unread inbox summary | \`./gmail-triage/SKILL.md\` |
| Gmail — watch for new mail (NDJSON stream) | \`./gmail-watch/SKILL.md\` |
| Docs — full API reference | \`./docs/SKILL.md\` |
| Docs — append text | \`./docs-write/SKILL.md\` |
| Calendar — full API reference | \`./calendar/SKILL.md\` |
| Calendar — agenda across calendars | \`./calendar-agenda/SKILL.md\` |
| Calendar — create event | \`./calendar-insert/SKILL.md\` |

## Typical Amazon-seller flows

- **Inventory sync**: \`./sheets/SKILL.md\` — \`gws sheets spreadsheets.values update\` / \`+append\` / \`+read\`.
- **Invoice archive**: \`./drive-upload/SKILL.md\` — \`gws drive +upload --file invoice.pdf\`.
- **Supplier email**: \`./gmail-send/SKILL.md\` + \`./gmail-reply/SKILL.md\`.
- **Listing copy updates**: \`./docs-write/SKILL.md\`.
- **Launch calendar**: \`./calendar-insert/SKILL.md\`.
`;

// `../gws-<name>/SKILL.md` → `../<name>/SKILL.md`（伞内引用扁平化）。
const CROSS_REF_RE = /\.\.\/gws-([a-z0-9][a-z0-9-]*)\/SKILL\.md/g;

function gwsDir(homeDir: string): string {
  return join(homeDir, ".claude", "skills", "gws");
}

/** 子进程捕获（ENOENT → rc 127 not found；超时 → rc 124），对齐 gws_integration._run。 */
async function run(cmd: string[], timeoutMs = 15_000, cwd?: string): Promise<{ rc: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd[0]!, cmd.slice(1), { timeout: timeoutMs, cwd, windowsHide: true });
    return { rc: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
    if (err.code === "ENOENT") return { rc: 127, stdout: "", stderr: "not found" };
    if (err.killed) return { rc: 124, stdout: err.stdout ?? "", stderr: "timeout" };
    return { rc: typeof err.code === "number" ? err.code : 1, stdout: err.stdout ?? "", stderr: err.stderr ?? String(e) };
  }
}

function parseAuthStatus(stdout: string): Record<string, unknown> {
  // CLI 在 JSON 前打 `Using keyring backend: …` 行——从第一个 { 起 parse。
  const start = stdout.indexOf("{");
  if (start < 0) return {};
  try {
    return JSON.parse(stdout.slice(start)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function authStateFromJson(data: Record<string, unknown>): { usable: boolean; reason: string; detail: Record<string, unknown> } {
  if (!Object.keys(data).length) return { usable: false, reason: "unparseable", detail: {} };
  const authMethod = String(data["auth_method"] ?? "none");
  if (authMethod === "none") return { usable: false, reason: "not_logged_in", detail: { auth_method: "none", needs_login: true } };
  const hasEnvToken = Boolean(data["token_env_var"]);
  const hasPlain = Boolean(data["plain_credentials_exists"]);
  const hasEncrypted = Boolean(data["encrypted_credentials_exists"]);
  const encryptionValid = Boolean(data["encryption_valid"]);
  const detail: Record<string, unknown> = {
    auth_method: authMethod,
    storage: data["storage"] ?? null,
    keyring_backend: data["keyring_backend"] ?? null,
    project_id: data["project_id"] ?? null,
    account_hint: data["client_id"] ?? data["config_client_id"] ?? null,
    token_cache_exists: Boolean(data["token_cache_exists"]),
  };
  if (hasEnvToken || hasPlain || (hasEncrypted && encryptionValid)) return { usable: true, reason: "logged_in", detail };
  if (hasEncrypted && !encryptionValid) {
    detail["needs_relogin"] = true;
    detail["encryption_error"] = data["encryption_error"] ?? null;
    return { usable: false, reason: "encryption_invalid", detail };
  }
  return { usable: false, reason: "not_logged_in", detail: { ...detail, needs_login: true } };
}

export interface GwsStatus {
  binary: boolean;
  auth: boolean;
  auth_reason: string;
  version: string | null;
  detail: Record<string, unknown>;
}

export async function checkStatus(): Promise<GwsStatus> {
  try {
    const probe = await run(["gws", "--version"]);
    if (probe.rc === 127) {
      return { binary: false, auth: false, auth_reason: "no_binary", version: null, detail: {} };
    }
    const version = probe.rc === 0 ? probe.stdout.trim() : null;
    const auth = await run(["gws", "auth", "status"]);
    if (auth.rc !== 0) return { binary: true, auth: false, auth_reason: "status_failed", version, detail: {} };
    const parsed = parseAuthStatus(auth.stdout);
    const state = authStateFromJson(parsed);
    return { binary: true, auth: state.usable, auth_reason: state.reason, version, detail: state.detail };
  } catch {
    return { binary: false, auth: false, auth_reason: "no_binary", version: null, detail: {} };
  }
}

function populateStaging(srcRoot: string, staging: string): void {
  for (const [srcName, destSub] of Object.entries(GWS_SUBSET)) {
    const src = join(srcRoot, srcName);
    if (!existsSync(src)) continue; // 用户 gws 版本可缺子技能——静默跳过
    const dest = join(staging, destSub);
    cpSync(src, dest, { recursive: true });
    // 重写刚拷的所有 SKILL.md 交叉引用
    rewriteDir(dest);
  }
  writeFileSync(join(staging, "SKILL.md"), UMBRELLA_BODY, "utf8");
}

function rewriteDir(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) rewriteDir(full);
    else if (entry.name === "SKILL.md") {
      const original = readFileSync(full, "utf8");
      const rewritten = original.replace(CROSS_REF_RE, "../$1/SKILL.md");
      if (rewritten !== original) writeFileSync(full, rewritten, "utf8");
    }
  }
}

export async function installSkills(homeDir: string): Promise<{ installed: boolean; subskills: string[]; count: number }> {
  const skillsDir = join(homeDir, ".claude", "skills");
  mkdirSync(skillsDir, { recursive: true });
  const gws = gwsDir(homeDir);

  // Step 1：`gws generate-skills` 进 OS 临时目录。gws >=0.22 校验 --output-dir
  // 必须是相对路径——cwd=父目录 + 传 basename（与原实现同招）。
  const genPath = mkdtempSync(join(tmpdir(), "gws_gen_"));
  try {
    const rc = await run(["gws", "generate-skills", "--output-dir", genPath.split(/[\\/]/).pop()!], 60_000, tmpdir());
    if (rc.rc !== 0) throw new Error(`gws generate-skills failed: ${rc.stderr.trim()}`);

    // Step 2：staging 建在 skills/ 下（同盘 rename 原子）。
    const staging = mkdtempSync(join(skillsDir, ".tmp_gws_"));
    const backup = join(skillsDir, ".bak_gws");
    let backedUp = false;
    try {
      populateStaging(genPath, staging);
      if (existsSync(backup)) rmSync(backup, { recursive: true, force: true });
      if (existsSync(gws)) {
        renameSync(gws, backup);
        backedUp = true;
      }
      renameSync(staging, gws);
      if (existsSync(backup)) rmSync(backup, { recursive: true, force: true });
      backedUp = false;
    } catch (e) {
      // 回滚：备份还原，staging 清理
      if (backedUp && existsSync(backup) && !existsSync(gws)) {
        try {
          renameSync(backup, gws);
        } catch {
          /* 还原失败只留痕 */
        }
      }
      if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
      throw e;
    }
  } finally {
    rmSync(genPath, { recursive: true, force: true });
  }

  const subskills = readdirSync(gws, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  return { installed: true, subskills, count: subskills.length };
}

export async function uninstallSkills(homeDir: string): Promise<{ removed: boolean }> {
  const gws = gwsDir(homeDir);
  if (existsSync(gws)) {
    rmSync(gws, { recursive: true, force: true });
    return { removed: true };
  }
  return { removed: false };
}

export function isInstalled(homeDir: string): boolean {
  return existsSync(join(gwsDir(homeDir), "SKILL.md"));
}
