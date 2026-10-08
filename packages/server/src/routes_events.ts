// 批次 4.6 路由：events(13)。契约对齐 app/routers/events.py：
// 状态机 VALID_TRANSITIONS 逐字；assignees/extra_data JSON 列原样；
// 发 event_created / event_updated / event_activity SSE。admin 门按原实现
// （backends/configure 无 admin 门——逐字核对过，全部端点只要登录用户）。

import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { HttpError } from "./types";
import { getCurrentUser, type AuthContext } from "./auth";
import type { ServerConfig } from "./config";
import { BackendConfigStore, EventSyncer, backendNames } from "./events/syncer";

export interface EventDeps {
  config: ServerConfig;
  db: DatabaseSync;
  auth: AuthContext;
  bus: { emit: (type: string, data: Record<string, unknown>) => void };
  /** 测试注入 syncer 的传输层。 */
  syncFetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

const VALID_STATUSES = new Set(["draft", "open", "in_progress", "waiting", "resolved", "closed", "dismissed"]);
const VALID_TRANSITIONS: Record<string, Set<string>> = {
  draft: new Set(["open", "dismissed"]),
  open: new Set(["in_progress", "waiting", "resolved", "closed", "dismissed"]),
  in_progress: new Set(["waiting", "resolved", "closed"]),
  waiting: new Set(["in_progress", "resolved", "closed"]),
  resolved: new Set(["closed", "open"]),
  closed: new Set(["open"]),
  dismissed: new Set(["open"]),
};

interface EventRow {
  id: string;
  channel_message_id: string | null;
  channel_type: string | null;
  store_id: string | null;
  title: string;
  description: string | null;
  event_date: string | null;
  deadline: string | null;
  platform: string | null;
  source_text: string | null;
  status: string | null;
  sync_backend: string | null;
  sync_id: string | null;
  sync_error: string | null;
  case_id: string | null;
  assignees: string | null;
  created_by: string | null;
  priority: number | null;
  created_at: string | null;
  updated_at: string | null;
}

function eventResponse(e: EventRow): Record<string, unknown> {
  return {
    id: e.id,
    channel_message_id: e.channel_message_id,
    channel_type: e.channel_type,
    store_id: e.store_id,
    title: e.title,
    description: e.description,
    event_date: e.event_date,
    deadline: e.deadline,
    platform: e.platform,
    source_text: e.source_text,
    status: e.status,
    sync_backend: e.sync_backend,
    sync_id: e.sync_id,
    sync_error: e.sync_error,
    case_id: e.case_id,
    assignees: e.assignees,
    created_by: e.created_by,
    priority: e.priority ?? 0,
    created_at: e.created_at,
    updated_at: e.updated_at,
  };
}

interface ActivityRow {
  id: string;
  event_id: string;
  user_id: string | null;
  actor_type: string | null;
  action: string;
  content: string;
  extra_data: string | null;
  created_at: string | null;
}

function activityResponse(a: ActivityRow): Record<string, unknown> {
  return {
    id: a.id,
    event_id: a.event_id,
    user_id: a.user_id,
    actor_type: a.actor_type,
    action: a.action,
    content: a.content,
    extra_data: a.extra_data,
    created_at: a.created_at,
  };
}

export function registerEventRoutes(app: Hono, deps: EventDeps): void {
  const { db, auth, bus, config } = deps;
  const configs = new BackendConfigStore(config.homeDir);
  const syncer = new EventSyncer(configs, deps.syncFetch);

  const getEventOr404 = (id: string): EventRow => {
    const row = db.prepare("SELECT * FROM events WHERE id = ?").get(id) as EventRow | undefined;
    if (!row) throw new HttpError(404, "Event not found");
    return row;
  };

  const logActivity = (
    eventId: string,
    userId: string | null,
    actorType: string,
    action: string,
    content: string,
    extraData?: Record<string, unknown>,
  ): ActivityRow => {
    const id = randomUUID();
    db.prepare(
      "INSERT INTO event_activities (id, event_id, user_id, actor_type, action, content, extra_data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(id, eventId, userId, actorType, action, content, extraData ? JSON.stringify(extraData) : null, new Date().toISOString());
    const activity = db.prepare("SELECT * FROM event_activities WHERE id = ?").get(id) as unknown as ActivityRow;
    bus.emit("event_activity", { event_id: eventId, activity_id: id, actor_type: actorType, action, content });
    return activity;
  };

  // ── 列表（status 逗号分隔多值 / store_id / category） ──
  app.get("/api/events", (c) => {
    getCurrentUser(c, auth);
    let sql = "SELECT * FROM events";
    const where: string[] = [];
    const params: string[] = [];
    const status = c.req.query("status");
    if (status) {
      const statuses = status
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (statuses.length === 1) {
        where.push("status = ?");
        params.push(statuses[0]!);
      } else if (statuses.length > 1) {
        where.push(`status IN (${statuses.map(() => "?").join(",")})`);
        params.push(...statuses);
      }
    }
    const storeId = c.req.query("store_id");
    if (storeId) {
      where.push("store_id = ?");
      params.push(storeId);
    }
    const category = c.req.query("category");
    if (category === "user") where.push("platform != 'system'");
    else if (category === "system") where.push("platform = 'system'");
    if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
    sql += " ORDER BY created_at DESC";
    const rows = db.prepare(sql).all(...params) as unknown as EventRow[];
    return c.json(rows.map(eventResponse));
  });

  app.post("/api/events", async (c) => {
    const user = getCurrentUser(c, auth);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (!body["title"]) throw new HttpError(422, "title required");
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO events (id, channel_message_id, channel_type, store_id, title, description, event_date, deadline,
                           platform, source_text, status, sync_backend, sync_id, sync_error, case_id, assignees,
                           created_by, priority, created_at, updated_at)
       VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, ?, NULL, 'open', ?, NULL, NULL, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      (body["store_id"] as string) ?? null,
      String(body["title"]),
      (body["description"] as string) ?? null,
      (body["event_date"] as string) ?? null,
      (body["deadline"] as string) ?? null,
      (body["platform"] as string) ?? null,
      (body["sync_backend"] as string) ?? null,
      (body["case_id"] as string) ?? null,
      (body["assignees"] as string) ?? null,
      user.id,
      Number(body["priority"] ?? 0),
      now,
      now,
    );
    const event = getEventOr404(id);
    logActivity(id, user.id, "user", "created", `Event created: ${event.title}`);
    bus.emit("event_created", { event_id: id, title: event.title, status: event.status });
    return c.json(eventResponse(event));
  });

  // ── backends ──
  app.get("/api/events/backends", (c) => {
    getCurrentUser(c, auth);
    return c.json(backendNames().map((name) => ({ name, configured: Boolean(Object.keys(configs.load(name)).length) })));
  });

  app.post("/api/events/backends/configure", async (c) => {
    getCurrentUser(c, auth);
    const body = (await c.req.json().catch(() => ({}))) as { backend?: string; config?: Record<string, unknown> };
    if (!body.backend || !(backendNames() as string[]).includes(body.backend)) throw new HttpError(400, `Unknown backend: ${body.backend}`);
    configs.save(body.backend, body.config ?? {});
    return c.json({ ok: true, backend: body.backend });
  });

  app.get("/api/events/:event_id", (c) => {
    getCurrentUser(c, auth);
    return c.json(eventResponse(getEventOr404(c.req.param("event_id") ?? "")));
  });

  app.put("/api/events/:event_id", async (c) => {
    getCurrentUser(c, auth);
    const event = getEventOr404(c.req.param("event_id") ?? "");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const fields: Record<string, unknown> = {};
    for (const key of ["title", "description", "event_date", "deadline", "platform", "sync_backend", "case_id", "assignees", "priority", "store_id"]) {
      if (key in body) fields[key] = body[key];
    }
    if (Object.keys(fields).length) {
      const sets = Object.keys(fields).map((k) => `${k} = ?`);
      const values = Object.values(fields).map((v) => (v === null ? null : typeof v === "number" ? v : String(v)));
      db.prepare(`UPDATE events SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...values, new Date().toISOString(), event.id);
    } else {
      db.prepare("UPDATE events SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), event.id);
    }
    return c.json(eventResponse(getEventOr404(event.id)));
  });

  app.post("/api/events/:event_id/status", async (c) => {
    const user = getCurrentUser(c, auth);
    const event = getEventOr404(c.req.param("event_id") ?? "");
    const body = (await c.req.json().catch(() => ({}))) as { status?: string };
    const newStatus = body.status ?? "";
    if (!VALID_STATUSES.has(newStatus)) throw new HttpError(400, `Invalid status: ${newStatus}`);
    const allowed = VALID_TRANSITIONS[event.status ?? ""] ?? new Set();
    if (!allowed.has(newStatus)) throw new HttpError(400, `Cannot transition from ${event.status} to ${newStatus}`);
    const oldStatus = event.status;
    db.prepare("UPDATE events SET status = ?, updated_at = ? WHERE id = ?").run(newStatus, new Date().toISOString(), event.id);
    logActivity(event.id, user.id, "user", "status_changed", `Status changed: ${oldStatus} -> ${newStatus}`, { old_status: oldStatus, new_status: newStatus });
    bus.emit("event_updated", { event_id: event.id, status: newStatus, old_status: oldStatus });
    return c.json(eventResponse(getEventOr404(event.id)));
  });

  app.post("/api/events/:event_id/confirm", async (c) => {
    const user = getCurrentUser(c, auth);
    const event = getEventOr404(c.req.param("event_id") ?? "");
    if (event.status !== "draft") throw new HttpError(400, `Cannot confirm event in status ${event.status}`);
    const oldStatus = event.status;
    db.prepare("UPDATE events SET status = 'open', updated_at = ? WHERE id = ?").run(new Date().toISOString(), event.id);
    logActivity(event.id, user.id, "user", "status_changed", `Confirmed: ${oldStatus} -> open`, { old_status: oldStatus, new_status: "open" });
    // 已配置 sync_backend → 自动同步
    if (event.sync_backend) {
      try {
        const syncId = await syncer.syncEvent(event.sync_backend, event.title, event.description, event.event_date, event.deadline);
        db.prepare("UPDATE events SET sync_id = ?, sync_error = NULL WHERE id = ?").run(syncId, event.id);
        logActivity(event.id, null, "system", "synced", `Synced to ${event.sync_backend}`);
      } catch (e) {
        db.prepare("UPDATE events SET sync_error = ? WHERE id = ?").run(e instanceof Error ? e.message : String(e), event.id);
      }
    }
    const updated = getEventOr404(event.id);
    bus.emit("event_updated", { event_id: event.id, status: updated.status });
    return c.json(eventResponse(updated));
  });

  // 注意：activities 的 GET 在 /:event_id/activities（FastAPI 同款路由顺序）
  app.get("/api/events/:event_id/activities", (c) => {
    getCurrentUser(c, auth);
    const rows = db
      .prepare("SELECT * FROM event_activities WHERE event_id = ? ORDER BY created_at")
      .all(c.req.param("event_id") ?? "") as unknown as ActivityRow[];
    return c.json(rows.map(activityResponse));
  });

  app.post("/api/events/:event_id/activities", async (c) => {
    const user = getCurrentUser(c, auth);
    const event = getEventOr404(c.req.param("event_id") ?? "");
    const body = (await c.req.json().catch(() => ({}))) as { action?: string; content?: string };
    if (!body.content) throw new HttpError(422, "content required");
    const actorType = user.role === "ai_bot" ? "ai" : "user";
    const activity = logActivity(event.id, user.id, actorType, body.action ?? "note_added", body.content);
    db.prepare("UPDATE events SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), event.id);
    return c.json(activityResponse(activity));
  });

  app.post("/api/events/:event_id/dismiss", async (c) => {
    const user = getCurrentUser(c, auth);
    const event = getEventOr404(c.req.param("event_id") ?? "");
    const oldStatus = event.status;
    db.prepare("UPDATE events SET status = 'dismissed', updated_at = ? WHERE id = ?").run(new Date().toISOString(), event.id);
    logActivity(event.id, user.id, "user", "status_changed", `Dismissed: ${oldStatus} -> dismissed`, { old_status: oldStatus, new_status: "dismissed" });
    return c.json(eventResponse(getEventOr404(event.id)));
  });

  app.post("/api/events/:event_id/sync", async (c) => {
    getCurrentUser(c, auth);
    const event = getEventOr404(c.req.param("event_id") ?? "");
    if (!event.sync_backend) throw new HttpError(400, "No sync backend configured for this event");
    try {
      if (event.sync_id) {
        await syncer.updateEvent(event.sync_backend, event.sync_id, event.title, event.description, event.event_date, event.deadline);
      } else {
        const syncId = await syncer.syncEvent(event.sync_backend, event.title, event.description, event.event_date, event.deadline);
        db.prepare("UPDATE events SET sync_id = ? WHERE id = ?").run(syncId, event.id);
      }
      db.prepare("UPDATE events SET sync_error = NULL WHERE id = ?").run(event.id);
      logActivity(event.id, null, "system", "synced", `Synced to ${event.sync_backend}`);
    } catch (e) {
      db.prepare("UPDATE events SET sync_error = ? WHERE id = ?").run(e instanceof Error ? e.message : String(e), event.id);
    }
    db.prepare("UPDATE events SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), event.id);
    return c.json(eventResponse(getEventOr404(event.id)));
  });

  app.delete("/api/events/:event_id", async (c) => {
    getCurrentUser(c, auth);
    const event = getEventOr404(c.req.param("event_id") ?? "");
    // 已同步 → 尽力删远端（失败仅告警，与原实现一致）
    if (event.sync_id && event.sync_backend) {
      try {
        await syncer.deleteEvent(event.sync_backend, event.sync_id);
      } catch (e) {
        console.warn(`[vibe-server] Failed to delete event from backend: ${e instanceof Error ? e.message : e}`);
      }
    }
    db.prepare("DELETE FROM event_activities WHERE event_id = ?").run(event.id);
    db.prepare("DELETE FROM events WHERE id = ?").run(event.id);
    return c.json({ ok: true });
  });
}
