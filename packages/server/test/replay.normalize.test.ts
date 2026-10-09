// 归一化器单测：规则是录制回放两侧共用的比较契约，规则本身必须有钉子。

import { describe, expect, it } from "vitest";
import { firstDiff, normalizeValue } from "./replay/normalize";

describe("normalizeValue", () => {
  it("UUID 形状字符串 → <uuid>（含固定种子 UUID）", () => {
    expect(normalizeValue("44fbd58a-5b7f-4669-a061-2f4ec8e2d9e7")).toBe("<uuid>");
    expect(normalizeValue("00000000-0000-0000-0000-000000000001")).toBe("<uuid>");
    expect(normalizeValue("not-a-uuid")).toBe("not-a-uuid");
  });

  it("ISO 日期时间 → <iso>（Python 微秒+00:00 与 JS 毫秒 Z 两种形状）", () => {
    expect(normalizeValue("2026-10-09T00:55:31.588076+00:00")).toBe("<iso>");
    expect(normalizeValue("2026-10-09T00:55:31.588Z")).toBe("<iso>");
    expect(normalizeValue("2026-10-09T00:55:31")).toBe("<iso>");
    expect(normalizeValue("2027-01-01")).toBe("<date>");
    // 非日期的普通字符串不受影响
    expect(normalizeValue("2026-10-09-not-a-date")).toBe("2026-10-09-not-a-date");
  });

  it("version 键 → <ver>；非 version 键的同形字符串不归", () => {
    expect(normalizeValue("0.0.0+dev", "version")).toBe("<ver>");
    expect(normalizeValue("1.2.3", "latest_version")).toBe("<ver>");
    expect(normalizeValue("0.1.0", "schema_version")).toBe("<ver>");
    expect(normalizeValue("09:30")).toBe("09:30");
  });

  it("git 修订键（sha/commit）→ <sha>（两侧 git 库各自成库，修订必异）", () => {
    expect(normalizeValue("47e7a6382960", "sha")).toBe("<sha>");
    expect(normalizeValue("e3a4ac96a88b320c0befa4b1814ed15aeca94787", "commit")).toBe("<sha>");
    expect(normalizeValue(null, "commit")).toBeNull(); // system/info commit=null 保留
  });

  it("job_id 拼 schedule_<uuid> → 归一（动态 schedule id）；静态 id 原样", () => {
    expect(normalizeValue("schedule_437f4dfe-2206-4bb1-9192-860715939458", "job_id")).toBe("schedule_<uuid>");
    expect(normalizeValue("schedule__catalog_sync", "job_id")).toBe("schedule__catalog_sync");
    expect(normalizeValue("stall_reaper", "job_id")).toBe("stall_reaper");
    // 非 job_id 键的同形字符串不归（规则只钉 /api/cron/jobs 的这个键；裸 UUID
    // 规则匹配的是整体形状，复合串不命中 → 原样保留）
    expect(normalizeValue("schedule_437f4dfe-2206-4bb1-9192-860715939458", "id")).toBe(
      "schedule_437f4dfe-2206-4bb1-9192-860715939458",
    );
  });

  it("mtime 键 → <mtime>；*.db 条目 size → <dbsize>", () => {
    expect(normalizeValue(1791507304.197585, "mtime")).toBe("<mtime>");
    const entry = normalizeValue({ path: "data\\vibe_seller.db", is_dir: false, size: 212992 });
    expect(entry).toEqual({ path: "data\\vibe_seller.db", is_dir: false, size: "<dbsize>" });
    // 文本模板 size 保留（那是逐字节比较的契约面）
    const md = normalizeValue({ path: "notes\\replay.md", is_dir: false, size: 10 });
    expect(md).toEqual({ path: "notes\\replay.md", is_dir: false, size: 10 });
  });

  it("绝对文件路径 → <abspath>；相对路径与 /api 路由不受影响", () => {
    expect(normalizeValue("C:\\Users\\x\\.vibe-seller")).toBe("<abspath>");
    expect(normalizeValue("/home/x/.vibe-seller/stores/a")).toBe("<abspath>");
    expect(normalizeValue("stores\\replay-store-renamed")).toBe("stores\\replay-store-renamed");
    expect(normalizeValue("/api/health")).toBe("/api/health");
    expect(normalizeValue("/api/telemetry/locale")).toBe("/api/telemetry/locale");
  });

  it("嵌套结构递归归一，键集合与数组长度保持原样", () => {
    const body = {
      id: "44fbd58a-5b7f-4669-a061-2f4ec8e2d9e7",
      created_at: "2026-10-09T00:55:31.588076+00:00",
      next_run: "2027-10-08T01:55:31+00:00",
      files: [{ path: "stores\\a\\STORE.md", size: 62, mtime: 1.5 }],
      detail: [
        { type: "string_too_long", loc: ["body", "locale"], msg: "String should have at most 16 characters", input: "xxxxxxxxxxxxxxxxxxxx", ctx: { max_length: 16 } },
      ],
    };
    const n = normalizeValue(body) as Record<string, unknown>;
    expect(n.id).toBe("<uuid>");
    expect(n.created_at).toBe("<iso>");
    expect(n.next_run).toBe("<iso>");
    expect((n.files as unknown[])[0]).toEqual({ path: "stores\\a\\STORE.md", size: 62, mtime: "<mtime>" });
    expect(n.detail).toEqual(body.detail); // 422 校验数组逐字段保留
  });
});

describe("firstDiff", () => {
  it("无差异返回 null", () => {
    expect(firstDiff({ a: 1, b: [2, 3] }, { a: 1, b: [2, 3] })).toBeNull();
  });

  it("报告首个差异的路径与两侧值", () => {
    expect(firstDiff({ a: { b: 1, c: 2 } }, { a: { b: 1, c: 3 } })).toEqual({
      path: "$.a.c",
      expected: 2,
      actual: 3,
    });
    expect(firstDiff({ list: [1, 2] }, { list: [1] })).toMatchObject({ path: "$.list" });
    expect(firstDiff({ a: 1 }, { a: 1, extra: true })).toEqual({ path: "$.extra", expected: undefined, actual: true });
  });

  it("类型不同（对象 vs 标量）直接报差异", () => {
    expect(firstDiff({ a: [1] }, { a: 1 })).toEqual({ path: "$.a", expected: [1], actual: 1 });
  });
});
