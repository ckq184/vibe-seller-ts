// 批次 4.7 整改 B：回放时区钉死。
//
// fixture 有 8 处字面 "Asia/Shanghai"（settings/schedules 的 timezone 字段逐
// 字符串比较，来自两侧各自的"服务器时区"解析），宿主机时区不同必假红。录制器
// （python/record_replay_fixture.py，已随 Phase 5.2 退役）env 显式 TZ=Asia/Shanghai；本模块在 TS 侧
// 钉同一个锚——必须作为 replay.test.ts 的**首个 import**（ESM 按序求值，先于
// 任何 app 代码的模块级执行）。Node 24 在 Windows 上同样支持运行时改 TZ 影响
// Intl/Date 的时区解析。
//
// 验收标准：TZ=UTC npx vitest run packages/server/test/replay.test.ts 全绿。

process.env.TZ = "Asia/Shanghai";
