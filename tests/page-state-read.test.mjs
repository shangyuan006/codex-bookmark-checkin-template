import test from 'node:test';
import assert from 'node:assert/strict';
import {readAfterNavigation} from '../src/page-state-read.mjs';
import {waitForConfirmedCheckinState} from '../src/browser.mjs';

function fixture(){
  let url='https://checkin.example/verify';let waits=0;
  return {page:{url:()=>url,isClosed:()=>false,waitForLoadState:async()=>{waits++;}},move:value=>{url=value;},waits:()=>waits};
}

test('navigation destroys state context once, then confirmed state is reread without an action',async()=>{
  const f=fixture();let reads=0;
  f.page.title=async()=> 'Check-in';
  f.page.evaluate=async()=>{
    if(reads++===0){f.move('https://checkin.example/done');throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation');}
    return {bodyText:'今日已签到',passwordInputs:false,challengeEvidence:[]};
  };
  const result=await waitForConfirmedCheckinState(f.page,{checkinStatePollMs:5},1000);
  assert.equal(result.status,'already_signed');assert.equal(reads,2);assert.equal(f.waits(),1);
});

test('title navigation discards an old success snapshot and reads the new login page',async()=>{
  const f=fixture();let reads=0;
  f.page.evaluate=async()=>({bodyText:reads++===0 ? '今日已签到' : '请先登录',passwordInputs:reads>1,challengeEvidence:[]});
  f.page.title=async()=>{if(reads===1)throw new Error('Execution context was destroyed');return '登录';};
  const result=await waitForConfirmedCheckinState(f.page,{checkinStatePollMs:5},10);
  assert.equal(result.status,'login_required');assert.equal(reads,2);
});

test('read recovery is bounded and never swallows unrelated failures or closed pages',async()=>{
  const f=fixture();let reads=0;
  await assert.rejects(readAfterNavigation(f.page,async()=>{reads++;throw new Error('Execution context was destroyed');},{retryDelayMs:0}),/destroyed/);
  assert.equal(reads,3);assert.equal(f.waits(),2);
  reads=0;
  await assert.rejects(readAfterNavigation(f.page,async()=>{reads++;throw new Error('Permission denied');}),/Permission denied/);
  assert.equal(reads,1);
  f.page.isClosed=()=>true;
  await assert.rejects(readAfterNavigation(f.page,async()=>{throw new Error('unexpected read');}),/Page closed/);
});

test('read recovery rejects cross-origin redirects even when the old read reported success',async()=>{
  const f=fixture();
  await assert.rejects(readAfterNavigation(f.page,async()=>{f.move('https://outside.example/');return {status:'signed'};}));
});
