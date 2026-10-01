import test from 'node:test';
import assert from 'node:assert/strict';
import {readNativeCheckinState} from '../src/native-checkin-state.mjs';
import {readCloudflareFrameEvidence} from '../src/challenge-frame-state.mjs';
import {waitForNativeCheckinAction} from '../src/native-checkin-action.mjs';

const origin='https://checkin.example';
const config={savedLoginSessionRules:{[origin]:{type:'new_api'}}};
function page(snapshot={}) {
  return {url:()=>origin+'/profile',title:async()=>'',evaluate:async()=>({
    bodyText:'每日签到 未签到 '+'.'.repeat(100),hasPassword:false,controlTexts:['立即签到'],challengeEvidence:[],...snapshot,
  })};
}
const noFrames=async()=>[];
const valid=async()=>({status:'valid'});

test('native ready state requires an explicitly configured authoritative session',async()=>{
  for(const [session,status] of [['valid','ready'],['invalid','login_required'],['unknown','unconfirmed']]) {
    const result=await readNativeCheckinState(page(),origin,config,{readFrames:noFrames,verifySession:async()=>({status:session})});
    assert.equal(result.state.status,status);
  }
});

test('invalid saved session prevents a stale visible button from being clicked',async()=>{
  const active=page();
  const result=await waitForNativeCheckinAction(active,origin,{}, {
    timeoutMs:1000,
    readState:async()=> (await readNativeCheckinState(active,origin,config,{readFrames:noFrames,verifySession:async()=>({status:'invalid'})})).state,
    click:async()=>{throw new Error('stale button must not be clicked');},
  });
  assert.equal(result.clicked,false);
});

test('an early short page waits instead of classifying missing storage as expired login',async()=>{
  let checks=0;
  const result=await readNativeCheckinState(page({bodyText:'加载中'}),origin,config,{readFrames:noFrames,verifySession:async()=>{checks++;return {status:'invalid'};}});
  assert.equal(result.state.status,'unconfirmed');assert.equal(checks,0);
});

test('login form and redirect override stale completion controls',async()=>{
  for(const active of [page({hasPassword:true,controlTexts:['今日已签到']}),{...page({controlTexts:['今日已签到']}),url:()=>origin+'/sign-in'}]) {
    const result=await readNativeCheckinState(active,origin,config,{readFrames:noFrames,verifySession:valid});
    assert.equal(result.state.status,'login_required');
  }
});

test('a frame invisible to DOM selectors is still a challenge; a response alone is not signed',async()=>{
  const frame={visible:true,challengeLike:true,resolvedState:false,responsePresent:false};
  let state=await readNativeCheckinState(page(),origin,config,{verifySession:valid,readFrames:async()=>[frame]});
  assert.equal(state.state.status,'interactive_challenge');
  state=await readNativeCheckinState(page(),origin,config,{verifySession:valid,readFrames:async()=>[{...frame,responsePresent:true}]});
  assert.equal(state.state.status,'ready');
  state=await readNativeCheckinState(page({bodyText:'.'.repeat(100),controlTexts:['今日已签到']}),origin,config,{verifySession:valid,readFrames:async()=>[{...frame,responsePresent:true}]});
  assert.equal(state.state.status,'already_signed');
});

test('a late server result must be observed after the token, never inferred from it',async()=>{
  const active=page();let completed=false;
  active.evaluate=async()=>({bodyText:'.'.repeat(100),hasPassword:false,controlTexts:completed?['今日已签到']:['立即签到'],challengeEvidence:[]});
  const deps={verifySession:valid,readFrames:async()=>[{visible:true,challengeLike:true,resolvedState:false,responsePresent:true}]};
  assert.equal((await readNativeCheckinState(active,origin,config,deps)).state.status,'ready');
  completed=true;
  assert.equal((await readNativeCheckinState(active,origin,config,deps)).state.status,'already_signed');
});

test('resolved Cloudflare evidence never resolves an unrelated captcha',async()=>{
  const result=await readNativeCheckinState(page({challengeEvidence:[{visible:true,cloudflare:false,resolvedState:false,responsePresent:false}]}),origin,config,
    {verifySession:valid,readFrames:async()=>[{visible:true,challengeLike:true,resolvedState:false,responsePresent:true}]});
  assert.equal(result.state.status,'interactive_challenge');
});

test('origins without session configuration retain existing behavior',async()=>{
  const result=await readNativeCheckinState(page(),origin,{}, {readFrames:noFrames,verifySession:async()=>null});
  assert.equal(result.state.status,'ready');
});

function frame(url,{visible=true,checked=false,detached=false}={}) {
  return {url:()=>url,frameElement:async()=>{
    if(detached)throw new Error('detached');
    return {isVisible:async()=>visible,boundingBox:async()=>({x:1,y:1,width:300,height:65})};
  },evaluate:async()=>checked};
}

test('frame evidence permits only visible HTTPS Cloudflare frames and contains no token value',async()=>{
  const active={frames:()=>[
    frame('https://challenges.cloudflare.com/widget'),
    frame('https://challenges.cloudflare.com/hidden',{visible:false}),
    frame('http://challenges.cloudflare.com/widget'),
    frame('https://challenges.cloudflare.com.evil.example/widget'),
    frame('https://challenges.cloudflare.com/stale',{detached:true}),
  ],evaluate:async()=>true};
  assert.deepEqual(await readCloudflareFrameEvidence(active,origin),[{visible:true,challengeLike:true,resolvedState:false,responsePresent:true}]);
});

test('one response cannot resolve multiple Cloudflare frames',async()=>{
  const result=await readCloudflareFrameEvidence({frames:()=>[frame('https://challenges.cloudflare.com/a'),frame('https://challenges.cloudflare.com/b')],evaluate:async()=>true},origin);
  assert.equal(result.length,2);assert.equal(result.some(item=>item.responsePresent),false);
});
