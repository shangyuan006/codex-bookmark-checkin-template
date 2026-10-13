import test from 'node:test';
import assert from 'node:assert/strict';
import { bindNativeCompletion } from '../src/native-completion-evidence.mjs';
import { nativePreflightProgress, freshNativePreflightResults } from '../src/native-preflight-state.mjs';
import { bindSuccessEvidence, successEvidence } from '../src/checkin-evidence.mjs';

const origin = 'https://sequence.example';
const target = { origin };
const config = { sequentialActionRules: { [origin]: { steps: [
  { url: `${origin}/profile`, actionTexts: ['Sign in'], actionType: 'daily_checkin' },
] } } };
const result = () => ({ origin, status: 'already_signed', evidence: successEvidence('page_text', 'native_confirmed_completion') });
const step = (actionType = 'daily_checkin') => bindSuccessEvidence({ status: 'already_signed',
  evidence: successEvidence('page_text', 'sequential_step_confirmed') }, { origin, actionType }, config);

test('native confirmation retains read-only step evidence through runner progress', async () => {
  let readOnly;
  const completed = await bindNativeCompletion(result(), target, config, async activeConfig => {
    readOnly = activeConfig.checkinReadOnly;
    return { status: 'already_signed', actionResults: [step()], requiredActionTypes: ['daily_checkin'], submissionTrackedPerAction: true };
  });
  assert.equal(readOnly, true);
  assert.equal(completed.status, 'already_signed');
  const fresh = freshNativePreflightResults({ generatedAt: new Date().toISOString(), results: [completed] }, new Set([origin]), new Date(), config);
  const [progress] = nativePreflightProgress([target], fresh);
  assert.equal(progress.actionResults.length, 1);
  assert.deepEqual(progress.requiredActionTypes, ['daily_checkin']);
  assert.equal(progress.submissionTrackedPerAction, true);
});

test('parent completion cannot stand in for a missing, foreign or partial step', async () => {
  const absent = await bindNativeCompletion(result(), target, config);
  assert.equal(absent.status, 'unconfirmed');
  const partial = await bindNativeCompletion(result(), target, config, async () => ({ status: 'unconfirmed', actionResults: [] }));
  assert.equal(partial.status, 'unconfirmed');
  for (const actionResult of [step('wrong_action'), { ...step(), origin: 'https://other.example' },
    { ...step(), accountKey: 'other' }, { ...step(), evidence: { ...step().evidence, binding: { ...step().evidence.binding, cycleId: 'old' } } }]) {
    const invalid = await bindNativeCompletion(result(), target, config, async () => ({ status: 'already_signed',
      actionResults: [actionResult], requiredActionTypes: ['daily_checkin'] }));
    assert.equal(invalid.status, 'unconfirmed');
  }
});

test('a completed check-in step cannot claim an unfinished second action', async () => {
  const twoSteps = { sequentialActionRules: { [origin]: { steps: [...config.sequentialActionRules[origin].steps,
    { url: `${origin}/draw`, actionTexts: ['Draw'], actionType: 'daily_draw' }] } } };
  const completed = await bindNativeCompletion(result(), target, twoSteps, async () => ({ status: 'already_signed',
    actionResults: [step()], requiredActionTypes: ['daily_checkin'] }));
  assert.equal(completed.status, 'unconfirmed');
});
