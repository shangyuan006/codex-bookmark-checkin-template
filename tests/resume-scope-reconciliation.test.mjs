import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { reconcileResumeScope, reconcileManualScope } from '../src/resume-scope-reconciliation.mjs';
import { buildCurrentPlan } from '../src/current-plan.mjs';
import { publicBookmarkReport } from '../src/bookmarks.mjs';
import { bindSuccessEvidence, successEvidence } from '../src/checkin-evidence.mjs';
import { assertManualVerificationExecution } from '../src/manual-verification-guard.mjs';

const exec = promisify(execFile);
const root = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const now = new Date('2026-10-08T04:00:00Z');
const target = name => ({ origin: `https://${name}.example`, candidates: [`https://${name}.example/profile`],
  allowedOrigins: [`https://${name}.example`], folderNames: ['Daily'], title: name });
const plan = targets => ({ targets, targetCount: targets.length, sources: [], comparison: {}, exactUrlCount: targets.length });
const completed = (t, config = {}, at = now) => bindSuccessEvidence({ origin: t.origin, status: 'signed',
  evidence: successEvidence('page_text', 'page_completion_text', at) }, t, config, at);
const report = (p, results, config = {}, at = now) => ({ runId: '20261008-100000', runState: 'final', isComplete: true,
  plannedTotal: results.length, processedTotal: results.length, finishedAt: at.toISOString(),
  planFingerprint: buildCurrentPlan(p, config).planFingerprint,
  bookmarkSummary: publicBookmarkReport({ ...p, ...buildCurrentPlan(p, config) }), results });

test('deleting a bookmark preserves remaining bound evidence and trims the manual scope', () => {
  const [removed, kept, pending] = ['removed', 'kept', 'pending'].map(target);
  const before = plan([removed, kept, pending]);
  const after = plan([kept, pending]);
  const original = report(before, [completed(removed), completed(kept), { origin: pending.origin, status: 'login_required' }]);
  const rebased = reconcileResumeScope(original, after, {}, now);
  assert.equal(rebased.results.length, 2);
  assert.deepEqual(rebased.results[0].evidence, original.results[1].evidence);
  assert.equal(rebased.finishedAt, original.finishedAt);
  assert.equal(rebased.results[1].status, 'login_required');
  assert.equal(rebased.planFingerprint, buildCurrentPlan(after).planFingerprint);
  const update = reconcileManualScope({ sourceRunId: original.runId, state: 'pending_verification',
    authoritativeEvidenceRequired: true, targets: [removed, pending].map(t => ({ origin: t.origin, verificationStatus: 'pending' })) }, after, {}, now);
  assert.equal(update.changed, true);
  assert.deepEqual(update.document.targets.map(t => t.origin), [pending.origin]);
  assert.equal(update.document.removedTargets[0].removalReason, 'removed_from_current_plan');
  assertManualVerificationExecution(update.document, { runDate: '20261008', consume: true,
    resumeRequested: true, allowSubset: true, selectedOrigins: new Set([pending.origin]) });
});

test('new and changed candidates remain pending and stale cycles are not restamped', () => {
  const old = target('one'), added = target('two');
  const before = plan([old]);
  const original = report(before, [completed(old)]);
  const changed = { ...old, candidates: [`${old.origin}/attendance`] };
  const rebased = reconcileResumeScope(original, plan([changed, added]), {}, now);
  assert.deepEqual(rebased.results.map(r => r.status), ['unconfirmed', 'unconfirmed']);
  assert.ok(rebased.results.every(r => !r.evidence && !r.observedAt));
  const stale = report(before, [completed(old, {}, new Date('2026-10-07T04:00:00Z'))]);
  assert.equal(reconcileResumeScope(stale, plan([old, added]), {}, now).results[0].status, 'unconfirmed');
  assert.equal(reconcileResumeScope({ ...original, runId: '20261007-100000' }, plan([old, added]), {}, now), null);
});

test('legacy completion still requires the current site, action, account and allowed origin', () => {
  const one = target('one'), added = target('two');
  const original = report(plan([one]), [completed(one)]);
  delete original.bookmarkSummary.targetPlanFingerprints;
  assert.equal(reconcileResumeScope(original, plan([one, added]), {}, now).results[0].status, 'signed');
  for (const field of ['accountKey', 'actionType', 'observedOrigin', 'siteOrigin']) {
    const bad = structuredClone(original);
    bad.results[0].evidence.binding[field] = field.endsWith('Origin') ? added.origin : 'other';
    assert.equal(reconcileResumeScope(bad, plan([one, added]), {}, now).results[0].status, 'unconfirmed');
  }
});

test('scope changes cannot clear an unresolved submission or transfer a provider account', () => {
  const one = target('one'), added = target('two');
  const config = { reauthCheckinRules: { [one.origin]: { provider: 'LinuxDO' } },
    agentrouterAccounts: [{ origin: one.origin, accountKey: 'sso', provider: 'LinuxDO' }] };
  const signed = completed({ ...one, accountKey: 'sso', actionType: 'reauth' }, config);
  signed.provider = 'GitHub';
  const original = report(plan([one]), [{ origin: one.origin, status: 'signed', accountResults: [signed] }], config);
  const result = reconcileResumeScope(original, plan([one, added]), config, now).results[0];
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.accountResults[0].status, 'unconfirmed');
  const manual = reconcileManualScope({ sourceRunId: original.runId, state: 'pending_verification',
    authoritativeEvidenceRequired: true, targets: [{ origin: one.origin, accountKeys: ['sso'],
      verificationStatus: 'signed', accountResults: [signed] }] }, plan([one, added]), config, now);
  assert.equal(manual.document.targets[0].verificationStatus, 'pending');
  const pending = report(plan([one]), [{ origin: one.origin, status: 'needs_attention', submissionAttempted: true }]);
  const changed = { ...one, candidates: [`${one.origin}/other`] };
  assert.equal(reconcileResumeScope(pending, plan([changed, added]), {}, now).results[0].retryable, false);
});

test('removing every manual target completes scope cleanup without inventing signed results', () => {
  const one = target('one'), two = target('two');
  const doc = { sourceRunId: '20261008-100000', state: 'pending_verification', authoritativeEvidenceRequired: true,
    targets: [{ origin: one.origin, verificationStatus: 'pending' }] };
  const update = reconcileManualScope(doc, plan([two]), {}, now);
  assert.equal(update.document.state, 'verification_complete');
  assert.equal(update.document.targets.length, 0);
  assert.equal(update.document.removedTargets[0].verificationStatus, 'pending');
  const sequenceConfig = { sequentialActionRules: { [two.origin]: { steps: [{ url: `${two.origin}/draw`,
    actionTexts: ['Draw'], actionType: 'daily_draw' }] } } };
  const sequence = reconcileManualScope({ ...doc, targets: [{ origin: two.origin, actionType: 'daily_draw',
    verificationStatus: 'pending' }] }, plan([two]), sequenceConfig, now);
  assert.equal(sequence.document.targets.length, 1);
});

test('production wrapper reconciles a deleted target before preflight and consumes the remaining manual work', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scope-wrapper-'));
  try {
    for (const folder of ['src', 'scripts', 'config', 'logs', 'tmp']) await fs.mkdir(path.join(dir, folder));
    await fs.cp(path.join(root, 'src'), path.join(dir, 'src'), { recursive: true });
    const deps = ['CheckinContract.generated', 'Run-Checkin', 'Resolve-Runtime', 'RunLock', 'ManualVerification',
      'ResultContract', 'ManualAbandonment', 'NativeFallbackPolicy', 'PreflightScope', 'CheckinCycle', 'TaskRetryPolicy', 'TaskRuntimeBudget'];
    for (const name of deps) await fs.copyFile(path.join(root, 'scripts', `${name}.ps1`), path.join(dir, 'scripts', `${name}.ps1`));
    const [removed, kept] = ['removed', 'kept'].map(target);
    const bookmarksPath = path.join(dir, 'bookmarks.json');
    await fs.writeFile(bookmarksPath, JSON.stringify({ roots: { bookmark_bar: { type: 'folder', name: 'Root',
      children: [{ type: 'folder', name: 'Checkin', children: [{ type: 'folder', name: 'Daily',
        children: [{ type: 'url', name: 'kept', url: kept.candidates[0] }] }] }] } } }));
    const config = { bookmarksPath, mobileFolderNames: ['Checkin'], targetFolderNames: ['Daily'], minimumBookmarkTargetCount: 1,
      nodeExecutable: process.execPath, runMutexName: `Local\\ScopeFixture-${randomUUID()}`, taskRunAttempts: 1,
      taskRetryDelayMinutes: 0, nativeWafPreflightUrls: [kept.candidates[0]], syncBookmarkSavedLogins: false };
    await fs.writeFile(path.join(dir, 'config', 'config.json'), JSON.stringify(config));
    const realNow = new Date();
    const date = [realNow.getFullYear(), realNow.getMonth() + 1, realNow.getDate()].map((v, i) => i ? String(v).padStart(2, '0') : v).join('');
    const initial = report(plan([removed, kept]), [completed(removed, {}, realNow), { origin: kept.origin, status: 'login_required' }], {}, realNow);
    initial.runId = `${date}-100000`;
    await fs.writeFile(path.join(dir, 'logs', 'latest.json'), JSON.stringify(initial));
    await fs.writeFile(path.join(dir, 'tmp', 'manual-verification.json'), JSON.stringify({ sourceRunId: initial.runId,
      createdAt: realNow.toISOString(), sourceFinishedAt: realNow.toISOString(), state: 'pending_verification', authoritativeEvidenceRequired: true,
      targets: [removed, kept].map(t => ({ origin: t.origin, verificationStatus: 'pending' })) }));
    await fs.writeFile(path.join(dir, 'scripts', 'Prepare-NativeWafSession.ps1'), String.raw`
      param($Origins, $OverrideTodayAbandonment, $AttemptId)
      $doc=Get-Content -Raw -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'tmp/manual-verification.json') | ConvertFrom-Json
      if (@($doc.targets).Count -ne 1 -or $doc.targets[0].origin -ne 'https://kept.example') { throw 'Preflight ran before scope cleanup' }
    `);
    await fs.writeFile(path.join(dir, 'src', 'index.mjs'), String.raw`
      import fs from 'node:fs/promises'; import path from 'node:path';
      import { assertManualVerificationExecution } from './manual-verification-guard.mjs';
      const root=process.cwd();
      if(process.argv.includes('--list-preflight-targets')) console.log(JSON.stringify([{origin:'https://kept.example'}]));
      else {
        const doc=JSON.parse(await fs.readFile(path.join(root,'tmp/manual-verification.json'),'utf8'));
        const resume=process.argv[process.argv.indexOf('--resume-report')+1];
        const before=JSON.parse(await fs.readFile(resume,'utf8'));
        assertManualVerificationExecution(doc,{runDate:before.runId.slice(0,8),consume:process.argv.includes('--consume-manual-verification'),
          resumeRequested:!!resume,allowSubset:true,selectedOrigins:new Set(['https://kept.example'])});
        await fs.writeFile(path.join(root,'tmp/verified.json'),JSON.stringify({remaining:doc.targets.length,resumeCount:before.results.length}));
        const final={...before,selectedOrigins:['https://kept.example'],results:[{origin:'https://kept.example',status:'signed'}]};
        await fs.writeFile(path.join(root,'logs/latest.json'),JSON.stringify(final));
      }
    `);
    await exec('pwsh', ['-NoProfile', '-NonInteractive', '-File', path.join(dir, 'scripts', 'Run-Checkin.ps1'),
      '-Attempts', '1', '-SuppressReport'], { cwd: dir, windowsHide: true, timeout: 30_000 });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'tmp', 'verified.json'), 'utf8')), { remaining: 1, resumeCount: 1 });
    assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'tmp', 'manual-verification.json'), 'utf8')).state, 'verification_complete');
  } finally { await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
