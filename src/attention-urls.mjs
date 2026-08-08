import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readBookmarkPlan } from "./bookmarks.mjs";

export const ATTENTION_STATUSES = new Set([
  "login_required",
  "interactive_challenge",
  "managed_challenge",
  "managed_challenge_timeout",
  "needs_attention",
]);

const MANUAL_DEFERRED_CAUSES = new Set(["login_required", "managed_challenge_timeout"]);

export function requiresManualAttention(result) {
  if (result?.status === "deferred") return MANUAL_DEFERRED_CAUSES.has(result.retryCause);
  return ATTENTION_STATUSES.has(result?.status);
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
  selection = [],
  bookmarkLastModifiedAt = null,
}) {
  if (requestedOrigins.length > 0 && selection.length > 0) {
    throw new Error("Origins 和 Selection 不能同时使用");
  }

  const targetByOrigin = new Map(plan.targets.map((target) => [target.origin, target]));
  const resultByOrigin = new Map((latest.results ?? []).map((result) => [result.origin, result]));
  const pending = sortAttentionItems(
    [...resultByOrigin.values()]
      .filter(requiresManualAttention)
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
      if (previous && !requiresManualAttention(previous)) return null;
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
    availableCount: pending.length,
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
  const bookmarkStat = await fs.stat(config.bookmarksPath);
  // Manual handoff must use the live bookmark file. A backup can contain a URL
  // that the user has already replaced, so failure here is intentionally fatal.
  const plan = await readBookmarkPlan(config.bookmarksPath, config);
  const latest = await fs.readFile(path.join(rootDirectory, "logs", "latest.json"), "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return {
        runId: null,
        results: plan.targets.map((target) => ({ origin: target.origin, status: "login_required" })),
      };
    });
  const { requestedOrigins, selection } = parseAttentionArguments(argv);
  return buildAttentionHandoff({
    plan,
    latest,
    preferredOrigins: config.attentionPreferredOrigins ?? [],
    requestedOrigins,
    selection,
    bookmarkLastModifiedAt: bookmarkStat.mtime.toISOString(),
  });
}

const sourcePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === sourcePath) {
  const rootDirectory = path.dirname(path.dirname(sourcePath));
  const handoff = await loadAttentionHandoff(rootDirectory, process.argv.slice(2));
  process.stdout.write(JSON.stringify(handoff));
}
