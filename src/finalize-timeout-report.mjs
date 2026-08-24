import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { publicBookmarkReport } from "./bookmarks.mjs";
import { readEffectiveBookmarkPlan } from "./effective-bookmark-plan.mjs";
import { summarizeResults, writeRunResult } from "./logger.mjs";
import { isCurrentLocalRunId, nextDeferredRetryAt } from "./retry-policy.mjs";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.dirname(sourceDirectory);

export function finalizeTimedOutResults(targets, progressResults, now = new Date()) {
  const previousByOrigin = new Map((progressResults ?? []).map((result) => [result?.origin, result]));
  const retryAt = now.toISOString();
  return targets.map((target) => {
    const previous = previousByOrigin.get(target.origin);
    if (previous) {
      return {
        ...previous,
        origin: target.origin,
        title: target.title,
        folderNames: target.folderNames,
      };
    }
    return {
      origin: target.origin,
      title: target.title,
      folderNames: target.folderNames,
      status: "deferred",
      retryCause: "task_timeout",
      reason: "任务级超时，尚未处理，等待后续定向重试",
      nextEligibleAt: retryAt,
      attempt: 0,
      durationMs: 0,
    };
  });
}

export function buildTimeoutReport(plan, progress, now = new Date()) {
  const planOrigins = new Set(plan.targets.map((target) => target.origin));
  const requestedSelectedOrigins = Array.isArray(progress.selectedOrigins)
    ? progress.selectedOrigins.filter((origin) => planOrigins.has(origin))
    : plan.targets.map((target) => target.origin);
  const selectedOriginSet = new Set(requestedSelectedOrigins);
  const selectedTargets = plan.targets.filter((target) => selectedOriginSet.has(target.origin));
  const selectedProgressResults = Array.isArray(progress.selectedResults)
    ? progress.selectedResults
    : (progress.results ?? []).filter((result) => selectedOriginSet.has(result?.origin));
  const selectedResults = finalizeTimedOutResults(selectedTargets, selectedProgressResults, now);
  const cumulativeByOrigin = new Map((progress.results ?? [])
    .filter((result) => planOrigins.has(result?.origin))
    .map((result) => [result.origin, result]));
  for (const result of selectedResults) cumulativeByOrigin.set(result.origin, result);
  const results = plan.targets.map((target) => cumulativeByOrigin.get(target.origin)).filter(Boolean);
  const plannedTotal = plan.targets.length;
  const processedTotal = results.length;
  const isComplete = plannedTotal > 0 && processedTotal === plannedTotal;
  return {
    runId: progress.runId,
    runState: "final",
    plannedTotal,
    processedTotal,
    isComplete,
    selectedOrigins: selectedTargets.map((target) => target.origin),
    selectedTotal: selectedTargets.length,
    selectedProcessedTotal: selectedResults.length,
    selectedSummary: summarizeResults(selectedResults),
    scopeComplete: selectedTargets.length > 0 && selectedResults.length === selectedTargets.length,
    startedAt: progress.startedAt ?? now.toISOString(),
    finishedAt: now.toISOString(),
    timeoutRecovered: true,
    bookmarkSummary: publicBookmarkReport(plan),
    summary: summarizeResults(results),
    nextRetryAt: nextDeferredRetryAt(results, now),
    results,
  };
}

async function main() {
  const progressIndex = process.argv.indexOf("--progress-report");
  const requestedProgressPath = progressIndex >= 0 ? String(process.argv[progressIndex + 1] ?? "").trim() : "";
  if (!requestedProgressPath) throw new Error("用法: node src/finalize-timeout-report.mjs --progress-report <logs/progress.json>");

  const config = JSON.parse(await fs.readFile(path.join(rootDirectory, "config", "config.json"), "utf8"));
  const logsRoot = path.resolve(rootDirectory, "logs");
  const progressPath = path.resolve(requestedProgressPath);
  if (!progressPath.startsWith(`${logsRoot}${path.sep}`) || path.basename(progressPath) !== "progress.json") {
    throw new Error("超时进度报告必须位于本项目 logs 目录且名称为 progress.json");
  }
  const progress = JSON.parse(await fs.readFile(progressPath, "utf8"));
  if (!Array.isArray(progress.results) || !isCurrentLocalRunId(progress.runId)) {
    throw new Error("超时进度报告不是今天的有效运行");
  }

  const plan = await readEffectiveBookmarkPlan(
    config.bookmarksPath,
    config,
    path.join(rootDirectory, "data", "last-valid-bookmark-plan.json"),
  );
  const report = buildTimeoutReport(plan, progress);
  const runLog = { runId: report.runId, directory: path.dirname(progressPath) };
  const minimumTargets = Math.max(1, Number(config.minimumBookmarkTargetCount) || 1);
  const updateLatest = report.isComplete && report.results.length >= minimumTargets;
  const resultPath = await writeRunResult(logsRoot, runLog, report, {
    updateLatest,
    reconcileLatest: !updateLatest && report.scopeComplete,
  });
  console.log(JSON.stringify({
    resultPath,
    selectedSummary: report.selectedSummary,
    summary: report.summary,
  }));
}

const sourcePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === sourcePath) await main();
