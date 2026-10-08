// 店铺浏览器 profile 书签读取（app/browser/bookmarks.py 移植）。
// 两个 Chrome profile 位置按存在性取胜：browser-use per-session profile
//（~/.config/browseruse/profiles/<slug>/）与 Chrome 后端持久 profile
//（~/.vibe-seller/browser_profiles/<slug>/）。Ziniao 的书签盘上加密——恒 []。

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function browserUseProfilesDir(): string {
  const configHome = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
  return join(process.env["BROWSER_USE_CONFIG_DIR"] ?? join(configHome, "browseruse"), "profiles");
}

export function vibeProfilesDir(homeDir: string): string {
  return join(homeDir, "browser_profiles");
}

export function readBookmarks(homeDir: string, storeSlug: string): { name: string; url: string }[] {
  for (const root of [browserUseProfilesDir(), vibeProfilesDir(homeDir)]) {
    const path = join(root, storeSlug, "Default", "Bookmarks");
    if (existsSync(path)) return parseBookmarksFile(path, storeSlug);
  }
  return [];
}

/** Ziniao 书签加密（非标准 Chrome JSON）且 oauth 与目录名不匹配——API 兼容性 no-op。 */
export function readZiniaoBookmarks(_browserOauth: string): { name: string; url: string }[] {
  return [];
}

function parseBookmarksFile(bookmarksFile: string, label: string): { name: string; url: string }[] {
  try {
    const data = JSON.parse(readFileSync(bookmarksFile, "utf8")) as { roots?: Record<string, unknown> };
    const results: { name: string; url: string }[] = [];
    const walk = (node: Record<string, unknown>): void => {
      if (node["type"] === "url") {
        results.push({ name: String(node["name"] ?? ""), url: String(node["url"] ?? "") });
      }
      for (const child of (node["children"] as Record<string, unknown>[] | undefined) ?? []) walk(child);
    };
    for (const root of Object.values(data.roots ?? {})) {
      if (root && typeof root === "object") walk(root as Record<string, unknown>);
    }
    return results;
  } catch (e) {
    console.warn(`[vibe-server] Failed to read bookmarks for ${label}: ${e instanceof Error ? e.message : e}`);
    return [];
  }
}
