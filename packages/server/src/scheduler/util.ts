// 小工具面：服务器时区解析（逐字对齐 app/utils/timezone.get_server_timezone ——
// 纯本地 IANA 解析，失败回退 UTC；AppSettings 的 default_schedule_timezone 只在
// schedule create/update 的时区解析里用，不在这里）。

export function getServerTimezone(_deps?: unknown): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
