// 批次 4.7.1 telemetry 模块单测：门控链 / bucket 全集 / base properties /
// 最小 PostHog transport / locale 端点 / settings GET·PUT（含顺序红线）。
// 传输注入假捕获，绝不真网（PRD §3.5 验收 1/2/4/5）。

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as telemetry from "../src/telemetry/core";
import { TelemetryEvent } from "../src/telemetry/events";
import { PosthogTransport } from "../src/telemetry/transport";
import { createApp, hashPassword, type AppDeps } from "../src/app";
import { openDb, seed } from "../src/db";
import { EventBus } from "../src/bus";
import type { ServerConfig } from "../src/config";

// 门控链涉及的环境变量：每条用例前存档、用例后恢复，避免污染其他用例。
const ENV_KEYS = [
  "VIBE_SELLER_TELEMETRY",
  "CI",
  "GITHUB_ACTIONS",
  "BUILDKITE",
  "GITLAB_CI",
  "CIRCLECI",
  "JENKINS_URL",
  "VITEST",
  "NODE_ENV",
] as const;

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k]!;
  }
  telemetry.__test.reset();
});

// ── bucket 函数全集（逐边界对齐 app/telemetry.py） ──

describe("bucket 函数", () => {
  it("count_bucket：0 / 1-5 / 6-20 / 21-100 / 100+ 逐边界", () => {
    expect(telemetry.countBucket(0)).toBe("0");
    expect(telemetry.countBucket(-3)).toBe("0");
    expect(telemetry.countBucket(1)).toBe("1-5");
    expect(telemetry.countBucket(5)).toBe("1-5");
    expect(telemetry.countBucket(6)).toBe("6-20");
    expect(telemetry.countBucket(20)).toBe("6-20");
    expect(telemetry.countBucket(21)).toBe("21-100");
    expect(telemetry.countBucket(100)).toBe("21-100");
    expect(telemetry.countBucket(101)).toBe("100+");
  });

  it("duration_bucket：unknown / <30s / 30s-2m / 2m-10m / 10m-30m / >30m，负数钳 0", () => {
    expect(telemetry.durationBucket(null)).toBe("unknown");
    expect(telemetry.durationBucket(-5)).toBe("<30s");
    expect(telemetry.durationBucket(0)).toBe("<30s");
    expect(telemetry.durationBucket(29)).toBe("<30s");
    expect(telemetry.durationBucket(30)).toBe("30s-2m");
    expect(telemetry.durationBucket(119)).toBe("30s-2m");
    expect(telemetry.durationBucket(120)).toBe("2m-10m");
    expect(telemetry.durationBucket(599)).toBe("2m-10m");
    expect(telemetry.durationBucket(600)).toBe("10m-30m");
    expect(telemetry.durationBucket(1799)).toBe("10m-30m");
    expect(telemetry.durationBucket(1800)).toBe(">30m");
    // int(seconds) 截断：61.9 → 61 → 30s-2m
    expect(telemetry.durationBucket(61.9)).toBe("30s-2m");
  });

  it("duration_seconds_from_iso：解析成功 / 缺失 / 坏值 / 负数钳 0", () => {
    const start = "2026-01-01T00:00:00Z";
    const end = "2026-01-01T00:01:30Z";
    expect(telemetry.durationSecondsFromIso(start, end)).toBe(90);
    expect(telemetry.durationSecondsFromIso(null, end)).toBeNull();
    expect(telemetry.durationSecondsFromIso(start, null)).toBeNull();
    expect(telemetry.durationSecondsFromIso("", end)).toBeNull();
    expect(telemetry.durationSecondsFromIso("not-a-date", end)).toBeNull();
    expect(telemetry.durationSecondsFromIso(end, start)).toBe(0);
  });

  it("duration_bucket_from_iso 组合两者", () => {
    expect(telemetry.durationBucketFromIso("2026-01-01T00:00:00Z", "2026-01-01T00:10:00Z")).toBe("10m-30m");
    expect(telemetry.durationBucketFromIso("bad", "worse")).toBe("unknown");
  });

  it("length_bucket：0 单列、<50 覆盖 1-49、各段边界", () => {
    expect(telemetry.lengthBucket(0)).toBe("0");
    expect(telemetry.lengthBucket(-1)).toBe("0");
    expect(telemetry.lengthBucket(1)).toBe("<50");
    expect(telemetry.lengthBucket(49)).toBe("<50");
    expect(telemetry.lengthBucket(50)).toBe("50-200");
    expect(telemetry.lengthBucket(199)).toBe("50-200");
    expect(telemetry.lengthBucket(200)).toBe("200-1k");
    expect(telemetry.lengthBucket(999)).toBe("200-1k");
    expect(telemetry.lengthBucket(1000)).toBe("1k-5k");
    expect(telemetry.lengthBucket(4999)).toBe("1k-5k");
    expect(telemetry.lengthBucket(5000)).toBe("5k+");
  });

  it("age_bucket_days：unknown / <1d / 1-7d / 1-4w / 1-3m / 3-12m / >1y", () => {
    expect(telemetry.ageBucketDays(null)).toBe("unknown");
    expect(telemetry.ageBucketDays(0.5)).toBe("<1d");
    expect(telemetry.ageBucketDays(1)).toBe("1-7d");
    expect(telemetry.ageBucketDays(6.9)).toBe("1-7d");
    expect(telemetry.ageBucketDays(7)).toBe("1-4w");
    expect(telemetry.ageBucketDays(29)).toBe("1-4w");
    expect(telemetry.ageBucketDays(30)).toBe("1-3m");
    expect(telemetry.ageBucketDays(89)).toBe("1-3m");
    expect(telemetry.ageBucketDays(90)).toBe("3-12m");
    expect(telemetry.ageBucketDays(364)).toBe("3-12m");
    expect(telemetry.ageBucketDays(365)).toBe(">1y");
  });

  it("retention_days_bucket：0-disabled / <7 / 7-30 / 30-90 / 90+", () => {
    expect(telemetry.retentionDaysBucket(0)).toBe("0-disabled");
    expect(telemetry.retentionDaysBucket(-1)).toBe("0-disabled");
    expect(telemetry.retentionDaysBucket(6)).toBe("<7");
    expect(telemetry.retentionDaysBucket(7)).toBe("7-30");
    expect(telemetry.retentionDaysBucket(30)).toBe("7-30");
    expect(telemetry.retentionDaysBucket(31)).toBe("30-90");
    expect(telemetry.retentionDaysBucket(90)).toBe("30-90");
    expect(telemetry.retentionDaysBucket(91)).toBe("90+");
  });

  it("tz_continent_bucket：空→UTC；无 / →UTC 字面或 other；9 洲白名单", () => {
    expect(telemetry.tzContinentBucket(null)).toBe("UTC");
    expect(telemetry.tzContinentBucket("")).toBe("UTC");
    expect(telemetry.tzContinentBucket("UTC")).toBe("UTC");
    expect(telemetry.tzContinentBucket("GMT")).toBe("other");
    for (const head of ["Asia", "America", "Europe", "Africa", "Australia", "Pacific", "Atlantic", "Indian", "Antarctica"]) {
      expect(telemetry.tzContinentBucket(`${head}/Somewhere`)).toBe(head);
    }
    expect(telemetry.tzContinentBucket("Bogus/City")).toBe("other");
  });

  it("email_provider_kind：11 域名映射表 + other 兜底 + 大小写/空白", () => {
    expect(telemetry.emailProviderKind("a@gmail.com")).toBe("gmail");
    expect(telemetry.emailProviderKind("a@googlemail.com")).toBe("gmail");
    expect(telemetry.emailProviderKind("a@outlook.com")).toBe("outlook");
    expect(telemetry.emailProviderKind("a@hotmail.com")).toBe("outlook");
    expect(telemetry.emailProviderKind("a@live.com")).toBe("outlook");
    expect(telemetry.emailProviderKind("a@msn.com")).toBe("outlook");
    expect(telemetry.emailProviderKind("a@icloud.com")).toBe("icloud");
    expect(telemetry.emailProviderKind("a@me.com")).toBe("icloud");
    expect(telemetry.emailProviderKind("a@yahoo.com")).toBe("yahoo");
    expect(telemetry.emailProviderKind("a@yahoo.co.jp")).toBe("yahoo");
    expect(telemetry.emailProviderKind("a@ymail.com")).toBe("yahoo");
    expect(telemetry.emailProviderKind("a@unknown.dev")).toBe("other");
    expect(telemetry.emailProviderKind(null)).toBe("other");
    expect(telemetry.emailProviderKind("noatsign")).toBe("other");
    expect(telemetry.emailProviderKind("User@GMAIL.Com")).toBe("gmail");
    expect(telemetry.emailProviderKind("a@ outlook.com ")).toBe("outlook");
  });
});

// ── base properties 与 runtime_os ──

describe("base_properties", () => {
  it("键面 = 预裁决集：删 python_version、增 node_version（PRD §6.2）", () => {
    const props = telemetry.baseProperties();
    expect(Object.keys(props).sort()).toEqual(
      ["app_locale", "app_version", "is_docker", "node_version", "os", "os_release"].sort(),
    );
    expect(props.python_version).toBeUndefined();
  });

  it("app_version 取仓库根 package.json（0.1.0）；node_version 取 process.version", () => {
    const props = telemetry.baseProperties();
    expect(props.app_version).toBe("0.1.0");
    expect(props.node_version).toBe(process.version);
    expect(props.is_docker).toBe(existsSync("/.dockerenv"));
    expect(typeof props.os_release).toBe("string");
  });

  it("app_locale 默认 unknown；set_app_locale 跟随；空串回 unknown", () => {
    expect(telemetry.baseProperties().app_locale).toBe("unknown");
    telemetry.setAppLocale("zh");
    expect(telemetry.baseProperties().app_locale).toBe("zh");
    telemetry.setAppLocale("");
    expect(telemetry.baseProperties().app_locale).toBe("unknown");
  });

  it("runtime_os：本平台映射到五分类之一", () => {
    const valid = new Set(["mac", "windows", "wsl", "linux", "other"]);
    expect(valid.has(telemetry.runtimeOs())).toBe(true);
    if (process.platform === "win32") expect(telemetry.runtimeOs()).toBe("windows");
    if (process.platform === "darwin") expect(telemetry.runtimeOs()).toBe("mac");
  });
});

// ── 门控链（PRD §3.2：env=0 / vitest / CI 变量 / db_disabled） ──

describe("门控链", () => {
  it("VIBE_SELLER_TELEMETRY=0 → init 不建客户端、isEnabled false", () => {
    process.env.VIBE_SELLER_TELEMETRY = "0";
    telemetry.init("/nonexistent-data-dir-for-test");
    expect(telemetry.isEnabled()).toBe(false);
    expect(telemetry.getInstallId()).toBeNull();
  });

  it("vitest 环境（VITEST 存在）→ init 不建客户端（测试禁真网的第一道门）", () => {
    process.env.VITEST = "true";
    delete process.env.VIBE_SELLER_TELEMETRY;
    telemetry.init("/nonexistent-data-dir-for-test");
    expect(telemetry.isEnabled()).toBe(false);
  });

  it("CI 变量任一非空 → init 不建客户端（同名移植原 ci_signals）", () => {
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
    delete process.env.VIBE_SELLER_TELEMETRY;
    for (const ci of ["CI", "GITHUB_ACTIONS", "BUILDKITE", "GITLAB_CI", "CIRCLECI", "JENKINS_URL"]) {
      telemetry.__test.reset();
      process.env[ci] = "1";
      telemetry.init("/nonexistent-data-dir-for-test");
      expect(telemetry.isEnabled()).toBe(false);
      delete process.env[ci];
    }
  });

  it("全开（无 vitest/CI/env 禁用）→ init 建客户端 + install_id 落盘；重复 init 幂等", async () => {
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
    delete process.env.VIBE_SELLER_TELEMETRY;
    const dir = await mkdtemp(join(tmpdir(), "vibe-telemetry-"));
    try {
      telemetry.init(dir);
      expect(telemetry.isEnabled()).toBe(true);
      const id = telemetry.getInstallId();
      expect(id).toBeTruthy();
      expect(existsSync(join(dir, "install_id"))).toBe(true);
      expect((await readFile(join(dir, "install_id"), "utf8")).trim()).toBe(id);
      // 重复 init：不再换 id、不重建客户端
      telemetry.init(dir);
      expect(telemetry.getInstallId()).toBe(id);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("install_id 已有文件 → 复用；IO 失败 → 一次性 uuid 不落盘", async () => {
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
    delete process.env.VIBE_SELLER_TELEMETRY;
    const dir = await mkdtemp(join(tmpdir(), "vibe-telemetry-"));
    try {
      await writeFile(join(dir, "install_id"), "preexisting-id\n", "utf8");
      telemetry.init(dir);
      expect(telemetry.getInstallId()).toBe("preexisting-id");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    // dataDir 的父路径是文件 → 读/写必败 → uuid 兜底且不落盘（与原 _resolve_install_id 一致）
    const blocker = await mkdtemp(join(tmpdir(), "vibe-telemetry-file-"));
    const notADir = join(blocker, "f");
    await writeFile(notADir, "x", "utf8");
    telemetry.__test.reset();
    telemetry.init(join(notADir, "sub"));
    expect(telemetry.getInstallId()).toBeTruthy();
    expect(existsSync(join(notADir, "sub", "install_id"))).toBe(false);
    await rm(blocker, { recursive: true, force: true });
  });

  it("db_disabled → send no-op；解除后恢复", () => {
    const captured: { event: string; properties: Record<string, unknown> }[] = [];
    telemetry.__test.enable(captured);
    expect(telemetry.isEnabled()).toBe(true);
    telemetry.setDbDisabled(true);
    expect(telemetry.isEnabled()).toBe(false);
    telemetry.send("x", {});
    expect(captured).toHaveLength(0);
    telemetry.setDbDisabled(false);
    expect(telemetry.isEnabled()).toBe(true);
    telemetry.send("x", {});
    expect(captured).toHaveLength(1);
  });

  it("env=0 时即使客户端在手 send 也 no-op（is_enabled 双查 env）", () => {
    const captured: { event: string; properties: Record<string, unknown> }[] = [];
    telemetry.__test.enable(captured);
    process.env.VIBE_SELLER_TELEMETRY = " 0 "; // strip 语义
    expect(telemetry.isEnabled()).toBe(false);
    telemetry.send("x", {});
    expect(captured).toHaveLength(0);
  });

  it("客户端未 init → send no-op 不抛", () => {
    telemetry.__test.reset();
    expect(() => telemetry.send("x", {})).not.toThrow();
  });
});

// ── send 属性合并（原 tests/unit/test_telemetry.py 三断言照搬，python_version→node_version） ──

describe("send 属性合并", () => {
  let captured: { event: string; properties: Record<string, unknown> }[] = [];
  beforeEach(() => {
    captured = [];
    telemetry.__test.enable(captured);
  });

  function lastProps(): Record<string, unknown> {
    expect(captured.length).toBeGreaterThan(0);
    return captured[captured.length - 1]!.properties;
  }

  it("base properties 合入每一个事件，caller 键保留", () => {
    telemetry.send("task_created", { has_schedule: "false" });
    const props = lastProps();
    expect(props["app_version"]).toBe(telemetry.APP_VERSION);
    expect(props).toHaveProperty("os");
    expect(props).toHaveProperty("node_version"); // 原 python_version（预裁决 §6.2）
    expect(props).toHaveProperty("is_docker");
    expect(props["has_schedule"]).toBe("false");
  });

  it("无 caller properties 时也带版本", () => {
    telemetry.send("store_deleted");
    const props = lastProps();
    expect(props["app_version"]).toBe(telemetry.APP_VERSION);
    expect(props).toHaveProperty("os");
  });

  it("caller 属性覆盖 base（app_version 显式传入则 caller 赢）", () => {
    telemetry.send("app_started", { app_version: "override" });
    expect(lastProps()["app_version"]).toBe("override");
  });

  it("捕获函数抛错被吞掉（send 永不抛出）", () => {
    telemetry.__test.enable([], "boom-install", { throwOnCapture: true });
    expect(() => telemetry.send("x", {})).not.toThrow();
  });
});

// ── 最小 PostHog transport ──

describe("PosthogTransport", () => {
  interface Posted {
    url: string;
    body: {
      api_key: string;
      batch: { event: string; distinct_id: string; properties: Record<string, unknown>; timestamp: string; type: string }[];
    };
  }

  function makeTransport(post: (url: string, body: string) => Promise<void>, flushAt = 20, flushIntervalMs = 10_000): PosthogTransport {
    return new PosthogTransport({ apiKey: "phc_test", host: "https://t.vibe-sellers.com", flushAt, flushIntervalMs, post });
  }

  const parse = (body: string): Posted["body"] => JSON.parse(body) as Posted["body"];

  it("flushAt=20：capture 只入队；第 20 条触发批量 POST {host}/batch/", async () => {
    const posted: Posted[] = [];
    const t = makeTransport(async (url, body) => void posted.push({ url, body: parse(body) }));
    for (let i = 0; i < 19; i++) t.capture("install-1", `evt-${i}`, { i });
    expect(posted).toHaveLength(0);
    t.capture("install-1", "evt-19", { i: 19 });
    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toBe("https://t.vibe-sellers.com/batch/");
    expect(posted[0]!.body.api_key).toBe("phc_test");
    expect(posted[0]!.body.batch).toHaveLength(20);
    const first = posted[0]!.body.batch[0]!;
    expect(first).toMatchObject({ event: "evt-0", distinct_id: "install-1", type: "capture" });
    expect(typeof first.timestamp).toBe("string");
    expect(first.properties).toMatchObject({ i: 0 });
    await t.shutdown();
  });

  it("shutdown() 排空剩余队列", async () => {
    const posted: Posted[] = [];
    const t = makeTransport(async (url, body) => void posted.push({ url, body: parse(body) }));
    t.capture("i", "only", {});
    expect(posted).toHaveLength(0);
    await t.shutdown();
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body.batch).toHaveLength(1);
  });

  it("定时 flush（10s 默认语义，测试用 20ms 验证定时器通路）", async () => {
    const posted: Posted[] = [];
    const t = makeTransport(async (url, body) => void posted.push({ url, body: parse(body) }), 20, 20);
    t.capture("i", "timer-flush", {});
    await new Promise((r) => setTimeout(r, 80));
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body.batch[0]!.event).toBe("timer-flush");
    await t.shutdown();
  });

  it("POST 失败被吞掉、队列排空（send 面永不抛）", async () => {
    let calls = 0;
    const t = makeTransport(async () => {
      calls += 1;
      throw new Error("network down");
    });
    t.capture("i", "a", {});
    await expect(t.flush()).resolves.toBeUndefined();
    expect(calls).toBe(1);
    // 队列已排空：再次 flush 不重发
    await t.flush();
    expect(calls).toBe(1);
    await t.shutdown();
  });

  it("identify 走 $identify capture 形状（posthog-python 最小等价）", async () => {
    const posted: Posted[] = [];
    const t = makeTransport(async (url, body) => void posted.push({ url, body: parse(body) }));
    t.identify("install-1", { app_locale: "zh" });
    await t.shutdown();
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body.batch[0]).toMatchObject({ event: "$identify", distinct_id: "install-1" });
    expect(posted[0]!.body.batch[0]!.properties["$set"]).toMatchObject({ app_locale: "zh" });
  });
});

// ── app 面：locale 端点 + settings GET/PUT ──

describe("telemetry app 面", () => {
  let dir: string;
  let deps: AppDeps;
  let app: ReturnType<typeof createApp>;
  let adminCookie: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "vibe-telemetry-app-"));
    const cfg: ServerConfig = {
      homeDir: dir,
      dataDir: join(dir, "data"),
      dbPath: join(dir, "vibe_seller.db"),
      jwtSecretFile: join(dir, "jwt_secret"),
      port: 0,
      adminEmail: "admin@vibe-seller.local",
      adminPassword: "admin",
      adminUsername: "admin",
      version: "0.1.0-test",
      jwtSecret: "test-secret",
    };
    const db = openDb(cfg);
    seed(db, cfg, hashPassword);
    deps = { config: cfg, jwtSecret: "test-secret", db, bus: new EventBus() };
    app = createApp(deps);
    const res = await app.request("/api/auth/login", { method: "POST", body: JSON.stringify({ identifier: "admin", password: "admin" }), headers: { "content-type": "application/json" } });
    adminCookie = res.headers.get("set-cookie")!.split(";")[0]!;
  });

  const postJson = (path: string, body: unknown) =>
    app.request(path, { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify(body) });
  const putJson = (path: string, body: unknown) =>
    app.request(path, { method: "PUT", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify(body) });

  it("locale 端点：白名单 en/zh；否则 unknown；恒 ok:true；>16 截断；app_locale 跟随", async () => {
    let res = await postJson("/api/telemetry/locale", { locale: "zh" });
    expect(await res.json()).toEqual({ ok: true, locale: "zh" });
    expect(telemetry.baseProperties().app_locale).toBe("zh");

    res = await postJson("/api/telemetry/locale", { locale: "fr" });
    expect(await res.json()).toEqual({ ok: true, locale: "unknown" });
    expect(telemetry.baseProperties().app_locale).toBe("unknown");

    res = await postJson("/api/telemetry/locale", { locale: "en" });
    expect(await res.json()).toEqual({ ok: true, locale: "en" });
    expect(telemetry.baseProperties().app_locale).toBe("en");

    // ≤16 截断（任务预裁决；原实现为 pydantic max_length=16 → 422，差异已注释记录）。
    // 截断后的 16 字符不在白名单 → 归一 unknown。
    res = await postJson("/api/telemetry/locale", { locale: "x".repeat(20) });
    expect(await res.json()).toEqual({ ok: true, locale: "unknown" });
    expect(telemetry.baseProperties().app_locale).toBe("unknown");
  });

  it("settings GET：env 禁用 → 回报 telemetry_enabled='false'（PRD §3.5.5）", async () => {
    process.env.VIBE_SELLER_TELEMETRY = "0";
    const body = (await (await app.request("/api/settings", { headers: { cookie: adminCookie } })).json()) as Record<string, string>;
    expect(body.telemetry_enabled).toBe("false");
  });

  it("settings GET：init 过（注入 install_id）→ 响应含 install_id", async () => {
    const captured: { event: string; properties: Record<string, unknown> }[] = [];
    telemetry.__test.enable(captured, "iid-1234");
    const body = (await (await app.request("/api/settings", { headers: { cookie: adminCookie } })).json()) as Record<string, string>;
    expect(body.install_id).toBe("iid-1234");
  });

  it("settings PUT 顺序红线：telemetry_enabled false→true 那次 setting_changed 必须发出", async () => {
    const captured: { event: string; properties: Record<string, unknown> }[] = [];
    telemetry.__test.enable(captured);
    // 模拟启动已按库里的 false 关掉遥测（main._apply_persisted_telemetry_flag 等价态）
    deps.db.prepare("INSERT INTO app_settings (key, value) VALUES ('telemetry_enabled', 'false') ON CONFLICT(key) DO UPDATE SET value = 'false'").run();
    telemetry.setDbDisabled(true);
    expect(telemetry.isEnabled()).toBe(false);

    const res = await putJson("/api/settings", { telemetry_enabled: true });
    expect(await res.json()).toEqual({ ok: true });

    const evt = captured.find((c) => c.event === TelemetryEvent.SETTING_CHANGED);
    expect(evt).toBeDefined();
    expect(evt!.properties).toMatchObject({ key: "telemetry_enabled", to_value: true });
    // 顺序副证：PUT 之后 db_disabled 已解除
    expect(telemetry.isEnabled()).toBe(true);
  });

  it("settings PUT：每个接受 key 一条事件，to_value 按键分桶", async () => {
    const captured: { event: string; properties: Record<string, unknown> }[] = [];
    telemetry.__test.enable(captured);
    await putJson("/api/settings", {
      auth_required: false,
      max_agent_concurrency: 5,
      default_schedule_timezone: "Asia/Shanghai",
      task_retention_days: 30,
      default_schedule_phase_mode: "single",
      browser_headless: "true",
      skills_auto_sync_enabled: "yes",
      unknown_key: "ignored",
    });
    const byKey = new Map(captured.filter((c) => c.event === TelemetryEvent.SETTING_CHANGED).map((c) => [c.properties["key"] as string, c.properties["to_value"]]));
    expect(byKey.get("auth_required")).toBe(false);
    expect(byKey.get("max_agent_concurrency")).toBe(5);
    expect(byKey.get("default_schedule_timezone")).toBe("Asia");
    expect(byKey.get("task_retention_days")).toBe("7-30");
    expect(byKey.get("default_schedule_phase_mode")).toBe("single");
    expect(byKey.get("browser_headless")).toBe(true);
    expect(byKey.get("skills_auto_sync_enabled")).toBe(false); // 'yes' 非 true/1 → false
    expect(byKey.has("unknown_key")).toBe(false);
  });
});
