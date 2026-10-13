import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { waitForNativeReadOnlyCompletion, resumeNativeDailyCycle } from '../src/native-checkin-state.mjs';
import { guardPageSubmissions } from '../src/submission-guard.mjs';

const origin = 'https://completion.example';

test('read-only confirmation waits for delayed completion without another action or reload', async () => {
  let time = 0, reads = 0;
  const page = { waitForTimeout: async ms => { time += ms; } };
  const result = await waitForNativeReadOnlyCompletion(page, origin, {}, {
    timeoutMs: 5000, now: () => time,
    readState: async () => {
      reads++;
      return { state: { status: time < 2000 ? 'ready' : 'already_signed' } };
    },
  });
  assert.equal(result.state.status, 'already_signed');
  assert.equal(time, 2000);
  assert.equal(reads, 3);
});

test('read-only confirmation is bounded and never turns a ready page into success', async () => {
  let time = 0;
  const result = await waitForNativeReadOnlyCompletion({ waitForTimeout: async ms => { time += ms; } }, origin, {}, {
    timeoutMs: 2500, now: () => time, readState: async () => ({ state: { status: 'ready' } }),
  });
  assert.equal(time, 2500);
  assert.equal(result.state.status, 'ready');
});

test('read-only confirmation promptly hands off explicit login or interactive blockers', async () => {
  for (const status of ['login_required', 'interactive_challenge', 'deferred']) {
    const result = await waitForNativeReadOnlyCompletion({ waitForTimeout: async () => assert.fail('must not wait') }, origin, {}, {
      readState: async () => ({ state: { status } }),
    });
    assert.equal(result.state.status, status);
  }
});

test('native inspector waits through a quarantined loading page and blocks mutating attendance requests', async () => {
  const source = await fs.readFile(new URL('../src/native-browser-inspect.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function inspectWithPlaywright() {');
  const end = source.indexOf('\nif (executeNewApiCheckin)', start);
  assert.ok(start > 0 && end > start);
  let time = 0, closed = 0, observed;
  const routes = [], outputs = [];
  const state = async () => ({ state: { status: time < 2000 ? 'ready' : 'already_signed' }, siteBodyLoaded: true });
  const page = { url: () => origin + '/', waitForLoadState: async () => {},
    waitForTimeout: async ms => { time += ms; }, route: async (match, handler) => { routes.push({ match, handler }); } };
  const noAction = async () => assert.fail('pending submission must not permit another action');
  const deps = {
    connectOverCdpWithRetry: async () => ({ contexts: () => [{ pages: () => [page] }], close: async () => { closed++; } }),
    chromium: {}, port: 12345, maxWaitSeconds: 30, expectedOrigin: origin,
    scope: { observe: async value => { observed = value; }, allPending: async () => [] },
    attachSubmissionScope: () => {}, guardPageSubmissions,
    executeCheckin: true, mayExecuteCheckin: false, selectNewestOriginPage: () => page, pagesForOrigin: () => [page],
    readPageState: state, config: {}, actionRule: {}, retryableChallengeOutcomes: new Set(), allowEndpointReady: false,
    resumeNativeDailyCycle,
    waitForNativeReadOnlyCompletion: (activePage, expected, config, options) => waitForNativeReadOnlyCompletion(activePage, expected, config,
      { ...options, now: () => time, readState: state }),
    waitForNativeCheckinAction: noAction, clickVisibleNativeSafeLineControl: noAction, clickVisibleNativeChallengeControl: noAction,
    nativeEvidence: async value => value, reconcileSubmissionResult: value => value,
    Date: { now: () => time }, console: { log: value => outputs.push(JSON.parse(value)) },
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction(...Object.keys(deps), source.slice(start, end) + '\nawait inspectWithPlaywright();')(...Object.values(deps));
  assert.equal(time, 2000);
  assert.equal(closed, 1);
  assert.equal(observed.status, 'already_signed');
  assert.equal(outputs[0].actionAttempted, false);
  assert.equal(outputs[0].status, 'already_signed');
  let aborted = 0, continued = 0;
  const route = routes.find(route => route.match(new URL(origin + '/attendance.php')));
  assert.ok(route);
  for (const method of ['POST', 'GET']) {
    await route.handler({ request: () => ({ method: () => method, url: () => origin + '/attendance.php' }),
      abort: async () => { aborted++; }, continue: async () => { continued++; } });
  }
  assert.equal(aborted, 1);
  assert.equal(continued, 1);
});
