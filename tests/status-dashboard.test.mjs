import test from 'node:test';
import assert from 'node:assert/strict';
import {statusPageModel, renderStatusPage} from '../src/status-dashboard.mjs';

const origin='https://skip.example';
const report={runId:'20260930-120000',results:[{origin,status:'error',reason:'original network error',failureCode:'network_error',nextEligibleAt:'2026-09-30T08:00:00Z'}]};
const pending={targets:[{origin}]};
const now=new Date(2026,8,30,14);
const model=(abandonment,at=now)=>statusPageModel(report,pending,{},[],abandonment,{now:at});

test('today abandonment is a display projection, removes pending/retry and keeps the source result',()=>{
  const row=model({date:'20260930',origins:[origin]}).rows[0];
  assert.equal(row.status,'abandoned');
  assert.equal(row.manual,false);
  assert.equal(row.nextRetry,'—');
  assert.equal(row.failureCode,'—');
  assert.equal(row.evidence,'user_today_skip');
  assert.equal(report.results[0].status,'error');
  assert.equal(report.results[0].reason,'original network error');
  assert.match(renderStatusPage(model({date:'20260930',origins:[origin]})),/今日跳过/);
});

test('stale, next-day, malformed and noncanonical abandonment cannot suppress an error',()=>{
  for(const state of [
    {},{date:'20260929',origins:[origin]},
    {date:'20260930',origins:[origin+'/profile']},
    {date:'20260930',origins:[['https://','fixture:fixture@','skip.example'].join('')]},
    {date:'20260930',origins:'not an array'},
  ]) {
    const row=model(state).rows[0];
    assert.equal(row.status,'error');assert.equal(row.manual,true);
  }
  assert.equal(model({date:'20260930',origins:[origin]},new Date(2026,9,1,10)).rows[0].status,'error');
});

test('an explicit abandonment status remains displayable without a side file',()=>{
  const result=statusPageModel({results:[{origin,status:'abandoned'}]},pending);
  assert.equal(result.rows[0].status,'abandoned');assert.equal(result.rows[0].manual,false);
});

test('authoritative success or no-feature results take precedence over an old same-day skip',()=>{
  for(const status of ['signed','already_signed','not_available']) {
    const result=statusPageModel({...report,results:[{origin,status}]},pending,{},[],{date:'20260930',origins:[origin]},{now});
    assert.equal(result.rows[0].status,status);assert.equal(result.rows[0].manual,false);
  }
});
