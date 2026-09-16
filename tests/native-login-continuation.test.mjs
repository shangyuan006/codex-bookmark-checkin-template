import test from 'node:test';
import assert from 'node:assert/strict';
import {continueNativeCheckinAfterLogin} from '../src/native-login-continuation.mjs';
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
