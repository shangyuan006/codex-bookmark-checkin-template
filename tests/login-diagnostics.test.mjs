import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoginDiagnostics, sanitizeLoginDiagnostics } from '../src/login-diagnostics.mjs';
import { loginHelperOutcomeFromStreams } from '../src/login-recovery.mjs';

test('native diagnostics count login POSTs without retaining request or response data', () => {
  const checkpoints = [];
  let time = 10;
  const probe = createLoginDiagnostics({ expectedOrigin: 'https://login.test', now: () => time,
    emit: value => checkpoints.push(value) });
  const request = (url, method = 'POST') => ({ url: () => url, method: () => method,
    postData: () => { throw new Error('must never read payload'); } });
  const login = request('https://login.test/api/user/login?private=sentinel');
  probe.checkpoint('credentials_ready', { credentialsReady: true, password: ['sent', 'inel'].join('') });
  probe.checkpoint('submit_click', { submitAttempts: 1 });
  probe.observeRequest(login);
  probe.observeRequest(request('https://other.test/login'));
  probe.observeRequest(request('https://login.test/login', 'GET'));
  probe.observeRequest(request('https://login.test/api/checkin'));
  probe.observeResponse({ request: () => login, status: () => 401,
    text: () => { throw new Error('must never read body'); } });
  probe.checkpoint('post_submit', { submitClicksCompleted: 1 });
  time = 1010;
  const snapshot = probe.snapshot();
  assert.equal(snapshot.loginDiagnostics.loginPostRequests, 1);
  assert.equal(snapshot.loginDiagnostics.loginPostResponses, 1);
  assert.deepEqual(snapshot.loginDiagnostics.loginPostStatusCodes, [401]);
  assert.equal(snapshot.loginDiagnostics.elapsedMs, 1000);
  assert.doesNotMatch(JSON.stringify(checkpoints), /sentinel|login\.test|password/);
});

test('diagnostics whitelist fields, strict types and bounded counters', () => {
  assert.deepEqual(sanitizeLoginDiagnostics({ formUnique: 'yes', credentialsReady: true,
    submitAttempts: -1, loginPostResponses: 1001, elapsedMs: Infinity,
    url: 'private', error: 'private', loginPostStatusCodes: [200, 200, '403', 0, 999, 500] }),
  { loginDiagnostics: { credentialsReady: true, loginPostStatusCodes: [200, 500] } });
  assert.deepEqual(sanitizeLoginDiagnostics(null), {});
});

test('last safe checkpoint survives a killed or timed-out helper', () => {
  const lines = [
    { loginStage: 'form_fields', loginDiagnostics: { formUnique: true } },
    { loginStage: 'submit_click', loginDiagnostics: { submitAttempts: 1, credentialsReady: true, raw: 'private' } },
  ].map(JSON.stringify).join('\n');
  const result = loginHelperOutcomeFromStreams('', `${lines}\nprocess ended`, 'timeout');
  assert.equal(result.status, 'timeout');
  assert.equal(result.loginStage, 'submit_click');
  assert.equal(result.loginDiagnostics.submitAttempts, 1);
  assert.doesNotMatch(JSON.stringify(result), /private|raw/);
  const merged = loginHelperOutcomeFromStreams('{"status":"needs_attention"}', lines);
  assert.equal(merged.loginStage, 'submit_click');
  assert.equal(merged.loginDiagnostics.credentialsReady, true);
});

test('diagnostic observer failures cannot break login', () => {
  const probe = createLoginDiagnostics({ expectedOrigin: 'https://login.test',
    emit: () => { throw new Error('closed stream'); } });
  assert.doesNotThrow(() => probe.checkpoint('form_fields', { formUnique: false }));
  assert.doesNotThrow(() => probe.observeResponse({ request: () => { throw new Error('gone'); } }));
});
