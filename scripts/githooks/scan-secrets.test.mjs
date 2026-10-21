// scan-secrets（pre-commit secret 扫描）测试（宪法门禁④，PRD 路线3 §二④/§四/§五.3/§五.8/§六）。
//
// 分层（同 commit-msg.test.mjs 模式）：
//   纯函数单测——PATTERNS 模式表、maskSecret 打码（前 4 后 2 + …，<8 全打码）、
//   scanLine 每模式一条命中（假密钥自造）+ 打码断言（结果不含完整密钥）+
//   allowlist 放行 + 多模式同行 + 无命中（§五.3）；scanText 行号/打码行/CRLF；
//   looksBinary（NUL/替换符判二进制）；loadAllowlist（缺失→空、损坏→抛）。
//   CLI 集成——spawn node scan-secrets.mjs：命中 exit 1 且输出含 文件:行号 与打码行、
//   不含完整密钥；干净 exit 0；非 git 仓 exit 2；allowlist 损坏 exit 2。
//   真仓集成——os.tmpdir 下 git init 临时仓 + core.hooksPath 指向本仓 scripts/githooks：
//   staged 假密钥 → git commit 非零退出且输出含 文件:行号；allowlist 放行后提交成功；
//   二进制文件 staged 提交不被误拦；Deleted staged 路径跳过；
//   --no-verify 对照组（PRD §六.2 明示取舍：hook 层不防绕过，防绕过靠代码质量审查核对 diff）。
//
// 测试源文件自身的防自伤设计（本文件提交时会被本 hook 扫描）：
//   - 单测假密钥一律用 "EXAMPLE/FAKE/MULTI" 等显式假串字面量，并在
//     scripts/githooks/secret-allowlist.json 逐条登记（re 同时匹配测试行与 JSON 行自身）；
//   - 需要"不被放行"的拦截路径假密钥（sk-LIVE…）用字符串拼接构造
//     （"sk-" + "LIVE…"），源行不构成模式命中，故无需 allowlist。
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import {
  PATTERNS,
  loadAllowlist,
  looksBinary,
  main,
  maskSecret,
  scanLine,
  scanText,
} from "./scan-secrets.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, "scan-secrets.mjs");
const hookEntryPath = join(here, "pre-commit");
const allowlistPath = join(here, "secret-allowlist.json");

// ── 假密钥库（全部自造；字面量键已逐条登记进 secret-allowlist.json）──

const SK_FAKE = "sk-EXAMPLE111111111111111FAKE"; // stepfun-openai-sk
const ANTHROPIC_FAKE_LINE = 'ANTHROPIC_AUTH_TOKEN = "EXAMPLE2222222222222222222FAKE"';
const AWS_FAKE = "AKIAEXAMPLE333333333";
const PEM_FAKE_LINE = 'pemHeader = "-----BEGIN RSA PRIVATE KEY-----"';
const GHP_FAKE = "ghp_EXAMPLE44444444444444444444444444444444";
const GH_PAT_FAKE = "github_pat_EXAMPLE88888888888888888888888888";
const SLACK_FAKE = "xoxb-EXAMPLE66666666666666";
const WECOM_FAKE = "qyapi.weixin.qq.com/cgi-bin/webhook/send?key=7777777777777777777777777777777777777777";
const MULTI_FAKE_LINE = 'ANTHROPIC_API_KEY=sk-MULTI000000000000000EXAMPLE';
// 拦截路径专用（不入 allowlist）：拼接构造，测试源行不含可命中字面量
const BLOCKED_SK = "sk-" + "LIVE1111111111111111KEY";

// ── 工具（参照 commit-msg.test.mjs）──

const tmpDirs = [];
afterAll(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function git(cwd, ...args) {
  const r = spawnSync("git", ["-c", "core.quotepath=off", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} 失败(exit=${r.status}): ${r.stderr}`);
  return r.stdout;
}

function mkTemp(withGit) {
  const dir = mkdtempSync(join(tmpdir(), "scan-secrets-test-"));
  tmpDirs.push(dir);
  if (withGit) {
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "test@example.com");
    git(dir, "config", "user.name", "test");
    git(dir, "config", "core.autocrlf", "false");
    git(dir, "config", "commit.gpgsign", "false");
  }
  return dir;
}

// 直 spawn（node + 参数数组，不经 shell）；cwd = 目标仓（hook 内 git 命令按 cwd 取 staged）
function runNode(script, args, cwd) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });
}

// runNode 的异步版：等待期间让出事件循环。本文件全是同步 spawn，整文件同步段在全套并行下
// 超过 60s 会撞 vitest worker RPC 超时（onTaskUpdate），重载用例改走本函数（路线4 S10a）
function runNodeAsync(script, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

// 写提交信息文件（UTF-8）并用 -F 提交（绕开 Windows 命令行中文参数编码变量）
function commitWithMessage(repoDir, message, extraArgs = []) {
  const msgFile = join(repoDir, ".git", "scan-test-msg.txt");
  writeFileSync(msgFile, message, "utf8");
  return spawnSync("git", ["commit", "-F", msgFile, ...extraArgs], { cwd: repoDir, encoding: "utf8" });
}

// ── PATTERNS 模式表（PRD §四，七模式）──

describe("PATTERNS 模式表（PRD §四）", () => {
  it("共 7 个模式，名字与 PRD 模式表一致且逐条带 RegExp", () => {
    expect(PATTERNS.map((p) => p.name)).toEqual([
      "stepfun-openai-sk",
      "anthropic-token-assign",
      "aws-access-key",
      "private-key-block",
      "github-token",
      "slack-token",
      "wecom-webhook-key",
    ]);
    for (const p of PATTERNS) {
      expect(p.re, p.name).toBeInstanceOf(RegExp);
      expect(p.name.length, p.name).toBeGreaterThan(0);
    }
  });

  it("github-token 双分支：ghp_ 与 github_pat_ 均命中", () => {
    const gh = PATTERNS.find((p) => p.name === "github-token");
    expect(gh.re.test(GHP_FAKE)).toBe(true);
    expect(gh.re.test(GH_PAT_FAKE)).toBe(true);
    expect(gh.re.test("ghp_短")).toBe(false);
  });
});

// ── maskSecret 打码（前 4 后 2 + …；<8 全打码；输出绝不含完整命中串）──

describe("maskSecret 打码", () => {
  it("长命中只留前 4 后 2 + …", () => {
    expect(maskSecret(SK_FAKE)).toBe("sk-E…KE");
    expect(maskSecret(AWS_FAKE)).toBe("AKIA…33");
  });

  it("8 位边界：正常打码；7 位全打码", () => {
    expect(maskSecret("12345678")).toBe("1234…78");
    expect(maskSecret("1234567")).toBe("*******");
  });

  it("打码结果不含命中串中段（前 4 后 2 之外的字符不出现）", () => {
    const masked = maskSecret(GHP_FAKE);
    expect(masked).toBe("ghp_…44");
    expect(masked).not.toContain(GHP_FAKE.slice(0, 10));
  });
});

// ── scanLine：每模式一条命中 + 打码断言（PRD §五.3）──

describe("scanLine：每个模式一条命中（假密钥自造）", () => {
  const cases = [
    { name: "stepfun-openai-sk", line: `const token = "${SK_FAKE}";` },
    { name: "anthropic-token-assign", line: ANTHROPIC_FAKE_LINE },
    { name: "aws-access-key", line: `aws_key = ${AWS_FAKE}` },
    { name: "private-key-block", line: PEM_FAKE_LINE },
    { name: "github-token", line: `token: ${GHP_FAKE}` },
    { name: "github-token（github_pat_ 分支）", line: `token: ${GH_PAT_FAKE}` },
    { name: "slack-token", line: `cfg = "${SLACK_FAKE}"` },
    { name: "wecom-webhook-key", line: `url = "https://${WECOM_FAKE}"` },
  ];

  for (const c of cases) {
    it(`${c.name}：命中且打码（输出不含完整密钥）`, () => {
      const { hits } = scanLine(c.line, []);
      expect(hits.length, c.line).toBe(1);
      expect(hits[0].name).toBe(c.name.startsWith("github-token") ? "github-token" : c.name);
      // 打码断言：结构化结果不得包含任何完整密钥字面量
      const fullKeys = [SK_FAKE, AWS_FAKE, GHP_FAKE, GH_PAT_FAKE, SLACK_FAKE, WECOM_FAKE];
      for (const k of fullKeys) {
        expect(JSON.stringify(hits), k).not.toContain(k);
      }
      expect(hits[0].masked).toMatch(/…|\*+/);
    });
  }

  it("private-key-block：OPENSSH / EC / 无算法前缀变体均命中", () => {
    const pk = PATTERNS.find((p) => p.name === "private-key-block");
    // PEM 块头字面量用拼接构造（同 BLOCKED_SK 的防自伤约定）：裸 BEGIN 行若进
    // allowlist 等于对所有真实 .pem 关闭本模式（allowlist 按行子串放行，不放行裸块头），
    // 故让源行不构成模式命中——运行时字符串不变，断言不变
    for (const head of [
      "-----BEGIN " + "PRIVATE KEY-----",
      "-----BEGIN " + "RSA PRIVATE KEY-----",
      "-----BEGIN " + "EC PRIVATE KEY-----",
      "-----BEGIN " + "OPENSSH PRIVATE KEY-----",
    ]) {
      expect(pk.re.test(head), head).toBe(true);
    }
    expect(pk.re.test("-----BEGIN CERTIFICATE-----")).toBe(false);
  });
});

describe("scanLine：allowlist 与多模式（PRD §五.3）", () => {
  it("无命中行返回空 hits", () => {
    expect(scanLine("const greeting = 'hello world';", [])).toEqual({ hits: [] });
    expect(scanLine("", []).hits).toEqual([]);
  });

  it("命中行匹配 allowlist 任一 re 即放行（hits 为空）", () => {
    const line = `const token = "${SK_FAKE}";`;
    expect(scanLine(line, []).hits.length).toBe(1);
    expect(scanLine(line, [{ re: SK_FAKE, note: "单测假密钥" }]).hits).toEqual([]);
    // 字符串形式与 {re} 形式等价
    expect(scanLine(line, [SK_FAKE]).hits).toEqual([]);
  });

  it("allowlist 不匹配时照常命中（放行不扩大）", () => {
    const line = `const token = "${SK_FAKE}";`;
    expect(scanLine(line, [{ re: "完全不相关的行", note: "n/a" }]).hits.length).toBe(1);
  });

  it("多模式同行：anthropic 赋值 + sk- 值 → 两条命中", () => {
    const { hits } = scanLine(`const leak = "${MULTI_FAKE_LINE}";`, []);
    expect(hits.map((h) => h.name).sort()).toEqual(
      ["anthropic-token-assign", "stepfun-openai-sk"].sort(),
    );
    for (const h of hits) {
      expect(h.masked).not.toContain("MULTI000000000000000EXAMPLE");
      expect(h.masked).not.toContain("sk-MULTI000000000000000EXAMPLE");
    }
  });
});

// ── scanText：行号 + 命中 + 打码行 ──

describe("scanText：返回行号与命中（打码行不回显密钥）", () => {
  const lines = [
    "clean line 1",
    `token = ${SK_FAKE}`,
    "clean line 3",
    PEM_FAKE_LINE,
    "clean line 5",
  ];

  it("1 基行号正确，maskedLine 打码且不含完整密钥", () => {
    const findings = scanText(lines.join("\n"), []);
    expect(findings.length).toBe(2);
    expect(findings[0].line).toBe(2);
    expect(findings[0].hits[0].name).toBe("stepfun-openai-sk");
    expect(findings[0].maskedLine).toBe(`token = sk-E…KE`);
    expect(findings[1].line).toBe(4);
    expect(findings[1].hits[0].name).toBe("private-key-block");
    expect(JSON.stringify(findings)).not.toContain(SK_FAKE);
  });

  it("CRLF 文本行号不变", () => {
    const findings = scanText(lines.join("\r\n"), []);
    expect(findings.map((f) => f.line)).toEqual([2, 4]);
  });

  it("allowlist 放行的行不出现在结果里", () => {
    const findings = scanText(lines.join("\n"), [{ re: SK_FAKE, note: "单测" }]);
    expect(findings.length).toBe(1);
    expect(findings[0].line).toBe(4);
  });
});

// ── looksBinary（NUL / UTF-8 替换符判二进制，PRD §四）──

describe("looksBinary", () => {
  it("含 NUL 或解码替换符 → true；普通文本 → false", () => {
    expect(looksBinary(Buffer.from([0x00, 0x01, 0x02]))).toBe(true);
    expect(looksBinary(Buffer.from([0xff, 0xfe, 0x00]))).toBe(true);
    expect(looksBinary(Buffer.from("plain text line\n", "utf8"))).toBe(false);
    expect(looksBinary(Buffer.from("中文 UTF-8 文本\n", "utf8"))).toBe(false);
  });
});

// ── loadAllowlist ──

describe("loadAllowlist", () => {
  it("合法文件 → allowlines 数组（每条含 re 与 note）", () => {
    const allowlines = loadAllowlist(allowlistPath);
    expect(Array.isArray(allowlines)).toBe(true);
    expect(allowlines.length).toBeGreaterThan(0);
    for (const a of allowlines) {
      expect(typeof a.re).toBe("string");
      expect(typeof a.note).toBe("string");
      expect(a.note.length).toBeGreaterThan(0);
    }
    // 本测试文件用到的假密钥字面量必须已被登记（防自伤的硬断言）。断言分两层：
    //   ① 功能放行（全部字面量）：按提交时的真实路径验证——模式命中含该字面量的行
    //      （空 allowlist 下 1 处命中），登记后的 allowlist 使同一行 hits 为空；
    //   ② 文本包含（仅无正则元字符的字面量）：allowlist re 文本须包含该字面量。
    //     不对含元字符的字面量（如 wecom 的 "?"，re 中是量词）做文本包含断言——
    //     "re 文本包含字面量"与"正则放行该行"并不等价（全字面量 re 反而失配），
    //     allowlist 对 wecom 登记的是刻意更窄且正则有效的 key=777… 形态。
    const joined = allowlines.map((a) => a.re).join("\n");
    const fakes = [SK_FAKE, AWS_FAKE, GHP_FAKE, GH_PAT_FAKE, SLACK_FAKE, WECOM_FAKE];
    for (const fake of fakes) {
      const probe = `const token = "${fake}";`;
      expect(scanLine(probe, []).hits.length, `模式应命中：${fake}`).toBe(1);
      expect(scanLine(probe, allowlines).hits, `allowlist 应放行：${fake}`).toEqual([]);
    }
    for (const fake of [SK_FAKE, AWS_FAKE, GHP_FAKE, GH_PAT_FAKE, SLACK_FAKE]) {
      expect(joined, fake).toContain(fake);
    }
  });

  it("文件缺失 → 空 allowlist（不放行任何行，最严格方向）", () => {
    expect(loadAllowlist(join(mkTemp(false), "no-such.json"))).toEqual([]);
  });

  it("损坏 JSON / 形状非法 / 缺 note → 抛错（main 转退出 2，不静默吞）", () => {
    const dir = mkTemp(false);
    writeFileSync(join(dir, "bad.json"), "{ not json", "utf8");
    expect(() => loadAllowlist(join(dir, "bad.json"))).toThrow();
    writeFileSync(join(dir, "shape.json"), JSON.stringify({ noallowlines: 1 }), "utf8");
    expect(() => loadAllowlist(join(dir, "shape.json"))).toThrow(/allowlines/);
    writeFileSync(join(dir, "nonote.json"), JSON.stringify({ allowlines: [{ re: "x" }] }), "utf8");
    expect(() => loadAllowlist(join(dir, "nonote.json"))).toThrow(/note/);
  });

  it("正则不可编译的条目 → 加载期抛错且信息含条目内容（审查 Major1：坏正则不得拖到扫描期才炸）", () => {
    const dir = mkTemp(false);
    writeFileSync(
      join(dir, "badre.json"),
      JSON.stringify({ allowlines: [{ re: "[", note: "坏正则示例" }] }),
      "utf8",
    );
    expect(() => loadAllowlist(join(dir, "badre.json"))).toThrow(/不可编译/);
  });
});

// ── CLI 集成：node scan-secrets.mjs（cwd = 目标仓）──

describe("CLI 集成", () => {
  it("staged 假密钥 → exit 1，输出含 文件:行号/[模式名]/打码行，不含完整密钥，含修复指引", () => {
    const dir = mkTemp(true);
    writeFileSync(join(dir, "leak.txt"), `token = ${BLOCKED_SK}\n`, "utf8");
    git(dir, "add", "leak.txt");
    const r = runNode(cliPath, [], dir);
    expect(r.status).toBe(1);
    const out = r.stdout + r.stderr;
    // fixture 为单行文件（密钥在第 1 行；两行 fixture 的行号断言见真仓集成孪生用例）
    expect(out).toContain("leak.txt:1");
    expect(out).toContain("[stepfun-openai-sk]");
    expect(out).toContain("sk-L…EY");
    expect(out).not.toContain(BLOCKED_SK);
    expect(out).toContain("轮换");
    expect(out).toContain("secret-allowlist.json");
  }, 30_000);

  it("staged 干净文件 → exit 0", () => {
    const dir = mkTemp(true);
    writeFileSync(join(dir, "ok.txt"), "nothing suspicious here\n", "utf8");
    git(dir, "add", "ok.txt");
    expect(runNode(cliPath, [], dir).status).toBe(0);
  }, 30_000);

  it("二进制 staged（NUL 字节）→ 跳过，exit 0", () => {
    const dir = mkTemp(true);
    writeFileSync(join(dir, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]));
    git(dir, "add", "blob.bin");
    expect(runNode(cliPath, [], dir).status).toBe(0);
  }, 30_000);

  it("非 git 目录 → exit 2", () => {
    const r = runNode(cliPath, [], mkTemp(false));
    expect(r.status).toBe(2);
  });

  it("allowlist 损坏 → exit 2（不静默放行）", () => {
    const dir = mkTemp(true);
    const bad = join(dir, "bad-allowlist.json");
    writeFileSync(bad, "{ broken", "utf8");
    writeFileSync(join(dir, "ok.txt"), "clean\n", "utf8");
    git(dir, "add", "ok.txt");
    // CLI 级验证：CLI 无 allowlist 参数（规格如此），默认读模块同目录的
    // secret-allowlist.json——把模块与损坏 allowlist 复制到 temp 目录作为独立模块根
    // 再跑 CLI，全链路验证"损坏 → exit 2 fail loud"（模块仅依赖 node: 内置，可单文件复制）
    const copyDir = mkTemp(false);
    writeFileSync(join(copyDir, "scan-secrets.mjs"), readFileSync(cliPath, "utf8"), "utf8");
    writeFileSync(join(copyDir, "secret-allowlist.json"), "{ broken", "utf8");
    expect(runNode(join(copyDir, "scan-secrets.mjs"), [], dir).status).toBe(2);
    // 经 main 的 allowlistPath 注入直接验证损坏 → 2
    expect(main([process.execPath, cliPath], { cwd: dir, allowlistPath: bad })).toBe(2);
  }, 30_000);

  it("allowlist 坏正则条目 → exit 2 且 stderr 含 allowlist 与条目内容提示，非裸堆栈（审查 Major1）", () => {
    const dir = mkTemp(true);
    writeFileSync(join(dir, "ok.txt"), "clean\n", "utf8");
    git(dir, "add", "ok.txt");
    // CLI 级全链路验证：复制模块 + 坏正则 allowlist 到独立模块根（同上"损坏 JSON"用例的形态）
    const copyDir = mkTemp(false);
    writeFileSync(join(copyDir, "scan-secrets.mjs"), readFileSync(cliPath, "utf8"), "utf8");
    writeFileSync(
      join(copyDir, "secret-allowlist.json"),
      JSON.stringify({ allowlines: [{ re: "[", note: "坏正则" }] }),
      "utf8",
    );
    const r = runNode(join(copyDir, "scan-secrets.mjs"), [], dir);
    expect(r.status).toBe(2);
    const err = r.stderr;
    expect(err).toContain("allowlist");
    expect(err).toContain("[");
    // 非裸英文堆栈：不得出现 node 未捕获异常的 "at <fn>:<line>:<col>" 帧行
    expect(err).not.toMatch(/\n\s+at /);
  }, 30_000);

  it("staged 嵌入式 gitlink（mode 160000）→ 跳过不扫描，exit 0（审查 Major2）", () => {
    const dir = mkTemp(true);
    writeFileSync(join(dir, "ok.txt"), "clean\n", "utf8");
    git(dir, "add", "ok.txt");
    // 造 staged gitlink：指向外仓对象库中不存在的 commit sha（嵌套仓 clone 后对象
    // 不在外仓 odb 的真实形态）；git 索引层不校验 gitlink 目标存在性，实测可加
    git(dir, "update-index", "--add", "--cacheinfo", "160000,deadbeefdeadbeefdeadbeefdeadbeefdeadbeef,nested");
    const r = runNode(cliPath, [], dir);
    expect(r.status).toBe(0);
  }, 30_000);

  it("组合 staged（3 文本+1 二进制+1 gitlink）→ 全部逐文件正确扫描：命中文件被拒、干净/跳过不误报（审查 Major3 batch 化防回归）", () => {
    const dir = mkTemp(true);
    // 路径按字母序即 diff 顺序：命中文件夹在二进制与 gitlink 之间，
    // 钉住 batch 化后 sha↔path 按序对应不错位
    writeFileSync(join(dir, "a-clean.txt"), "clean marker A\n", "utf8");
    writeFileSync(join(dir, "b-blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]));
    writeFileSync(join(dir, "c-leak.txt"), `const t = "${BLOCKED_SK}";\n`, "utf8");
    writeFileSync(join(dir, "e-clean.txt"), "clean marker E\n", "utf8");
    git(dir, "add", "a-clean.txt", "b-blob.bin", "c-leak.txt", "e-clean.txt");
    git(dir, "update-index", "--add", "--cacheinfo", "160000,deadbeefdeadbeefdeadbeefdeadbeefdeadbeef,d-nested");
    const r = runNode(cliPath, [], dir);
    expect(r.status).toBe(1);
    const out = r.stdout + r.stderr;
    expect(out).toContain("c-leak.txt:1");
    expect(out).toContain("[stepfun-openai-sk]");
    expect(out).toContain("sk-L…EY");
    expect(out).not.toContain(BLOCKED_SK);
    // 干净文本与跳过对象不得出现在命中清单（映射错位会把它顶到别的路径/行上）
    expect(out).not.toContain("a-clean.txt");
    expect(out).not.toContain("e-clean.txt");
    expect(out).not.toContain("d-nested");
    // 拒绝输出同时提示已跳过数量（Minor 2 改写：1 二进制 + 1 gitlink）
    expect(out).toMatch(/另有 2 个二进制\/删除\/gitlink 变更已跳过扫描/);
  }, 30_000);

  it("staged 文本总量超 64MB（ENOBUFS）→ exit 2，中文提示含上限与分批提交指引（路线4 S10a）", async () => {
    const dir = mkTemp(true);
    // 约 68MB 纯文本（680000 行 × 100 字节），不含任何密钥模式
    writeFileSync(join(dir, "big.txt"), ("x".repeat(99) + "\n").repeat(680_000), "utf8");
    git(dir, "add", "big.txt");
    const r = await runNodeAsync(cliPath, [], dir);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("分批提交");
    expect(r.stderr).toContain("64MB");
    expect(r.stderr).not.toContain("spawnSync git ENOBUFS");
  }, 60_000);

  it("staged 清单取全量 sha：diff --cached --raw 调用带 --no-abbrev（路线4 S11，GIT_TRACE 参数级断言）", () => {
    const dir = mkTemp(true);
    writeFileSync(join(dir, "ok.txt"), "clean\n", "utf8");
    git(dir, "add", "ok.txt");
    const tracePath = join(mkTemp(false), "git-trace.log");
    const r = spawnSync(process.execPath, [cliPath], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GIT_TRACE: tracePath },
    });
    expect(r.status).toBe(0);
    const rawCalls = readFileSync(tracePath, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.includes("diff --cached --raw"));
    expect(rawCalls.length).toBeGreaterThan(0); // 防空真：确实捕获到这次调用
    for (const l of rawCalls) expect(l).toContain("--no-abbrev");
  }, 30_000);

  it("allowlist 缺失 → 照常扫描（缺失=零放行）", () => {
    const dir = mkTemp(true);
    writeFileSync(join(dir, "leak.txt"), `token = ${BLOCKED_SK}\n`, "utf8");
    git(dir, "add", "leak.txt");
    expect(main([process.execPath, cliPath], { cwd: dir, allowlistPath: join(dir, "nope.json") })).toBe(1);
  }, 30_000);

  it("main() 直调（cwd 注入）：干净仓 0 / 命中仓 1", () => {
    const clean = mkTemp(true);
    writeFileSync(join(clean, "a.txt"), "fine\n", "utf8");
    git(clean, "add", "a.txt");
    expect(main([process.execPath, cliPath], { cwd: clean })).toBe(0);

    const leak = mkTemp(true);
    writeFileSync(join(leak, "a.txt"), `k = ${BLOCKED_SK}\n`, "utf8");
    git(leak, "add", "a.txt");
    expect(main([process.execPath, cliPath], { cwd: leak })).toBe(1);
  }, 30_000);
});

// ── hook 入口 ──

describe("pre-commit hook 入口", () => {
  it("文件存在、带 node shebang、转发 scan-secrets.mjs（合法仓 0 / 命中仓 1）", () => {
    expect(existsSync(hookEntryPath)).toBe(true);
    expect(readFileSync(hookEntryPath, "utf8").startsWith("#!/usr/bin/env node")).toBe(true);

    const clean = mkTemp(true);
    writeFileSync(join(clean, "a.txt"), "fine\n", "utf8");
    git(clean, "add", "a.txt");
    expect(runNode(hookEntryPath, [], clean).status).toBe(0);

    const leak = mkTemp(true);
    writeFileSync(join(leak, "a.txt"), `k = ${BLOCKED_SK}\n`, "utf8");
    git(leak, "add", "a.txt");
    expect(runNode(hookEntryPath, [], leak).status).toBe(1);
  }, 30_000);
});

// ── 真仓集成：git commit 真实走 pre-commit（PRD §五.3/§五.4）──

describe("真仓集成：core.hooksPath 指向本仓 scripts/githooks", () => {
  // 绝对路径（正斜杠）指向本仓 githooks；allowlist 读本仓工作区文件（含单测假密钥条目）
  const hooksPath = here.replace(/\\/g, "/");

  function withHooks(dir) {
    git(dir, "config", "core.hooksPath", hooksPath);
    return dir;
  }

  it("干净内容 + 合法 message → 提交成功（双 hook 全链放行）", () => {
    const dir = withHooks(mkTemp(true));
    writeFileSync(join(dir, "ok.txt"), "clean content\n", "utf8");
    git(dir, "add", "ok.txt");
    const r = commitWithMessage(dir, "feat: 临时仓干净提交\n");
    expect(r.status).toBe(0);
  }, 30_000);

  it("staged 假密钥 → git commit 非零退出，输出含 文件:行号 与打码行", () => {
    const dir = withHooks(mkTemp(true));
    writeFileSync(join(dir, "leak.txt"), `line1\nconst t = "${BLOCKED_SK}";\n`, "utf8");
    git(dir, "add", "leak.txt");
    const r = commitWithMessage(dir, "feat: 带密钥的提交应被拦截\n");
    expect(r.status).not.toBe(0);
    const out = r.stdout + r.stderr;
    expect(out).toContain("leak.txt:2");
    expect(out).toContain("[stepfun-openai-sk]");
    expect(out).toContain("sk-L…EY");
    expect(out).not.toContain(BLOCKED_SK);
  }, 30_000);

  it("allowlist 放行后提交成功（登记过的单测假密钥）", () => {
    const dir = withHooks(mkTemp(true));
    writeFileSync(join(dir, "fixture.txt"), `const token = "${SK_FAKE}";\n`, "utf8");
    git(dir, "add", "fixture.txt");
    const r = commitWithMessage(dir, "feat: allowlist 放行的假密钥提交\n");
    expect(r.status).toBe(0);
  }, 30_000);

  it("二进制文件 staged 提交不被误拦", () => {
    const dir = withHooks(mkTemp(true));
    writeFileSync(join(dir, "blob.bin"), Buffer.from([0x00, 0x01, 0x02]));
    git(dir, "add", "blob.bin");
    const r = commitWithMessage(dir, "feat: 二进制文件提交\n");
    expect(r.status).toBe(0);
  }, 30_000);

  it("Deleted staged 路径跳过（HEAD 中含密钥的文件被删不拦提交）", () => {
    const dir = withHooks(mkTemp(true));
    // 造 HEAD：含密钥文件用 --no-verify 入库（仅测试造数；见下方对照组用例的同款取舍）
    writeFileSync(join(dir, "leak.txt"), `token = ${BLOCKED_SK}\n`, "utf8");
    git(dir, "add", "leak.txt");
    expect(commitWithMessage(dir, "chore: 造数入库\n", ["--no-verify"]).status).toBe(0);
    // staged 删除 + 干净新增 → 扫描只看 Added/Modified，删除路径放行
    writeFileSync(join(dir, "clean.txt"), "ok\n", "utf8");
    git(dir, "add", "clean.txt");
    git(dir, "rm", "leak.txt");
    const r = commitWithMessage(dir, "feat: 删除含密钥文件并新增干净文件\n");
    expect(r.status).toBe(0);
  }, 30_000);

  it("只扫 staged：工作区脏改 + 未跟踪文件含密钥、staged 干净 → 放行；stage 脏改后被拦（路线4 S14，PRD §六.5）", () => {
    const dir = withHooks(mkTemp(true));
    writeFileSync(join(dir, "tracked.txt"), "base\n", "utf8");
    git(dir, "add", "tracked.txt");
    expect(commitWithMessage(dir, "feat: 干净基线\n").status).toBe(0);
    // staged = 干净修改；工作区在其上再追加密钥行（不 stage）+ 未跟踪密钥文件
    writeFileSync(join(dir, "tracked.txt"), "base\nclean change\n", "utf8");
    git(dir, "add", "tracked.txt");
    writeFileSync(join(dir, "tracked.txt"), `base\nclean change\nconst t = "${BLOCKED_SK}";\n`, "utf8");
    writeFileSync(join(dir, "untracked.txt"), `token = ${BLOCKED_SK}\n`, "utf8");
    const status = git(dir, "status", "--porcelain");
    expect(status).toContain("MM tracked.txt");
    expect(status).toContain("?? untracked.txt");
    expect(commitWithMessage(dir, "feat: staged 干净的修改\n").status).toBe(0);
    // 对照：stage 脏改后同一密钥被拦（证明放行不是空真）
    git(dir, "add", "tracked.txt");
    const r = commitWithMessage(dir, "feat: stage 后应被拦截\n");
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toContain("[stepfun-openai-sk]");
  }, 30_000);

  it("对照组：--no-verify 能提交带密钥内容（PRD §六.2 明示取舍：hook 层不防绕过，防绕过靠代码质量审查核对 diff）", () => {
    const dir = withHooks(mkTemp(true));
    writeFileSync(join(dir, "leak2.txt"), `token = ${BLOCKED_SK}\n`, "utf8");
    git(dir, "add", "leak2.txt");
    const r = commitWithMessage(dir, "feat: no-verify 对照组\n", ["--no-verify"]);
    expect(r.status).toBe(0);
  }, 30_000);
});
