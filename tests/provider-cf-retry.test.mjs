import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {linuxDoProbeFailureStage} from '../src/oauth-provider-session.mjs';
import {loginHelperOutcomeFromStreams} from '../src/login-recovery.mjs';
import {
  aggregateReauthResults, reauthLoginFailureResult, runProviderOnlyWithRetry,
  shouldRetryOAuthFailureStage,
} from '../src/reauth-checkin.mjs';
import {isResumeRetryEligible} from '../src/retry-policy.mjs';
import {requiresManualAttention} from '../src/attention-urls.mjs';

test('provider probe distinguishes unresolved CF and rate limits from ordinary session failures', () => {
  assert.equal(linuxDoProbeFailureStage({status:'unknown',challengeObserved:true}), 'linuxdo_session_challenge');
  assert.equal(linuxDoProbeFailureStage({status:'unknown',challengeObserved:true,rateLimited:true}), 'linuxdo_session_rate_limited');
  for (const result of [undefined, {status:'unknown'}, {status:'unknown',challengeObserved:'true'},
    {status:'invalid'}, {status:'invalid',challengeObserved:true}]) {
    assert.equal(linuxDoProbeFailureStage(result), 'linuxdo_session');
  }
  assert.equal(linuxDoProbeFailureStage({status:'valid',challengeObserved:true,rateLimited:true}), null);
});

for (const stage of ['linuxdo_session_challenge','linuxdo_session_rate_limited']) {
  test(`${stage} survives private helper streams without leaking payloads`, () => {
    const result=loginHelperOutcomeFromStreams(
      JSON.stringify({status:'needs_attention',oauthStage:stage,private:'do-not-copy'}),
      JSON.stringify({oauthStage:'linuxdo_session',private:'do-not-copy'}),
    );
    assert.equal(result.succeeded,false);
    assert.equal(result.oauthStage,stage);
    assert.equal(JSON.stringify(result).includes('do-not-copy'),false);
    assert.equal(shouldRetryOAuthFailureStage(stage),false);
  });

  test(`${stage} stops outer OAuth retries and native refresh after one settled helper`, async () => {
    let calls=0, refreshes=0;
    const outcome=await runProviderOnlyWithRetry({provider:'LinuxDO'}, {}, {oauthAttempts:3}, {
      runHelper:async (_rule,_config,_account,args)=>{
        assert.deepEqual(args,['--provider-only']);calls++;
        return {succeeded:false,oauthStage:stage};
      },
      refreshSession:async()=>{refreshes++;return true;},
    });
    assert.equal(calls,1);
    assert.equal(refreshes,0);
    assert.deepEqual(outcome,{succeeded:false,oauthStage:stage});
  });
}

test('ordinary session uncertainty retains bounded retries and one native refresh', async () => {
  const calls=[];let refreshes=0;
  const outcome=await runProviderOnlyWithRetry({provider:'LinuxDO'}, {}, {
    oauthAttempts:2,oauthRetryDelayMs:500,
  }, {
    runHelper:async (_rule,_config,_account,args)=>{
      calls.push(args);
      return calls.length===3 ? {succeeded:true,oauthStage:'completed'}
        : {succeeded:false,oauthStage:'linuxdo_session'};
    },
    refreshSession:async()=>{refreshes++;return true;},
  });
  assert.equal(outcome.succeeded,true);
  assert.equal(calls.length,3);
  assert.equal(refreshes,1);
  assert.deepEqual(calls[2],['--provider-only','--diagnostic-stage','automatic_provider_after_refresh']);
});

test('valid provider session proceeds without native refresh', async () => {
  const result=await runProviderOnlyWithRetry({provider:'LinuxDO'}, {}, {oauthAttempts:3}, {
    runHelper:async()=>({succeeded:true,oauthStage:'completed'}),
    refreshSession:async()=>{assert.fail('Do not refresh a confirmed provider session');},
  });
  assert.equal(result.succeeded,true);
});

test('non-retryable provider blockers remain in manual attention and preserve completed siblings', () => {
  const origin='https://reauth.example';
  const failed=reauthLoginFailureResult('LinuxDO','linuxdo_session_challenge',{beforeLogout:true});
  assert.equal(failed.retryable,false);
  assert.equal(failed.failureCode,'oauth_linuxdo_session_challenge');
  assert.match(failed.reason,/CF 真人验证阻塞/);
  assert.match(failed.reason,/登录状态尚未确认/);
  assert.match(failed.reason,/未退出 Agent Router/);
  const parent={origin,...aggregateReauthResults([
    {accountKey:'github',status:'already_signed'},
    {accountKey:'linuxdo',...failed},
  ])};
  assert.equal(parent.retryable,false);
  assert.equal(parent.accountResults[0].status,'already_signed');
  assert.equal(isResumeRetryEligible(parent,new Set([origin])),false);
  assert.equal(requiresManualAttention(parent),true);
  assert.equal(Object.hasOwn(reauthLoginFailureResult('LinuxDO','linuxdo_session'),'retryable'),false);
  assert.equal(Object.hasOwn(aggregateReauthResults([
    {accountKey:'github',status:'needs_attention'},
    {accountKey:'linuxdo',...failed},
  ]),'retryable'),false);
});

test('OAuth wiring preserves the settled provider stage and manual-only result before target logout', async () => {
  const oauth=await fs.readFile(new URL('../src/oauth-login.mjs',import.meta.url),'utf8');
  const reauth=await fs.readFile(new URL('../src/reauth-checkin.mjs',import.meta.url),'utf8');
  assert.match(oauth,/linuxDoProbeFailureStage\(result\);\s*if \(failureStage\) setOAuthStage\(failureStage\)/);
  assert.match(reauth,/if \(!providerRecovery\.succeeded\) \{\s*return reauthLoginFailureResult\(rule\.provider, providerRecovery\.oauthStage, \{ beforeLogout: true \}\)/);
});
