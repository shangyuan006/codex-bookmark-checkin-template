import test from 'node:test';
import assert from 'node:assert/strict';
import {continueCloudflareRecovery, getCloudflareRecoveryRule} from '../src/cloudflare-recovery.mjs';
import {waitForManagedChallenge, waitForCheckinAction} from '../src/browser.mjs';
import {isRetryEligible, filterAutomaticRetryOrigins} from '../src/retry-policy.mjs';
import {buildAttentionHandoff, requiresManualAttention} from '../src/attention-urls.mjs';
import {selectSamePageManualTarget} from '../src/live-checkin-session.mjs';

const origin = 'https://tracker.example';
const challenged = {status:'interactive_challenge',unresolvedChallenge:true};
function recoveryFixture(readState, click = () => ({clicked:true,outcome:'challenge_frame_clicked'})) {
  let time = 0;
  const clicks = [];
  const options = {
    readState:async () => readState(time,clicks.length),
    clickChallenge:async () => {clicks.push(time);return click();},
    now:() => time,
    wait:async ms => {time += ms;},
  };
  return {options,clicks,time:() => time};
}

test('repeated CF challenges stop after three separated clicks and reach native handoff', async () => {
  const fixture = recoveryFixture(() => challenged);
  const result = {...await continueCloudflareRecovery(fixture.options),origin};
  assert.deepEqual(fixture.clicks, [0,5000,10000]);
  assert.equal(fixture.time(),15000);
  assert.equal(result.status,'interactive_challenge');
  assert.equal(result.challengeAttempts,3);
  assert.equal(result.manualBrowserMode,'native');
  assert.equal(isRetryEligible(result),false);
  assert.equal(filterAutomaticRetryOrigins(new Set([origin]),[result]).size,0);
  assert.equal(requiresManualAttention(result),true);
});

test('a late completion after the last CF click wins over retry exhaustion', async () => {
  const completion = {status:'already_signed',evidence:{source:'page_text',authoritative:true}};
  const fixture = recoveryFixture(time => time >= 14000 ? completion : challenged);
  assert.equal(await continueCloudflareRecovery(fixture.options),completion);
  assert.equal(fixture.clicks.length,3);
});

test('CF progress is observed before a second click, without treating a click as success', async () => {
  const fixture = recoveryFixture(time => time >= 4500 ? {status:'signed'} : challenged);
  const result = await continueCloudflareRecovery(fixture.options);
  assert.equal(result.status,'signed');
  assert.deepEqual(fixture.clicks,[0]);
});

test('a briefly disappearing challenge does not prematurely restart the sign-in action', async () => {
  const fixture = recoveryFixture(time => time > 0 && time < 2500 ? {status:'ready'} : challenged);
  const result = await continueCloudflareRecovery(fixture.options);
  assert.equal(result.status,'interactive_challenge');
  assert.deepEqual(fixture.clicks,[0,5000,10000]);
});

test('resolved verification alone remains ready and needs a separate completion check', async () => {
  const fixture = recoveryFixture(time => time >= 1000 ? {status:'ready'} : challenged);
  const result = await continueCloudflareRecovery(fixture.options);
  assert.equal(result.status,'ready');
  assert.deepEqual(fixture.clicks,[0]);
  assert.equal(result.evidence,undefined);
});

test('missing controls stop at the wait deadline without claiming a successful click', async () => {
  const fixture = recoveryFixture(() => challenged,()=>({clicked:false,outcome:'challenge_not_found'}));
  const result = await continueCloudflareRecovery({...fixture.options,waitMs:3000});
  assert.equal(result.status,'interactive_challenge');
  assert.equal(result.challengeAttempts,0);
  assert.equal(fixture.time(),3000);
  assert.equal(fixture.clicks.length,1);
});

test('ambiguous CF controls stop immediately and retain manual attention', async () => {
  const fixture = recoveryFixture(() => challenged,()=>({clicked:false,outcome:'challenge_frame_not_unique'}));
  const result = await continueCloudflareRecovery(fixture.options);
  assert.equal(result.retryable,false);
  assert.equal(fixture.clicks.length,1);
});

test('recovery click budget cannot be increased above three', async () => {
  const fixture = recoveryFixture(() => challenged);
  await continueCloudflareRecovery({...fixture.options,maxClicks:1000});
  assert.equal(fixture.clicks.length,3);
});

test('CF rules are opt-in per origin and bounded', () => {
  assert.equal(getCloudflareRecoveryRule(origin,{}),null);
  const config = {cloudflareRecoveryRules:{[origin]:{waitMs:999999,maxClicks:10,frameStableMs:1,settleMs:1}}};
  assert.deepEqual(getCloudflareRecoveryRule(origin,config),{waitMs:60000,maxClicks:3,frameStableMs:3000,settleMs:2000});
  assert.equal(getCloudflareRecoveryRule('https://unrelated.example',config),null);
});

test('configured managed CF timeout does not refresh or resubmit the challenge page', async () => {
  const page = {url:()=>origin+'/attendance.php',title:async()=>'',
    evaluate:async()=>({bodyText:'Just a moment',passwordInputs:false,challengeEvidence:[],confirmedCheckinControl:false}),
    reload:async()=>assert.fail('the challenge document must not be reloaded')};
  const result = await waitForManagedChallenge(page,{cloudflareRecoveryRules:{[origin]:{waitMs:1000}},
    cloudflareWaitMs:0,checkinStateWaitMs:10});
  assert.equal(result.failureCode,'cloudflare_verification_unresolved');
  assert.equal(result.retryable,false);
  assert.equal(result.manualBrowserMode,'native');
});

test('native CF handoff survives all selection modes and overrides a same-page Playwright rule', () => {
  const latest = {runId:'20261007-120000',results:[{origin,...{status:'interactive_challenge',retryable:false,manualBrowserMode:'native'}}]};
  const plan = {targets:[{origin,candidates:[origin+'/']}]};
  const config = {samePageManualCheckinRules:{[origin]:{expectedPath:'/',widgetSelector:'.widget',responseSelector:'.response',actionName:'签到'}}};
  for (const selection of [{},{requestedOrigins:[origin]},{handoffOrigins:[origin]},{selection:[1]}]) {
    const handoff = buildAttentionHandoff({plan,latest,...selection});
    assert.equal(handoff.targets[0].manualBrowserMode,'native');
    assert.equal(selectSamePageManualTarget(handoff,config),null);
  }
});

test('PT magic check-in label selects only its visible enabled same-origin entry', async () => {
  const base = {index:0,text:'签到得魔力',visible:true,disabled:false,tagName:'A',href:origin+'/attendance.php',formAction:null};
  const discover = values => waitForCheckinAction({url:()=>origin+'/',locator:()=>({evaluateAll:async()=>values})},
    [origin],{checkinActionDiscoveryWaitMs:0});
  assert.equal((await discover([base])).href,base.href);
  assert.equal(await discover([{...base,disabled:true}]),null);
  assert.equal(await discover([{...base,href:'https://outside.example/attendance.php'}]),null);
  assert.equal(await discover([{...base,text:'签到得魔力规则'}]),null);
});
