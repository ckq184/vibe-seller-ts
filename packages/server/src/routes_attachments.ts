// 批次 4.6 路由：screenshots(1) + attachments(3)。契约对齐 app/routers/
// screenshots.py、attachments.py。附件写入任务工作区 uploads/（agent cwd 可读），
// 元数据落 task_attachments；类型/大小契约见 uploads.ts。

import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { HttpError } from "./types";
import { getCurrentUser, type AuthContext } from "./auth";
import type { ServerConfig } from "./config";
import { readSingleFilePart, saveUpload } from "./routes_vision";
import { rejectDisallowedType } from "./uploads";

export interface AttachmentDeps {
  config: ServerConfig;
  db: DatabaseSync;
  auth: AuthContext;
}

interface AttachmentRow {
  id: string;
  task_id: string;
  file_name: string;
  file_path: string;
  file_type: string;
  file_size: number;
  created_at: string | null;
}

function attachmentResponse(a: AttachmentRow): Record<string, unknown> {
  return {
    id: a.id,
    task_id: a.task_id,
    file_name: a.file_name,
    file_type: a.file_type,
    file_size: a.file_size,
    created_at: a.created_at,
  };
}

export function registerAttachmentRoutes(app: Hono, deps: AttachmentDeps): void {
  const { db, auth, config } = deps;
  const tasksDir = join(config.homeDir, "tasks");

  app.get("/api/screenshots/:screenshot_id", (c) => {
    getCurrentUser(c, auth);
    const row = db.prepare("SELECT * FROM screenshots WHERE id = ?").get(c.req.param("screenshot_id") ?? "") as { file_path: string } | undefined;
    if (!row) throw new HttpError(404, "Screenshot not found");
    if (!existsSync(row.file_path)) throw new HttpError(404, "Screenshot file not found");
    return c.body(new Uint8Array(readFileSync(row.file_path)), 200, { "content-type": "image/png" });
  });

  app.post("/api/attachments/:task_id", async (c) => {
    getCurrentUser(c, auth);
    const taskId = c.req.param("task_id") ?? "";
    if (!db.prepare("SELECT id FROM tasks WHERE id = ?").get(taskId)) throw new HttpError(404, "Task not found");
    const upload = await readSingleFilePart(c);
    rejectDisallowedType(upload.contentType);

    const attachmentId = randomUUID();
    // 写进任务工作区 uploads/（agent 可 Read）；data/attachments 曾是 DB blob
    // agent 看不见——历史教训（原实现注释同款）。
    const ext = (upload.filename.includes(".") ? upload.filename.slice(upload.filename.lastIndexOf(".")) : "").toLowerCase() || ".bin";
    const stem = (upload.filename.includes(".") ? upload.filename.slice(0, upload.filename.lastIndexOf(".")) : upload.filename).replace(/[^A-Za-z0-9._-]/g, "_") || "upload";
    const outDir = join(tasksDir, taskId, "uploads");
    mkdirSync(outDir, { recursive: true });
    let filePath = join(outDir, `${stem}${ext}`);
    if (existsSync(filePath)) filePath = join(outDir, `${stem}-${attachmentId.slice(0, 6)}${ext}`);
    const fileSize = await saveUpload(upload.data, filePath);

    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO task_attachments (id, task_id, file_name, file_path, file_type, file_size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(attachmentId, taskId, upload.filename || "untitled", filePath, upload.contentType || "application/octet-stream", fileSize, now);
    return c.json(attachmentResponse({ id: attachmentId, task_id: taskId, file_name: upload.filename || "untitled", file_path: filePath, file_type: upload.contentType || "application/octet-stream", file_size: fileSize, created_at: now }));
  });

  app.get("/api/attachments/:task_id", (c) => {
    getCurrentUser(c, auth);
    const rows = db.prepare("SELECT * FROM task_attachments WHERE task_id = ?").all(c.req.param("task_id") ?? "") as unknown as AttachmentRow[];
    return c.json(rows.map(attachmentResponse));
  });

  app.get("/api/attachments/file/:attachment_id", (c) => {
    getCurrentUser(c, auth);
    const row = db.prepare("SELECT * FROM task_attachments WHERE id = ?").get(c.req.param("attachment_id") ?? "") as AttachmentRow | undefined;
    if (!row) throw new HttpError(404, "Attachment not found");
    if (!existsSync(row.file_path)) throw new HttpError(404, "File not found on disk");
    return c.body(new Uint8Array(readFileSync(row.file_path)), 200, {
      "content-type": row.file_type,
      "content-disposition": `attachment; filename="${row.file_name.replace(/["\\]/g, "_")}"`,
    });
  });
}
