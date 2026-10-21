// 批次 4.5 路由：workspace（19 端点）+ assistant（3 端点）。
// 契约对齐 app/routers/workspace.py、workspace_assistant.py；错误形状恒 {"detail"}。

import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { HttpError } from "./types";
import { getCurrentUser, type AuthContext } from "./auth";
import type { ServerConfig } from "./config";
import { WorkspaceManager } from "./workspace/manager";
import { KnowledgeSyncManager, SkillsSyncManager } from "./workspace/sync";
import { WorkspaceAssistantManager } from "./workspace/assistant";
import { storeSlug } from "./workspace/storeData";
import { WORKSPACE_ASSISTANT_PROMPT } from "./workspace/assistantPrompt";
import { DEFAULT_PROFILE_ID } from "./profiles/presets";

export interface WorkspaceDeps {
  config: ServerConfig;
  db: DatabaseSync;
  auth: AuthContext;
  bus: { emit: (type: string, data: Record<string, unknown>) => void };
  workspace: WorkspaceManager;
  knowledgeSync: KnowledgeSyncManager;
  skillsSync: SkillsSyncManager;
  assistant: WorkspaceAssistantManager;
}

// 内联渲染只允许在 app 源下无法执行脚本的类型（绝不 text/html、绝不 image/svg+xml
// ——那是 agent/商家写的 workspace 文件的存储型 XSS 向量），其余一律附件下载。
const INLINE_SAFE_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"]);

const RAW_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".html": "text/html",
  ".htm": "text/html",
  ".svg": "image/svg+xml",
  ".zip": "application/zip",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
};

function guessMime(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot === -1) return "application/octet-stream";
  return RAW_MIME[name.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

function contentDisposition(kind: "inline" | "attachment", filename: string): string {
  if (/^[\x20-\x7e]*$/.test(filename) && !filename.includes('"') && !filename.includes("\\")) {
    return `${kind}; filename="${filename}"`;
  }
  const asciiFallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function registerWorkspaceRoutes(app: Hono, deps: WorkspaceDeps): void {
  const { db, auth, workspace, knowledgeSync, skillsSync, assistant } = deps;

  app.get("/api/workspace/tree", async (c) => {
    getCurrentUser(c, auth);
    return c.json(await workspace.listTree());
  });

  app.get("/api/workspace/structured", async (c) => {
    getCurrentUser(c, auth);
    return c.json(await workspace.getStructured());
  });

  app.get("/api/workspace/file", async (c) => {
    getCurrentUser(c, auth);
    const path = c.req.query("path") ?? "";
    const content = await workspace.readFile(path);
    return c.json({ path, content });
  });

  app.get("/api/workspace/file/raw", async (c) => {
    getCurrentUser(c, auth);
    const path = c.req.query("path") ?? "";
    const filePath = workspace.resolveFile(path);
    const { readFile } = await import("node:fs/promises");
    const body = await readFile(filePath);
    const name = filePath.split(/[\\/]/).pop() ?? "file";
    const mediaType = guessMime(name);
    const disposition = INLINE_SAFE_TYPES.has(mediaType) ? "inline" : "attachment";
    return c.body(new Uint8Array(body), 200, {
      "content-type": mediaType,
      "content-disposition": contentDisposition(disposition, name),
    });
  });

  app.put("/api/workspace/file", async (c) => {
    getCurrentUser(c, auth);
    const path = c.req.query("path") ?? "";
    const body = (await c.req.json().catch(() => ({}))) as { content?: string };
    if (typeof body.content !== "string") throw new HttpError(422, "content required");
    await workspace.writeFile(path, body.content);
    return c.json({ path, status: "ok" });
  });

  app.delete("/api/workspace/file", async (c) => {
    getCurrentUser(c, auth);
    const path = c.req.query("path") ?? "";
    await workspace.deleteFile(path);
    return c.json({ path, status: "deleted" });
  });

  app.get("/api/workspace/skills", async (c) => {
    getCurrentUser(c, auth);
    return c.json(await workspace.listSkills());
  });

  app.put("/api/workspace/skills/:slug", async (c) => {
    getCurrentUser(c, auth);
    const slug = c.req.param("slug");
    const body = (await c.req.json().catch(() => ({}))) as { skill_md?: string; files?: Record<string, string> };
    if (typeof body.skill_md !== "string") throw new HttpError(422, "skill_md required");
    return c.json(await workspace.saveSkill(slug, body.skill_md, body.files));
  });

  app.post("/api/workspace/skill", async (c) => {
    getCurrentUser(c, auth);
    const body = (await c.req.json().catch(() => ({}))) as { name?: string; description?: string; origin_url?: string };
    if (typeof body.name !== "string") throw new HttpError(422, "name required");
    if (body.name.startsWith("_")) throw new HttpError(400, `Skill names starting with _ are reserved: ${body.name}`);
    const relPath = await workspace.createSkill(body.name, body.description ?? "", body.origin_url ?? "");
    return c.json({ path: relPath, status: "created" });
  });

  app.delete("/api/workspace/skills/:slug", async (c) => {
    getCurrentUser(c, auth);
    const slug = c.req.param("slug");
    if (slug.startsWith("_")) throw new HttpError(400, "Cannot delete built-in skills");
    await workspace.deleteSkill(slug);
    return c.json({ slug, status: "deleted" });
  });

  app.post("/api/workspace/store-profile", async (c) => {
    getCurrentUser(c, auth);
    const body = (await c.req.json().catch(() => ({}))) as { slug?: string; name?: string; platform?: string; country?: string; backend?: string };
    if (typeof body.slug !== "string" || typeof body.name !== "string") throw new HttpError(422, "slug and name required");
    const relPath = await workspace.createStoreProfile(body.slug, body.name, body.platform ?? "", body.country ?? "", body.backend ?? "chrome");
    return c.json({ path: relPath, status: "created" });
  });

  app.get("/api/workspace/file/history", async (c) => {
    getCurrentUser(c, auth);
    const path = c.req.query("path") ?? "";
    const maxCount = Number.parseInt(c.req.query("max_count") ?? "50", 10);
    try {
      const history = await workspace.fileHistory(path, Number.isNaN(maxCount) ? 50 : maxCount);
      return c.json({ path, commits: history });
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) throw new HttpError(404, `File not found: ${path}`);
      throw new HttpError(400, e instanceof Error ? e.message : String(e));
    }
  });

  app.get("/api/workspace/file/version", async (c) => {
    getCurrentUser(c, auth);
    const path = c.req.query("path") ?? "";
    const commit = c.req.query("commit") ?? "";
    try {
      const content = await workspace.fileAtCommit(path, commit);
      return c.json({ path, commit, content });
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : String(e));
    }
  });

  app.post("/api/workspace/file/reset", async (c) => {
    getCurrentUser(c, auth);
    const body = (await c.req.json().catch(() => ({}))) as { path?: string; commit?: string };
    if (typeof body.path !== "string" || typeof body.commit !== "string") throw new HttpError(422, "path and commit required");
    try {
      await workspace.resetFileToCommit(body.path, body.commit);
      return c.json({ path: body.path, commit: body.commit, status: "ok" });
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : String(e));
    }
  });

  // ── knowledge 同步 ──
  app.post("/api/workspace/knowledge/sync", async (c) => {
    getCurrentUser(c, auth);
    return c.json(await knowledgeSync.fetchRemote());
  });
  app.get("/api/workspace/knowledge/sync-status", (c) => {
    getCurrentUser(c, auth);
    return c.json(knowledgeSync.getSyncStatus());
  });
  app.get("/api/workspace/knowledge/sync-meta", (c) => {
    getCurrentUser(c, auth);
    return c.json(knowledgeSync.getSyncMeta());
  });

  // ── skills 同步 ──
  app.post("/api/workspace/skills/sync", async (c) => {
    getCurrentUser(c, auth);
    const local = skillsSync.fetch();
    const remote = await skillsSync.fetchRemote();
    return c.json({ ...local, remote });
  });
  app.get("/api/workspace/skills/sync-meta", (c) => {
    getCurrentUser(c, auth);
    return c.json(skillsSync.getSyncMeta());
  });

  // ── workspace assistant ──
  const buildSystemPrompt = (): string => {
    let storesList: string;
    try {
      const stores = db.prepare("SELECT name, id, browser_backend FROM stores").all() as { name: string; id: string; browser_backend: string | null }[];
      if (stores.length > 0) {
        storesList = stores
          .map((s) => {
            const slug = storeSlug(s.name, s.id);
            const backend = s.browser_backend || "chrome";
            return `- **${s.name}** (slug: \`${slug}\`, backend: ${backend})`;
          })
          .join("\n");
      } else {
        storesList = "_No stores configured yet._";
      }
    } catch {
      storesList = "_Unable to load stores._";
    }
    return WORKSPACE_ASSISTANT_PROMPT.replace("{stores_list}", storesList);
  };

  app.post("/api/workspace/assistant/message", async (c) => {
    const user = getCurrentUser(c, auth);
    const body = (await c.req.json().catch(() => ({}))) as { content?: string; profile_id?: string };
    if (!body.content || !body.content.trim()) throw new HttpError(400, "Message cannot be empty");
    const profileId = body.profile_id || DEFAULT_PROFILE_ID;
    const systemPrompt = buildSystemPrompt();
    const started = await assistant.sendOrStart(user.id, body.content, profileId, systemPrompt);
    return c.json({ ok: started, user_id: user.id });
  });

  app.post("/api/workspace/assistant/stop", (c) => {
    const user = getCurrentUser(c, auth);
    const stopped = assistant.stop(user.id);
    return c.json({ ok: stopped });
  });

  app.get("/api/workspace/assistant/status", (c) => {
    const user = getCurrentUser(c, auth);
    return c.json({ running: assistant.isRunning(user.id) });
  });
}
