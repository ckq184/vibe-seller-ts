// 广告任务声明词汇（app/ai/ad_declaration.py 移植）：scope 规范形、整店规则、
// 同回合棘齿（只能收窄/升格）。行是权威；AD_TASK.json 是给 agent 看的镜像。

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const AD_TASK_KINDS = new Set(["audit", "create", "execute", "investigate"]);
export const DECLARATION_FILENAME = "AD_TASK.json";

export interface AdScope {
  combos?: { platform: string; country: string }[];
  campaigns?: string[];
  products?: string[];
}

export function declarationPath(homeDir: string, taskId: string): string {
  return join(homeDir, "tasks", taskId, DECLARATION_FILENAME);
}

/** 容错规范化：写路径上拒绝一个几乎对的 scope 成本是一整个 run。 */
export function normaliseScope(raw: unknown): AdScope {
  if (typeof raw !== "object" || raw === null) return {};
  const src = raw as Record<string, unknown>;
  const out: AdScope = {};

  const combos: { platform: string; country: string }[] = [];
  const rawCombos = Array.isArray(src.combos) ? (src.combos as unknown[]) : [];
  for (const c of rawCombos) {
    if (typeof c !== "object" || c === null) continue;
    const platform = String((c as Record<string, unknown>).platform ?? "").trim().toLowerCase();
    const country = String((c as Record<string, unknown>).country ?? "").trim().toUpperCase();
    if (platform && country) combos.push({ platform, country });
  }
  if (combos.length) out.combos = combos;

  for (const key of ["campaigns", "products"] as const) {
    const rawVals = Array.isArray(src[key]) ? (src[key] as unknown[]) : [];
    const vals = rawVals.map((v) => String(v ?? "").trim()).filter((v) => v);
    if (vals.length) out[key] = vals;
  }
  return out;
}

export function isWholeStore(scope: AdScope | null): boolean {
  return !(scope ?? {}).combos?.length;
}

function comboKeys(scope: AdScope | null): Set<string> {
  return new Set(((scope ?? {}).combos ?? []).map((c) => `${c.platform}|${c.country}`));
}

/**
 * 严格收窄（同 kind 重申报）：市场必须相同；campaigns 从"全部"到点名集合，
 * 或已在点名集合内的子集。
 */
export function isNarrowing(prev: AdScope | null, next: AdScope | null): boolean {
  if (!prev || !next) return false;
  const prevKeys = comboKeys(prev);
  const nextKeys = comboKeys(next);
  if (prevKeys.size !== nextKeys.size || [...nextKeys].some((k) => !prevKeys.has(k))) return false;
  const prevC = new Set((prev.campaigns ?? []).map((c) => c.trim()));
  const newC = new Set((next.campaigns ?? []).map((c) => c.trim()));
  if (newC.size === 0) return false; // 空 = 该市场全部活动，绝不是收窄
  if (prevC.size === 0) return true;
  return [...newC].every((c) => prevC.has(c));
}

/** 轴向不外扩：空 = 全部（不是没有），所以清空轴是最宽值。 */
function axisWithin(prevVals: Set<string>, newVals: Set<string>): boolean {
  if (prevVals.size === 0) return true;
  return newVals.size > 0 && [...newVals].every((v) => prevVals.has(v));
}

/** reach 不外扩（kind 变化用；相同 scope 也过——弱于 isNarrowing）。 */
export function reachWithin(prev: AdScope | null, next: AdScope | null): boolean {
  if (!prev || !next) return false;
  return (
    axisWithin(comboKeys(prev), comboKeys(next)) &&
    axisWithin(new Set((prev.campaigns ?? []).map((c) => c.trim())), new Set((next.campaigns ?? []).map((c) => c.trim())))
  );
}

// 同回合唯一放行的 kind 变化：investigate → audit（补上欠的覆盖义务、开审查台）。
const KIND_UPGRADES = new Set(["investigate>audit"]);

/** 同回合棘齿整体：不许减义务、不许扩覆盖。 */
export function supersedes(prevKind: string, prevScope: AdScope | null, newKind: string, newScope: AdScope | null): boolean {
  if (newKind === prevKind) return isNarrowing(prevScope, newScope);
  return KIND_UPGRADES.has(`${prevKind}>${newKind}`) && reachWithin(prevScope, newScope);
}

/** 已接受声明镜像进任务工作区（best-effort：行是权威，镜像写不出就让门自己 fail closed）。 */
export function writeDeclarationFile(homeDir: string, taskId: string, kind: string, scope: AdScope): void {
  try {
    const path = declarationPath(homeDir, taskId);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ kind, scope }, null, 2), "utf8");
  } catch {
    /* best-effort */
  }
}
