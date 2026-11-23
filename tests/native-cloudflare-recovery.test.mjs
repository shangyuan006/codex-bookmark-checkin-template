import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeCloudflareReader } from '../src/native-cloudflare-recovery.mjs';
import { freshNativePreflightHandoffs, nativePreflightProgress } from '../src/native-preflight-state.mjs';

const origin = 'https://checkin.example';
const challenge = { state: { status: 'interactive_challenge' }, cloudflareUnresolved: true };

function fixture(read = () => challenge, overrides = {}) {
  let time = 0;
  const clicks = [], pages = [0, 1, 2, 3].map(id => ({ id, url: () => origin + '/profile' }));
  const reader = createNativeCloudflareReader(origin, {
    readState: async () => read(time, clicks.length), enabled: true,
    rule: { actionTexts: ['立即签到'], clickChallenge: true },
    now: () => time, deadline: () => 45000, wait: async ms => { time += ms; },
    resolvePage: async () => pages[clicks.length],
    recover: async page => {
      clicks.push({ time, page: page.id });
      return { clicked: true, outcome: 'challenge_frame_clicked', details: { allowedFrameCount: 1,
        frameStableMs: 4000, privateFrameUrl: 'PRIVATE-FIXTURE-URL' } };
    },
    ...overrides,
  });
  return { reader, clicks, pages, time: () => time };
}

test('native CF recovery reacquires replacement pages and stops after three separated clicks', async () => {
  const f = fixture();
  const result = await f.reader.read(f.pages[0]);
  assert.deepEqual(f.clicks, [{ time: 0, page: 0 }, { time: 5000, page: 1 }, { time: 10000, page: 2 }]);
  assert.equal(f.time(), 15000);
  assert.equal(result.state.failureCode, 'cloudflare_verification_unresolved');
  assert.equal(result.state.retryable, false);
  assert.equal(result.state.manualBrowserMode, 'native');
  assert.equal((await f.reader.read(f.pages[0])).state.challengeAttempts, 3);
  assert.equal(f.clicks.length, 3, 'later reads must not reset the click budget');
  const diagnostics = f.reader.diagnostics();
  assert.equal(diagnostics.clickCount, 3);
  assert.equal(diagnostics.probeCount, 3);
  assert.equal(diagnostics.details.frameStableMs, 4000);
  assert.doesNotMatch(JSON.stringify(diagnostics), /PRIVATE|https:|bodyText/);
});

test('native recovery waits for a late completion after the final CF click', async () => {
  const completed = { state: { status: 'already_signed' }, cloudflareUnresolved: false };
  const f = fixture(time => time >= 14000 ? completed : challenge);
  assert.equal((await f.reader.read(f.pages[0])).state.status, 'already_signed');
  assert.equal(f.reader.diagnostics().finalStatus, 'already_signed');
  assert.equal(f.clicks.length, 3);
});

test('resolved native CF remains ready until the site confirms check-in', async () => {
  const f = fixture(time => time >= 1000 ? { state: { status: 'ready' }, cloudflareUnresolved: false } : challenge);
  const result = await f.reader.read(f.pages[0]);
  assert.equal(result.state.status, 'ready');
  assert.equal(result.state.evidence, undefined);
  assert.equal(f.time(), 6000);
  assert.equal(f.clicks.length, 1);
});

test('native CF verification respects read-only mode and ignores unrelated captchas', async () => {
  for (const [read, enabled] of [[() => challenge, false],
    [() => ({ state: { status: 'interactive_challenge' }, cloudflareUnresolved: false }), true]]) {
    const f = fixture(read, { enabled, recover: async () => assert.fail('verification must remain untouched') });
    assert.equal((await f.reader.read(f.pages[0])).state.status, 'interactive_challenge');
    assert.equal(f.clicks.length, 0);
  }
});

test('native recovery rejects a replacement outside the expected origin', async () => {
  const f = fixture(() => challenge, { resolvePage: async () => ({ url: () => 'https://outside.example/' }) });
  await assert.rejects(f.reader.read(f.pages[0]));
  assert.equal(f.clicks.length, 0);
});

test('native recovery preserves a completion that appears after an earlier handoff', async () => {
  let completed = false;
  const f = fixture(() => completed ? { state: { status: 'signed' }, cloudflareUnresolved: false } : challenge);
  await f.reader.read(f.pages[0]);
  completed = true;
  assert.equal((await f.reader.read(f.pages[0])).state.status, 'signed');
  assert.equal(f.clicks.length, 3);
});

test('native CF handoff reaches the manual queue with diagnostics instead of another automatic attempt', async () => {
  const f = fixture(), result = await f.reader.read(f.pages[0]);
  const now = new Date(), attempt = 'a'.repeat(32);
  const report = { generatedAt: now.toISOString(), results: [{ origin, ...result.state,
    preflightAttemptId: attempt, cloudflareDiagnostics: f.reader.diagnostics() }] };
  const handoffs = freshNativePreflightHandoffs(report, new Set([origin]), attempt, now);
  assert.equal(handoffs.size, 1);
  const [progress] = nativePreflightProgress([{ origin }], handoffs);
  assert.equal(progress.manualBrowserMode, 'native');
  assert.equal(progress.cloudflareDiagnostics.clickCount, 3);
  assert.equal(progress.failureCode, 'cloudflare_verification_unresolved');
  assert.equal(freshNativePreflightHandoffs(report, new Set([origin]), 'b'.repeat(32), now).size, 0);
});
