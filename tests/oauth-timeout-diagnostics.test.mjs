import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runOAuthHelper } from '../src/reauth-checkin.mjs';
import { recoverOAuthProgressDiagnostic, writeOAuthFlowDiagnostic } from '../src/oauth-flow-diagnostics.mjs';
import { loginHelperOutcomeFromStreams } from '../src/login-recovery.mjs';
import { classifyOAuthFlowPage, describeOAuthFlowPages } from '../src/oauth-target-state.mjs';

const rule = { origin: 'https://target.example', loginUrl: 'https://target.example/login', provider: 'LinuxDO' };
const account = { accountKey: 'default', automationUserDataDir: 'fixture-profile' };
const checkpoint = {
  oauthStage: 'session_verification', stages: ['target_login', 'target_callback', 'session_verification'],
  callbackWaitDiagnostics: { outcome: 'target_returned', polls: 40, elapsedMs: 9750, budgetMs: 15_000 },
  callbackDiagnostics: { outcome: 'session_stabilizing', polls: 2, elapsedMs: 250, budgetMs: 15_000 },
  flowPageKinds: ['provider_home'], currentPageKind: 'provider_home',
  url: 'https://provider.example/?code=private-fixture', body: 'private-fixture',
};

test('a real Node helper killed by execFile leaves the last phase in the terminal diagnostic', async () => {
  const execute = promisify(execFile), records = [];
  const code = `process.stderr.write(${JSON.stringify(JSON.stringify(checkpoint) + '\n')});setInterval(()=>{},1000);`;
  const outcome = await runOAuthHelper(rule, {}, account, [], {
    execute: () => execute(process.execPath, ['-e', code], { timeout: 1500, windowsHide: true }),
    writeDiagnostic: async entry => { records.push(entry); },
  });
  assert.equal(outcome.status, 'timeout');
  assert.equal(outcome.succeeded, false);
  assert.equal(records.length, 1);
  assert.equal(records[0].terminationReason, 'helper_timeout');
  assert.equal(records[0].oauthStage, 'session_verification');
});

test('both Node watchdog timeout shapes persist a sanitized final record with the latest phase', async t => {
  const logsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-timeout-'));
  t.after(() => fs.rm(logsRoot, { recursive: true, force: true }));
  for (const shape of [{ killed: true, signal: 'SIGTERM', code: null }, { code: 'ETIMEDOUT' }]) {
    let clock = 0;
    const outcome = await runOAuthHelper(rule, {}, account, [], {
      now: () => clock,
      execute: async () => {
        clock = 180_000;
        throw Object.assign(new Error('private-fixture'), shape, {
          stderr: ['unstructured-private-fixture', JSON.stringify(checkpoint), 'trailing-private-fixture'].join('\n'),
        });
      },
      writeDiagnostic: entry => writeOAuthFlowDiagnostic(entry, { logsRoot }),
    });
    assert.equal(outcome.succeeded, false);
    assert.equal(outcome.status, 'timeout');
    assert.equal(outcome.oauthStage, 'session_verification');
  }
  const [file] = await fs.readdir(logsRoot);
  const text = await fs.readFile(path.join(logsRoot, file), 'utf8');
  const records = text.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records.length, 2);
  for (const record of records) {
    assert.equal(record.status, 'timeout');
    assert.equal(record.terminationReason, 'helper_timeout');
    assert.equal(record.oauthStage, 'session_verification');
    assert.equal(record.elapsedMs, 180_000);
    assert.deepEqual(record.stages, checkpoint.stages);
    assert.deepEqual(record.callbackWaitDiagnostics, checkpoint.callbackWaitDiagnostics);
    assert.deepEqual(record.callbackDiagnostics, checkpoint.callbackDiagnostics);
    assert.deepEqual(record.flowPageKinds, ['provider_home']);
    assert.equal(record.currentPageKind, 'provider_home');
  }
  assert.doesNotMatch(text, /private-fixture|https:/);
});

test('a normally reported failure keeps its soft timeout details without duplicating the child log', async () => {
  let writes = 0;
  const final = { status: 'needs_attention', ...checkpoint,
    callbackDiagnostics: { outcome: 'session_unconfirmed', polls: 10, elapsedMs: 2250, budgetMs: 15_000 },
    terminationReason: 'flow_timeout', timeoutPhase: 'session' };
  const outcome = await runOAuthHelper(rule, {}, account, [], {
    execute: async () => { throw Object.assign(new Error('fixture'), {
      code: 2, stdout: JSON.stringify(final), stderr: JSON.stringify(checkpoint),
    }); },
    writeDiagnostic: async () => { writes++; },
  });
  assert.equal(writes, 0);
  assert.equal(outcome.terminationReason, 'flow_timeout');
  assert.deepEqual(outcome.callbackWaitDiagnostics, checkpoint.callbackWaitDiagnostics);
  assert.deepEqual(outcome.callbackDiagnostics, final.callbackDiagnostics);
});

test('a helper exiting without a final result is logged, and buffer errors are not called timeouts', async () => {
  for (const execute of [async () => ({}), async () => {
    throw Object.assign(new Error('private-fixture'), {
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true, signal: 'SIGTERM',
    });
  }]) {
    const records = [];
    const outcome = await runOAuthHelper(rule, {}, account, [], {
      execute, writeDiagnostic: async entry => { records.push(entry); },
    });
    assert.equal(outcome.succeeded, false);
    assert.equal(outcome.status, 'failed');
    assert.equal(records.length, 1);
    assert.equal(records[0].terminationReason, 'helper_failed');
  }
});

test('an incomplete helper crash is recorded even without any progress JSON', async () => {
  const records = [];
  const outcome = await runOAuthHelper(rule, {}, account, ['--provider-only'], {
    execute: async () => { throw Object.assign(new Error('private-fixture'), { code: 1, stderr: 'private-fixture' }); },
    writeDiagnostic: async entry => { records.push(entry); },
  });
  assert.equal(outcome.succeeded, false);
  assert.equal(records.length, 1);
  assert.equal(records[0].flow, 'automatic_provider');
  assert.equal(records[0].terminationReason, 'helper_failed');
  assert.equal(records[0].oauthStage, 'helper_failed');
  assert.doesNotMatch(JSON.stringify(records), /private-fixture/);
});

test('stream recovery keeps only bounded timing categories and lets the final result override progress', () => {
  const recovered = recoverOAuthProgressDiagnostic(JSON.stringify({ ...checkpoint,
    callbackWaitDiagnostics: { outcome: 'target_returned', polls: Infinity, elapsedMs: -4, budgetMs: 1e9, body: 'private-fixture' },
  }));
  assert.deepEqual(recovered.callbackWaitDiagnostics, { outcome: 'target_returned', polls: 0, elapsedMs: 0, budgetMs: 600_000 });
  const outcome = loginHelperOutcomeFromStreams(JSON.stringify({ status: 'logged_in', oauthStage: 'completed',
    callbackDiagnostics: { outcome: 'session_confirmed', polls: 4, elapsedMs: 750, budgetMs: 15_000 } }), JSON.stringify(checkpoint));
  assert.equal(outcome.status, 'logged_in');
  assert.equal(outcome.oauthStage, 'completed');
  assert.equal(outcome.callbackDiagnostics.outcome, 'session_confirmed');
  assert.doesNotMatch(JSON.stringify(outcome), /private-fixture|https:/);
  const interrupted = recoverOAuthProgressDiagnostic([
    JSON.stringify(checkpoint),
    JSON.stringify({ oauthStage: 'session_verification', authorizationSurface: { body: 'private-fixture' } }),
  ].join('\n'));
  assert.deepEqual(interrupted.stages, checkpoint.stages);
  assert.deepEqual(interrupted.callbackWaitDiagnostics, checkpoint.callbackWaitDiagnostics);
  assert.doesNotMatch(JSON.stringify(interrupted), /private-fixture|https:/);
});

test('flow page diagnostics classify official routes without retaining URLs, queries or request IDs', async t => {
  const origin = 'https://target.example';
  const pages = [
    ['https://linux.do/?private-fixture=value', 'provider_home'],
    ['https://linux.do/login', 'provider_login'],
    ['https://linux.do/session/sso_provider?sig=private-fixture', 'provider_sso'],
    ['https://connect.linux.do/oauth2/approve/private-fixture', 'provider_approval'],
    ['https://connect.linux.do/oauth2/authorize?state=private-fixture', 'provider_authorization'],
    [origin + '/login', 'target_login'], [origin + '/oauth/callback?code=private-fixture', 'target_callback'],
    [origin + '/profile', 'target_page'], ['https://linux.do.evil.example/', 'other_https'],
    ['https://user:private-fixture@example.com/', 'unavailable'], ['about:blank', 'non_https'],
  ].map(([url, expected]) => {
    const page = { url: () => url };
    assert.equal(classifyOAuthFlowPage(page, origin, 'LinuxDO'), expected);
    return page;
  });
  const stale = { url: () => origin + '/old-private-fixture' };
  const description = describeOAuthFlowPages({ pages: () => [...pages, stale] }, origin, 'LinuxDO', {
    acceptPage: page => page !== stale, currentPage: pages[0],
  });
  assert.equal(description.currentPageKind, 'provider_home');
  assert.doesNotMatch(JSON.stringify(description), /https:|private-fixture/);
  const logsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-page-kinds-'));
  t.after(() => fs.rm(logsRoot, { recursive: true, force: true }));
  await writeOAuthFlowDiagnostic({ flow: 'automatic_target', provider: 'LinuxDO', status: 'needs_attention',
    oauthStage: 'target_callback', terminationReason: 'wait_timeout', timeoutPhase: 'callback',
    ...description, flowPageKinds: [...description.flowPageKinds, 'private-fixture'],
    url: 'private-fixture', body: 'private-fixture' }, { logsRoot });
  const [file] = await fs.readdir(logsRoot);
  const text = await fs.readFile(path.join(logsRoot, file), 'utf8');
  const record = JSON.parse(text);
  assert.equal(record.terminationReason, 'wait_timeout');
  assert.equal(record.timeoutPhase, 'callback');
  assert.deepEqual(record.flowPageKinds, description.flowPageKinds);
  assert.doesNotMatch(text, /https:|private-fixture/);
  const outcome = loginHelperOutcomeFromStreams(JSON.stringify({ status: 'needs_attention',
    providerAuthorizationChallengeOutcome: 'departed_unconfirmed', ...description }));
  assert.equal(outcome.providerAuthorizationChallengeOutcome, 'departed_unconfirmed');
  assert.deepEqual(outcome.flowPageKinds, description.flowPageKinds);
});
