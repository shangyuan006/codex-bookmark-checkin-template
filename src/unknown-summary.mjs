import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sanitizeSubmissionDiagnostics } from './sequential-click-diagnostics.mjs';

const empty = () => ({ unknownRows: 0, requestObservedRows: 0, clickDispatchedRows: 0,
  verificationWaitRows: 0, preDispatchFailureRows: 0, missingObservationRows: 0, otherUnknownRows: 0 });
const runPattern = /^\d{8}-\d{6}(?:-[a-f0-9]{32}-[1-9]\d?)?$/;
const unknownCodes = new Set(['submission_quarantined', 'submission_outcome_unknown', 'same_page_completion_unconfirmed',
  'native_submission_unconfirmed', 'image_captcha_submission_unconfirmed', 'same_page_verification_unresolved',
  'cloudflare_verification_unresolved', 'piggo_calendar_unconfirmed']);
function leaves(row, parent = {}) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid row');
  const value = { ...parent, ...row };
  for (const key of ['accountResults', 'actionResults']) {
    if (row[key] != null && !Array.isArray(row[key])) throw new Error('Invalid nested rows');
    if (row[key]?.length) return row[key].flatMap(child => leaves(child,
      { origin: value.origin, accountKey: value.accountKey ?? 'default', actionType: value.actionType ?? 'checkin' }));
  }
  const origin = new URL(value.origin);
  if (origin.protocol !== 'https:' || origin.origin !== value.origin
    || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value.accountKey ?? 'default')
    || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.actionType ?? 'checkin')) throw new Error('Invalid row identity');
  return [value];
}

export function unknownRowCategory(row) {
  if (['signed', 'already_signed', 'not_available', 'abandoned'].includes(row.status)) return null;
  const observation = row.submissionObservation ?? row;
  if (!unknownCodes.has(row.failureCode) && !unknownCodes.has(observation.failureCode)
    && !['unconfirmed', 'clicked'].includes(row.status) && row.submissionAttempted !== true) return null;
  const d = sanitizeSubmissionDiagnostics(row.submissionDiagnostics ?? observation.submissionDiagnostics);
  const first = row.firstSubmissionFailure ?? observation.firstSubmissionFailure;
  const imageRequest = (Array.isArray(row.captchaAttempts) ? row.captchaAttempts : [])
    .some(value => Number.isInteger(value?.requestCount) && value.requestCount > 0 && value.requestCount <= 10000);
  if ((d?.submissionRequestCount ?? d?.requestCount ?? 0) > 0 || d?.submissionRequestObserved === true || imageRequest) return 'requestObservedRows';
  if (d?.action?.dispatchInvoked === true) return 'clickDispatchedRows';
  if (['interactive_challenge', 'managed_challenge', 'managed_challenge_timeout'].includes(observation.status)
    || /verification|challenge/.test(observation.failureCode ?? '')
    || d?.verification?.firstWidgetAfterMs != null) return 'verificationWaitRows';
  if (d?.action?.dispatchInvoked === false && d.action.outcome === 'failed'
    || first?.action?.dispatchInvoked === false && first.action.outcome === 'failed') return 'preDispatchFailureRows';
  if (!d) return 'missingObservationRows';
  return 'otherUnknownRows';
}

// Counts are report rows, including repeated observations across runs. They
// are never counts of real submissions, verification clicks or affected users.
export async function summarizeUnknownReports(root, { maxReports = 500 } = {}) {
  const directory = path.join(root, 'logs'), totals = empty(), groups = new Map(), errors = [];
  const candidates = (await fs.readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return []; throw error;
  })).filter(e => e.isDirectory() && !e.isSymbolicLink() && runPattern.test(e.name))
    .sort((a, b) => b.name.localeCompare(a.name));
  const selected = candidates.slice(0, Math.max(1, Math.min(5000, Number(maxReports) || 500)));
  let filesRead = 0;
  for (const entry of selected) {
    let report, rows;
    try {
      const file = path.join(directory, entry.name, 'result.json'), stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 10 * 1024 * 1024) throw new Error('Unsafe report');
      report = JSON.parse(await fs.readFile(file, 'utf8'));
      const rawDate = entry.name.slice(0, 8), isoDate = rawDate.slice(0, 4) + '-' + rawDate.slice(4, 6) + '-' + rawDate.slice(6, 8);
      const date = new Date(isoDate + 'T00:00:00Z');
      if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== isoDate
        || report.runId !== entry.name || !Array.isArray(report.results)) throw new Error('Invalid report');
      rows = report.results.flatMap(row => leaves(row));
    } catch { errors.push({ runId: entry.name, code: 'report_unreadable_or_invalid' }); continue; }
    filesRead++;
    const date = entry.name.slice(0, 8);
    for (const row of rows) {
      const category = unknownRowCategory(row);
      if (!category) continue;
      const targetHash = createHash('sha256').update(JSON.stringify([row.origin,
        row.accountKey ?? 'default', row.actionType ?? 'checkin'])).digest('hex').slice(0, 16);
      const key = date + ':' + targetHash;
      if (!groups.has(key)) groups.set(key, { date, targetHash, ...empty() });
      const group = groups.get(key);
      group.unknownRows++; group[category]++; totals.unknownRows++; totals[category]++;
    }
  }
  return { schemaVersion: 1, countUnit: 'report_rows', complete: errors.length === 0 && selected.length === candidates.length,
    filesRead, truncated: selected.length < candidates.length, totals, groups: [...groups.values()], errors };
}

export async function main(args = process.argv.slice(2)) {
  if (args.length && (args.length !== 2 || args[0] !== '--root')) {
    process.stderr.write('Usage: node src/unknown-summary.mjs [--root <project>]\n'); return 1;
  }
  try {
    const root = args[1] ?? path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const result = await summarizeUnknownReports(root);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n'); return result.complete ? 0 : 2;
  } catch { process.stderr.write('Unable to read check-in reports\n'); return 1; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
