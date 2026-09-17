import test from 'node:test';
import assert from 'node:assert/strict';
import {continueNativeCheckinAfterLogin} from '../src/native-login-continuation.mjs';
import {freshNativePreflightHandoffs, freshNativePreflightResults} from '../src/native-preflight-state.mjs';
import {isRetryEligible, filterAutomaticRetryOrigins} from '../src/retry-policy.mjs';
import {isTerminalResult} from '../src/result-contract.mjs';
const target={origin:'https://one.example'};
const config={nativeChallengePreflight:[{url:'https://one.example/profile',action:{actionTexts:['Check in']}}]};

test('successful login continues native check-in and requires confirmation for the same origin',async()=>{
  let ran=false;
  const result=await continueNativeCheckinAfterLogin(target,config,{succeeded:true},{
    runPreflight:async origin=>{assert.equal(origin,target.origin);ran=true;},
    readConfirmations:async()=>{assert.ok(ran);return new Map([[target.origin,{status:'signed'}]]);},
  });
  assert.equal(result.status,'signed');
  assert.equal(result.nativePreflight,true);
});
test('native login without check-in proof requires attention instead of falling back to a different session',async()=>{
  const result=await continueNativeCheckinAfterLogin(target,config,{succeeded:true},{
    runPreflight:async()=>{},readConfirmations:async()=>new Map([['https://other.example',{status:'signed'}]]),
  });
  assert.equal(result.status,'needs_attention');
});
test('passive rules, failed logins and already-confirmed helpers never trigger another native action',async()=>{
  const never=async()=>{throw new Error('unexpected execution');};
  for(const [cfg,outcome] of [[config,{succeeded:false}],[{}, {succeeded:true}],
    [{nativeChallengePreflight:[{url:'https://one.example/',passiveOnly:true}]},{succeeded:true}],
    [config,{succeeded:true,authoritativeCheckinStatus:'signed'}]]){
    assert.equal(await continueNativeCheckinAfterLogin(target,cfg,outcome,{runPreflight:never,readConfirmations:never}),null);
  }
});
test('continuation preserves a checkpoint after later failure but stops on unsafe cleanup',async()=>{
  const readConfirmations=async()=>new Map([[target.origin,{status:'already_signed'}]]);
  const result=await continueNativeCheckinAfterLogin(target,config,{succeeded:true},{
    runPreflight:async()=>{throw new Error('later failure');},readConfirmations,
  });
  assert.equal(result.status,'already_signed');
  await assert.rejects(continueNativeCheckinAfterLogin(target,config,{succeeded:true},{
    runPreflight:async()=>{throw Object.assign(new Error('cleanup failed'),{cleanupFailed:true});},readConfirmations,
  }),/cleanup failed/);
});

test('post-login SafeLine checkpoint survives a later failure and blocks automatic continuation',async()=>{
  for (const failAfterCheckpoint of [false,true]) {
    let report, writtenAttempt;
    const result=await continueNativeCheckinAfterLogin(target,config,{succeeded:true},{
      runPreflight:async(origin,attemptId)=>{
        assert.equal(origin,target.origin);
        assert.match(attemptId,/^[a-f0-9]{32}$/);
        writtenAttempt=attemptId;
        const observedAt=new Date().toISOString();
        report={generatedAt:observedAt,results:[{
          origin,status:'interactive_challenge',failureCode:'safeline_client_challenge',retryable:false,
          preflightAttemptId:attemptId,observedAt,actionAttempted:false,actionOutcome:'not_attempted',
        }]};
        if(failAfterCheckpoint) throw new Error('later failure');
      },
      readConfirmations:async attemptId=>{
        assert.equal(attemptId,writtenAttempt);
        return freshNativePreflightHandoffs(report,new Set([target.origin]),attemptId);
      },
    });
    assert.equal(result.status,'interactive_challenge');
    assert.equal(result.failureCode,'safeline_client_challenge');
    assert.equal(result.retryable,false);
    assert.equal(result.actionAttempted,false);
    assert.equal(result.actionOutcome,'not_attempted');
    assert.equal(result.nativePreflight,true);
    assert.equal(isTerminalResult(result),false);
    assert.equal(isRetryEligible(result),false);
    assert.deepEqual([...filterAutomaticRetryOrigins(new Set([target.origin]),[{...result,origin:target.origin}])],[]);
  }
});

test('post-login recovery rejects stale, future, previous-attempt and other-origin blockers',async()=>{
  const attempts=new Set();
  for(const mismatch of ['old-attempt','previous-day','future','other-origin']){
    let report;
    const result=await continueNativeCheckinAfterLogin(target,config,{succeeded:true},{
      runPreflight:async(origin,attemptId)=>{
        assert.equal(attempts.has(attemptId),false);
        attempts.add(attemptId);
        const generatedAt=new Date().toISOString();
        const observedAt=new Date(Date.now()+(mismatch==='previous-day'?-86400000:mismatch==='future'?86400000:0)).toISOString();
        report={generatedAt,results:[{
          origin:mismatch==='other-origin'?'https://other.example':origin,
          status:'interactive_challenge',failureCode:'safeline_client_challenge',retryable:false,observedAt,
          preflightAttemptId:mismatch==='old-attempt'?'0'.repeat(32):attemptId,
        }]};
      },
      readConfirmations:async attemptId=>freshNativePreflightHandoffs(report,new Set([target.origin]),attemptId),
    });
    assert.equal(result.status,'needs_attention',mismatch);
    assert.equal(result.failureCode,'native_checkin_after_login_unconfirmed');
    assert.notEqual(result.retryable,false);
  }
});

test('fresh authoritative confirmation takes precedence over a blocker in post-login recovery',async()=>{
  const result=await continueNativeCheckinAfterLogin(target,config,{succeeded:true},{
    runPreflight:async()=>{},
    readConfirmations:async attemptId=>{
      const observedAt=new Date().toISOString();
      const report={generatedAt:observedAt,results:[
        {origin:target.origin,status:'interactive_challenge',failureCode:'safeline_client_challenge',retryable:false,preflightAttemptId:attemptId,observedAt},
        {origin:target.origin,status:'already_signed',observedAt},
      ]};
      const allowed=new Set([target.origin]);
      return new Map([...freshNativePreflightHandoffs(report,allowed,attemptId),...freshNativePreflightResults(report,allowed)]);
    },
  });
  assert.equal(result.status,'already_signed');
  assert.notEqual(result.retryable,false);
  assert.equal(isTerminalResult(result),true);
});
