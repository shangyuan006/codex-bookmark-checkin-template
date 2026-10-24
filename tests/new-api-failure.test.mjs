import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { runNewApiProtocol } from '../src/new-api-protocol.mjs';
import { tryNewApiHttpFirst } from '../src/new-api-http.mjs';

const origin = 'https://api.example';
const self = { httpStatus: 200, body: { success: true, data: { id: '42' } } };
const state = value => ({ httpStatus: 200, body: { success: true, data: { checked_in_today: value } } });
const rejected = (message, httpStatus = 401) => ({ httpStatus, body: { success: false, message } });

async function run(responses, options = {}) {
  const calls = [], diagnostics = [];
  const result = await runNewApiProtocol({ expectedAccountId: '42', wait: async () => {}, ...options,
    onFailure: value => diagnostics.push(value),
    request: async (path, method) => {
      calls.push({ path, method });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
  });
  return { result, calls, diagnostics };
}

test('API failures distinguish missing identity, invalid credentials, forbidden routes and outages', async () => {
  const cases = [
    [rejected('New-Api-User header not provided: private-detail'), 'user_header_required', 'needs_attention', 'new_api_user_header_required'],
    [rejected('access token 无效: private-detail', 200), 'token_invalid', 'login_required'],
    [rejected('请先登录: private-detail', 200), 'session_invalid', 'login_required'],
    [rejected('operation forbidden: private-detail', 403), 'access_denied', 'needs_attention', 'new_api_access_denied'],
    [rejected('not found: private-detail', 404), 'route_unavailable', 'needs_attention', 'new_api_route_unavailable'],
    [rejected('private-detail', 503), 'upstream_unavailable', 'deferred', 'site_server_error'],
    [rejected('private-detail', 429), 'rate_limit', 'deferred'],
  ];
  for (const [response, kind, status, code] of cases) {
    for (const phase of ['identity', 'status']) {
      const { result, calls, diagnostics } = await run(phase === 'identity' ? [response] : [self, response]);
      assert.equal(result.apiFailureKind, kind);
      assert.equal(result.status, status);
      if (code) assert.equal(result.failureCode, code);
      if (['user_header_required', 'access_denied', 'route_unavailable'].includes(kind)) {
        assert.equal(result.retryableLoginRecovery, false);
      }
      assert.deepEqual(diagnostics, [{ kind, phase }]);
      assert.equal(calls.some(call => call.method === 'POST'), false);
      assert.doesNotMatch(JSON.stringify({ result, diagnostics }), /private-detail|"42"/);
    }
  }
});

test('HTML challenges, non-JSON pages and redirects never mean that a session expired', async () => {
  for (const response of [
    { httpStatus: 403, contentType: 'text/html', bodyText: '<html><title>Just a moment</title>private-detail</html>' },
    { httpStatus: 401, contentType: 'application/json', cfMitigated: 'challenge', bodyText: '{}' },
    { httpStatus: 200, bodyText: '<!doctype html><body>ordinary private-detail</body>' },
    { httpStatus: 302, bodyText: '' },
  ]) {
    const { result, calls, diagnostics } = await run([response], { expectedAccountId: null, fallbackOnChallenge: true });
    assert.equal(result, null);
    assert.equal(calls.length, 1);
    assert.notEqual(diagnostics[0].kind, 'session_invalid');
    assert.doesNotMatch(JSON.stringify(diagnostics), /private-detail/);
  }
});

test('a missing HTTP identity header can fall back to browser storage without requesting a login', async () => {
  const { result, diagnostics } = await run([rejected('New-Api-User header not provided')], {
    expectedAccountId: null, fallbackOnChallenge: true,
  });
  assert.equal(result, null);
  assert.equal(diagnostics[0].kind, 'user_header_required');
});

test('ambiguous submission failures retain the submission guard and never send a second POST', async () => {
  for (const response of [
    { httpStatus: 403, contentType: 'text/html', bodyText: '<html>Just a moment</html>' },
    rejected('New-Api-User header not provided'),
    rejected('upstream failed', 503),
    new Error('connection lost'),
  ]) {
    let rejectedIntent = 0;
    const { result, calls } = await run([self, state(false), response, state(false), state(false), state(false), state(false)], {
      fallbackOnChallenge: true, rejectSubmission: async () => { rejectedIntent++; },
    });
    assert.equal(result.failureCode, 'api_submission_unconfirmed');
    assert.equal(result.submissionAttempted, true);
    assert.equal(rejectedIntent, 0);
    assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  }
});

test('only an explicit JSON challenge rejection releases the unused submission intent', async () => {
  let rejectedIntent = 0;
  const { result, calls } = await run([self, state(false), rejected('Turnstile token 为空', 200)], {
    fallbackOnChallenge: true, rejectSubmission: async () => { rejectedIntent++; },
  });
  assert.equal(result, null);
  assert.equal(rejectedIntent, 1);
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});

test('serialized browser protocol retains failure categories without exposing response text', async () => {
  for (const [response, status, kind] of [
    [new Response('<html>Just a moment private-detail</html>', { status: 403, headers: { 'Content-Type': 'text/html' } }), 'interactive_challenge', 'challenge'],
    [new Response(JSON.stringify(rejected('access token 无效 private-detail', 200).body)), 'login_required', 'token_invalid'],
    [new Response(JSON.stringify(rejected('New-Api-User header not provided private-detail').body), { status: 401 }), 'needs_attention', 'user_header_required'],
  ]) {
    const context = vm.createContext({ Date, Intl, AbortSignal, fetch: async () => response,
      document: { querySelectorAll: () => [], body: { innerText: '' } },
    });
    const result = await vm.runInContext(`(${runNewApiProtocol.toString()})()`, context);
    assert.equal(result.status, status);
    assert.equal(result.apiFailureKind, kind);
    assert.doesNotMatch(JSON.stringify(result), /private-detail/);
  }
});

test('HTTP fallback metrics preserve a fixed diagnosis while disposing every response', async () => {
  let disposed = 0;
  const context = { request: { fetch: async url => ({
    url: () => url, status: () => 403,
    headers: () => ({ 'content-type': 'text/html', 'cf-mitigated': 'challenge' }),
    text: async () => '<html>Just a moment private-detail</html>',
    dispose: async () => { disposed++; },
  }) } };
  const result = await tryNewApiHttpFirst(context, { origin }, { apiFirstOrigins: [origin], newApiCheckinOrigins: [origin] });
  assert.equal(result.fallback, true);
  assert.equal(result.metrics.failureKind, 'challenge');
  assert.equal(result.metrics.failurePhase, 'identity');
  assert.equal(disposed, 1);
  assert.doesNotMatch(JSON.stringify(result), /private-detail/);
});
