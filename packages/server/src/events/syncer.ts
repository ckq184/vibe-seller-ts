// 事件同步抽象层（app/events_system/syncer.py + backends/dida365.py 移植）。
// 后端配置落 ~/.vibe-seller/config/event_backends.json；dida365 走其 Open API
// （httpx → fetch，注入式便于测试）；google_calendar 在 Python 侧就是 ImportError
// 降级（无 google SDK 时一切调用抛错），TS 侧零依赖红线同理——注册表保留名单，
// 调用即抛错（与 ImportError 行为对齐），注释记录。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface EventBackend {
  createEvent(title: string, description: string | null, eventDate: string | null, deadline: string | null): Promise<string>;
  updateEvent(externalId: string, title: string, description: string | null, eventDate: string | null, deadline: string | null): Promise<void>;
  deleteEvent(externalId: string): Promise<void>;
}

const DIDA365_API_BASE = "https://api.dida365.com/open/v1";

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

function isoWithTime(due: string): string {
  return due.includes("T") ? due : `${due}T00:00:00+0000`;
}

export class Dida365Backend implements EventBackend {
  private accessToken = "";
  private projectId = "";

  constructor(private readonly fetchImpl: FetchImpl = fetch) {}

  configure(config: Record<string, unknown>): void {
    this.accessToken = String(config["access_token"] ?? "");
    this.projectId = String(config["project_id"] ?? "");
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.accessToken}`, "Content-Type": "application/json" };
  }

  private payload(title: string, description: string | null, eventDate: string | null, deadline: string | null): Record<string, unknown> {
    const payload: Record<string, unknown> = { title };
    if (description) payload["content"] = description;
    if (this.projectId) payload["projectId"] = this.projectId;
    const due = deadline || eventDate;
    if (due) payload["dueDate"] = isoWithTime(due);
    return payload;
  }

  async createEvent(title: string, description: string | null, eventDate: string | null, deadline: string | null): Promise<string> {
    const resp = await this.fetchImpl(`${DIDA365_API_BASE}/task`, { method: "POST", headers: this.headers(), body: JSON.stringify(this.payload(title, description, eventDate, deadline)) });
    if (!resp.ok) throw new Error(`dida365 create failed: HTTP ${resp.status}`);
    const data = (await resp.json()) as { id?: string };
    return data.id ?? "";
  }

  async updateEvent(externalId: string, title: string, description: string | null, eventDate: string | null, deadline: string | null): Promise<void> {
    const resp = await this.fetchImpl(`${DIDA365_API_BASE}/task/${encodeURIComponent(externalId)}`, { method: "POST", headers: this.headers(), body: JSON.stringify(this.payload(title, description, eventDate, deadline)) });
    if (!resp.ok) throw new Error(`dida365 update failed: HTTP ${resp.status}`);
  }

  async deleteEvent(externalId: string): Promise<void> {
    // dida365 删除要求 projectId + taskId。
    const resp = await this.fetchImpl(`${DIDA365_API_BASE}/project/${encodeURIComponent(this.projectId)}/task/${encodeURIComponent(externalId)}`, { method: "DELETE", headers: this.headers() });
    if (!resp.ok) throw new Error(`dida365 delete failed: HTTP ${resp.status}`);
  }
}

/** ImportError 语义的 google_calendar：注册表保留（/backends 名单一致），调用即抛。 */
class GoogleCalendarUnavailable implements EventBackend {
  private fail(): never {
    throw new Error("google_calendar backend requires the Google API client libraries, which are not available in the TS runtime (parity with the Python ImportError fallback).");
  }
  createEvent(): Promise<string> {
    this.fail();
  }
  updateEvent(): Promise<void> {
    this.fail();
  }
  deleteEvent(): Promise<void> {
    this.fail();
  }
}

// 注册顺序 = Python main.py import 顺序：dida365 → google_calendar。
const BACKEND_REGISTRY: Record<string, (fetchImpl?: FetchImpl) => EventBackend> = {
  dida365: (fetchImpl) => new Dida365Backend(fetchImpl),
  google_calendar: () => new GoogleCalendarUnavailable(),
};

export function backendNames(): string[] {
  return Object.keys(BACKEND_REGISTRY);
}

// ── 后端配置读写（event_backends.json） ──

export class BackendConfigStore {
  constructor(private readonly homeDir: string) {}

  private get path(): string {
    return join(this.homeDir, "config", "event_backends.json");
  }

  load(backendName: string): Record<string, unknown> {
    if (!existsSync(this.path)) return {};
    try {
      const all = JSON.parse(readFileSync(this.path, "utf8")) as Record<string, Record<string, unknown>>;
      return all[backendName] ?? {};
    } catch {
      return {};
    }
  }

  save(backendName: string, config: Record<string, unknown>): void {
    mkdirSync(join(this.homeDir, "config"), { recursive: true });
    let all: Record<string, Record<string, unknown>> = {};
    if (existsSync(this.path)) {
      try {
        all = JSON.parse(readFileSync(this.path, "utf8"));
      } catch {
        /* 与原实现同：坏文件静默重建 */
      }
    }
    all[backendName] = config;
    writeFileSync(this.path, JSON.stringify(all, null, 2), "utf8");
  }
}

export class EventSyncer {
  constructor(private readonly configs: BackendConfigStore, private readonly fetchImpl?: FetchImpl) {}

  private backend(backendName: string): EventBackend {
    const factory = BACKEND_REGISTRY[backendName];
    if (!factory) throw new Error(`Unknown backend: ${backendName}. Available: ${Object.keys(BACKEND_REGISTRY)}`);
    const backend = factory(this.fetchImpl);
    if (backend instanceof Dida365Backend) backend.configure(this.configs.load(backendName));
    return backend;
  }

  syncEvent(backendName: string, title: string, description: string | null, eventDate: string | null, deadline: string | null): Promise<string> {
    return this.backend(backendName).createEvent(title, description, eventDate, deadline);
  }

  updateEvent(backendName: string, externalId: string, title: string, description: string | null, eventDate: string | null, deadline: string | null): Promise<void> {
    return this.backend(backendName).updateEvent(externalId, title, description, eventDate, deadline);
  }

  deleteEvent(backendName: string, externalId: string): Promise<void> {
    return this.backend(backendName).deleteEvent(externalId);
  }
}
