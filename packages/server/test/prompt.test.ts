// run prompt 的店铺上下文（路线 4 T2 / S1 收尾）：STORE.md 按正主 storeSlug 定位
// stores/<slug>/，对齐原 task_runner_context.py 的 slug = _store_slug(store.name, store.id)。
// 此前 storeContext 用 4.7.2 之前的旧公式（恒拼 -<id 前 8 位>），新店的 STORE.md 读不到。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildRunPrompt } from "../src/agent/prompt";
import type { ServerConfig } from "../src/config";
import { storeSlug } from "../src/workspace/storeData";

const homeDir = mkdtempSync(join(tmpdir(), "vibe-prompt-"));
afterAll(() => rmSync(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const config = { homeDir } as ServerConfig;

describe("buildRunPrompt 店铺上下文", () => {
  it("STORE.md 从 stores/<storeSlug(name, id)>/ 读取并注入 prompt", () => {
    const store = { id: "c82f5251-0000-4000-8000-000000000001", name: "My_Shop 01" };
    const dir = join(homeDir, "stores", storeSlug(store.name, store.id)); // stores/my-shop-01
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "STORE.md"), "STORE-MARKER-7f3a：主营户外用品\n");
    const task = { id: "t1", title: "查库存", description: null, platform: null, country: null, store_id: store.id, wait_condition: null, plan: null };
    const { prompt } = buildRunPrompt(config, { task, mode: "execute", store });
    expect(prompt).toContain("店铺资料（STORE.md）：\nSTORE-MARKER-7f3a：主营户外用品");
  });
});
