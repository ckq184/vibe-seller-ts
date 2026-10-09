// 批次 4.6 路由：channels(7)。契约对齐 app/routers/channels.py：
// 活动实例进程内 Map；配置持久化 config/channels.json；poll → 事件抽取 →
// Event 落库（首个已配置后端自动同步，失败落 confirmed+sync_error）→ event_created SSE。

import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeTextSync } from "./workspace/textio";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { HttpError } from "./types";
import { getCurrentUser, type AuthContext } from "./auth";
import type { ServerConfig } from "./config";
import { getChannel, channelTypes, type BaseChannel, type FetchLike } from "./channels/registry";
import { BackendConfigStore, EventSyncer, backendNames } from "./events/syncer";
import { EventExtractor } from "./events/extractor";

export interface ChannelDeps {
  config: ServerConfig;
  db: DatabaseSync;
  auth: AuthContext;
  bus: { emit: (type: string, data: Record<string, unknown>) => void };
  /** 测试注入 wecom/抽取/同步的传输层。 */
  fetchImpl?: FetchLike;
  syncFetch?: (url: string, init?: RequestInit) => Promise<Response>;
  extractImpl?: (text: string, channelType: string) => Promise<Record<string, unknown>[]>;
}

// 进程内活动实例（Python _active_channels/_channel_auto_create_events 同构）。
const activeChannels = new Map<string, BaseChannel>();
/** 测试钩子：webhook 回调入队等场景需要触达活动实例（Python 侧同类内部可达）。 */
export function getActiveChannelForTest(channelId: string): BaseChannel | undefined {
  return activeChannels.get(channelId);
}
const channelAutoCreateEvents = new Map<string, boolean>();

export function loadSavedConfigs(homeDir: string): Record<string, { channel_type: string; config: Record<string, unknown>; auto_create_events: boolean }> {
  const path = join(homeDir, "config", "channels.json");
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      /* 坏文件当空 */
    }
  }
  return {};
}

function saveConfigs(homeDir: string, configs: Record<string, unknown>): void {
  const path = join(homeDir, "config", "channels.json");
  mkdirSync(join(homeDir, "config"), { recursive: true });
  // 原 channels.json 经 Python 文本模式写（win32 CRLF）——textio 对齐
  writeTextSync(path, JSON.stringify(configs, null, 2));
}

interface EventRowLite {
  id: string;
  title: string;
  status: string;
}

export function registerChannelRoutes(app: Hono, deps: ChannelDeps): void {
  const { db, auth, bus, config } = deps;
  const extractor = new EventExtractor(deps.fetchImpl);
  const configs = new BackendConfigStore(config.homeDir);
  const syncer = new EventSyncer(configs, deps.syncFetch);

  app.get("/api/channels/types", (c) => {
    getCurrentUser(c, auth);
    return c.json(channelTypes().map((t) => ({ type: t.type, read_write: t.read_write })));
  });

  app.post("/api/channels/configure", async (c) => {
    getCurrentUser(c, auth);
    const body = (await c.req.json().catch(() => ({}))) as { channel_type?: string; config?: Record<string, unknown>; channel_id?: string; auto_create_events?: boolean };
    if (!body.channel_type) throw new HttpError(422, "channel_type required");
    let channel: BaseChannel;
    try {
      channel = getChannel(body.channel_type, deps.fetchImpl);
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : String(e));
    }
    await channel.configure(body.config ?? {});
    const channelId = body.channel_id || body.channel_type;
    activeChannels.set(channelId, channel);
    channelAutoCreateEvents.set(channelId, Boolean(body.auto_create_events));

    const saved = loadSavedConfigs(config.homeDir);
    saved[channelId] = { channel_type: body.channel_type, config: body.config ?? {}, auto_create_events: Boolean(body.auto_create_events) };
    saveConfigs(config.homeDir, saved);

    return c.json({ channel_id: channelId, status: "configured", auto_create_events: Boolean(body.auto_create_events) });
  });

  app.get("/api/channels/configs", (c) => {
    getCurrentUser(c, auth);
    return c.json(loadSavedConfigs(config.homeDir));
  });

  app.get("/api/channels/active", (c) => {
    getCurrentUser(c, auth);
    return c.json(
      [...activeChannels.entries()].map(([cid, ch]) => ({ channel_id: cid, channel_type: ch.channel_type, read_write: ch.read_write })),
    );
  });

  app.post("/api/channels/:channel_id/poll", async (c) => {
    getCurrentUser(c, auth);
    const channelId = c.req.param("channel_id") ?? "";
    const channel = activeChannels.get(channelId);
    if (!channel) throw new HttpError(404, `Channel not found: ${channelId}`);
    const messages = await channel.poll();

    const autoCreate = channelAutoCreateEvents.get(channelId) ?? false;
    const eventsCreated: EventRowLite[] = [];

    for (const m of messages) {
      const text = m.subject ? `${m.subject}\n${m.content}` : m.content;
      const extracted = deps.extractImpl ? await deps.extractImpl(text, channel.channel_type) : await extractor.extractEvents(text, channel.channel_type);

      for (const ev of extracted) {
        let status = "draft";
        let syncId: string | null = null;
        let syncError: string | null = null;

        // 初始同步后端 = 注册表序中第一个已配置的
        let syncBackend: string | null = null;
        for (const backendName of backendNames()) {
          if (Object.keys(configs.load(backendName)).length) {
            syncBackend = backendName;
            break;
          }
        }

        if (autoCreate && syncBackend) {
          try {
            syncId = await syncer.syncEvent(syncBackend, String(ev["title"] ?? ""), (ev["description"] as string) ?? null, (ev["event_date"] as string) ?? null, (ev["deadline"] as string) ?? null);
            status = "synced";
          } catch (e) {
            syncError = e instanceof Error ? e.message : String(e);
            status = "confirmed";
          }
        }

        const id = randomUUID();
        const now = new Date().toISOString();
        db.prepare(
          `INSERT INTO events (id, channel_message_id, channel_type, store_id, title, description, event_date, deadline,
                               platform, source_text, status, sync_backend, sync_id, sync_error, priority, created_at, updated_at)
           VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        ).run(
          id,
          m.message_id || null,
          channel.channel_type,
          String(ev["title"] ?? "Untitled Event"),
          (ev["description"] as string) ?? null,
          (ev["event_date"] as string) ?? null,
          (ev["deadline"] as string) ?? null,
          (ev["platform"] as string) ?? null,
          text.slice(0, 2000),
          status,
          syncBackend,
          syncId,
          syncError,
          now,
          now,
        );
        db.prepare(
          "INSERT INTO event_activities (id, event_id, user_id, actor_type, action, content, created_at) VALUES (?, ?, NULL, 'channel', 'created', ?, ?)",
        ).run(randomUUID(), id, `Extracted from ${channel.channel_type} channel`, now);
        eventsCreated.push({ id, title: String(ev["title"] ?? "Untitled Event"), status });
      }
    }

    for (const event of eventsCreated) {
      bus.emit("event_created", { event_id: event.id, title: event.title, status: event.status });
    }

    return c.json({
      messages: messages.map((m) => ({ sender: m.sender, content: m.content, subject: m.subject, message_id: m.message_id })),
      events_created: eventsCreated.length,
    });
  });

  app.post("/api/channels/:channel_id/send", async (c) => {
    getCurrentUser(c, auth);
    const channelId = c.req.param("channel_id") ?? "";
    const channel = activeChannels.get(channelId);
    if (!channel) throw new HttpError(404, `Channel not found: ${channelId}`);
    if (!channel.read_write || !channel.send) throw new HttpError(400, `Channel ${channelId} is read-only`);
    const body = (await c.req.json().catch(() => ({}))) as { content?: string; recipient?: string };
    const success = await channel.send(body.content ?? "", body.recipient ?? "");
    return c.json({ ok: success });
  });

  app.delete("/api/channels/:channel_id", async (c) => {
    getCurrentUser(c, auth);
    const channelId = c.req.param("channel_id") ?? "";
    const channel = activeChannels.get(channelId);
    if (!channel) throw new HttpError(404, `Channel not found: ${channelId}`);
    activeChannels.delete(channelId);
    channelAutoCreateEvents.delete(channelId);
    await channel.close?.();
    return c.json({ ok: true });
  });
}
