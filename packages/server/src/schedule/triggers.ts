// 触发器计算：把原 APScheduler build_trigger 的六种语义移植为纯函数 nextRun(after)。
// 锚点语义是重启不漂移的关键（原 _interval_start/_weekly_start/_monthly_months 的注释）：
// interval 网格锚在 schedule.created_at，而不是进程启动时刻 —— 每次重启重建作业时
// 网格保持不变。monthly 用月份网格（月长不定，interval 触发器表达不了 N 个月），
// N 不整除 12 时年内缺口≠N 是原实现已接受的文档化限制。

import { daysInMonth, fromZoned, validateTimezone, zonedParts, type ZonedParts } from "./tz";

export type NextRunFn = (after: Date) => Date | null;

export interface TriggerParams {
  scheduleType: string; // 'minutes'|'hours'|'days'|'weekly'|'monthly'
  scheduleTime: string; // HH:MM or HH:MM:SS
  scheduleDay: number | null;
  intervalValue: number;
  timezone: string;
  /** ISO 创建时间；interval 网格锚点。 */
  anchor: string | null;
}

function parseHHMM(scheduleTime: string): { h: number; m: number } {
  const parts = scheduleTime.split(":");
  const h = Number.parseInt(parts[0] ?? "0", 10);
  const m = Number.parseInt(parts[1] ?? "0", 10);
  return { h, m: Number.isNaN(m) ? 0 : m };
}

function parseIso(ts: string): Date | null {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 墙上日期 + 天数偏移 → Date（跨月/跨年由 Date.UTC 进位）。 */
function addWallDays(p: ZonedParts, days: number, tz: string, h: number, mi: number): Date {
  const base = Date.UTC(p.year, p.month - 1, p.day + days, h, mi, 0);
  const d = new Date(base);
  return fromZoned(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), h, mi, tz);
}

/** 对齐 _interval_start：锚点墙钟时间，day 级调度钉住 HH:MM。 */
function intervalOrigin(anchor: Date, tz: string, h: number | null, mi: number | null): ZonedParts {
  const p = zonedParts(anchor, tz);
  if (h !== null) {
    return { ...p, hour: h, minute: mi ?? 0, second: 0 };
  }
  return { ...p, second: 0 };
}

/** 对齐 _weekly_start：锚点周内平移到目标 ISO 周几，钉住 HH:MM。 */
function weeklyOrigin(anchor: Date, tz: string, scheduleDay: number | null, h: number, mi: number): ZonedParts {
  const p = zonedParts(anchor, tz);
  const shift = scheduleDay !== null ? scheduleDay - p.isoWeekday : 0;
  return { ...p, hour: h, minute: mi, second: 0, day: p.day + shift };
}

/** 对齐 _monthly_months：锚点月起 N 步月份网格（12 个月内）。 */
export function monthlyMonths(anchor: Date, tz: string, intervalValue: number): number[] {
  const base = zonedParts(anchor, tz).month;
  const months = new Set<number>();
  for (let k = 0; k <= Math.floor(11 / intervalValue); k++) {
    months.add((((base - 1 + k * intervalValue) % 12) + 12) % 12 + 1);
  }
  return [...months].sort((a, b) => a - b);
}

function gridNext(originMs: number, stepMs: number, after: Date): Date | null {
  if (!Number.isFinite(originMs)) return null;
  let k = Math.ceil((after.getTime() - originMs) / stepMs);
  if (k <= 0) k = 0;
  let candidate = originMs + k * stepMs;
  while (candidate <= after.getTime()) {
    k += 1;
    candidate = originMs + k * stepMs;
  }
  return new Date(candidate);
}

function dailyOrWeeklyNext(p: ZonedParts, tz: string, h: number, mi: number, weekdayFilter: number | null, after: Date): Date | null {
  // 从 after 的墙钟日当日起逐日扫（最多 366*5 天），首个人选既满足周几又晚于 after。
  // 当天 HH:MM 仍在上半场时今天就触发（APScheduler CronTrigger 同语义）。
  const start = zonedParts(after, tz);
  for (let i = 0; i <= 366 * 5; i++) {
    const cand = addWallDays(start, i, tz, h, mi);
    if (cand.getTime() <= after.getTime()) continue;
    if (weekdayFilter !== null && zonedParts(cand, tz).isoWeekday !== weekdayFilter) continue;
    return cand;
  }
  return null;
}

/** build_trigger 全量移植：给定调度参数返回 nextRun(after)。 */
export function buildTrigger(params: TriggerParams): NextRunFn {
  const tz = params.timezone;
  if (!validateTimezone(tz)) throw new Error(`Invalid timezone: ${tz}`);
  const anchor = params.anchor ? parseIso(params.anchor) : null;
  const { h, m } = parseHHMM(params.scheduleTime);
  const interval = Math.max(1, params.intervalValue || 1);

  if (params.scheduleType === "minutes") {
    if (!anchor) return () => null;
    const origin = intervalOrigin(anchor, tz, null, null);
    const originMs = fromZoned(origin.year, origin.month, origin.day, origin.hour, origin.minute, tz, origin.second).getTime();
    return (after) => gridNext(originMs, interval * 60_000, after);
  }
  if (params.scheduleType === "hours") {
    if (!anchor) return () => null;
    const origin = intervalOrigin(anchor, tz, null, null);
    const originMs = fromZoned(origin.year, origin.month, origin.day, origin.hour, origin.minute, tz, origin.second).getTime();
    return (after) => gridNext(originMs, interval * 3_600_000, after);
  }
  if (params.scheduleType === "days") {
    if (interval === 1) {
      return (after) => dailyOrWeeklyNext(zonedParts(after, tz), tz, h, m, null, after);
    }
    if (!anchor) return () => null;
    const origin = intervalOrigin(anchor, tz, h, m);
    const originDate = addWallDays({ ...origin, day: origin.day }, 0, tz, h, m);
    return (after) => {
      // 天级网格走墙钟日（DST 不漂移），粗算 k 再线性校正
      const approx = Math.floor((after.getTime() - originDate.getTime()) / (interval * 86_400_000));
      for (let k = Math.max(0, approx - 2); k < approx + interval * 3 + 4; k++) {
        const cand = addWallDays(origin, k * interval, tz, h, m);
        if (cand.getTime() > after.getTime()) return cand;
      }
      return null;
    };
  }
  if (params.scheduleType === "weekly") {
    if (params.scheduleDay !== null && !(params.scheduleDay >= 1 && params.scheduleDay <= 7)) {
      throw new Error(`weekly schedule_day must be 1..7 (ISO weekday, Mon=1..Sun=7); got ${params.scheduleDay}`);
    }
    if (interval > 1) {
      if (!anchor) return () => null;
      const origin = weeklyOrigin(anchor, tz, params.scheduleDay, h, m);
      const originDate = addWallDays(origin, 0, tz, h, m);
      return (after) => {
        const approx = Math.floor((after.getTime() - originDate.getTime()) / (interval * 7 * 86_400_000));
        for (let k = Math.max(0, approx - 2); k < approx + interval * 3 + 4; k++) {
          const cand = addWallDays(origin, k * interval * 7, tz, h, m);
          if (cand.getTime() > after.getTime()) return cand;
        }
        return null;
      };
    }
    return (after) => dailyOrWeeklyNext(zonedParts(after, tz), tz, h, m, params.scheduleDay, after);
  }
  if (params.scheduleType === "monthly") {
    if (!anchor) return () => null;
    const months = monthlyMonths(anchor, tz, interval);
    const day = params.scheduleDay;
    return (after) => {
      const start = zonedParts(after, tz);
      for (let i = 0; i < 48; i++) {
        const mo = ((start.month - 1 + i) % 12) + 1;
        const y = start.year + Math.floor((start.month - 1 + i) / 12);
        if (!months.includes(mo)) continue;
        if (day === null || day < 1 || day > daysInMonth(y, mo)) continue;
        const cand = fromZoned(y, mo, day, h, m, tz);
        if (cand.getTime() > after.getTime()) return cand;
      }
      return null;
    };
  }
  // 兜底：按 daily（对齐 build_trigger 的 fallback）
  return (after) => dailyOrWeeklyNext(zonedParts(after, tz), tz, h, m, null, after);
}

// ── 原生 cron 表达式（/api/cron，5 字段；APScheduler CronTrigger 语义） ──

export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number> | null; // null = '*'（不受限）
  month: Set<number> | null;
  dow: Set<number> | null; // 0=Mon..6=Sun（7 归一到 Sun=6）
}

const DOW_NAMES: Record<string, number> = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };

function parseField(text: string, min: number, max: number, isDow: boolean): Set<number> | null {
  const out = new Set<number>();
  for (const partRaw of text.split(",")) {
    const part = partRaw.trim().toLowerCase();
    if (!part) throw new Error(`Invalid cron field: ${text}`);
    const slashIdx = part.indexOf("/");
    const rangePart = slashIdx === -1 ? part : part.slice(0, slashIdx);
    const stepPart = slashIdx === -1 ? undefined : part.slice(slashIdx + 1);
    const step = stepPart !== undefined ? Number.parseInt(stepPart, 10) : 1;
    if (Number.isNaN(step) || step < 1) throw new Error(`Invalid cron step in: ${text}`);
    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else if (rangePart.includes("-")) {
      const segs = rangePart.split("-");
      const a = segs[0] ?? "";
      const b = segs[1] ?? "";
      const loRes = resolveValue(a, isDow, min, max);
      const hiRes = resolveValue(b, isDow, min, max);
      if (loRes === null || hiRes === null || loRes > hiRes) throw new Error(`Invalid cron range: ${text}`);
      lo = loRes;
      hi = hiRes;
    } else {
      const v = resolveValue(rangePart, isDow, min, max);
      if (v === null) throw new Error(`Invalid cron value: ${text}`);
      lo = v;
      hi = stepPart !== undefined ? max : v;
    }
    for (let val = lo; val <= hi; val += step) out.add(isDow && val === 7 ? 6 : val);
  }
  if (out.size === 0) throw new Error(`Invalid cron field: ${text}`);
  return text.trim() === "*" ? null : out;
}

function resolveValue(token: string, isDow: boolean, min: number, max: number): number | null {
  if (isDow && token in DOW_NAMES) return DOW_NAMES[token] ?? null;
  const v = Number.parseInt(token, 10);
  if (Number.isNaN(v)) return null;
  if (isDow && v === 7) return 6;
  if (v < min || v > max) return null;
  return v;
}

/** "minute hour day month day_of_week"；字段数不对抛错（路由转 400）。 */
export function parseCronExpression(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Invalid cron expression (need 5 fields): ${expr}`);
  return {
    minute: parseField(parts[0]!, 0, 59, false)!,
    hour: parseField(parts[1]!, 0, 23, false)!,
    dom: parseField(parts[2]!, 1, 31, false),
    month: parseField(parts[3]!, 1, 12, false)!,
    dow: parseField(parts[4]!, 0, 7, true),
  };
}

/**
 * cron 下一次触发。APScheduler 的 day/dow 组合语义：两者都受限时 OR，
 * 只有一个受限时该字段必须命中；`*` 字段（解析为 null）不受限。
 */
export function cronNextRun(fields: CronFields, after: Date, tz = "UTC"): Date | null {
  const start = zonedParts(after, tz);
  let dayCursor = { y: start.year, mo: start.month, d: start.day };
  for (let i = 0; i < 366 * 5; i++) {
    if (!fields.month || fields.month.has(dayCursor.mo)) {
      const domOk = fields.dom === null || fields.dom.has(dayCursor.d);
      const wd = wallWeekday(dayCursor.y, dayCursor.mo, dayCursor.d);
      const dowOk = fields.dow === null || fields.dow.has(wd);
      const dayMatches = fields.dom !== null && fields.dow !== null ? domOk || dowOk : domOk && dowOk;
      if (dayMatches) {
        for (const h of [...fields.hour].sort((a, b) => a - b)) {
          for (const mi of [...fields.minute].sort((a, b) => a - b)) {
            const cand = fromZoned(dayCursor.y, dayCursor.mo, dayCursor.d, h, mi, tz);
            if (cand.getTime() > after.getTime()) return cand;
          }
        }
      }
    }
    dayCursor = nextDay(dayCursor);
  }
  return null;
}

function wallWeekday(y: number, mo: number, d: number): number {
  // ISO weekday（Mon=1..Sun=7）→ cron dow（Mon=0..Sun=6）
  const iso = new Date(Date.UTC(y, mo - 1, d)).getUTCDay(); // 0=Sun
  return iso === 0 ? 6 : iso - 1;
}

function nextDay(cur: { y: number; mo: number; d: number }): { y: number; mo: number; d: number } {
  const next = new Date(Date.UTC(cur.y, cur.mo - 1, cur.d + 1));
  return { y: next.getUTCFullYear(), mo: next.getUTCMonth() + 1, d: next.getUTCDate() };
}
