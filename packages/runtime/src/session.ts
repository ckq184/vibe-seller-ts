import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Session } from "@vibe/core";

export interface SessionStore {
  createSession(): Promise<Session>;
  loadSession(id: string): Promise<Session | undefined>;
  saveSession(session: Session): Promise<void>;
}

/** 测试/内存态用；id 工厂可注入以便金标测试钉死。 */
export class MemorySessionStore implements SessionStore {
  private readonly map = new Map<string, Session>();

  constructor(private readonly newId: () => string = () => randomUUID()) {}

  async createSession(): Promise<Session> {
    const session: Session = { id: this.newId(), createdAt: Date.now(), runs: [] };
    this.map.set(session.id, session);
    return session;
  }

  async loadSession(id: string): Promise<Session | undefined> {
    return this.map.get(id);
  }

  async saveSession(session: Session): Promise<void> {
    this.map.set(session.id, session);
  }
}

/** 一个 session 一个 JSON 文件；并发 session 互不触碰对方的文件。 */
export class FileSessionStore implements SessionStore {
  constructor(private readonly dir: string) {}

  private file(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  async createSession(): Promise<Session> {
    const session: Session = { id: randomUUID(), createdAt: Date.now(), runs: [] };
    await this.saveSession(session);
    return session;
  }

  async loadSession(id: string): Promise<Session | undefined> {
    try {
      return JSON.parse(await readFile(this.file(id), "utf8")) as Session;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  async saveSession(session: Session): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file(session.id), JSON.stringify(session, null, 2), "utf8");
  }
}
