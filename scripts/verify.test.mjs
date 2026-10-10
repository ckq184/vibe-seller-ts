// verify.mjs 的编排单测（PRD 路线3 验收 8–9 + §10）：全部走注入 fake runner，
// 不真跑 npm——真跑由交付步骤 dogfood `npm run verify` 负责（§7.5）。
// 覆盖点：参数解析（合法/未知参数/逗号与重复 --scope 展开）、四门禁按序、
// 透传参数数组、全过摘要、失败短序（失败门禁之后的 runner 不被调用）、
// 退出码与失败门禁名、缺 --scope 时第四门禁标记失败。
import { describe, expect, it } from "vitest";
import { buildGates, main, parseVerifyArgs, runGates } from "./verify.mjs";

// 收集型 io：断言横幅/摘要/用法提示打印内容，不污染测试输出
function fakeIo() {
  const lines = { log: [], error: [] };
  return {
    lines,
    log: (msg) => lines.log.push(String(msg)),
    error: (msg) => lines.error.push(String(msg)),
    all: () => lines.log.join("\n") + "\n" + lines.error.join("\n"),
  };
}

describe("parseVerifyArgs", () => {
  it("合法：单个 --scope", () => {
    expect(parseVerifyArgs(["--scope", "scripts/**"])).toEqual({
      scopes: ["scripts/**"],
      base: null,
    });
  });

  it("合法：逗号分隔展开并去空白", () => {
    expect(parseVerifyArgs(["--scope", "a,b , c"])).toEqual({
      scopes: ["a", "b", "c"],
      base: null,
    });
  });

  it("合法：重复 --scope 累积", () => {
    expect(parseVerifyArgs(["--scope", "a", "--scope", "b,c"])).toEqual({
      scopes: ["a", "b", "c"],
      base: null,
    });
  });

  it("合法：--base 可选，值去首尾空白", () => {
    expect(parseVerifyArgs(["--scope", "a", "--base", "  abc123 "])).toEqual({
      scopes: ["a"],
      base: "abc123",
    });
  });

  it("缺 --scope 不算用法错误：返回 scopes=null（交给门禁④标记失败，四门禁缺一不可）", () => {
    expect(parseVerifyArgs([])).toEqual({ scopes: null, base: null });
  });

  it("未知参数（未知旗标/位置参数）→ 用法错误", () => {
    expect(() => parseVerifyArgs(["--json"])).toThrow(/非法参数/);
    expect(() => parseVerifyArgs(["extra"])).toThrow(/非法参数/);
  });

  it("--scope 值为空/缺值 → 用法错误", () => {
    expect(() => parseVerifyArgs(["--scope", "  "])).toThrow(/--scope 值为空/);
    expect(() => parseVerifyArgs(["--scope"])).toThrow(/--scope 缺少值/);
  });

  it("--base 缺值 → 用法错误", () => {
    expect(() => parseVerifyArgs(["--scope", "a", "--base"])).toThrow(/--base 缺少值/);
  });
});

describe("buildGates", () => {
  it("四门禁按序：① typecheck ② test ③ build:server ④ check-scope", () => {
    const gates = buildGates({ scopes: ["a"], base: null });
    expect(gates.map((g) => g.name)).toEqual([
      "① 类型检查",
      "② 测试",
      "③ 构建",
      "④ diff 范围检查",
    ]);
    expect(gates[0].spawn).toMatchObject({ file: "npm run typecheck", shell: true });
    expect(gates[1].spawn).toMatchObject({ file: "npm test", shell: true });
    expect(gates[2].spawn).toMatchObject({ file: "npm run build:server", shell: true });
    // 门禁④不经 shell：process.execPath + 参数数组直 spawn（glob 模式免引号转义）
    expect(gates[3].spawn.shell).toBe(false);
    expect(gates[3].spawn.file).toBe(process.execPath);
  });

  it("④ 透传参数数组：每个 pattern 单独一个 --scope，--base 原样", () => {
    const gates = buildGates({ scopes: ["scripts/**", "docs/*.md"], base: "abc123" });
    expect(gates[3].spawn.args).toEqual([
      expect.stringContaining("check-scope.mjs"),
      "--scope", "scripts/**",
      "--scope", "docs/*.md",
      "--base", "abc123",
    ]);
  });

  it("逗号展开后的 scopes 逐个透传（parseVerifyArgs → buildGates 通路）", () => {
    const { scopes, base } = parseVerifyArgs(["--scope", "a,b", "--base", "x1"]);
    const gates = buildGates({ scopes, base });
    expect(gates[3].spawn.args).toEqual([
      expect.stringContaining("check-scope.mjs"),
      "--scope", "a",
      "--scope", "b",
      "--base", "x1",
    ]);
  });

  it("缺 --scope：仅第四门禁标记失败（含用法提示），前三个门禁不受影响", () => {
    const gates = buildGates({ scopes: null, base: null });
    for (const g of gates.slice(0, 3)) expect(g.preFailed).toBeUndefined();
    expect(gates[3].preFailed).toContain("--scope");
    expect(gates[3].usageHint).toContain("check-scope.mjs");
  });
});

describe("runGates（fake runner，不真跑 npm）", () => {
  it("全过：四门禁按序调用 runner，结果 ok 且逐门禁留耗时", () => {
    const gates = buildGates({ scopes: ["a"], base: null });
    const calls = [];
    const io = fakeIo();
    const outcome = runGates(
      gates,
      (gate) => {
        calls.push(gate.name);
        return 0;
      },
      io,
    );
    expect(calls).toEqual(gates.map((g) => g.name));
    expect(outcome.ok).toBe(true);
    expect(outcome.failed).toBeNull();
    expect(outcome.results).toHaveLength(4);
    expect(outcome.results.every((r) => r.ok)).toBe(true);
    expect(typeof outcome.totalMs).toBe("number");
  });

  it("短序：第 2 门禁失败后后续 runner 不被调用，failed 指向门禁②及其退出码", () => {
    const gates = buildGates({ scopes: ["a"], base: null });
    const calls = [];
    const outcome = runGates(
      gates,
      (gate) => {
        calls.push(gate.name);
        return gate === gates[1] ? 3 : 0;
      },
      fakeIo(),
    );
    expect(calls).toEqual([gates[0].name, gates[1].name]);
    expect(outcome.ok).toBe(false);
    expect(outcome.failed.name).toBe(gates[1].name);
    expect(outcome.failed.exitCode).toBe(3);
    expect(outcome.results).toHaveLength(1);
  });

  it("缺 --scope：门禁④标记失败且 runner 只被调用三次，用法提示已打印", () => {
    const gates = buildGates({ scopes: null, base: null });
    const calls = [];
    const io = fakeIo();
    const outcome = runGates(
      gates,
      (gate) => {
        calls.push(gate.name);
        return 0;
      },
      io,
    );
    expect(calls).toHaveLength(3);
    expect(outcome.ok).toBe(false);
    expect(outcome.failed.name).toBe(gates[3].name);
    expect(io.all()).toContain("check-scope.mjs");
    expect(io.all()).toContain("--scope");
  });

  it("每门禁打印开始横幅（含实际命令）与结束结论（含耗时）", () => {
    const gates = buildGates({ scopes: ["a"], base: null });
    const io = fakeIo();
    runGates(gates, () => 0, io);
    const out = io.lines.log.join("\n");
    expect(out).toContain("npm run typecheck");
    expect(out).toContain("npm test");
    expect(out).toContain("npm run build:server");
    expect(out).toContain("check-scope.mjs");
    expect(out).toMatch(/通过（/);
    expect(out).toMatch(/开始：/);
  });
});

describe("main（注入 runner 与 io）", () => {
  it("未知参数 → 退出码 2，stderr 含用法提示，不执行任何门禁", () => {
    const io = fakeIo();
    const calls = [];
    const code = main(["--json"], { ...io, runner: (g) => calls.push(g.name) });
    expect(code).toBe(2);
    expect(calls).toHaveLength(0);
    expect(io.lines.error.join("\n")).toContain("用法");
  });

  it("全过 → 退出码 0，log 打印四门禁摘要与总耗时", () => {
    const io = fakeIo();
    const code = main(["--scope", "a"], { ...io, runner: () => 0 });
    expect(code).toBe(0);
    const out = io.lines.log.join("\n");
    expect(out).toContain("四门禁全部通过");
    expect(out).toContain("总耗时");
    for (const name of ["① 类型检查", "② 测试", "③ 构建", "④ diff 范围检查"]) {
      expect(out).toContain(name);
    }
  });

  it("注入失败 → 退出码 1，指明失败门禁名与命令", () => {
    const io = fakeIo();
    const code = main(["--scope", "a"], {
      ...io,
      runner: (gate) => (gate.name === "② 测试" ? 1 : 0),
    });
    expect(code).toBe(1);
    const err = io.lines.error.join("\n");
    expect(err).toContain("② 测试");
    expect(err).toContain("npm test");
  });

  it("缺 --scope → 退出码 1（门禁④失败，非用法错误），有用法提示", () => {
    const io = fakeIo();
    const code = main([], { ...io, runner: () => 0 });
    expect(code).toBe(1);
    expect(io.all()).toContain("④ diff 范围检查");
    expect(io.all()).toContain("check-scope.mjs");
  });
});
