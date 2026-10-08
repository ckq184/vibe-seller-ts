// 时区工具：node:intl 内建 IANA 支持（Node ≥ 16 全量 ICU），不引依赖。
// 语义对齐原实现 zoneinfo + APScheduler trigger：wall-clock 触发、DST 由
// offset 两次迭代消解。

export function validateTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  second: number;
  isoWeekday: number; // Mon=1..Sun=7
}

const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function zonedParts(date: Date, tz: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) map[p.type] = p.value;
  const hour = Number(map.hour) === 24 ? 0 : Number(map.hour); // 某些 ICU 用 24 表示午夜
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    second: Number(map.second),
    isoWeekday: WEEKDAY[map.weekday ?? "Mon"] ?? 1,
  };
}

/** 该瞬间 tz 的偏移量（毫秒，东侧为正）。 */
export function tzOffsetMs(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** 把 tz 下的墙上时间转成 UTC Date；DST 歧义按 offset 二次迭代消解。 */
export function fromZoned(y: number, mo: number, d: number, h: number, mi: number, tz: string, s = 0): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let ts = guess;
  for (let i = 0; i < 2; i++) {
    const off = tzOffsetMs(new Date(ts), tz);
    ts = guess - off;
  }
  return new Date(ts);
}

export function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}
