// 批次 4.4 触发器数学：interval 锚点网格 / weekly / monthly 月份网格 / 原生 cron。
// 锚点语义是重启不漂移的关键（原 _interval_start 的注释）：网格是调度定义的纯函数。

import { describe, expect, it } from "vitest";
import { buildTrigger, cronNextRun, monthlyMonths, parseCronExpression } from "../src/schedule/triggers";
import { fromZoned, validateTimezone, zonedParts } from "../src/schedule/tz";

const TZ = "Asia/Shanghai"; // UTC+8，无夏令时——断言可预测

describe("时区工具", () => {
  it("validateTimezone：合法 IANA 通过，垃圾串拒绝", () => {
    expect(validateTimezone("Asia/Shanghai")).toBe(true);
    expect(validateTimezone("UTC")).toBe(true);
    expect(validateTimezone("Not/AZone")).toBe(false);
  });

  it("fromZoned：墙上时间 → 正确 UTC 瞬间", () => {
    // 2026-10-08 09:00 +08:00 = 2026-10-08T01:00Z
    const d = fromZoned(2026, 10, 8, 9, 0, TZ);
    expect(d.toISOString()).toBe("2026-10-08T01:00:00.000Z");
    const p = zonedParts(d, TZ);
    expect([p.year, p.month, p.day, p.hour, p.minute]).toEqual([2026, 10, 8, 9, 0]);
    expect(p.isoWeekday).toBe(4); // 2026-10-08 是周四
  });
});

describe("monthlyMonths（对齐 _monthly_months）", () => {
  it("每 3 个月：锚 1 月 → 1,4,7,10", () => {
    const anchor = fromZoned(2026, 1, 15, 9, 0, TZ);
    expect(monthlyMonths(anchor, TZ, 3)).toEqual([1, 4, 7, 10]);
  });
  it("每 5 个月：12 不整除——k 取 0..⌊11/5⌋，年内 3 个点（原实现同款）", () => {
    const anchor = fromZoned(2026, 6, 1, 9, 0, TZ);
    expect(monthlyMonths(anchor, TZ, 5)).toEqual([4, 6, 11]);
  });
  it("锚点取 tz 墙钟月而非 UTC 月（月底跨月案例）", () => {
    // 2026-06-30 23:00Z 在上海已是 7 月
    const anchor = new Date("2026-06-30T23:00:00Z");
    expect(monthlyMonths(anchor, TZ, 6)).toEqual([1, 7]);
  });
});

describe("buildTrigger（六种语义）", () => {
  const anchor = "2026-10-01T00:00:00.000Z"; // 上海 10-01 08:00

  it("minutes：网格锚在 created_at，而非进程启动", () => {
    const next = buildTrigger({ scheduleType: "minutes", scheduleTime: "09:00", scheduleDay: null, intervalValue: 15, timezone: TZ, anchor });
    // 网格：10-01 08:00 + k*15min；after=查询时刻 之后的第一个网格点与启动时刻无关
    const grid0 = fromZoned(2026, 10, 1, 8, 0, TZ).getTime();
    const got = next(new Date(grid0 + 16 * 60_000));
    expect(got!.getTime()).toBe(grid0 + 30 * 60_000); // 08:16 之后 → 08:30
  });

  it("hours：每 N 小时的网格点", () => {
    const next = buildTrigger({ scheduleType: "hours", scheduleTime: "09:00", scheduleDay: null, intervalValue: 2, timezone: TZ, anchor });
    const grid0 = fromZoned(2026, 10, 1, 8, 0, TZ).getTime();
    expect(next(new Date(grid0))!.getTime()).toBe(grid0 + 2 * 3_600_000);
  });

  it("days N=1：每日 HH:MM（cron 语义，与锚点无关）", () => {
    const next = buildTrigger({ scheduleType: "days", scheduleTime: "09:30", scheduleDay: null, intervalValue: 1, timezone: TZ, anchor });
    const after = fromZoned(2026, 10, 8, 9, 0, TZ);
    const got = next(after)!;
    expect(zonedParts(got, TZ)).toMatchObject({ year: 2026, month: 10, day: 8, hour: 9, minute: 30 });
  });

  it("days N>1：隔 N 天的 HH:MM，网格锚在 created_at 的墙上日期", () => {
    const next = buildTrigger({ scheduleType: "days", scheduleTime: "09:30", scheduleDay: null, intervalValue: 3, timezone: TZ, anchor });
    // 锚日 10-01；10-02 09:31 之后的首个网格点 = 10-04 09:30
    const got = next(fromZoned(2026, 10, 2, 9, 31, TZ))!;
    expect(zonedParts(got, TZ)).toMatchObject({ month: 10, day: 4, hour: 9, minute: 30 });
  });

  it("weekly N=1：目标 ISO 周几的 HH:MM（Mon=1..Sun=7）", () => {
    const next = buildTrigger({ scheduleType: "weekly", scheduleTime: "08:00", scheduleDay: 1, intervalValue: 1, timezone: TZ, anchor });
    // 10-08（周四）之后的首个周一 = 10-12
    const got = next(fromZoned(2026, 10, 8, 12, 0, TZ))!;
    expect(zonedParts(got, TZ)).toMatchObject({ month: 10, day: 12, hour: 8 });
    expect(zonedParts(got, TZ).isoWeekday).toBe(1);
  });

  it("weekly N>1：每 N 周的周几网格，锚在 created_at 周内平移", () => {
    const next = buildTrigger({ scheduleType: "weekly", scheduleTime: "08:00", scheduleDay: 3, intervalValue: 2, timezone: TZ, anchor });
    // 锚 10-01（周四 isoWeekday=3）；起点 = 锚周周三 09-30 08:00；之后每个 2 周
    const got = next(fromZoned(2026, 9, 29, 12, 0, TZ))!;
    expect(zonedParts(got, TZ).isoWeekday).toBe(3);
    expect(zonedParts(got, TZ)).toMatchObject({ month: 9, day: 30, hour: 8, minute: 0 });
    const got2 = next(fromZoned(2026, 9, 30, 8, 1, TZ))!;
    expect(zonedParts(got2, TZ)).toMatchObject({ month: 10, day: 14 }); // +2 周
  });

  it("weekly schedule_day 越界要炸（1..7 之外不许悄悄绕到别的周几）", () => {
    expect(() =>
      buildTrigger({ scheduleType: "weekly", scheduleTime: "08:00", scheduleDay: 8, intervalValue: 1, timezone: TZ, anchor }),
    ).toThrow(/1\.\.7/);
  });

  it("monthly：日号 + 月份网格；日号超月长当月不触发", () => {
    const next = buildTrigger({ scheduleType: "monthly", scheduleTime: "09:00", scheduleDay: 31, intervalValue: 1, timezone: TZ, anchor: "2026-01-15T00:00:00.000Z" });
    // 锚 1 月；每 1 个月 = 每月；31 日 → 1/3/5/7/8/10/12 月
    const got = next(fromZoned(2026, 1, 31, 10, 0, TZ))!;
    expect(zonedParts(got, TZ)).toMatchObject({ month: 3, day: 31, hour: 9 });
  });

  it("monthly N>1：锚月起 N 步月份网格", () => {
    const next = buildTrigger({ scheduleType: "monthly", scheduleTime: "09:00", scheduleDay: 15, intervalValue: 3, timezone: TZ, anchor: "2026-02-10T00:00:00.000Z" });
    const got = next(fromZoned(2026, 2, 15, 10, 0, TZ))!;
    expect(zonedParts(got, TZ)).toMatchObject({ month: 5, day: 15, hour: 9 });
  });
});

describe("原生 cron（/api/cron）", () => {
  it("5 字段解析；字段数不对抛错", () => {
    expect(() => parseCronExpression("0 9 * * 1-5")).not.toThrow();
    expect(() => parseCronExpression("0 9 * *")).toThrow(/5 fields/);
    expect(() => parseCronExpression("99 9 * * *")).toThrow();
  });

  it("0 9 * * 0-4：下个工作日 09:00（APScheduler dow：Mon=0..Sun=6）", () => {
    const fields = parseCronExpression("0 9 * * 0-4");
    // 2026-10-10 是周六（dow 5，不在 0-4）
    const got = cronNextRun(fields, fromZoned(2026, 10, 10, 0, 0, TZ), TZ)!;
    expect(zonedParts(got, TZ)).toMatchObject({ month: 10, day: 12, hour: 9, minute: 0 });
    expect(zonedParts(got, TZ).isoWeekday).toBe(1);
  });

  it("dom 与 dow 都受限时 OR 语义（APScheduler day_or）", () => {
    // 每月 1 号 或 周日（dow 6）
    const fields = parseCronExpression("30 4 1 * 6");
    // 2026-10-04 是周日；10-01 已过
    const got = cronNextRun(fields, fromZoned(2026, 10, 2, 0, 0, TZ), TZ)!;
    expect(zonedParts(got, TZ)).toMatchObject({ month: 10, day: 4, hour: 4, minute: 30 });
  });

  it("*/15 分钟步进 + 月份受限", () => {
    const fields = parseCronExpression("*/15 9 1 10 *");
    const got = cronNextRun(fields, fromZoned(2026, 10, 1, 9, 16, TZ), TZ)!;
    expect(zonedParts(got, TZ)).toMatchObject({ month: 10, day: 1, hour: 9, minute: 30 });
  });

  it("dow 7 归一为周日；名称字段支持", () => {
    const fields = parseCronExpression("0 9 * * sun");
    const got = cronNextRun(fields, fromZoned(2026, 10, 10, 0, 0, TZ), TZ)!;
    expect(zonedParts(got, TZ).isoWeekday).toBe(7);
    expect(() => parseCronExpression("0 9 * * 7")).not.toThrow();
  });
});
