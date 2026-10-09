// 录制回放契约测试的响应归一化（PRD §4.1：两侧同规则，归一化器有单测）。
//
// 规则只归「跨运行必然漂移的动态值」，不放松任何结构性比较：
//   <uuid>    UUID 形状字符串（每库各自 randomUUID；DEFAULT_USER_ID 等
//             固定 UUID 两侧本就相同，归一后仍等价）
//   <iso>     ISO-8601 日期时间（Python isoformat 微秒+00:00 vs JS toISOString
//             毫秒 Z）；<date> 纯日期（watermark/event_date）
//   <ver>     键名以 version 结尾的字符串值（原实现 0.0.0+dev vs TS 0.1.0-replay）
//   <sha>     键名为 sha/commit 的 git 修订（workspace git 历史两侧仓库各自成库，
//             修订号必然不同——版本标识符一类，结构面照常比较）
//   <mtime>   文件系统 mtime（workspace structured 条目，纯环境产物）
//   <dbsize>  *.db 文件的 size（SQLite 页布局跨实现必然不同；文本模板 size
//             仍逐字节比较——那才是契约）
//   <abspath> 绝对文件路径（Windows 盘符 / POSIX 两段以上；/api 路由除外）
// 键集合、数组长度、嵌套结构一律原样 deep-equal。

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// Python: 2026-10-09T00:55:31.588076+00:00；JS: 2026-10-09T00:55:31.588Z
const ISO_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WIN_PATH_RE = /^[A-Za-z]:[\\/]/;
// 两段以上、不以 /api 开头的 POSIX 绝对路径才算文件路径
const POSIX_PATH_RE = /^\/(?!api(\/|$))[^/]+\/+/;

export function normalizeValue(value: unknown, key = ""): unknown {
  // mtime 是文件系统时间戳（数字），先于类型分支判断
  if (key === "mtime") return "<mtime>";
  if (typeof value === "string") {
    if (key === "sha" || key === "commit") return "<sha>";
    if (key.toLowerCase().endsWith("version")) return "<ver>";
    if (UUID_RE.test(value)) return "<uuid>";
    if (ISO_RE.test(value)) return "<iso>";
    if (DATE_RE.test(value)) return "<date>";
    if (WIN_PATH_RE.test(value) || POSIX_PATH_RE.test(value)) return "<abspath>";
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => normalizeValue(v, key));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    const obj = value as Record<string, unknown>;
    // *.db 条目的 size 归一（tree 条目形如 {path: 'data\\vibe_seller.db', size: N}）
    const dbEntry =
      typeof obj.path === "string" && /\.(db|db-journal|db-wal|db-shm)$/.test(obj.path) && typeof obj.size === "number";
    for (const [k, v] of Object.entries(obj)) {
      out[k] = dbEntry && k === "size" ? "<dbsize>" : normalizeValue(v, k);
    }
    return out;
  }
  return value;
}

export interface ReplayDiff {
  path: string;
  expected: unknown;
  actual: unknown;
}

/** 首个差异点（归一化之后比较）；无差异返回 null。 */
export function firstDiff(expected: unknown, actual: unknown, path = "$"): ReplayDiff | null {
  if (JSON.stringify(expected) === JSON.stringify(actual)) return null;
  const e = expected as Record<string, unknown> | null;
  const a = actual as Record<string, unknown> | null;
  if (
    expected !== null &&
    actual !== null &&
    typeof expected === "object" &&
    typeof actual === "object" &&
    !Array.isArray(expected) === !Array.isArray(actual)
  ) {
    if (Array.isArray(expected) && Array.isArray(actual)) {
      if (expected.length !== actual.length) return { path, expected, actual };
      for (let i = 0; i < expected.length; i++) {
        const d = firstDiff(expected[i], actual[i], `${path}[${i}]`);
        if (d) return d;
      }
      return null;
    }
    const keys = new Set([...Object.keys(e!), ...Object.keys(a!)]);
    for (const k of keys) {
      if (!(k in (e as object))) return { path: `${path}.${k}`, expected: undefined, actual: (a as Record<string, unknown>)[k] };
      if (!(k in (a as object))) return { path: `${path}.${k}`, expected: (e as Record<string, unknown>)[k], actual: undefined };
      const d = firstDiff((e as Record<string, unknown>)[k], (a as Record<string, unknown>)[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return { path, expected, actual };
}
