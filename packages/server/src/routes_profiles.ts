// 批次 4.5 路由：profiles（7 端点）。契约对齐 app/routers/profiles.py。
// assert_profile_compatible（~/.claude/settings.json ANTHROPIC_* 覆盖检测）落为 no-op：
// TS 运行时不经 Claude Code CLI，外部工具的 env 覆盖路径不存在（见 migration-plan）。
// telemetry.send 未接（批次 4.7）——其余语义逐字段对齐。

import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { HttpError } from "./types";
import { getCurrentUser, type AuthContext } from "./auth";
import { getUserById } from "./db";
import { ProfileManager } from "./profiles/manager";
import { validateProfileEnv } from "./profiles/validate";
import { DEFAULT_PROFILE_ID } from "./profiles/presets";

export interface ProfilesDeps {
  db: DatabaseSync;
  auth: AuthContext;
  manager: ProfileManager;
}

export function registerProfilesRoutes(app: Hono, deps: ProfilesDeps): void {
  const { db, auth, manager } = deps;

  app.get("/api/profiles", (c) => {
    getCurrentUser(c, auth);
    return c.json({ profiles: manager.listProfiles() });
  });

  app.post("/api/profiles", async (c) => {
    getCurrentUser(c, auth);
    const data = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    // data['id'] / data['name'] 缺失 = KeyError → 400 str(KeyError)（原实现同形）
    const profileId = data.id;
    if (profileId === undefined) throw new HttpError(400, "'id'");
    const name = data.name;
    if (name === undefined) throw new HttpError(400, "'name'");
    try {
      const profile = manager.createProfile(String(profileId), {
        name: name as string,
        env: (data.env ?? {}) as Record<string, string>,
        description: typeof data.description === "string" ? data.description : "",
        load_global_mcp: Boolean(data.load_global_mcp ?? false),
      });
      return c.json(profile);
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : String(e));
    }
  });

  app.put("/api/profiles/:profile_id", async (c) => {
    getCurrentUser(c, auth);
    const profileId = c.req.param("profile_id");
    const data = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      const profile = manager.updateProfile(profileId, data);
      return c.json(profile);
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : String(e));
    }
  });

  app.delete("/api/profiles/:profile_id", (c) => {
    const profileId = c.req.param("profile_id");
    const current = getCurrentUser(c, auth);
    try {
      manager.deleteProfile(profileId); // default → ValueError → 400；缺失 → 幂等 ok
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : String(e));
    }
    // 被删的是当前用户默认档 → 回落 default
    const user = getUserById(db, current.id);
    if (user && user.default_profile_id === profileId) {
      db.prepare("UPDATE users SET default_profile_id = 'default', updated_at = ? WHERE id = ?").run(new Date().toISOString(), user.id);
    }
    return c.json({ ok: true });
  });

  app.patch("/api/profiles/:profile_id/set-default", (c) => {
    const profileId = c.req.param("profile_id");
    const current = getCurrentUser(c, auth);
    const profile = manager.getProfile(profileId);
    if (!profile) throw new HttpError(404, "Profile not found");
    const user = getUserById(db, current.id);
    if (!user) throw new HttpError(404, "User not found");
    db.prepare("UPDATE users SET default_profile_id = ?, updated_at = ? WHERE id = ?").run(profileId, new Date().toISOString(), user.id);
    let schedulesSynced = 0;
    if (user.sync_profile_to_schedules) {
      // opt-in 偏好：把该用户钉了具体 ai_profile_id 的排程一并迁到新默认；
      // 'default'/NULL 行本就活继承 live 默认，刻意不动；他人排程不在范围内
      db.prepare(
        "UPDATE schedules SET ai_profile_id = ? WHERE created_by = ? AND ai_profile_id IS NOT NULL AND ai_profile_id != ?",
      ).run(profileId, user.id, DEFAULT_PROFILE_ID);
      const row = db.prepare("SELECT changes() AS n").get() as { n: number };
      schedulesSynced = row.n;
    }
    return c.json({ ok: true, default_profile_id: profileId, schedules_synced: schedulesSynced });
  });

  app.post("/api/profiles/validate", async (c) => {
    getCurrentUser(c, auth);
    const data = (await c.req.json().catch(() => ({}))) as { env?: Record<string, string> };
    const result = await validateProfileEnv(data.env ?? {});
    return c.json(result);
  });

  app.get("/api/profiles/presets", (c) => {
    getCurrentUser(c, auth);
    return c.json({ presets: manager.getProviderPresets() });
  });
}
