// @vibe/bridge 导出面。Phase 5.2 起 Python 编排路径退役：HTTP+SSE 桥服务
// （server.ts）、scripted 引擎（scripted.ts）、MCP stdio 客户端（mcp.ts）、活 run
// 注册表（registry.ts）已删除；保留的是 server 进程内复用的装配面——
// translator（事件词表翻译）、profiles（桥 profiles.json 双源解析）、pi 引擎装配
// （readEnv/defaultBudget/buildPi + gatePolicyFor/toVibeToolSpecs/RunFactoryResult）。

export { createTranslator, type BridgeEvent, type DonePayload } from "./translate";
export { loadProfiles, type LoadedProfiles, type VibeProfile } from "./profiles";
export {
  readEnv,
  defaultBudget,
  buildPi,
  gatePolicyFor,
  toVibeToolSpecs,
  type BridgeEnv,
  type PiBundle,
  type ToolSchemaInfo,
  type RunFactoryResult,
} from "./main";
