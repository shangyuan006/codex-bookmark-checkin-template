import fs from "node:fs/promises";
import path from "node:path";
import {
  atomicWriteJson,
  ensurePrivateDirectory,
  redactPrivateResultText,
} from "./security.mjs";

const AUTHORITATIVE_STATUSES = new Set(["signed", "already_signed", "not_available"]);

export function sanitizeForPersistence(value) {
  if (typeof value === "string") return redactPrivateResultText(value);
  if (Array.isArray(value)) return value.map(sanitizeForPersistence);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeForPersistence(item)]));
}

function completeFinalReport(report) {
  if (!report || report.runState !== "final" || report.isComplete !== true || !Array.isArray(report.results)) return false;
  const plannedTotal = Number(report.plannedTotal) || 0;
  const processedTotal = Number(report.processedTotal) || report.results.length;
  return plannedTotal > 0 && processedTotal >= plannedTotal && report.results.length >= plannedTotal;
}

function runDate(runId) {
  return String(runId ?? "").match(/^(\d{8})-/)?.[1] ?? null;
}

export function summarizeResults(results) {
  return Object.fromEntries(
    [...new Set(results.map((result) => result.status))]
      .map((status) => [status, results.filter((result) => result.status === status).length]),
  );
}

function shouldPromote(current, incoming) {
  if (!AUTHORITATIVE_STATUSES.has(incoming?.status)) return false;
  if (!AUTHORITATIVE_STATUSES.has(current?.status)) return true;
  return incoming.status === "signed" && current.status !== "signed";
}

function currentBookmarkPlan(incoming) {
  if (incoming?.scopeComplete !== true || !Array.isArray(incoming?.bookmarkSummary?.targets)) return null;
  const targets = incoming.bookmarkSummary.targets;
  const origins = targets.map((target) => target?.origin).filter(Boolean);
  const targetCount = Number(incoming.bookmarkSummary.targetCount);
  const plannedTotal = Number(incoming.plannedTotal);
  if (origins.length === 0
    || new Set(origins).size !== origins.length
    || targetCount !== origins.length
    || plannedTotal !== origins.length) return null;
  return { origins, targets };
}

export function mergeAuthoritativeDailyResults(latest, incoming, reconciledAt = new Date()) {
  const latestDate = runDate(latest?.runId);
  if (!completeFinalReport(latest)
    || incoming?.runState !== "final"
    || !Array.isArray(incoming?.results)
    || !latestDate
    || runDate(incoming.runId) !== latestDate) return null;

  const incomingByOrigin = new Map(incoming.results
    .filter((result) => result?.origin && AUTHORITATIVE_STATUSES.has(result.status))
    .map((result) => [result.origin, result]));
  const bookmarkPlan = currentBookmarkPlan(incoming);
  if (bookmarkPlan) {
    const currentOrigins = new Set(bookmarkPlan.origins);
    const latestByOrigin = new Map(latest.results.map((result) => [result?.origin, result]));
    if (latestByOrigin.size !== latest.results.length
      || latest.results.some((result) => !result?.origin || !currentOrigins.has(result.origin))
      || [...incomingByOrigin.keys()].some((origin) => !currentOrigins.has(origin))) return null;

    const newOrigins = bookmarkPlan.origins.filter((origin) => !latestByOrigin.has(origin));
    if (newOrigins.some((origin) => !incomingByOrigin.has(origin))) return null;
    const results = bookmarkPlan.origins.map((origin) => {
      const current = latestByOrigin.get(origin);
      const candidate = incomingByOrigin.get(origin);
      if (!current) return candidate;
      return candidate && shouldPromote(current, candidate) ? { ...current, ...candidate } : current;
    });
    const changed = newOrigins.length > 0
      || results.some((result, index) => result !== latestByOrigin.get(bookmarkPlan.origins[index]));
    if (!changed) return null;

    const remainingDeferred = results
      .filter((result) => result.status === "deferred" && result.nextEligibleAt)
      .map((result) => Date.parse(result.nextEligibleAt))
      .filter(Number.isFinite)
      .sort((left, right) => left - right);
    return {
      ...latest,
      plannedTotal: results.length,
      processedTotal: results.length,
      isComplete: true,
      scopeComplete: true,
      bookmarkSummary: incoming.bookmarkSummary,
      selectedTotal: Number(incoming.selectedTotal) || incoming.results.length,
      selectedProcessedTotal: Number(incoming.selectedProcessedTotal) || incoming.results.length,
      selectedOrigins: incoming.selectedOrigins ?? incoming.results.map((result) => result.origin).filter(Boolean),
      selectedSummary: incoming.selectedSummary ?? summarizeResults(incoming.results),
      summary: summarizeResults(results),
      nextRetryAt: remainingDeferred.length > 0 ? new Date(remainingDeferred[0]).toISOString() : null,
      results,
      reconciledAt: reconciledAt.toISOString(),
      reconciledFromRunIds: [...new Set([
        ...(latest.reconciledFromRunIds ?? []),
        incoming.runId,
      ])].slice(-20),
    };
  }
  let changed = false;
  const results = latest.results.map((current) => {
    const candidate = incomingByOrigin.get(current.origin);
    if (!candidate || !shouldPromote(current, candidate)) return current;
    changed = true;
    return { ...current, ...candidate };
  });
  if (!changed) return null;

  const remainingDeferred = results
    .filter((result) => result.status === "deferred" && result.nextEligibleAt)
    .map((result) => Date.parse(result.nextEligibleAt))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  return {
    ...latest,
    selectedTotal: Number(incoming.selectedTotal) || incoming.results.length,
    selectedProcessedTotal: Number(incoming.selectedProcessedTotal) || incoming.results.length,
    selectedOrigins: incoming.selectedOrigins ?? incoming.results.map((result) => result.origin).filter(Boolean),
    selectedSummary: incoming.selectedSummary ?? summarizeResults(incoming.results),
    summary: summarizeResults(results),
    nextRetryAt: remainingDeferred.length > 0 ? new Date(remainingDeferred[0]).toISOString() : null,
    results,
    reconciledAt: reconciledAt.toISOString(),
    reconciledFromRunIds: [...new Set([
      ...(latest.reconciledFromRunIds ?? []),
      incoming.runId,
    ])].slice(-20),
  };
}

function localRunId(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export async function createRunLog(rootDirectory) {
  const runId = localRunId();
  const directory = path.join(rootDirectory, runId);
  await ensurePrivateDirectory(directory);
  return { runId, directory };
}

export async function writeRunResult(rootDirectory, runLog, result, {
  updateLatest = true,
  reconcileLatest = false,
} = {}) {
  const runFile = path.join(runLog.directory, "result.json");
  const latestFile = path.join(rootDirectory, "latest.json");
  const safeResult = sanitizeForPersistence(result);
  await atomicWriteJson(runFile, safeResult);
  if (updateLatest) {
    await atomicWriteJson(latestFile, safeResult);
  } else if (reconcileLatest) {
    const latest = await fs.readFile(latestFile, "utf8").then(JSON.parse).catch(() => null);
    const reconciled = mergeAuthoritativeDailyResults(latest, safeResult);
    if (reconciled) await atomicWriteJson(latestFile, reconciled);
  }
  return runFile;
}

async function readJson(filePath) {
  return fs.readFile(filePath, "utf8").then(JSON.parse).catch(() => null);
}

async function sanitizeJsonFile(filePath) {
  const value = await readJson(filePath);
  if (!value) return { value: null, changed: false };
  const safeValue = sanitizeForPersistence(value);
  const changed = JSON.stringify(value) !== JSON.stringify(safeValue);
  if (changed) await atomicWriteJson(filePath, safeValue);
  return { value: safeValue, changed };
}

export async function repairLocalResultHistory(rootDirectory, siteStatePath = null) {
  const resolvedRoot = path.resolve(rootDirectory);
  const runFiles = [];
  for (const entry of await fs.readdir(resolvedRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = path.resolve(resolvedRoot, entry.name);
    if (!directory.startsWith(`${resolvedRoot}${path.sep}`)) continue;
    for (const name of ["progress.json", "result.json"]) {
      const filePath = path.join(directory, name);
      const stat = await fs.lstat(filePath).catch(() => null);
      if (stat?.isFile() && !stat.isSymbolicLink()) runFiles.push(filePath);
    }
  }

  const latestPath = path.join(resolvedRoot, "latest.json");
  const latestStat = await fs.lstat(latestPath).catch(() => null);
  let sanitizedFiles = 0;
  let latest = null;
  if (latestStat?.isFile() && !latestStat.isSymbolicLink()) {
    const repaired = await sanitizeJsonFile(latestPath);
    latest = repaired.value;
    sanitizedFiles += Number(repaired.changed);
  }

  const runReports = [];
  for (const filePath of runFiles.sort()) {
    const repaired = await sanitizeJsonFile(filePath);
    sanitizedFiles += Number(repaired.changed);
    if (path.basename(filePath) === "result.json" && repaired.value) runReports.push(repaired.value);
  }

  const reconciledRunIds = [];
  for (const report of runReports.sort((left, right) => String(left.runId).localeCompare(String(right.runId)))) {
    const reconciled = mergeAuthoritativeDailyResults(latest, report);
    if (!reconciled) continue;
    latest = reconciled;
    reconciledRunIds.push(report.runId);
  }
  if (reconciledRunIds.length > 0) await atomicWriteJson(latestPath, latest);

  if (siteStatePath) {
    const resolvedState = path.resolve(siteStatePath);
    const stateStat = await fs.lstat(resolvedState).catch(() => null);
    if (stateStat?.isFile() && !stateStat.isSymbolicLink()) {
      const repaired = await sanitizeJsonFile(resolvedState);
      sanitizedFiles += Number(repaired.changed);
    }
  }

  return {
    scannedFiles: runFiles.length + Number(Boolean(latestStat?.isFile())) + Number(Boolean(siteStatePath)),
    sanitizedFiles,
    reconciledRunIds,
  };
}

export async function cleanupOldLogs(rootDirectory, retentionDays) {
  const resolvedRoot = path.resolve(rootDirectory);
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  for (const entry of await fs.readdir(rootDirectory, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const fullPath = path.resolve(rootDirectory, entry.name);
    if (!fullPath.startsWith(`${resolvedRoot}${path.sep}`)) continue;
    const stat = await fs.lstat(fullPath).catch(() => null);
    if (stat?.isSymbolicLink()) continue;
    if (stat && stat.mtimeMs < cutoff) await fs.rm(fullPath, { recursive: true, force: true });
  }
}
