import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readBookmarkPlan } from "./bookmarks.mjs";

export const ATTENTION_STATUSES = new Set([
  "error",
  "login_required",
  "interactive_challenge",
  "managed_challenge",
  "managed_challenge_timeout",
  "needs_attention",
]);

const MANUAL_DEFERRED_CAUSES = new Set(["login_required", "managed_challenge_timeout"]);
const AUTHORITATIVE_STATUSES = new Set(["signed", "already_signed", "not_available"]);

export function requiresManualAttention(result) {
  if (result?.status === "deferred") return MANUAL_DEFERRED_CAUSES.has(result.retryCause);
  return ATTENTION_STATUSES.has(result?.status);
}

export function canExplicitlyRequestManualAttention(result) {
  if (!result) return true;
  return requiresManualAttention(result) || ["no_action", "clicked"].includes(result.status);
}

function runDate(runId) {
  return String(runId ?? "").match(/^(\d{8})-/)?.[1] ?? null;
}

function localDateKey(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("");
}

async function loadCurrentAbandonedOrigins(rootDirectory, latest) {
  const document = await fs.readFile(path.join(rootDirectory, "tmp", "manual-abandon.json"), "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  if (!document || String(document.date ?? "") !== (runDate(latest?.runId) ?? localDateKey())) return [];
  return Array.isArray(document.origins) ? document.origins : [];
}

async function loadCurrentManualHandoffOrigins(rootDirectory, latest) {
  const document = await fs.readFile(path.join(rootDirectory, "tmp", "manual-handoff.json"), "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  if (!document
    || document.state !== "awaiting_manual_handoff"
    || document.authoritativeEvidenceRequired !== true
    || !Array.isArray(document.targets)) return null;
  const expectedDate = runDate(latest?.runId);
  if (expectedDate && runDate(document.sourceRunId) !== expectedDate) return null;
  return document.targets.map((target) => target?.origin);
}

export function mergeAttentionEvidence(latest, runReports = []) {
  const baselineResults = Array.isArray(latest?.results) ? latest.results : [];
  const baselineDate = runDate(latest?.runId);
  if (!baselineDate) return latest;

  const newestByOrigin = new Map();
  for (const report of [...runReports]
    .filter((candidate) => runDate(candidate?.runId) === baselineDate && Array.isArray(candidate?.results))
    .sort((left, right) => String(left.runId).localeCompare(String(right.runId)))) {
    const selectedOrigins = Array.isArray(report.selectedOrigins)
      ? new Set(report.selectedOrigins.map((value) => String(value)))
      : null;
    for (const result of report.results) {
      const origin = String(result?.origin ?? "");
      if (!origin || (selectedOrigins && !selectedOrigins.has(origin))) continue;
      newestByOrigin.set(origin, result);
    }
  }

  const merged = new Map(baselineResults
    .filter((result) => result?.origin)
    .map((result) => [result.origin, result]));
  for (const [origin, candidate] of newestByOrigin) {
    const current = merged.get(origin);
    if (AUTHORITATIVE_STATUSES.has(current?.status)) continue;
    merged.set(origin, candidate);
  }
  return {
    ...latest,
    results: [...merged.values()],
  };
}

async function loadCurrentDayRunReports(logsDirectory, latest) {
  const expectedDate = runDate(latest?.runId);
  if (!expectedDate) return [];
  const resolvedLogs = path.resolve(logsDirectory);
  const entries = await fs.readdir(resolvedLogs, { withFileTypes: true }).catch(() => []);
  const reports = [];
  for (const entry of entries
    .filter((candidate) => candidate.isDirectory() && !candidate.isSymbolicLink())
    .sort((left, right) => right.name.localeCompare(left.name))
    .slice(0, 256)) {
    const directory = path.resolve(resolvedLogs, entry.name);
    if (!directory.startsWith(`${resolvedLogs}${path.sep}`)) continue;
    const resultPath = path.join(directory, "result.json");
    const stat = await fs.lstat(resultPath).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) continue;
    const report = await fs.readFile(resultPath, "utf8").then(JSON.parse).catch(() => null);
    if (runDate(report?.runId) === expectedDate) reports.push(report);
  }
  return reports;
}

function normalizeRequestedOrigin(value) {
  try {
    const url = new URL(String(value));
    if (!/^https?:$/.test(url.protocol)) throw new Error();
    return url.origin;
  } catch {
    throw new Error(`无效的待处理站点 origin：${value}`);
  }
}

function sortAttentionItems(items, preferredOrigins = []) {
  return [...items].sort((left, right) => {
    const leftIndex = preferredOrigins.indexOf(left.origin);
    const rightIndex = preferredOrigins.indexOf(right.origin);
    if (leftIndex >= 0 || rightIndex >= 0) {
      return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex)
        - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex);
    }
    return left.origin.localeCompare(right.origin);
  });
}

export function buildAttentionHandoff({
  plan,
  latest,
  preferredOrigins = [],
  requestedOrigins = [],
  handoffOrigins = null,
  selection = [],
  excludedOrigins = [],
  bookmarkLastModifiedAt = null,
}) {
  if (requestedOrigins.length > 0 && selection.length > 0) {
    throw new Error("Origins 和 Selection 不能同时使用");
  }

  const targetByOrigin = new Map(plan.targets.map((target) => [target.origin, target]));
  const resultByOrigin = new Map((latest.results ?? []).map((result) => [result.origin, result]));
  const excludedOriginSet = new Set(excludedOrigins.map(normalizeRequestedOrigin));
  const pending = sortAttentionItems(
    [...resultByOrigin.values()]
      .filter((result) => requiresManualAttention(result) && !excludedOriginSet.has(result.origin))
      .map((result) => {
        const target = targetByOrigin.get(result.origin);
        if (!target?.candidates?.length) return null;
        return {
          origin: target.origin,
          url: target.candidates[0],
          previousStatus: result.status,
        };
      })
      .filter(Boolean),
    preferredOrigins,
  );

  let targets = pending;
  let selectionMode = "pending";
  if (requestedOrigins.length > 0) {
    selectionMode = "origins";
    const normalized = [...new Set(requestedOrigins.map(normalizeRequestedOrigin))];
    const selected = normalized.map((origin) => {
      const target = targetByOrigin.get(origin);
      const previous = resultByOrigin.get(origin);
      if (!target?.candidates?.length) return null;
      if (excludedOriginSet.has(origin)) return null;
      if (!canExplicitlyRequestManualAttention(previous)) return null;
      return {
        origin,
        url: target.candidates[0],
        previousStatus: previous?.status ?? "new_target",
      };
    });
    const missing = normalized.filter((origin, index) => !selected[index]);
    if (missing.length > 0) {
      throw new Error(`所选站点不在当前待处理列表中：${missing.join(", ")}`);
    }
    targets = selected;
  } else if (Array.isArray(handoffOrigins)) {
    selectionMode = "handoff";
    const pendingByOrigin = new Map(pending.map((target) => [target.origin, target]));
    const combinedOrigins = [
      ...handoffOrigins.map(normalizeRequestedOrigin),
      ...pending.map((target) => target.origin),
    ];
    targets = [...new Set(combinedOrigins)]
      .map((origin) => {
        if (pendingByOrigin.has(origin)) return pendingByOrigin.get(origin);
        const target = targetByOrigin.get(origin);
        const previous = resultByOrigin.get(origin);
        if (!target?.candidates?.length || excludedOriginSet.has(origin)) return null;
        if (!canExplicitlyRequestManualAttention(previous)) return null;
        return {
          origin,
          url: target.candidates[0],
          previousStatus: previous?.status ?? "new_target",
        };
      })
      .filter(Boolean);
  } else if (selection.length > 0) {
    selectionMode = "selection";
    const indexes = [...new Set(selection.map((value) => Number(value)))];
    if (indexes.some((value) => !Number.isInteger(value) || value < 1 || value > pending.length)) {
      throw new Error(`Selection 必须是 1 到 ${pending.length} 的待处理站点序号`);
    }
    targets = indexes.map((value) => pending[value - 1]);
  }

  return {
    schemaVersion: 1,
    selectionMode,
    sourceRunId: latest.runId ?? null,
    sourceFinishedAt: latest.finishedAt ?? null,
    bookmarkPlanGeneratedAt: plan.generatedAt ?? null,
    bookmarkLastModifiedAt,
    availableCount: selectionMode === "handoff" ? targets.length : pending.length,
    targets,
  };
}

export function parseAttentionArguments(argv) {
  const requestedOrigins = [];
  const selection = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--origin") requestedOrigins.push(argv[++index] ?? "");
    else if (argv[index] === "--selection") selection.push(argv[++index] ?? "");
    else throw new Error(`未知参数：${argv[index]}`);
  }
  return { requestedOrigins, selection };
}

export async function loadAttentionHandoff(rootDirectory, argv = []) {
  const configPath = path.join(rootDirectory, "config", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  // Manual handoff must use the live bookmark file. A backup can contain a URL
  // that the user has already replaced, so failure here is intentionally fatal.
  const plan = await readBookmarkPlan(config.bookmarksPath, config);
  const bookmarkStats = await Promise.all(plan.bookmarkFiles.map((source) => fs.stat(source.path)));
  const bookmarkLastModifiedAt = new Date(Math.max(...bookmarkStats.map((stat) => stat.mtimeMs))).toISOString();
  const logsDirectory = path.join(rootDirectory, "logs");
  const latest = await fs.readFile(path.join(logsDirectory, "latest.json"), "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return {
        runId: null,
        results: plan.targets.map((target) => ({ origin: target.origin, status: "login_required" })),
      };
    });
  const attentionLatest = mergeAttentionEvidence(
    latest,
    await loadCurrentDayRunReports(logsDirectory, latest),
  );
  const { requestedOrigins, selection } = parseAttentionArguments(argv);
  const handoffOrigins = requestedOrigins.length === 0 && selection.length === 0
    ? await loadCurrentManualHandoffOrigins(rootDirectory, attentionLatest)
    : null;
  return buildAttentionHandoff({
    plan,
    latest: attentionLatest,
    preferredOrigins: config.attentionPreferredOrigins ?? [],
    requestedOrigins,
    handoffOrigins,
    selection,
    excludedOrigins: await loadCurrentAbandonedOrigins(rootDirectory, attentionLatest),
    bookmarkLastModifiedAt,
  });
}

const sourcePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === sourcePath) {
  const rootDirectory = path.dirname(path.dirname(sourcePath));
  const handoff = await loadAttentionHandoff(rootDirectory, process.argv.slice(2));
  process.stdout.write(JSON.stringify(handoff));
}
