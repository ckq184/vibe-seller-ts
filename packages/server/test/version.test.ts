// 版本号单一来源（路线 4 T2 / G1）：对齐原版 app/version.py——/api/health、/api/version、
// /api/system/info 与遥测 app_version 同出根 package.json 的 version；VIBE_VERSION 覆盖保留。
// 期望值直接读仓库根 package.json，不经被测模块，防止"同源自证"。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readServerConfig } from "../src/config";
import * as telemetry from "../src/telemetry/core";

const rootPkgVersion = (
  JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "package.json"), "utf8")) as { version: string }
).version;

describe("版本号单一来源", () => {
  it("未设 VIBE_VERSION → config.version 取根 package.json 的 version，与遥测 APP_VERSION 同源", () => {
    expect(readServerConfig({}).version).toBe(rootPkgVersion);
    expect(telemetry.APP_VERSION).toBe(rootPkgVersion);
  });

  it("设了 VIBE_VERSION → 取覆盖值", () => {
    expect(readServerConfig({ VIBE_VERSION: "9.9.9-override" }).version).toBe("9.9.9-override");
  });
});
