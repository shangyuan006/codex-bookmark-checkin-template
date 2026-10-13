import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { atomicWriteJson } from '../src/security.mjs';
import { waitForReauthLogout } from '../src/reauth-logout.mjs';
import { prepareOAuthTargetPage, sanitizeOAuthPageObservation } from '../src/oauth-target-state.mjs';
import { sanitizeOAuthFlowDiagnostic, writeOAuthFlowDiagnostic } from '../src/oauth-flow-diagnostics.mjs';
import { loginHelperOutcomeFromStreams } from '../src/login-recovery.mjs';
import { reauthRecoveryAction } from '../src/reauth-recovery.mjs';
import { shouldRetryOAuthFailureStage } from '../src/reauth-checkin.mjs';

const exec = promisify(execFile);

async function fixtureDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'checkin-oct12-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
  test(`Windows ${code} replacement retries the same JSON file without rewriting its content`, async t => {
    const directory = await fixtureDirectory(t), file = path.join(directory, 'progress.json');
    await fs.writeFile(file, '{"version":1}');
    const replacements = [], delays = [];
    let writes = 0;
    const io = { ...fs,
      writeFile: async (...args) => { writes++; return fs.writeFile(...args); },
      rename: async (...args) => {
        replacements.push(args);
        if (replacements.length === 1) throw Object.assign(new Error('fixture lock'), { code });
        return fs.rename(...args);
      },
    };
    await atomicWriteJson(file, { version: 2 }, { io, platform: 'win32', wait: async ms => delays.push(ms) });
    assert.equal(writes, 1);
    assert.deepEqual(replacements[0], replacements[1]);
    assert.deepEqual(delays, [50]);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { version: 2 });
    assert.deepEqual(await fs.readdir(directory), ['progress.json']);
  });
}

test('permanent replacement failure is bounded and preserves the previous valid destination', async t => {
  const directory = await fixtureDirectory(t), file = path.join(directory, 'progress.json');
  await fs.writeFile(file, '{"version":1}');
  let attempts = 0, writes = 0;
  const delays = [], failure = Object.assign(new Error('fixture lock'), { code: 'EPERM' });
  await assert.rejects(atomicWriteJson(file, { version: 2 }, {
    platform: 'win32', wait: async ms => delays.push(ms),
    io: { ...fs, writeFile: async (...args) => { writes++; return fs.writeFile(...args); },
      rename: async () => { attempts++; throw failure; } },
  }), error => error === failure);
  assert.equal(attempts, 6); assert.equal(writes, 1);
  assert.deepEqual(delays, [50, 100, 200, 400, 800]);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { version: 1 });
  assert.deepEqual(await fs.readdir(directory), ['progress.json']);
});

for (const [platform, code] of [['linux', 'EPERM'], ['win32', 'ENOENT']]) {
  test(`${platform} ${code} is not treated as a transient Windows file lock`, async t => {
    const directory = await fixtureDirectory(t), file = path.join(directory, 'progress.json');
    let attempts = 0;
    await assert.rejects(atomicWriteJson(file, {}, { platform,
      io: { ...fs, rename: async () => { attempts++; throw Object.assign(new Error('fixture'), { code }); } },
      wait: async () => { throw new Error('Unexpected retry'); },
    }), error => error.code === code);
    assert.equal(attempts, 1); assert.deepEqual(await fs.readdir(directory), []);
  });
}

test('concurrent writes in one process use separate temporary files and retain their own JSON', async t => {
  const directory = await fixtureDirectory(t), file = path.join(directory, 'progress.json');
  const written = new Map(), observed = [];
  const io = { ...fs,
    writeFile: async (temporary, content, options) => {
      written.set(temporary, content); return fs.writeFile(temporary, content, options);
    },
    rename: async (temporary, destination) => {
      const content = await fs.readFile(temporary, 'utf8');
      observed.push(content); assert.equal(content, written.get(temporary));
      return fs.rename(temporary, destination);
    },
  };
  await Promise.all([atomicWriteJson(file, { run: 'first' }, { io }), atomicWriteJson(file, { run: 'second' }, { io })]);
  assert.equal(written.size, 2);
  // Windows may retry a replacement during these competing renames. Every
  // attempt must still contain its writer's payload, as checked above.
  assert.deepEqual([...new Set(observed.map(value => JSON.parse(value).run))].sort(), ['first', 'second']);
  assert.deepEqual(await fs.readdir(directory), ['progress.json']);
});

const origin = 'https://example.test';
const rule = { origin, evidenceWaitMs: 2500 };
async function observeLogout(sequence, options = {}) {
  let time = 0, index = 0;
  const page = { isClosed: () => false, waitForTimeout: async ms => { time += ms; } };
  const result = await waitForReauthLogout(page, rule, {
    now: () => time,
    readEvidence: async () => sequence[Math.min(index++, sequence.length - 1)],
    ...options,
  });
  return { result, time, observations: index };
}
const loggedOut = { confirmed: true, targetSurface: 'target_login' };
const loggedIn = { confirmed: false, targetSurface: 'authenticated_target' };

test('logout verification waits for a delayed login page to remain stable', async () => {
  const { result, time } = await observeLogout([loggedIn, loggedIn, loggedIn, loggedIn, loggedOut]);
  assert.equal(result.confirmed, true); assert.equal(time, 2000);
});

test('a brief login-page flash followed by an authenticated page does not confirm logout', async () => {
  const { result, time } = await observeLogout([loggedOut, loggedOut, loggedIn]);
  assert.equal(result.confirmed, false); assert.equal(time, 2500);
});

test('a detached control during logout navigation resets the stability window and remains bounded', async () => {
  let reads = 0;
  const recovered = await observeLogout([], { readEvidence: async () => {
    if (reads++ === 1) throw new Error('Fixture navigation detached the control');
    return loggedOut;
  } });
  assert.equal(recovered.result.confirmed, true);
  assert.equal(recovered.time, 1500);
  const failed = await observeLogout([], { readEvidence: async () => { throw new Error('Fixture unavailable'); } });
  assert.equal(failed.result.confirmed, false);
  assert.equal(failed.result.targetSurface, 'unavailable');
  assert.equal(failed.time, 2500);
});

test('no logout success is inferred when the page stays authenticated or navigates to another origin', async () => {
  assert.equal((await observeLogout([loggedIn])).result.confirmed, false);
  const external = await observeLogout([{ confirmed: true, targetSurface: 'other_origin' }]);
  assert.equal(external.result.confirmed, false); assert.equal(external.observations, 1);
  assert.equal(shouldRetryOAuthFailureStage('logout_verification'), false);
  const previous = { date: '20261012', status: 'logged_out', updatedAt: '2026-10-12T02:00:00Z', loginEvidenceReset: true };
  assert.equal(reauthRecoveryAction(previous, new Date('2026-10-12T03:00:00Z')), 'resume');
  assert.equal(reauthRecoveryAction({ ...previous, logoutConfirmed: false }, new Date('2026-10-12T03:00:00Z')), 'restart');
});

test('OAuth closes only a configured same-origin overlay and retains its observation after dismissal', async () => {
  const config = { preCheckinDismissRules: { [origin]: { selectors: ['.notice-close'] } } };
  let reads = 0, closes = 0;
  const observations = [];
  const result = await prepareOAuthTargetPage({}, origin, config, {
    readSurface: async () => reads++ ? { kind: 'target_login', noticeVisible: false } : { kind: 'blocking_overlay', noticeVisible: true },
    dismissOverlay: async (_page, target, activeOrigin) => {
      assert.deepEqual(target.allowedOrigins, [origin]); assert.equal(activeOrigin, origin); closes++; return true;
    }, onObservation: value => observations.push({ ...value }),
  });
  assert.equal(closes, 1);
  assert.deepEqual(result, { targetSurface: 'target_login', noticeObserved: true, noticeDismissed: true });
  assert.equal(observations[0].targetSurface, 'blocking_overlay');
});

test('unconfigured and cross-origin dialogs are observed without being clicked', async () => {
  for (const [config, kind] of [[{}, 'blocking_overlay'],
    [{ preCheckinDismissRules: { [origin]: { selectors: ['.notice-close'] } } }, 'other_origin']]) {
    const result = await prepareOAuthTargetPage({}, origin, config, {
      readSurface: async () => ({ kind, noticeVisible: true }),
      dismissOverlay: async () => { throw new Error('Unexpected click'); },
    });
    assert.equal(result.noticeDismissed, false);
  }
});

test('new OAuth observations permit fixed categories and strict booleans only', async t => {
  const directory = await fixtureDirectory(t);
  const entry = { flow: 'automatic_logout', provider: 'GitHub', status: 'logged_out', oauthStage: 'logout_verification',
    stages: ['logout_verification'], logoutConfirmed: true, targetSurface: 'target_login', noticeObserved: true, noticeDismissed: false,
    url: 'https://example.test/?code=private-fixture', account: 'private-user@example.com', body: 'private-body' };
  assert.equal(await writeOAuthFlowDiagnostic(entry, { logsRoot: directory }), true);
  const [file] = await fs.readdir(directory), raw = await fs.readFile(path.join(directory, file), 'utf8');
  const safe = JSON.parse(raw);
  assert.equal(safe.status, 'logged_out'); assert.equal(safe.logoutConfirmed, true);
  assert.doesNotMatch(raw, /private-|https:|example\.com/);
  assert.deepEqual(sanitizeOAuthPageObservation({ ...entry, targetSurface: 'private-user', noticeObserved: 'true',
    noticeDismissed: 1, logoutConfirmed: 'true' }), {});
  assert.equal(sanitizeOAuthFlowDiagnostic({ ...entry, logoutConfirmed: 'true' }).status, 'needs_attention');
  const merged = loginHelperOutcomeFromStreams(JSON.stringify({ status: 'needs_attention', noticeObserved: false }),
    JSON.stringify({ oauthStage: 'logout_verification', targetSurface: 'authenticated_target', noticeObserved: true }));
  assert.equal(merged.noticeObserved, false); assert.equal(merged.targetSurface, 'authenticated_target');
});

test('the automatic reauth flow verifies logout before recording its resumable checkpoint', async () => {
  const source = await fs.readFile(new URL('../src/reauth-checkin.mjs', import.meta.url), 'utf8');
  const wait = source.indexOf('const logout = await waitForReauthLogout(');
  const stop = source.indexOf('if (!logout.confirmed)', wait);
  const checkpoint = source.indexOf('buildReauthStateEntry(date, "logged_out", new Date())', stop);
  assert.ok(wait >= 0 && stop > wait && checkpoint > stop);
  assert.match(source.slice(stop, checkpoint), /return.*status: 'needs_attention'/s);
});

test('the native login handoff retains the fixed logout-verification failure category', async () => {
  const source = await fs.readFile(new URL('../scripts/Open-AgentRouterLogin.ps1', import.meta.url), 'utf8');
  const stages = source.match(/\$safeOAuthStages = @\([\s\S]*?\n    \)/)?.[0];
  const classify = source.match(/\$failedStage = if \([\s\S]*?else \{ 'unknown' \}/)?.[0];
  assert.ok(stages && classify);
  const { stdout } = await exec('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `
    ${stages}
    $automaticResult = [pscustomobject]@{oauthStage='logout_verification'}
    ${classify}
    Write-Output $failedStage
  `], { windowsHide: true });
  assert.equal(stdout.trim(), 'logout_verification');
});
