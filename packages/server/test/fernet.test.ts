// Fernet 跨语言互操作钉子测试（批次 4.6 §4.1，本批最高风险项）。
// 向量全部现场录制（Python cryptography.fernet + 本实现），写死在此：
//
//   密钥派生（两语言同式）：key = urlsafe_b64(sha256(JWT_SECRET))
//
//   [钉子 1] Python→TS：Python `Fernet(key).encrypt('hellow-fernet-interop-中文密码')`
//     → gAAAAABqxzSDdIOGrtkb4ntEWVakU_KKwW7i-oa7Ij7_btNXi1ihW_oJPf5yaegf4A1DqHMaLrNTl6_d5HBQutgpELKsOdON0sORsdcb80K0yn-ej0oq_LGz8P1QxhHBINfDrgtcCmd8
//   [钉子 2] TS→Python：本实现以固定 ts=1759900000 加密 'ts-to-py-pin-数据'
//     → gAAAAABo5fFg1yd7hJe8BNVaIDY8_Lv3SJDEhsS5XsX0bsXio0uNKx4vdwxk1vx0GHP98SqzJU7C4tzdw3FrjZJpsZ_El96qkq-w7bm2Iehyanm4byjjDEI=
//     录制现场已用 Python Fernet.decrypt 验证可解（明文逐字节一致）。

import { describe, expect, it } from "vitest";
import { deriveFernetKey, fernetDecryptText, fernetEncrypt, FernetError } from "../src/crypto/fernet";

const SECRET = "vibe-ts-fernet-pin-secret";

describe("fernet cross-language interop", () => {
  const key = deriveFernetKey(SECRET);

  it("decrypts a Python-cryptography-produced token (钉子 1)", () => {
    const pyToken =
      "gAAAAABqxzSDdIOGrtkb4ntEWVakU_KKwW7i-oa7Ij7_btNXi1ihW_oJPf5yaegf4A1DqHMaLrNTl6_d5HBQutgpELKsOdON0sORsdcb80K0yn-ej0oq_LGz8P1QxhHBINfDrgtcCmd8";
    expect(fernetDecryptText(key, pyToken)).toBe("hellow-fernet-interop-中文密码");
  });

  it("reproduces the recorded TS→Python token and prefix (钉子 2，固定时间戳向量)", () => {
    // IV 随机，token 无法逐字节复现；录制向量断言可解（该向量在现场已由
    // Python Fernet.decrypt 解出同一明文），新加密断言 0x80+固定 ts 前缀。
    const recorded =
      "gAAAAABo5fFg1yd7hJe8BNVaIDY8_Lv3SJDEhsS5XsX0bsXio0uNKx4vdwxk1vx0GHP98SqzJU7C4tzdw3FrjZJpsZ_El96qkq-w7bm2Iehyanm4byjjDEI=";
    expect(fernetDecryptText(key, recorded)).toBe("ts-to-py-pin-数据");
    const fresh = fernetEncrypt(key, "ts-to-py-pin-数据", 1759900000);
    expect(fresh.startsWith("gAAAAABo5fFg")).toBe(true);
    expect(fernetDecryptText(key, fresh)).toBe("ts-to-py-pin-数据");
  });

  it("round-trips arbitrary utf8 and rejects tampering", () => {
    const token = fernetEncrypt(key, "另一段秘密 passw0rd!");
    expect(fernetDecryptText(key, token)).toBe("另一段秘密 passw0rd!");
    // 篡改第 10 个 base64 字符（时间戳区——非末组，6 位全部有效）：任何变更必改解码
    // 字节 → HMAC 必失配。不能动末字符：padding 边界只有 2 个有效位，改了也可能
    // 解出相同字节（约 1/16 概率静默通过——之前正是这个 flake）。
    const idx = 10;
    const flipped = token[idx] === "A" ? "B" : "A";
    const bad = token.slice(0, idx) + flipped + token.slice(idx + 1);
    expect(bad).not.toBe(token);
    expect(() => fernetDecryptText(key, bad)).toThrow(FernetError);
    // 错误密钥 → HMAC 失败（不解密，不泄漏）
    expect(() => fernetDecryptText(deriveFernetKey("other-secret"), token)).toThrow(FernetError);
    // 垃圾输入 → 格式错误
    expect(() => fernetDecryptText(key, "not-a-token")).toThrow(FernetError);
  });

  it("emits padded base64url identical to Python's urlsafe_b64encode", () => {
    // Python base64.urlsafe_b64decode 依赖 padding；输出必须带 '='。
    const token = fernetEncrypt(key, "x", 1_759_900_000);
    expect(token.length % 4).toBe(0);
    expect(token.startsWith("gAAAAABo5fFg")).toBe(true); // 0x80 + ts 大端
  });
});
