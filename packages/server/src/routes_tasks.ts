// 批次 4.2 路由：stores（DB 面 6）+ tasks（CRUD 面 7）+ task_messages 读。
// 契约对齐 app/routers/stores.py、app/routers/tasks.py；
// agent 执行类端点（start/design/execute-plan/agent/*、result、wake）留批次 4.3 —— 501。

import { Hono, type Context } from "hono";
import { mkdirSync, existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { HttpError } from "./types";
import { getCurrentUser, type AuthContext } from "./auth";
import { ACTIVE, canTransition, DESIGNABLE, RETRIABLE, STARTABLE, WAKEABLE } from "./task_states";
import { AGENT_REPORTED } from "./agent/outcome";
import { ActiveTaskError, deleteTaskCascade } from "./scheduler/reapers";
import * as telemetry from "./telemetry/core";
import { TelemetryEvent } from "./telemetry/events";
import { profileKindForId } from "./telemetry/tasks";
import type { TaskOrchestrator } from "./agent/orchestrator";
import type { ServerConfig } from "./config";
import { readTextSync, writeTextSync } from "./workspace/textio";

export interface TaskDeps {
  config: ServerConfig;
  db: DatabaseSync;
  auth: AuthContext;
  bus: {
    emit: (type: string, data: Record<string, unknown>) => void;
  };
  orchestrator: TaskOrchestrator;
  /** 店铺档案脚手架（WorkspaceManager.createStoreProfile；app.ts 注入）。 */
  createStoreProfile?: (
    slug: string,
    name: string,
    platform?: string,
    country?: string,
    backend?: string,
  ) => Promise<unknown>;
}

interface StoreRow {
  id: string;
  name: string;
  browser_backend: string;
  browser_config: string | null;
  ziniao_account_id: string | null;
  browser_oauth: string | null;
  platforms: string | null;
  countries: string | null;
  platform_countries: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskRow {
  id: string;
  parent_task_id: string | null;
  store_id: string | null;
  schedule_id: string | null;
  created_by: string;
  title: string;
  description: string | null;
  platform: string | null;
  country: string | null;
  status: string;
  plan: string | null;
  plan_history: string | null;
  result: string | null;
  submitted_result: string | null;
  review_gaps: string | null;
  submission_count: number | null;
  todos: string | null;
  error: string | null;
  error_category: string | null;
  wait_condition: string | null;
  batch_id: string | null;
  plan_mode: number | null;
  is_plan_only: number | null;
  ai_profile_id: string | null;
  session_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** 原 stores.py:530 _replace_name_in_md_files：.md 文件里的旧店名引用替换
 *（rglob 逐文件 try/except warning——单文件失败不挡改名）。批次 4.7 整改 E1：
 * 目录遍历的 readdir/stat 同样逐条目容错 continue——此前一条 statSync 失败
 * （竞态删除/坏符号链接）会中止整个 walk，与"单文件失败不挡改名"的语义相悖。 */
function replaceNameInMdFiles(directory: string, oldName: string, newName: string): void {
  if (!existsSync(directory)) return;
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // 原 rglob 对不可读目录产出空序列——跳过该子树
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let isDirectory: boolean;
      try {
        isDirectory = statSync(full).isDirectory();
      } catch {
        continue; // 消失/不可 stat 的条目：对齐 Python 逐文件 warning 语义，跳过不中止
      }
      if (isDirectory) walk(full);
      else if (entry.endsWith(".md")) {
        try {
          const content = readTextSync(full);
          if (content.includes(oldName)) writeTextSync(full, content.split(oldName).join(newName));
        } catch {
          /* 原 logger.warning 等价 */
        }
      }
    }
  };
  walk(directory);
}

function storeSlug(name: string, id: string): string {
  // 原 browser/wrapper.py store_slug：ASCII 归约非空时直接用归约名（无后缀），
  // 仅归约为空才回退 store-<id 前 8 位>。批次 4.7.2 录制回放对齐——此前恒拼
  // id 后缀，店铺工作区目录名与原实现漂移（replay-store-renamed vs
  // replay-store-renamed-c82f5251）。
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/_/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || `store-${id.slice(0, 8)}`;
}

function storeResponse(s: StoreRow): Record<string, unknown> {
  return {
    id: s.id,
    name: s.name,
    browser_backend: s.browser_backend,
    browser_config: parseJson<Record<string, unknown>>(s.browser_config, {}),
    ziniao_account_id: s.ziniao_account_id,
    browser_oauth: s.browser_oauth,
    platforms: parseJson<string[]>(s.platforms, []),
    countries: parseJson<string[]>(s.countries, []),
    platform_countries: parseJson<Record<string, string[]>>(s.platform_countries, {}),
    created_at: s.created_at,
    updated_at: s.updated_at,
  };
}

export function taskResponse(t: TaskRow, creatorNames: Map<string, string>): Record<string, unknown> {
  return {
    id: t.id,
    parent_task_id: t.parent_task_id,
    store_id: t.store_id,
    schedule_id: t.schedule_id,
    title: t.title,
    description: t.description,
    platform: t.platform,
    country: t.country,
    status: t.status,
    plan: t.plan,
    plan_history: t.plan_history,
    result: t.result,
    submitted_result: t.submitted_result,
    review_gaps: t.review_gaps,
    submission_count: t.submission_count ?? 0,
    todos: t.todos,
    error: t.error,
    error_category: t.error_category,
    wait_condition: t.wait_condition,
    batch_id: t.batch_id,
    plan_mode: Boolean(t.plan_mode),
    is_plan_only: Boolean(t.is_plan_only),
    ai_profile_id: t.ai_profile_id,
    session_id: t.session_id,
    started_at: t.started_at,
    completed_at: t.completed_at,
    created_by_name: creatorNames.get(t.created_by) ?? "admin",
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}

export function creatorNames(db: DatabaseSync, tasks: TaskRow[]): Map<string, string> {
  const map = new Map<string, string>();
  const ids = [...new Set(tasks.map((t) => t.created_by).filter(Boolean))];
  for (const id of ids) {
    const row = db.prepare("SELECT username FROM users WHERE id = ?").get(id) as { username: string } | undefined;
    if (row) map.set(id, row.username);
  }
  return map;
}

/** 阻塞改名/删除的状态：ACTIVE + queued（对齐 _BLOCKING_STATUSES）。 */
const BLOCKING = new Set([...ACTIVE, "queued"]);

function taskStepResponse(r: Record<string, unknown>): Record<string, unknown> {
  return {
    id: r.id,
    task_id: r.task_id,
    step_index: r.step_index,
    name: r.name,
    action_type: r.action_type,
    status: r.status,
    screenshot_id: r.screenshot_id,
    error: r.error,
  };
}

export function registerTaskRoutes(app: Hono, deps: TaskDeps): void {
  const { db, auth, bus, config, orchestrator, createStoreProfile } = deps;
  const nowIso = () => new Date().toISOString();
  const storeDir = (name: string, id: string) => join(config.homeDir, "stores", storeSlug(name, id));

  // ── stores ──
  app.get("/api/stores", (c: Context) => {
    getCurrentUser(c, auth);
    // 按最近任务更新排序（无任务的店铺靠后），再按创建时间倒序
    const rows = db
      .prepare(
        `SELECT s.*, COALESCE(lt.last_task_at, '') AS last_task_at
         FROM stores s
         LEFT JOIN (SELECT store_id, MAX(updated_at) AS last_task_at FROM tasks WHERE store_id IS NOT NULL GROUP BY store_id) lt
           ON s.id = lt.store_id
         ORDER BY last_task_at DESC, s.created_at DESC`,
      )
      .all() as unknown as StoreRow[];
    return c.json(rows.map(storeResponse));
  });

  app.post("/api/stores", async (c: Context) => {
    getCurrentUser(c, auth);
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      browser_backend?: string;
      browser_config?: Record<string, unknown>;
      ziniao_account_id?: string | null;
      browser_oauth?: string | null;
      platforms?: string[];
      countries?: string[];
      platform_countries?: Record<string, string[]>;
    };
    if (!body.name) throw new HttpError(422, "name required");
    const id = crypto.randomUUID();
    const now = nowIso();
    db.prepare(
      `INSERT INTO stores (id, name, browser_backend, browser_config, ziniao_account_id, browser_oauth,
                           platforms, countries, platform_countries, capabilities, config, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', NULL, ?, ?)`,
    ).run(
      id,
      body.name,
      body.browser_backend ?? "chrome",
      JSON.stringify(body.browser_config ?? {}),
      body.ziniao_account_id ?? null,
      body.browser_oauth ?? null,
      JSON.stringify(body.platforms ?? ["amazon"]),
      JSON.stringify(body.countries ?? ["US"]),
      JSON.stringify(body.platform_countries ?? {}),
      now,
      now,
    );
    // 店铺工作区目录 + metadata.json + 档案脚手架（原 stores.py:108-133，
    // best-effort：失败只 warning 不挡创建）
    try {
      const slug = storeSlug(body.name, id);
      const dir = storeDir(body.name, id);
      mkdirSync(dir, { recursive: true });
      const metaFile = join(dir, "metadata.json");
      if (!existsSync(metaFile)) {
        // 原经 Python 文本模式写（win32 CRLF，fixture size 63 = 57 LF + 6）
        writeTextSync(metaFile, JSON.stringify({ platforms: body.platform_countries ?? {} }, null, 2));
      }
      // STORE.md / notes.md / logistics.md / CATALOG.md 桩（create_store_profile）
      const platforms = body.platforms ?? ["amazon"];
      const countries = body.countries ?? ["US"];
      await createStoreProfile?.(slug, body.name, platforms[0] ?? "", countries[0] ?? "", body.browser_backend ?? "chrome");
    } catch {
      /* best-effort */
    }
    // 原 stores.py:98：commit 后统计（含新店）→ is_first_store = count <= 1
    const existingCount = (db.prepare("SELECT COUNT(*) AS n FROM stores").get() as { n: number }).n;
    telemetry.send(TelemetryEvent.STORE_CREATED, {
      browser_backend: body.browser_backend ?? "chrome",
      platform_count: (body.platforms ?? ["amazon"]).length,
      country_count: (body.countries ?? ["US"]).length,
      is_first_store: existingCount <= 1,
    });
    const row = db.prepare("SELECT * FROM stores WHERE id = ?").get(id) as unknown as StoreRow;
    return c.json(storeResponse(row));
  });

  app.put("/api/stores/:store_id", async (c: Context) => {
    getCurrentUser(c, auth);
    const storeId = (c.req.param("store_id") ?? "");
    const store = db.prepare("SELECT * FROM stores WHERE id = ?").get(storeId) as unknown as StoreRow | undefined;
    if (!store) throw new HttpError(404, "Store not found");
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      browser_config?: Record<string, unknown>;
      platforms?: string[];
      countries?: string[];
      platform_countries?: Record<string, string[]>;
    };
    if (body.name !== undefined && body.name !== store.name) {
      const blocking = db
        .prepare("SELECT COUNT(*) AS n FROM tasks WHERE store_id = ? AND status IN ('designing','running','queued')")
        .get(storeId) as { n: number };
      if (blocking.n > 0) throw new HttpError(409, "Cannot rename store with active tasks");
      const activeBrowser = db
        .prepare("SELECT id FROM browser_sessions WHERE store_id = ? AND status = 'running'")
        .get(storeId);
      if (activeBrowser) throw new HttpError(409, "Cannot rename store with active browser session. Stop the browser first.");
      const dup = db.prepare("SELECT id FROM stores WHERE name = ? AND id != ?").get(body.name, storeId);
      if (dup) throw new HttpError(409, "A store with this name already exists");
      // 工作区/浏览器 profile 目录改名（best-effort；wrapper 清理属浏览器层，4.6 接管）
      const oldDir = storeDir(store.name, store.id);
      const newDir = storeDir(body.name, store.id);
      if (oldDir !== newDir && existsSync(oldDir)) {
        try {
          mkdirSync(join(newDir, ".."), { recursive: true });
          rmSync(newDir, { recursive: true, force: true });
          const { renameSync } = await import("node:fs");
          renameSync(oldDir, newDir);
          // 原 stores.py:209 _replace_name_in_md_files：.md 里的旧店名引用替换
          replaceNameInMdFiles(newDir, store.name, body.name);
        } catch {
          /* best-effort */
        }
      }
      db.prepare("UPDATE stores SET name = ? WHERE id = ?").run(body.name, storeId);
    }
    if (body.browser_config !== undefined)
      db.prepare("UPDATE stores SET browser_config = ? WHERE id = ?").run(JSON.stringify(body.browser_config), storeId);
    if (body.platforms !== undefined)
      db.prepare("UPDATE stores SET platforms = ? WHERE id = ?").run(JSON.stringify(body.platforms), storeId);
    if (body.countries !== undefined)
      db.prepare("UPDATE stores SET countries = ? WHERE id = ?").run(JSON.stringify(body.countries), storeId);
    if (body.platform_countries !== undefined)
      db.prepare("UPDATE stores SET platform_countries = ? WHERE id = ?").run(JSON.stringify(body.platform_countries), storeId);
    db.prepare("UPDATE stores SET updated_at = ? WHERE id = ?").run(nowIso(), storeId);
    const row = db.prepare("SELECT * FROM stores WHERE id = ?").get(storeId) as unknown as StoreRow;
    return c.json(storeResponse(row));
  });

  app.get("/api/stores/:store_id", (c: Context) => {
    getCurrentUser(c, auth);
    const store = db.prepare("SELECT * FROM stores WHERE id = ?").get((c.req.param("store_id") ?? "")) as unknown as
      | StoreRow
      | undefined;
    if (!store) throw new HttpError(404, "Store not found");
    return c.json(storeResponse(store));
  });

  app.delete("/api/stores/:store_id", (c: Context) => {
    getCurrentUser(c, auth);
    const storeId = (c.req.param("store_id") ?? "");
    const store = db.prepare("SELECT * FROM stores WHERE id = ?").get(storeId) as unknown as StoreRow | undefined;
    if (!store) return c.json({ ok: true }); // 幂等
    const blocking = db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE store_id = ? AND status IN ('designing','running','queued')")
      .get(storeId) as { n: number };
    if (blocking.n > 0) throw new HttpError(409, "Cannot delete store with active tasks");
    // 遥测快照要在级联删除抹掉行之前取（原 stores.py:293-301 注释同义）
    const taskCountAtDeletion = (db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE store_id = ?").get(storeId) as { n: number }).n;
    // 清理引用表（SQLite 无级联，与原实现同序）；browser 停止属 4.6
    db.prepare("DELETE FROM store_email_links WHERE store_id = ?").run(storeId);
    db.prepare("DELETE FROM browser_sessions WHERE store_id = ?").run(storeId);
    db.prepare("DELETE FROM schedules WHERE store_id = ?").run(storeId);
    db.prepare("DELETE FROM tasks WHERE store_id = ?").run(storeId);
    db.prepare("UPDATE events SET store_id = NULL WHERE store_id = ?").run(storeId);
    // 店铺年龄（天）：created_at 解析失败 → unknown（原 stores.py:336-343）
    let ageDays: number | null = null;
    if (store.created_at) {
      const createdMs = Date.parse(store.created_at);
      if (!Number.isNaN(createdMs)) ageDays = (Date.now() - createdMs) / 86_400_000;
    }
    db.prepare("DELETE FROM stores WHERE id = ?").run(storeId);
    // 原 stores.py:348：删除落库后发
    telemetry.send(TelemetryEvent.STORE_DELETED, {
      browser_backend: store.browser_backend,
      task_count_at_deletion_bucket: telemetry.countBucket(taskCountAtDeletion || 0),
      age_bucket: telemetry.ageBucketDays(ageDays),
    });
    const deleteFiles = c.req.query("delete_files") === "true";
    if (deleteFiles) {
      try {
        rmSync(storeDir(store.name, store.id), { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    return c.json({ ok: true });
  });

  // bookmarks（4.6 收回）：读店铺浏览器 profile 的 Bookmarks 文件（chrome 后端持久
  // profile 或 browser-use per-session profile；ziniao 加密恒 []）。browser/start
  // 在 routes_browser.ts（进程编排属浏览器调用面）。

  // ── tasks ──
  app.get("/api/tasks", (c: Context) => {
    getCurrentUser(c, auth);
    const storeId = c.req.query("store_id") || null;
    const parentTaskId = c.req.query("parent_task_id") || null;
    const includeArchived = c.req.query("include_archived") !== "false";
    let sql = "SELECT * FROM tasks";
    const where: string[] = [];
    const params: string[] = [];
    if (storeId === "__none__") where.push("store_id IS NULL");
    else if (storeId) {
      where.push("store_id = ?");
      params.push(storeId);
    }
    if (parentTaskId) {
      where.push("parent_task_id = ?");
      params.push(parentTaskId);
    }
    if (!includeArchived) {
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      where.push("NOT (status IN ('completed','failed') AND updated_at < ?)");
      params.push(cutoff);
    }
    if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
    sql += " ORDER BY created_at DESC";
    const rows = db.prepare(sql).all(...params) as unknown as TaskRow[];
    const names = creatorNames(db, rows);
    return c.json(rows.map((t) => taskResponse(t, names)));
  });

  app.post("/api/tasks", async (c: Context) => {
    const user = getCurrentUser(c, auth);
    const body = (await c.req.json().catch(() => ({}))) as {
      store_id?: string | null;
      parent_task_id?: string | null;
      title?: string;
      description?: string | null;
      platform?: string | null;
      country?: string | null;
      plan_mode?: boolean | null;
      skip_reflection?: boolean | null;
      profile_id?: string | null;
      schedule_id?: string | null;
      defer_start?: boolean;
    };
    if (!body.title) throw new HttpError(422, "title required");
    if (body.store_id) {
      const store = db.prepare("SELECT id FROM stores WHERE id = ?").get(body.store_id);
      if (!store) throw new HttpError(404, "Store not found");
    }
    if (body.parent_task_id && !body.store_id) throw new HttpError(400, "Sub-tasks must have a store_id");

    // plan_mode 推导：无 store 任务恒 true；否则未指定时用用户默认
    let planMode = body.plan_mode;
    if (body.store_id == null) planMode = true;
    else if (planMode == null) planMode = Boolean(user.plan_mode_default);

    const id = crypto.randomUUID();
    const now = nowIso();
    const profileId =
      body.profile_id ||
      user.default_profile_id || // resolve_owner_profile 等价：用户默认档位
      "default";
    db.prepare(
      `INSERT INTO tasks (id, parent_task_id, store_id, schedule_id, template_id, created_by, assigned_to,
                          title, description, platform, country, status, priority, input_data,
                          plan, plan_history, result, accepted_result, submitted_result, review_gaps,
                          submission_count, transcript_tail, todos, error, error_category,
                          started_at, completed_at, plan_mode, is_plan_only, plan_version,
                          skip_reflection, wait_condition, batch_id, is_finalize, ai_profile_id,
                          session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, 'pending', 0, NULL,
               NULL, NULL, NULL, NULL, NULL, NULL,
               0, NULL, NULL, NULL, NULL,
               NULL, NULL, ?, 0, NULL, ?, NULL, NULL, 0, ?, NULL, ?, ?)`,
    ).run(
      id,
      body.parent_task_id ?? null,
      body.store_id ?? null,
      body.schedule_id ?? null,
      user.id,
      body.title,
      body.description ?? null,
      body.platform ?? null,
      body.country ?? null,
      planMode ? 1 : 0,
      body.skip_reflection ? 1 : 0,
      profileId,
      now,
      now,
    );
    // 完成态父任务被子任务重开（reopen_parent_if_child_active）
    if (body.parent_task_id) {
      db.prepare("UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ? AND status = 'completed'").run(now, body.parent_task_id);
    }
    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as unknown as TaskRow;
    const payload = taskResponse(row, creatorNames(db, [row]));
    // 先 task_created 后 task_update 的顺序是客户端依赖的契约
    bus.emit("task_created", { task_id: id, store_id: row.store_id, task: payload });
    // 遥测 task_created 与 SSE 总线的 task_created 同名不同物（PRD §3.3：两链路分开建模）。
    // 原 routers/tasks.py:198：plan_mode 取推导后的实际值。
    telemetry.send(TelemetryEvent.TASK_CREATED, {
      is_store_task: row.store_id !== null,
      plan_mode: Boolean(planMode),
      has_schedule: row.schedule_id !== null,
      has_parent: row.parent_task_id !== null,
      ai_profile_kind: profileKindForId(config.homeDir, row.ai_profile_id),
      description_length_bucket: telemetry.lengthBucket((row.description ?? "").length),
      created_by_role: user.role,
    });
    // defer_start / 执行编排（队列→agent）留 4.3：任务停在 pending
    void body.defer_start;
    // 原create_task 返回 ORM task 经 response_model 序列化——created_by_name 保持
    // 模型缺省 None（带 creator 名的 payload 只用于 SSE 广播，routers/tasks.py:187-216）。
    return c.json({ ...payload, created_by_name: null });
  });

  app.get("/api/tasks/:task_id", (c: Context) => {
    getCurrentUser(c, auth);
    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get((c.req.param("task_id") ?? "")) as unknown as
      | TaskRow
      | undefined;
    if (!row) throw new HttpError(404, "Task not found");
    return c.json(taskResponse(row, creatorNames(db, [row])));
  });

  app.delete("/api/tasks/:task_id", (c: Context) => {
    getCurrentUser(c, auth);
    const taskId = (c.req.param("task_id") ?? "");
    // 子树级联删除（原 task_delete.delete_task：子先删、FK 保持满足）
    try {
      deleteTaskCascade({ db, config }, taskId);
    } catch (err: unknown) {
      if (err instanceof ActiveTaskError) throw new HttpError(409, err.message);
      throw err;
    }
    return c.json({ ok: true });
  });

  app.get("/api/tasks/:task_id/steps", (c: Context) => {
    getCurrentUser(c, auth);
    const rows = db
      .prepare("SELECT * FROM task_steps WHERE task_id = ? ORDER BY step_index")
      .all((c.req.param("task_id") ?? "")) as unknown as Record<string, unknown>[];
    return c.json(rows.map(taskStepResponse));
  });

  app.patch("/api/tasks/:task_id/review-plan", async (c: Context) => {
    const user = getCurrentUser(c, auth);
    const taskId = (c.req.param("task_id") ?? "");
    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as unknown as TaskRow | undefined;
    if (!row) throw new HttpError(404, "Task not found");
    const body = (await c.req.json().catch(() => ({}))) as { plan_mode?: boolean | null };
    if (body.plan_mode != null) {
      if (!body.plan_mode && !row.store_id) throw new HttpError(400, "Non-store tasks require plan mode");
      db.prepare("UPDATE tasks SET plan_mode = ? WHERE id = ?").run(body.plan_mode ? 1 : 0, taskId);
      db.prepare("UPDATE users SET plan_mode_default = ?, updated_at = ? WHERE id = ?").run(body.plan_mode ? 1 : 0, nowIso(), user.id);
    }
    db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(nowIso(), taskId);
    const updated = db.prepare("SELECT plan_mode FROM tasks WHERE id = ?").get(taskId) as { plan_mode: number };
    return c.json({ ok: true, plan_mode: Boolean(updated.plan_mode) });
  });

  // ── agent 执行编排（批次 4.3）：TaskOrchestrator 注入 ──
  const requireTask = (taskId: string): Record<string, unknown> => {
    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as unknown as Record<string, unknown> | undefined;
    if (!row) throw new HttpError(404, "Task not found");
    return row;
  };
  const touch = (taskId: string, patch: Record<string, unknown>): void => {
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    const setSql = keys.map((k) => `${k} = ?`).join(", ");
    db.prepare(`UPDATE tasks SET ${setSql} WHERE id = ?`).run(...(keys.map((k) => patch[k]) as never[]), taskId);
  };
  const historyFor = (taskId: string): { role: string; content: string }[] =>
    (
      db
        .prepare("SELECT role, content FROM task_messages WHERE task_id = ? AND role IN ('user','assistant','result') ORDER BY seq")
        .all(taskId) as unknown as { role: string; content: string }[]
    ).slice(-10);

  // 手动运行 / defer_start 续跑：STARTABLE 守卫 → 队列或直启
  app.post("/api/tasks/:task_id/start", (c: Context) => {
    const user = getCurrentUser(c, auth);
    const taskId = (c.req.param("task_id") ?? "");
    const task = requireTask(taskId);
    if (!STARTABLE.has(String(task.status))) {
      throw new HttpError(400, `Cannot start task in status ${String(task.status)}`);
    }
    const store = task.store_id
      ? (db.prepare("SELECT id, name FROM stores WHERE id = ?").get(String(task.store_id)) as { id: string; name: string } | undefined)
      : null;
    if (task.store_id && !store) throw new HttpError(404, "Store not found");
    const result = orchestrator.enqueueOrLaunch(taskId, {
      mode: task.plan && task.plan_mode ? "plan_execute" : "execute",
      store: store ?? null,
      history: historyFor(taskId),
      profileId: (task.ai_profile_id as string | null) ?? (user.default_profile_id as string | null) ?? undefined,
    });
    if (result === "rejected") throw new HttpError(409, "Agent concurrency saturated");
    const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string };
    return c.json({ ok: true, task_id: taskId, status: row.status });
  });

  // 直接启动 agent（409 已在跑）
  app.post("/api/tasks/:task_id/agent/start", (c: Context) => {
    getCurrentUser(c, auth);
    const taskId = (c.req.param("task_id") ?? "");
    const task = requireTask(taskId);
    if (orchestrator.isRunning(taskId)) throw new HttpError(409, "Agent already running");
    if (!canTransition(String(task.status), "running")) throw new HttpError(400, `Cannot start agent in status ${String(task.status)}`);
    orchestrator.transition(taskId, "running");
    void orchestrator.start(taskId, { mode: Number(task.plan_mode) ? "design" : "execute" });
    return c.json({ ok: true, task_id: taskId, status: "agent_started" });
  });

  // 设计（plan 模式）：DESIGNABLE 守卫
  app.post("/api/tasks/:task_id/design", (c: Context) => {
    getCurrentUser(c, auth);
    const taskId = (c.req.param("task_id") ?? "");
    const task = requireTask(taskId);
    if (!DESIGNABLE.has(String(task.status))) throw new HttpError(400, `Cannot design task in status ${String(task.status)}`);
    if (orchestrator.isRunning(taskId)) throw new HttpError(409, "Agent already running");
    orchestrator.transition(taskId, "designing");
    void orchestrator.start(taskId, { mode: "design" });
    return c.json({ ok: true, task_id: taskId, status: "designing" });
  });

  // 执行已批准的计划
  app.post("/api/tasks/:task_id/execute-plan", (c: Context) => {
    getCurrentUser(c, auth);
    const taskId = (c.req.param("task_id") ?? "");
    const task = requireTask(taskId);
    if (String(task.status) !== "planned") throw new HttpError(400, `Cannot execute task in status ${String(task.status)}`);
    if (!task.plan) throw new HttpError(400, "Task has no plan to execute");
    if (orchestrator.isRunning(taskId)) throw new HttpError(409, "Agent already running");
    orchestrator.transition(taskId, "running");
    void orchestrator.start(taskId, { mode: "plan_execute" });
    return c.json({ ok: true, task_id: taskId, status: "running" });
  });

  app.post("/api/tasks/:task_id/agent/stop", (c: Context) => {
    getCurrentUser(c, auth);
    const taskId = (c.req.param("task_id") ?? "");
    requireTask(taskId);
    const stopped = orchestrator.stop(taskId);
    return c.json({ ok: true, task_id: taskId, status: stopped ? "stopping" : String(requireTask(taskId).status) });
  });

  // 唤醒 WAITING 任务
  app.post("/api/tasks/:task_id/wake", (c: Context) => {
    getCurrentUser(c, auth);
    const taskId = (c.req.param("task_id") ?? "");
    const task = requireTask(taskId);
    if (!WAKEABLE.has(String(task.status))) throw new HttpError(400, `Cannot wake task in status ${String(task.status)}`);
    const result = orchestrator.enqueueOrLaunch(taskId, { mode: "woken", history: historyFor(taskId) });
    if (result === "rejected") throw new HttpError(409, "Agent concurrency saturated");
    touch(taskId, { wait_condition: null });
    const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string };
    return c.json({ ok: true, task_id: taskId, status: row.status });
  });

  // 重试：RETRIABLE 守卫 + 清 run 状态（提交计数清零）+ 新 run
  app.post("/api/tasks/:task_id/retry", (c: Context) => {
    const user = getCurrentUser(c, auth);
    const taskId = (c.req.param("task_id") ?? "");
    const task = requireTask(taskId);
    if (!RETRIABLE.has(String(task.status))) throw new HttpError(400, `Cannot retry task in status ${String(task.status)}`);
    if (orchestrator.isRunning(taskId)) throw new HttpError(409, "Agent already running");
    const profileId = (task.ai_profile_id as string | null) ?? (user.default_profile_id as string | null) ?? "default";
    db.prepare(
      `UPDATE tasks SET result = NULL, accepted_result = NULL, submitted_result = NULL, review_gaps = NULL,
       transcript_tail = NULL, error = NULL, error_category = NULL, submission_count = 0, updated_at = ? WHERE id = ?`,
    ).run(new Date().toISOString(), taskId);
    const result = orchestrator.enqueueOrLaunch(taskId, { mode: "execute", history: historyFor(taskId), profileId });
    if (result === "rejected") throw new HttpError(409, "Agent concurrency saturated");
    const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string };
    return c.json({ ok: true, task_id: taskId, status: row.status, profile_id: profileId });
  });

  // 跟进消息：用户消息先落库 → 清 run 状态（提交计数保留）→ 新 run。
  // plan 阶段判定树（对齐 tasks_conversation.plan_phase_active）：planned 或
  // 未开跑即死的 plan 任务 → 重进设计；已完成任务的跟进是执行续跑，绝不重规划。
  app.post("/api/tasks/:task_id/messages", async (c: Context) => {
    const user = getCurrentUser(c, auth);
    const taskId = (c.req.param("task_id") ?? "");
    // 原 send_task_message 校验顺序：content 必填（400）先于任务查找（404）与
    // 状态机判定。批次 4.7.2 录制回放对齐（此前 TS 先查状态，空 content 在
    // pending 任务上返回 400 'Cannot message task in status pending'）。
    const rawBody = (await c.req.json().catch(() => ({}))) as { content?: string; profile_id?: string };
    if (!rawBody.content?.trim()) throw new HttpError(400, "content is required");
    const task = requireTask(taskId);
    if (orchestrator.isRunning(taskId)) throw new HttpError(409, "Agent is running; wait for it to finish");
    const status = String(task.status);
    if (!["completed", "failed", "planned", "waiting"].includes(status)) {
      throw new HttpError(400, `Cannot message task in status ${status}`);
    }
    const body = rawBody;
    const planPhaseActive =
      Number(task.plan_mode) &&
      (Number(task.is_plan_only) || (task.started_at == null && ["pending", "queued", "designing", "failed"].includes(status)));
    const planning = status === "planned" || Boolean(planPhaseActive);
    const target = planning ? "designing" : "running";
    if (!canTransition(status, target)) throw new HttpError(400, `Cannot message task in status ${status}`);
    const content = rawBody.content!.trim();
    orchestrator.insertUserMessage(taskId, content);
    const profileId = body.profile_id ?? (task.ai_profile_id as string | null) ?? (user.default_profile_id as string | null) ?? "default";
    db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(target, new Date().toISOString(), taskId);
    db.prepare(
      `UPDATE tasks SET result = NULL, accepted_result = NULL, submitted_result = NULL, review_gaps = NULL,
       transcript_tail = NULL, error = NULL, error_category = NULL, updated_at = ? WHERE id = ?`,
    ).run(new Date().toISOString(), taskId);
    bus.emit("task_message", { task_id: taskId, role: "user", content: body.content });
    void orchestrator.start(taskId, { mode: planning ? "design" : "chat", history: historyFor(taskId), profileId });
    return c.json({ ok: true, task_id: taskId, profile_id: profileId, content: body.content, attachments: [], profile_switched: false });
  });

  // 待答问题（确认闸门活挂起）
  app.get("/api/tasks/:task_id/questions/pending", (c: Context) => {
    getCurrentUser(c, auth);
    requireTask((c.req.param("task_id") ?? ""));
    return c.json(orchestrator.pendingQuestions((c.req.param("task_id") ?? "")));
  });

  // 批复（确认闸门 resume）
  app.post("/api/tasks/:task_id/questions/answer", async (c: Context) => {
    getCurrentUser(c, auth);
    const taskId = (c.req.param("task_id") ?? "");
    requireTask(taskId);
    const body = (await c.req.json().catch(() => ({}))) as { request_id?: string; answers?: Record<string, unknown> };
    if (!body.request_id) throw new HttpError(422, "request_id required");
    const answered = orchestrator.answer(taskId, body.request_id, body.answers ?? {});
    // 原 tasks_conversation.py answer_question：409 detail 恒
    // 'No agent running or no pending question'（批次 4.7.2 对齐）。
    if (!answered) throw new HttpError(409, "No agent running or no pending question");
    return c.json({ ok: true, resumed: true });
  });

  // MCP 入口：set_task_result（状态不在这里转——归编排器终局裁决）
  app.post("/api/tasks/:task_id/result", async (c: Context) => {
    getCurrentUser(c, auth);
    const taskId = (c.req.param("task_id") ?? "");
    const task = requireTask(taskId);
    const status = String(task.status);
    if (!["running", "designing"].includes(status)) throw new HttpError(400, `Cannot set result on task in status ${status}`);
    const body = (await c.req.json().catch(() => ({}))) as { result?: string; incomplete?: string[] };
    if (!body.result?.trim()) throw new HttpError(422, "result required");
    const declared = (body.incomplete ?? []).map((g) => String(g)).filter((g) => g.trim());
    const count = (task.submission_count as number | null) ?? 0;
    touch(taskId, {
      submitted_result: body.result,
      submission_count: count + 1,
      review_gaps: declared.length ? JSON.stringify(declared) : null,
      updated_at: new Date().toISOString(),
    });
    return c.json({ ok: true, task_id: taskId, status, resolved_from_file: false });
  });

  // MCP 入口：set_task_error（agent 自报错误：只记录不转状态——outcome 裁决时降级为 caveat）
  app.post("/api/tasks/:task_id/error", async (c: Context) => {
    getCurrentUser(c, auth);
    const taskId = (c.req.param("task_id") ?? "");
    const task = requireTask(taskId);
    const body = (await c.req.json().catch(() => ({}))) as { error?: string };
    if (!body.error?.trim()) throw new HttpError(422, "error required");
    touch(taskId, { error: body.error, error_category: AGENT_REPORTED, updated_at: new Date().toISOString() });
    return c.json({ ok: true, task_id: taskId, status: String(task.status) });
  });

  // 消息读（排除 delta/thinking_delta，按 seq 排序）
  app.get("/api/tasks/:task_id/messages", (c: Context) => {
    getCurrentUser(c, auth);
    const rows = db
      .prepare(
        "SELECT id, role, content, created_at FROM task_messages WHERE task_id = ? AND role NOT IN ('delta','thinking_delta') ORDER BY seq",
      )
      .all((c.req.param("task_id") ?? "")) as unknown as Record<string, unknown>[];
    return c.json(rows);
  });
}
