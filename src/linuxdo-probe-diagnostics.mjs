import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePrivateDirectory } from "./security.mjs";

const rootDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const stages = new Set([
  "automatic_provider", "automatic_provider_after_refresh", "automatic_target", "manual_provider",
  "manual_target", "manual_target_oauth", "manual_provider_after_close",
]);
const classifications = new Set(["valid", "invalid", "unknown"]);
const responseTypes = new Set(["json", "html", "other", "unavailable"]);
const errors = new Set(["request_failed", "navigation_failed", "fetch_failed", "json_parse_failed"]);
const fileNamePattern = /^linuxdo-session-probes-\d{8}\.jsonl$/;

function boundedNumber(value, maximum) {
  return Number.isFinite(value) ? Math.max(0, Math.min(maximum, Math.round(value))) : null;
}

export function sanitizeLinuxDoProbeDiagnostic(entry, now = new Date()) {
  if (!stages.has(entry?.stage)) return null;
  return {
    recordedAt: now.toISOString(),
    stage: entry.stage,
    status: classifications.has(entry.status) ? entry.status : "unknown",
    attempts: boundedNumber(entry.attempts, 24),
    elapsedMs: boundedNumber(entry.elapsedMs, 180_000),
    observations: (Array.isArray(entry.observations) ? entry.observations : []).slice(0, 24).map((value) => {
      const item = value && typeof value === "object" ? value : {};
      return {
        surface: ["request", "page"].includes(item.surface) ? item.surface : "page",
        step: ["landing", "session", "settle"].includes(item.step) ? item.step : "session",
        ...(item.step === "settle" ? { pageReady: item.pageReady === true } : {}),
        attempt: boundedNumber(item.attempt, 12),
        classification: classifications.has(item.classification) ? item.classification : null,
        httpStatus: Number.isInteger(item.httpStatus) && item.httpStatus >= 100 && item.httpStatus <= 599
          ? item.httpStatus : null,
        responseType: responseTypes.has(item.responseType) ? item.responseType : "unavailable",
        challenge: item.challenge === true,
        error: errors.has(item.error) ? item.error : null,
        elapsedMs: boundedNumber(item.elapsedMs, 120_000),
      };
    }),
  };
}

export async function writeLinuxDoProbeDiagnostic(entry, {
  logsRoot = path.join(rootDirectory, "logs"), now = new Date(), retentionDays = 14,
} = {}) {
  const safe = sanitizeLinuxDoProbeDiagnostic(entry, now);
  if (!safe) return false;
  try {
    await ensurePrivateDirectory(logsRoot);
    const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
    const filePath = path.join(logsRoot, `linuxdo-session-probes-${date}.jsonl`);
    const existing = await fs.lstat(filePath).catch(() => null);
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) return false;
    await fs.appendFile(filePath, `${JSON.stringify(safe)}\n`, { encoding: "utf8", mode: 0o600 });

    const days = Math.max(1, Math.min(90, Number(retentionDays) || 14));
    const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
    for (const item of await fs.readdir(logsRoot, { withFileTypes: true })) {
      if (!item.isFile() || !fileNamePattern.test(item.name)) continue;
      const oldPath = path.join(logsRoot, item.name);
      const stat = await fs.lstat(oldPath).catch(() => null);
      if (stat?.isFile() && !stat.isSymbolicLink() && stat.mtimeMs < cutoff) {
        await fs.unlink(oldPath).catch(() => {});
      }
    }
    return true;
  } catch {
    return false;
  }
}
