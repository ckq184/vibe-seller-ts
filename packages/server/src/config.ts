// 服务端配置：路径/端口/密钥文件，对齐原 app/config.py 的语义。
// 密钥红线：JWT_SECRET 优先取环境变量，否则用/生成 data/jwt_secret 文件（0600）。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export interface ServerConfig {
  homeDir: string;
  dataDir: string;
  dbPath: string;
  jwtSecretFile: string;
  port: number;
  frontendDist?: string;
  adminEmail: string;
  adminPassword: string;
  adminUsername: string;
  version: string;
  /** 环境变量注入的密钥（优先于密钥文件）；测试用。 */
  jwtSecret?: string;
}

export const DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000001";
export const AI_BOT_USER_ID = "00000000-0000-0000-0000-000000000002";
export const DEFAULT_TASK_RETENTION_DAYS = 30;

export function readServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const homeDir = env.VIBE_HOME ?? join(homedir(), ".vibe-seller");
  const dataDir = join(homeDir, "data");
  const port = Number.parseInt(env.BACKEND_PORT ?? "7777", 10);
  const frontendDist = env.FRONTEND_DIST ?? (env.VIBE_TS_ROOT ? join(env.VIBE_TS_ROOT, "frontend", "dist") : undefined);
  return {
    homeDir,
    dataDir,
    dbPath: join(dataDir, "vibe_seller.db"),
    jwtSecretFile: join(dataDir, "jwt_secret"),
    port,
    frontendDist: frontendDist && existsSync(frontendDist) ? frontendDist : undefined,
    adminEmail: env.ADMIN_EMAIL ?? "admin@vibe-seller.local",
    adminPassword: env.ADMIN_PASSWORD ?? "admin",
    adminUsername: (env.ADMIN_USERNAME ?? "admin").toLowerCase(),
    version: env.VIBE_VERSION ?? "0.0.0+dev",
    jwtSecret: env.JWT_SECRET || undefined,
  };
}

/**
 * 解析 JWT 密钥：$JWT_SECRET → 密钥文件 → 生成（token_urlsafe(48) 等价：
 * 48 随机字节 base64url），写入 0600。与原实现逐字节兼容（同文件格式）。
 */
export function resolveJwtSecret(cfg: ServerConfig): string {
  if (cfg.jwtSecret) return cfg.jwtSecret;
  if (existsSync(cfg.jwtSecretFile)) {
    const secret = readFileSync(cfg.jwtSecretFile, "utf8").trim();
    if (secret) return secret;
  }
  mkdirSync(cfg.dataDir, { recursive: true });
  const secret = randomBytes(48).toString("base64url");
  writeFileSync(cfg.jwtSecretFile, secret + "\n", { mode: 0o600 });
  return secret;
}
