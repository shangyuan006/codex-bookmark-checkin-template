import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSubmissionScope, readSubmissionJournal, reconcileSubmissionResult } from '../src/submission-guard.mjs';
import { writeScopedCheckinResult } from '../src/logger.mjs';
import { bindSuccessEvidence, successEvidence } from '../src/checkin-evidence.mjs';
import { localRunDate } from '../src/retry-policy.mjs';

const target = { origin: 'https://continuation.example', title: 'Fixture', allowedOrigins: ['https://continuation.example'] };
const diagnostics = { intentReserved: true, submissionRequestObserved: true, submissionRequestCount: 1,
  submissionResponseCount: 1, submissionRejectedCount: 1, submissionVerificationRequiredCount: 1,
  submissionPendingResponseCount: 0, submissionResponseStatus: 422,
  action: { phase: 'dispatch_click', outcome: 'click_returned', dispatchInvoked: true, elapsedMs: 37,
    label: 'PRIVATE_CONTROL', url: 'https://private.example/' },
  verification: { challengeFrameCount: 2, challengeFrameDetachedCount: 1, challengeFrameReplacementCount: 1,
    publicErrorCodes: [600010], events: [{ kind: 'frame_detached', elapsedMs: 40, text: 'PRIVATE_EVENT' }],
    token: 'PRIVATE_VERIFICATION' }, responseBody: 'PRIVATE_RESPONSE', token: 'PRIVATE_TOKEN' };

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nov19-repairs-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  await fs.mkdir(path.join(root, 'config')); await fs.mkdir(path.join(root, 'logs')); await fs.mkdir(path.join(root, 'tmp'));
  const config = { automationUserDataDir: path.join(root, 'profile') };
  await fs.writeFile(path.join(root, 'config/config.json'), JSON.stringify(config));
  return { root, config, journal: path.join(root, 'journal.json') };
}

test('an uncertain submission keeps safe click/request/rejection diagnostics across restart without releasing the intent', async t => {
  const f = await fixture(t), scope = createSubmissionScope(f.journal, target, f.config);
  await scope.begin();
  await scope.observe({ status: 'unconfirmed', failureCode: 'same_page_completion_unconfirmed', submissionDiagnostics: diagnostics,
    verificationRecoveryDiagnostics: { requestCount: 1, rejectionCount: 1, verificationRejectionCount: 1,
      pendingResponseCount: 0, requestFailed: false, outcome: 'protected', body: 'PRIVATE_BODY' } });
  const restarted = createSubmissionScope(f.journal, target, f.config), pending = await restarted.pending();
  const current = reconcileSubmissionResult({ status: 'ready' }, pending, target, f.config);
  assert.equal(current.failureCode, 'submission_quarantined');
  assert.equal(current.submissionObservation.submissionDiagnostics.action.dispatchInvoked, true);
  assert.equal(current.submissionObservation.submissionDiagnostics.submissionResponseStatus, 422);
  assert.equal(current.submissionObservation.submissionDiagnostics.verification.challengeFrameReplacementCount, 1);
  assert.equal(current.submissionObservation.verificationRecoveryDiagnostics.outcome, 'protected');
  await restarted.observe({ status: 'ready', siteBodyLoaded: true });
  const later = reconcileSubmissionResult({ status: 'not_signed', siteBodyLoaded: true }, await restarted.pending(), target, f.config);
  assert.equal(later.submissionObservation.status, 'not_signed');
  assert.equal(later.submissionObservation.submissionDiagnostics.action.dispatchInvoked, true);
  assert.equal(later.submissionObservation.submissionDiagnostics.submissionRequestCount, 1);
  await assert.rejects(restarted.begin(), /不确定提交/);
  const journal = await readSubmissionJournal(f.journal);
  assert.equal(journal.entries[0].verificationRejection, undefined, 'diagnostic counts are not a releasable rejection receipt');
  assert.doesNotMatch(JSON.stringify(journal), /PRIVATE|private\.example|responseBody|token/);
});

for (const priorStatus of ['needs_attention', 'signed', 'abandoned']) test(`a scoped failed observation is recorded and respects prior ${priorStatus}`, async t => {
  const f = await fixture(t), now = new Date(), before = new Date(now.getTime() - 5000).toISOString();
  const prior = priorStatus === 'signed' ? bindSuccessEvidence({ ...target, status: 'signed',
    evidence: successEvidence('page_text', 'page_completion_text') }, target, f.config)
    : { ...target, status: priorStatus, observedAt: before };
  const runId = localRunDate() + '-000000';
  await fs.writeFile(path.join(f.root, 'logs/latest.json'), JSON.stringify({ runId, runState: 'final', isComplete: true,
    plannedTotal: 1, processedTotal: 1, finishedAt: before, results: [prior] }));
  const { report } = await writeScopedCheckinResult(f.root, target, { status: 'interactive_challenge',
    failureCode: 'cloudflare_verification_unresolved', submissionAttempted: true, submissionDiagnostics: diagnostics }, f.config);
  const raw = JSON.parse(await fs.readFile(path.join(f.root, 'logs', report.runId, 'result.json')));
  assert.equal(raw.results[0].status, 'interactive_challenge');
  assert.equal(raw.results[0].submissionDiagnostics.submissionRequestCount, 1);
  assert.doesNotMatch(JSON.stringify(raw), /PRIVATE|private\.example|responseBody|token/);
  const latest = JSON.parse(await fs.readFile(path.join(f.root, 'logs/latest.json')));
  assert.equal(latest.results[0].status, priorStatus === 'needs_attention' ? 'interactive_challenge' : priorStatus);
});
