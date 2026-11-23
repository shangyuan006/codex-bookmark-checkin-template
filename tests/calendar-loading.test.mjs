import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForCalendarDayCheckinEvidence, classifyCalendarDayCheckinEvidence } from '../src/browser.mjs';

const origin = 'https://calendar.example';
const target = { origin, allowedOrigins: [origin] };
const config = { calendarDayCheckinOrigins: [origin], calendarDayCheckinWaitMs: 2000, checkinStatePollMs: 250 };
const empty = { buttonCount: 0, currentDateEvidenceCount: 0 };
const ready = { buttonCount: 1, currentDateEvidenceCount: 1, enabledCurrentDateButtonCount: 1,
  disabledCurrentDateButtonCount: 0, explicitTodayUnsigned: true, currentButtonIndex: 4 };
const signed = { ...ready, explicitTodayUnsigned: false, enabledCurrentDateButtonCount: 0,
  disabledCurrentDateButtonCount: 1, explicitSuccess: true };
function fixture() {
  let now = Date.parse('2026-10-09T04:00:00Z');
  let url = `${origin}/user/attendance`;
  const waits = [];
  return { page: { url: () => url, isClosed: () => false,
    waitForTimeout: async ms => { waits.push(ms); now += ms; } }, now: () => now, waits,
    navigate: destination => { url = destination; } };
}

test('calendar waits through an empty shell and stale month before accepting today', async () => {
  const f = fixture();
  const samples = [empty, { ...ready, currentDateEvidenceCount: 0 }, ready];
  let reads = 0;
  const result = await waitForCalendarDayCheckinEvidence(f.page, target, config, { now: f.now,
    readEvidence: async (_page, date) => { assert.equal(date.day, '9'); return samples[reads++]; } });
  assert.equal(classifyCalendarDayCheckinEvidence(result).status, 'ready');
  assert.deepEqual(f.waits, [250, 250]);
  assert.equal(reads, 3);
});

test('calendar confirmation waits for persisted completion after the submission reload', async () => {
  const f = fixture();
  let reads = 0;
  const result = await waitForCalendarDayCheckinEvidence(f.page, target, config, { afterClick: true, now: f.now,
    readEvidence: async () => [empty, ready, signed][reads++] });
  assert.equal(classifyCalendarDayCheckinEvidence(result, { afterClick: true }).status, 'signed');
  assert.equal(reads, 3);
});

test('missing calendar evidence times out without refreshing or submitting', async () => {
  const f = fixture();
  let reads = 0;
  const result = await waitForCalendarDayCheckinEvidence(f.page, target, { ...config, calendarDayCheckinWaitMs: 625 },
    { now: f.now, readEvidence: async () => { reads++; return empty; } });
  assert.equal(classifyCalendarDayCheckinEvidence(result).status, 'needs_attention');
  assert.deepEqual(f.waits, [250, 250, 125]);
  assert.equal(reads, 4);
});

test('a disabled date or historical success is not enough to confirm today', async () => {
  const f = fixture();
  const unconfirmed = { ...signed, explicitSuccess: false };
  const result = await waitForCalendarDayCheckinEvidence(f.page, target, { ...config, calendarDayCheckinWaitMs: 250 },
    { now: f.now, readEvidence: async () => unconfirmed });
  assert.equal(classifyCalendarDayCheckinEvidence(result).status, 'needs_attention');
  assert.deepEqual(f.waits, [250]);
});

test('calendar navigation outside the configured origin or path fails closed', async () => {
  for (const destination of ['https://outside.example/user/attendance', `${origin}/other`]) {
    const f = fixture();
    await assert.rejects(waitForCalendarDayCheckinEvidence(f.page, target, config, { now: f.now,
      readEvidence: async () => { f.navigate(destination); return ready; } }));
    assert.deepEqual(f.waits, []);
  }
});

test('calendar diagnostics distinguish the initial shell from the final dated completion', async () => {
  const f = fixture();
  let reads = 0;
  const samples = [
    { ...empty, loaded: false, pageState: 'unconfirmed' },
    { ...signed, loaded: true, authenticated: true, pageState: 'already_signed', currentDateCellSignedCount: 1,
      bodyText: 'private-account-and-reward', accountId: 'private-id' },
  ];
  const result = await waitForCalendarDayCheckinEvidence(f.page, target, config, {
    now: f.now, readEvidence: async () => samples[reads++],
  });
  assert.deepEqual(result.calendarDiagnostics, {
    reads: 2, elapsedMs: 250, expectedDay: 9, loaded: true, domReady: null, session: 'authenticated', pageState: 'already_signed',
    dayButtonCount: 1, currentDateCount: 1, signedCellCount: 1, explicitSuccess: true, unsignedObserved: false,
    firstLoaded: false, firstDayButtonCount: 0, outcome: 'already_signed', budgetMs: 2000, timedOut: false,
  });
  const classified = classifyCalendarDayCheckinEvidence(result);
  assert.equal(classified.status, 'already_signed');
  assert.doesNotMatch(JSON.stringify(classified), /private-account|private-id|bodyText|accountId/);
});

test('a rendered dated completion can confirm while unrelated resources still load', async () => {
  const f = fixture();
  const result = await waitForCalendarDayCheckinEvidence(f.page, target, config, { now: f.now,
    readEvidence: async () => ({ ...signed, loaded: false, domReady: true, pageState: 'already_signed' }) });
  assert.equal(classifyCalendarDayCheckinEvidence(result).status, 'already_signed');
  assert.equal(result.calendarDiagnostics.loaded, false);
  assert.equal(result.calendarDiagnostics.domReady, true);
  assert.deepEqual(f.waits, []);
});

test('loading, login and challenge blockers override calendar success until resolved', async () => {
  for (const [blocker, status] of [
    [{ loaded: false }, 'unconfirmed'],
    [{ loaded: true, pageState: 'login_required' }, 'login_required'],
    [{ loaded: true, pageState: 'interactive_challenge' }, 'interactive_challenge'],
    [{ loaded: true, pageState: 'managed_challenge' }, 'managed_challenge'],
    [{ loaded: true, pageState: 'deferred' }, 'needs_attention'],
  ]) {
    const f = fixture();
    const result = await waitForCalendarDayCheckinEvidence(f.page, target, { ...config, calendarDayCheckinWaitMs: 0 },
      { now: f.now, readEvidence: async () => ({ ...signed, ...blocker }) });
    assert.equal(classifyCalendarDayCheckinEvidence(result).status, status);
    assert.equal(result.calendarDiagnostics.outcome, status);
    assert.deepEqual(f.waits, []);
  }
});
