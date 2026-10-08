// 批次 4.5 workspace 契约测试：文件 CRUD、路径守卫、L1 只读、CATALOG 桩契约、
// skills CRUD + lockfile、店铺档案、git 历史三端点、structured/tree 形状、
// knowledge/skills 远端同步（本地 http server 假源）+ assistant SSE 面。
// 形状全部按 docs/phase4-backend-inventory.md 与原 routers/workspace.py 钉死。

import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createScriptedEngine } from "@vibe/bridge";
import { createApp, hashPassword, type AppDeps } from "../src/app";
import { openDb, seed } from "../src/db";
import { EventBus } from "../src/bus";
import { KnowledgeSyncManager, SkillsSyncManager } from "../src/workspace/sync";
import { WorkspaceManager, sanitizeText, parseYamlFrontmatter } from "../src/workspace/manager";
import { STUB_SUMMARY, isNearEmpty, findWronglyStubbed } from "../src/workspace/catalog";
import { storeSlug } from "../src/workspace/storeData";
import type { EngineFactory } from "../src/agent/orchestrator";
import type { ServerConfig } from "../src/config";
import { DEFAULT_USER_ID } from "../src/config";

let dir: string;
let deps: AppDeps;
let app: ReturnType<typeof createApp>;
let cookie: string;
let httpServer: Server;
let httpPort = 0;

const engineFactory: EngineFactory = async () => ({
  engine: createScriptedEngine({ decisions: [{ kind: "respond", content: "已记录到 notes.md" }], gatedTools: [], toolNames: [] }),
  tools: { execute: async () => ({ status: "error", error: { code: "invalid_tool", message: "unused" } }) },
});

async function waitFor<T>(fn: () => T | undefined | null, timeout = 8000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const v = fn();
    if (v !== undefined && v !== null) return v;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error("waitFor timeout");
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibe-ws-"));
  const config: ServerConfig = {
    homeDir: dir,
    dataDir: join(dir, "data"),
    dbPath: join(dir, "data", "vibe_seller.db"),
    jwtSecretFile: join(dir, "data", "jwt_secret"),
    port: 0,
    adminEmail: "admin@vibe-seller.local",
    adminPassword: "admin",
    adminUsername: "admin",
    version: "0.1.0-test",
    jwtSecret: "test-secret",
  };
  const db = openDb(config);
  seed(db, config, hashPassword);
  deps = { config, jwtSecret: "test-secret", db, bus: new EventBus(), engineFactory };
  app = createApp(deps);
  const res = await app.request("/api/auth/login", { method: "POST", body: JSON.stringify({ identifier: "admin", password: "admin" }), headers: { "content-type": "application/json" } });
  cookie = res.headers.get("set-cookie")!.split(";")[0]!;

  // 同步测试假源：/kn = knowledge、/sk = skills、/gh = GitHub commit API
  httpServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const serve = (body: string, type = "text/plain") => {
      res.writeHead(200, { "content-type": type });
      res.end(body);
    };
    if (url.pathname.startsWith("/gh/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ sha: "deadbeef1234567890" }]));
      return;
    }
    if (url.pathname === "/kn/MANIFEST.txt") return serve("common/a.md\n# comment\n\nextra/b.md\n");
    if (url.pathname === "/kn/common/a.md") return serve("# A\n\nshared knowledge body\n");
    if (url.pathname === "/kn/extra/b.md") return serve("extra body\n");
    if (url.pathname === "/sk/MANIFEST.txt") return serve("my-skill/SKILL.md\n");
    if (url.pathname === "/sk/my-skill/SKILL.md") return serve("---\nname: My Skill\ndescription: synced\n---\n\nbody\n");
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((done) => httpServer.listen(0, "127.0.0.1", done));
  httpPort = (httpServer.address() as { port: number }).port;
});

afterAll(async () => {
  deps.db.close();
  await new Promise<void>((done) => httpServer.close(() => done()));
  await rm(dir, { recursive: true, force: true });
});

const req = (path: string, init?: RequestInit) =>
  app.request(path, { ...init, headers: { cookie, ...(init?.headers as Record<string, string> | undefined) } });
const getJson = async (path: string) => (await (await req(path)).json()) as Record<string, unknown>;
const post = (path: string, body?: unknown) => req(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

describe("workspace tree/structured 形状", () => {
  it("tree：首启脚手架齐全，排除 .git", async () => {
    const tree = (await (await req("/api/workspace/tree")).json()) as { path: string; is_dir: boolean; size: number }[];
    const paths = tree.map((t) => t.path.split(/[\\/]/).join("/"));
    expect(paths).toContain("CLAUDE.md");
    expect(paths).toContain(".claude");
    expect(paths).toContain("knowledge");
    expect(paths).toContain("stores");
    expect(paths.some((p) => p === ".git" || p.startsWith(".git/"))).toBe(false);
    const claudeMd = tree.find((t) => t.path.replace(/\\/g, "/") === "CLAUDE.md")!;
    expect(claudeMd.is_dir).toBe(false);
    expect(claudeMd.size).toBeGreaterThan(0);
  });

  it("structured：五段视图与分类", async () => {
    await post("/api/workspace/skill", { name: "My Skill", description: "d1" });
    await post("/api/workspace/store-profile", { slug: "test-store", name: "Test Store", backend: "ziniao" });
    await req("/api/workspace/file?path=knowledge/local.md", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "local note" }) });
    await mkdir(join(dir, "knowledge", "project"), { recursive: true });
    await writeFile(join(dir, "knowledge", "project", "synced.md"), "synced from repo\n");
    const s = (await getJson("/api/workspace/structured")) as Record<string, unknown[]>;
    expect(Object.keys(s).sort()).toEqual(["local_knowledge", "project_knowledge", "root_files", "skills", "store_profiles"]);
    const skill = (s.skills as { slug: string; source: string; file_count: number }[]).find((x) => x.slug === "my-skill")!;
    expect(skill.source).toBe("custom");
    expect(skill.file_count).toBeGreaterThan(0);
    const store = (s.store_profiles as { slug: string; data_path: string; data_file_count: number }[]).find((x) => x.slug === "test-store")!;
    expect(store.data_path).toBe("store-data/test-store");
    expect((s.project_knowledge as { name: string }[]).map((x) => x.name)).toContain("synced.md");
    expect((s.local_knowledge as { name: string }[]).map((x) => x.name)).toContain("local.md");
    expect((s.root_files as { name: string }[]).map((x) => x.name)).toEqual(expect.arrayContaining(["CLAUDE.md", ".gitignore"]));
  });
});

describe("workspace 文件 CRUD 与守卫", () => {
  it("写读回环 + 缺失 404 + 穿越与 L1 拒绝", async () => {
    const put = await req("/api/workspace/file?path=notes/demo.md", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "# Demo\n\n内容" }) });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ path: "notes/demo.md", status: "ok" });
    const got = await getJson("/api/workspace/file?path=notes/demo.md");
    expect(got).toEqual({ path: "notes/demo.md", content: "# Demo\n\n内容" });

    const missing = await req("/api/workspace/file?path=notes/none.md");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ detail: "File not found: notes/none.md" });

    const traversal = await req("/api/workspace/file?path=../outside.txt");
    expect(traversal.status).toBe(400);
    expect(((await traversal.json()) as { detail: string }).detail).toContain("Path traversal not allowed");

    // 技能树的宽检路径也不允许 ..
    const skillTraversal = await req("/api/workspace/file?path=.claude/skills/../../secret.md");
    expect(skillTraversal.status).toBe(400);

    const l1 = await req("/api/workspace/file?path=knowledge/project/x.md", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "x" }) });
    expect(l1.status).toBe(400);
    expect(((await l1.json()) as { detail: string }).detail).toContain("read-only L1 path");

    const del = await req("/api/workspace/file?path=notes/demo.md", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ path: "notes/demo.md", status: "deleted" });
    const delAgain = await req("/api/workspace/file?path=notes/demo.md", { method: "DELETE" });
    expect(delAgain.status).toBe(404);
  });

  it("GB18030 平台导出回退读取；二进制拒绝并指向 raw", async () => {
    await writeFile(join(dir, "export.csv"), Buffer.from([0xd6, 0xd0, 0xce, 0xc4])); // "中文" GB18030
    const got = await getJson("/api/workspace/file?path=export.csv");
    expect(got.content).toBe("中文");
    await writeFile(join(dir, "blob.bin"), Buffer.from([0, 1, 2, 0xff, 0xfe]));
    const bin = await req("/api/workspace/file?path=blob.bin");
    expect(bin.status).toBe(400);
    expect(((await bin.json()) as { detail: string }).detail).toContain("use /api/workspace/file/raw");
  });

  it("raw：内联安全类型 inline，其余 attachment（XSS 守卫）", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeFile(join(dir, "pic.png"), png);
    const rawPng = await req("/api/workspace/file/raw?path=pic.png");
    expect(rawPng.status).toBe(200);
    expect(rawPng.headers.get("content-type")).toBe("image/png");
    expect(rawPng.headers.get("content-disposition")).toContain("inline");
    expect(Buffer.from(await rawPng.arrayBuffer()).equals(png)).toBe(true);

    await writeFile(join(dir, "doc.md"), "# doc\n");
    const rawMd = await req("/api/workspace/file/raw?path=doc.md");
    expect(rawMd.headers.get("content-disposition")).toContain("attachment");

    await writeFile(join(dir, "page.html"), "<script>1</script>");
    const rawHtml = await req("/api/workspace/file/raw?path=page.html");
    expect(rawHtml.headers.get("content-disposition")).toContain("attachment");
  });

  it("CATALOG 桩契约：把有内容的文件打桩 → 400；真摘要放行", async () => {
    await req("/api/workspace/file?path=stores/s1/real.md", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "one two three four five six seven" }) });
    const bad = await req("/api/workspace/file?path=stores/s1/CATALOG.md", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: `# Catalog\n\n| File | Relevance | Summary |\n|---|---|---|\n| stores/s1/real.md | profile | ${STUB_SUMMARY} |\n` }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { detail: string }).detail).toContain("they have real content");

    const good = await req("/api/workspace/file?path=stores/s1/CATALOG.md", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "# Catalog\n\n| File | Relevance | Summary |\n|---|---|---|\n| stores/s1/real.md | profile | 商品目录与运营笔记 |\n" }),
    });
    expect(good.status).toBe(200);
  });
});

describe("workspace skills CRUD", () => {
  it("create → list → save upsert → 删除；lockfile 同步", async () => {
    const created = await post("/api/workspace/skill", { name: "Pack Slip", description: "how to pack" });
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({ path: join(".claude", "skills", "pack-slip"), status: "created" });
    const lockfile = JSON.parse(await readFile(join(dir, ".claude", "skills", "skills.lock.json"), "utf8"));
    expect(lockfile.skills["pack-slip"].source).toBe("local");

    const reserved = await post("/api/workspace/skill", { name: "_builtins" });
    expect(reserved.status).toBe(400);

    let list = (await (await req("/api/workspace/skills")).json()) as { slug: string; name: string; updatable: boolean; source: string }[];
    const entry = list.find((s) => s.slug === "pack-slip")!;
    expect(entry).toMatchObject({ name: "Pack Slip", source: "custom", updatable: true });

    const saved = await req("/api/workspace/skills/pack-slip", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ skill_md: "---\nname: Pack Slip\n---\n\nupdated body", files: { "scripts/run.sh": "echo hi" } }) });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ slug: "pack-slip", path: join(".claude", "skills", "pack-slip"), action: "updated" });
    expect(await readFile(join(dir, ".claude", "skills", "pack-slip", "scripts", "run.sh"), "utf8")).toBe("echo hi");

    const badFile = await req("/api/workspace/skills/pack-slip", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ skill_md: "x", files: { "../evil.md": "x" } }) });
    expect(badFile.status).toBe(400);

    const del = await req("/api/workspace/skills/pack-slip", { method: "DELETE" });
    expect(del.status).toBe(200);
    const lock2 = JSON.parse(await readFile(join(dir, ".claude", "skills", "skills.lock.json"), "utf8"));
    expect(lock2.skills["pack-slip"]).toBeUndefined();
    list = (await (await req("/api/workspace/skills")).json()) as never;
    expect(list.find((s) => s.slug === "pack-slip")).toBeUndefined();
  });

  it("内置（synced）技能：save 拒 400、source=builtin；delete 只拦 _ 前缀（原实现语义）", async () => {
    await mkdir(join(dir, ".claude", "skills", "builtin-one"), { recursive: true });
    await writeFile(join(dir, ".claude", "skills", "builtin-one", "SKILL.md"), "---\nname: B1\n---\nbuilt-in body");
    await writeFile(join(dir, ".claude", "skills", ".sync_meta.json"), JSON.stringify({ synced_skills: ["builtin-one"] }));
    let list = (await (await req("/api/workspace/skills")).json()) as { slug: string; source: string; updatable: boolean }[];
    expect(list.find((s) => s.slug === "builtin-one")).toMatchObject({ source: "builtin", updatable: false });
    const save = await req("/api/workspace/skills/builtin-one", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ skill_md: "x" }) });
    expect(save.status).toBe(400);
    expect(((await save.json()) as { detail: string }).detail).toContain("built-in skill");
    const slugDel = await req("/api/workspace/skills/Bad_Slug", { method: "DELETE" });
    expect(slugDel.status).toBe(400);
    // 原实现 delete_skill 只拦 `_` 前缀——同步技能目录本身可删
    const del = await req("/api/workspace/skills/builtin-one", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(existsSync(join(dir, ".claude", "skills", "builtin-one"))).toBe(false);
    list = (await (await req("/api/workspace/skills")).json()) as never;
    expect(list.find((s) => s.slug === "builtin-one")).toBeUndefined();
  });
});

describe("workspace 店铺档案 + git 历史三端点", () => {
  it("脚手架幂等 + ziniao 路由文件", async () => {
    const r = await post("/api/workspace/store-profile", { slug: "shop-a", name: "Shop A" });
    expect(await r.json()).toEqual({ path: join("stores", "shop-a"), status: "created" });
    for (const f of ["STORE.md", "notes.md", "logistics.md", "CATALOG.md"]) {
      expect(existsSync(join(dir, "stores", "shop-a", f))).toBe(true);
    }
    expect(existsSync(join(dir, "stores", "shop-a", "browser-routing.md"))).toBe(false);
    await post("/api/workspace/store-profile", { slug: "shop-z", name: "Shop Z", backend: "ziniao" });
    expect(existsSync(join(dir, "stores", "shop-z", "browser-routing.md"))).toBe(true);
    // 幂等：已有文件不覆写
    await writeFile(join(dir, "stores", "shop-a", "notes.md"), "custom note");
    await post("/api/workspace/store-profile", { slug: "shop-a", name: "Shop A" });
    expect(await readFile(join(dir, "stores", "shop-a", "notes.md"), "utf8")).toBe("custom note");
  });

  it("history → version → reset 全链路", async () => {
    await req("/api/workspace/file?path=notes/h.md", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "v1" }) });
    await req("/api/workspace/file?path=notes/h.md", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "v2" }) });
    const hist = (await getJson("/api/workspace/file/history?path=notes/h.md")) as { path: string; commits: { sha: string; message: string; date: string; author: string }[] };
    expect(hist.path).toBe("notes/h.md");
    expect(hist.commits.length).toBeGreaterThanOrEqual(2);
    expect(hist.commits[0]!.message).toBe("Update notes/h.md");
    expect(hist.commits[0]!.sha).toHaveLength(12);
    const firstSha = hist.commits[hist.commits.length - 1]!.sha;
    const version = await getJson(`/api/workspace/file/version?path=notes/h.md&commit=${firstSha}`);
    expect(version).toMatchObject({ path: "notes/h.md", content: "v1" });

    const reset = await post("/api/workspace/file/reset", { path: "notes/h.md", commit: firstSha });
    expect(reset.status).toBe(200);
    expect(await readFile(join(dir, "notes", "h.md"), "utf8")).toBe("v1");

    const badVersion = await req("/api/workspace/file/version?path=notes/h.md&commit=deadbeef0000");
    expect(badVersion.status).toBe(400);

    // L1 不给 reset（审计义务在写边界）
    const l1Reset = await post("/api/workspace/file/reset", { path: "knowledge/project/x.md", commit: firstSha });
    expect(l1Reset.status).toBe(400);
    expect(((await l1Reset.json()) as { detail: string }).detail).toContain("read-only L1");
  });
});

describe("knowledge/skills 同步", () => {
  it("本地包同步诚实缺位；meta/status 读端点", async () => {
    expect(await getJson("/api/workspace/knowledge/sync-status")).toEqual({ available: false, reason: "No knowledge/ in package" });
    expect(await getJson("/api/workspace/knowledge/sync-meta")).toEqual({});
    // skills meta 此前用例可能已写入（.sync_meta.json 是共享状态），只验形状
    const skillsMeta = await getJson("/api/workspace/skills/sync-meta");
    expect(typeof skillsMeta).toBe("object");
  });

  it("knowledge fetchRemote：MANIFEST + 逐文件下载 + meta + system event", async () => {
    const db = deps.db;
    const before = (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
    const ks = new KnowledgeSyncManager({
      homeDir: dir,
      db,
      knowledgeRepoUrl: `http://127.0.0.1:${httpPort}/kn`,
      commitApiBase: `http://127.0.0.1:${httpPort}/gh`,
    });
    expect(ks.fetch()).toEqual({ synced: false, reason: "No knowledge/ in installed package" });
    const r = await ks.fetchRemote();
    expect(r).toMatchObject({ status: "success", copied: 2, skipped: 0, commit: "deadbeef1234567890" });
    expect(await readFile(join(dir, "knowledge", "project", "common", "a.md"), "utf8")).toContain("shared knowledge");
    const meta = JSON.parse(await readFile(join(dir, "knowledge", ".sync_meta.json"), "utf8"));
    expect(meta).toMatchObject({ last_commit: "deadbeef1234567890", status: "success", copied: 2 });
    expect((db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n).toBe(before + 1);
    // 二次全量：内容未变 → skipped
    const again = await ks.fetchRemote();
    expect(again).toMatchObject({ status: "success", copied: 0, skipped: 2 });
    // 冷却内 check 不触发
    expect(await ks.checkAndSyncRemote()).toBeNull();
  });

  it("skills fetchRemote：落盘 skills/<slug>；meta 收尾覆写后 synced_skills 标记走本地同步路径 → builtin", async () => {
    const ss = new SkillsSyncManager({
      homeDir: dir,
      db: deps.db,
      skillsRepoUrl: `http://127.0.0.1:${httpPort}/sk`,
      commitApiBase: `http://127.0.0.1:${httpPort}/gh`,
    });
    expect(ss.fetch()).toEqual({ synced: false, reason: "No skills/ in installed package" });
    const r = await ss.fetchRemote();
    expect(r).toMatchObject({ status: "success", copied: 1 });
    expect(existsSync(join(dir, ".claude", "skills", "my-skill", "SKILL.md"))).toBe(true);
    const meta = JSON.parse(await readFile(join(dir, ".claude", "skills", ".sync_meta.json"), "utf8"));
    expect(meta).toMatchObject({ last_commit: "deadbeef1234567890", status: "success", copied: 1 });
    // 原实现 fetch_remote 的收尾 meta 覆写会丢 synced_skills（本仓库上游怪癖，保真移植）；
    // synced_skills 由本地同步（fetch）路径标记——这里模拟标记后验证分类
    await writeFile(join(dir, ".claude", "skills", ".sync_meta.json"), JSON.stringify({ ...meta, synced_skills: ["my-skill"] }));
    expect([...ss.getSyncedSkills()]).toEqual(["my-skill"]);
    const wm = new WorkspaceManager(dir);
    const skills = (await wm.listSkills()) as { slug: string; source: string }[];
    expect(skills.find((s) => s.slug === "my-skill")!.source).toBe("builtin");
  });
});

describe("workspace assistant", () => {
  it("空消息 400；空闲 stop ok:false；status running:false", async () => {
    const empty = await post("/api/workspace/assistant/message", { content: "   " });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ detail: "Message cannot be empty" });
    expect(await (await post("/api/workspace/assistant/stop")).json()).toEqual({ ok: false });
    expect(await getJson("/api/workspace/assistant/status")).toEqual({ running: false });
  });

  it("message → SSE ws_assistant_message/result + ws_assistant_done(0)；status 复位", async () => {
    const key = `__ws_assistant_${DEFAULT_USER_ID}__`;
    const res = await post("/api/workspace/assistant/message", { content: "记住我的仓库在广州" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, user_id: DEFAULT_USER_ID });
    const done = await waitFor(() => deps.bus.history.find((h) => h.type === "ws_assistant_done" && h.data.session_key === key));
    expect(done!.data).toMatchObject({ return_code: 0 });
    const frames = deps.bus.history.filter((h) => h.type === "ws_assistant_message" && h.data.session_key === key);
    expect(frames.some((f) => f.data.role === "result" && f.data.content === "已记录到 notes.md")).toBe(true);
    // 让事件循环排水（会话收尾），状态应复位
    await new Promise((r) => setTimeout(r, 100));
    expect(await getJson("/api/workspace/assistant/status")).toEqual({ running: false });
    expect(await (await post("/api/workspace/assistant/stop")).json()).toEqual({ ok: false });
  });
});

describe("纯函数面", () => {
  it("sanitizeText 替换孤立代理对；frontmatter 平解析；storeSlug 回退", () => {
    expect(sanitizeText("ok")).toBe("ok");
    expect(sanitizeText("bad\ufffdthing")).toBe("bad\ufffdthing");
    expect(sanitizeText("lone\udcadsurrogate")).toBe("lone\ufffdsurrogate");
    expect(parseYamlFrontmatter("---\nname: A\ndescription: B\n---\nbody")).toEqual({ name: "A", description: "B" });
    expect(parseYamlFrontmatter("no frontmatter")).toEqual({});
    expect(storeSlug("My Store!")).toBe("my-store");
    expect(storeSlug("纯中文店", "12345678-abcd")).toBe("store-12345678");
    expect(isNearEmpty("---\nx: 1\n---\n# H\n\nbody words here")).toBe(true);
    expect(isNearEmpty("one two three four five six")).toBe(false);
    expect(findWronglyStubbed("| stores/a.md | x | other summary |", () => "content")).toEqual([]);
  });
});
