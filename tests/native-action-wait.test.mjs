import test from 'node:test';
import assert from 'node:assert/strict';
import {waitForNativeCheckinAction} from '../src/native-checkin-action.mjs';
import {classifyPageText} from '../src/detector.mjs';
import {configuredNoCheckinResult,isTerminalResult} from '../src/result-contract.mjs';
import {processTarget} from '../src/browser.mjs';
const origin='https://one.example';

test('native action waits for a delayed homepage link, clicks once and does not navigate directly',async()=>{
  let time=0,clicks=0;
  const page={url:()=>origin+'/',waitForTimeout:async ms=>{time+=ms;}};
  const result=await waitForNativeCheckinAction(page,origin,{}, {
    now:()=>time,timeoutMs:3000,readState:async()=>({status:time<500?'managed_challenge':'ready'}),prepare:async()=>{},
    click:async()=>{if(time<1000)return {clicked:false,outcome:'action_not_found'};clicks++;return {clicked:true,outcome:'clicked'};},
  });
  assert.equal(clicks,1);assert.equal(time,1000);assert.equal(result.clicked,true);
});
test('missing and ambiguous links do not cause a guessed navigation or repeated clicks',async()=>{
  for(const outcome of ['action_not_found','action_not_unique']){
    let time=0,attempts=0;
    const page={url:()=>origin+'/',waitForTimeout:async ms=>{time+=ms;}};
    const result=await waitForNativeCheckinAction(page,origin,{}, {
      now:()=>time,timeoutMs:500,readState:async()=>({status:'ready'}),prepare:async()=>{},
      click:async()=>{attempts++;return {clicked:false,outcome};},
    });
    assert.equal(result.clicked,false);assert.equal(result.outcome,outcome);
    assert.equal(outcome==='action_not_unique'?attempts:time,outcome==='action_not_unique'?1:500);
  }
});
test('SafeLine client rejection is an interactive challenge, never ready or signed',async()=>{
  const state=classifyPageText({url:origin+'/attendance.php',bodyText:'安全检测能力由 雷池 WAF 驱动 确认 客户端异常，请确认您是合法用户'});
  assert.equal(state.status,'interactive_challenge');
  const result=await waitForNativeCheckinAction({url:()=>origin+'/'},origin,{}, {
    timeoutMs:5000,readState:async()=>state,click:async()=>{throw new Error('must not click');},
  });
  assert.equal(result.clicked,false);
});
test('known closed features produce authoritative results without creating a browser page',async()=>{
  const target={origin,title:'Example',folderNames:['test']};
  const config={knownNoCheckinFeatureOrigins:[origin]};
  const result=await processTarget(null,target,config,[],null);
  assert.equal(result.status,'not_available');assert.equal(isTerminalResult(result),true);
  assert.equal(configuredNoCheckinResult(target,{}),null);
});
