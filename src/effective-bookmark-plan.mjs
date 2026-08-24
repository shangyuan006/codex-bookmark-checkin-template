import fs from "node:fs/promises";
import { readBookmarkPlanWithBackup } from "./bookmarks.mjs";

export function effectiveBookmarkPlanValidation(config = {}, lastValidPlan = null) {
  const minimumTargets = Math.max(1, Number(config.minimumBookmarkTargetCount) || 1);
  const previousCount = Math.max(0, Number(lastValidPlan?.targetCount) || 0);
  const effectiveMinimumTargets = previousCount >= minimumTargets
    ? Math.max(minimumTargets, Math.ceil(previousCount * 0.5))
    : minimumTargets;
  return { minimumTargets, previousCount, effectiveMinimumTargets };
}

export function validateEffectiveBookmarkPlan(plan, validation) {
  const targetCount = Math.max(0, Number(plan?.targetCount) || 0);
  const { minimumTargets, previousCount } = validation;
  const suddenDrop = previousCount >= minimumTargets && targetCount < Math.ceil(previousCount * 0.5);
  if (targetCount < minimumTargets || suddenDrop) {
    throw new Error(`书签目标异常：当前 ${targetCount} 个，上次 ${previousCount || "无记录"} 个；拒绝生成空签到结果`);
  }
  return plan;
}

async function readLastValidPlan(lastValidPlanPath) {
  if (!lastValidPlanPath) return null;
  try {
    return JSON.parse(await fs.readFile(lastValidPlanPath, "utf8"));
  } catch {
    return null;
  }
}

export async function readEffectiveBookmarkPlan(bookmarksPath, config = {}, lastValidPlanPath = null) {
  const lastValidPlan = await readLastValidPlan(lastValidPlanPath);
  const validation = effectiveBookmarkPlanValidation(config, lastValidPlan);
  const plan = await readBookmarkPlanWithBackup(bookmarksPath, {
    ...config,
    minimumBookmarkTargetCount: validation.effectiveMinimumTargets,
  });
  return validateEffectiveBookmarkPlan(plan, validation);
}
