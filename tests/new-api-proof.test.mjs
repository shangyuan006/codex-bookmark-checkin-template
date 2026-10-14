import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { runNewApiProtocol } from '../src/new-api-protocol.mjs';
import { newApiCheckinOptions } from '../src/new-api-policy.mjs';

const now = new Date('2026-10-13T04:00Z'), date = '2026-10-13';
const reply = data => ({ httpStatus:200, body:{success:true,data} });
const self = id => reply({id});
const record = {checkin_date:date,user_id:'12345',quota_awarded:67890};
const state = (checked, records) => reply({stats:{checked_in_today:checked,...(records === undefined ? {} : {records})}});
async function protocol(responses, options={}) {
  const calls=[];
  const result = await runNewApiProtocol({ clock:()=>now, wait:async()=>{}, ...options,
    request:async(path,method,id)=>{calls.push({path,method,id});const response=responses.shift();if(response instanceof Error)throw response;return response;} });
  return {result,calls};
}

test('New API rejects expected-account mismatch before a submission',async()=>{
  const {result,calls}=await protocol([self('54321')],{expectedAccountId:'12345'});
  assert.equal(result.failureCode,'account_mismatch');assert.equal(result.retryable,false);
  assert.equal(calls.length,1);assert.doesNotMatch(JSON.stringify(result),/12345|54321/);
});

test('New API requires exactly one dated, account-consistent record with a finite reward',async()=>{
  const badRecords=[[],[record,record],[{...record,checkin_date:'2026-10-12'}],
    [{...record,user_id:'54321'}],[{...record,quota_awarded:-1}],[{...record,quota_awarded:null}],
    [{...record,quota_awarded:''}],[{...record,quota_awarded:'Infinity'}],{}];
  for(const records of badRecords) {
    const {result,calls}=await protocol([self('12345'),state(true,records)]);
    assert.equal(result.status,'unconfirmed');assert.equal(result.retryable,false);
    assert.equal(calls.filter(c=>c.method==='POST').length,0);
  }
  const {result}=await protocol([self('12345'),state(true,[record]),self('12345')]);
  assert.equal(result.status,'already_signed');assert.equal(result.evidence.calendarVerified,true);
  assert.doesNotMatch(JSON.stringify(result),/12345|67890/);
});

test('boolean-only APIs retain compatibility while strict calendar mode blocks unsupported proof',async()=>{
  assert.equal((await protocol([self('12345'),state(true),self('12345')])).result.status,'already_signed');
  for(const checked of [true,false]) {
    const {result,calls}=await protocol([self('12345'),state(checked)],{requireCalendarRecord:true});
    assert.equal(result.status,'unconfirmed');assert.equal(calls.filter(c=>c.method==='POST').length,0);
  }
});

test('account drift invalidates both signed and unsigned observations',async()=>{
  for(const checked of [true,false]) {
    const {result,calls}=await protocol([self('12345'),state(checked,checked?[record]:[]),self('54321')],{readOnly:true});
    assert.equal(result.status,'unconfirmed');assert.equal(calls.filter(c=>c.method==='POST').length,0);
  }
});

test('a lost POST response can be confirmed by readback without sending another POST',async()=>{
  let began=0;
  const {result,calls}=await protocol([self('12345'),state(false,[]),new Error('fixture transport loss'),
    state(true,[record]),self('12345')],{beforeSubmit:async()=>{began++;}});
  assert.equal(result.status,'already_signed');assert.equal(began,1);
  assert.equal(calls.filter(c=>c.method==='POST').length,1);
});

test('POST success and switched-account readbacks never confirm or repeat submission',async()=>{
  const responses=[self('12345'),state(false,[]),reply({})];
  for(let i=0;i<4;i++) responses.push(state(true,[record]),self('54321'));
  const {result,calls}=await protocol(responses);
  assert.equal(result.submissionAttempted,true);assert.equal(result.failureCode,'api_submission_unconfirmed');
  assert.equal(calls.filter(c=>c.method==='POST').length,1);
});

test('cycle rollover during durable intent creation prevents POST and rejects that unused intent',async()=>{
  let at=now,rejected;
  const {result,calls}=await protocol([self('12345'),state(false,[])],{
    cycleEndAt:'2026-10-13T04:00:01Z',clock:()=>at,
    beforeSubmit:async()=>{at=new Date('2026-10-13T04:00:01Z');},rejectSubmission:async code=>{rejected=code;},
  });
  assert.equal(result.failureCode,'site_cycle_expired');assert.equal(rejected,'site_cycle_expired');
  assert.equal(calls.filter(c=>c.method==='POST').length,0);
});

test('strict browser proof cannot fall back to page text when the identity endpoint is unavailable',async()=>{
  const context = vm.createContext({ Date,Intl,AbortSignal,setTimeout,
    document:{querySelectorAll:()=>[{innerText:'已签到',getBoundingClientRect:()=>({width:100,height:30})}]},
    getComputedStyle:()=>({display:'block',visibility:'visible'}),
    fetch:async()=>({status:401,json:async()=>({})}) });
  const serialized=`(${runNewApiProtocol.toString()})`;
  const legacy=await vm.runInContext(`${serialized}()`,context);
  assert.equal(legacy.status,'already_signed');
  const strict=await vm.runInContext(`${serialized}({requireCalendarRecord:true})`,context);
  assert.equal(strict.status,'login_required');
});

test('private New API policy derives business date from the configured site cycle and hides invalid values',()=>{
  const target={origin:'https://api.example'},config={siteCycleRules:{[target.origin]:{resetAt:'13:00'}}};
  assert.equal(newApiCheckinOptions(target,config,now).checkinDate,'2026-10-12');
  for(const rule of [{expectedAccountId:'private-bad-id'},{expectedAccountId:Number.MAX_SAFE_INTEGER+1},{requireCalendarRecord:'yes'},{unknown:true}]) {
    assert.throws(()=>newApiCheckinOptions(target,{newApiAccountRules:{[target.origin]:rule}},now),error=>!error.message.includes('private-bad-id'));
  }
});

test('legacy nested-storage and visible-page IDs remain untrusted hints until the self endpoint confirms',async()=>{
  for(const storage of [true,false]) {
    const calls=[];
    const context=vm.createContext({Date,Intl,AbortSignal,setTimeout,
      localStorage:storage?{length:1,key:()=> 'user',getItem:()=>JSON.stringify({data:{user:{id:'12345'}}})}:undefined,
      document:{body:{innerText:'用户 ID: 12345'}},
      fetch:async(path,options)=>{calls.push(options.headers);const authorized=options.headers['New-Api-User']==='12345';
        return {status:authorized?200:401,json:async()=>path==='/api/user/self'?self('12345').body:state(true,[record]).body};},
    });
    const result=await vm.runInContext(`(${runNewApiProtocol.toString()})({readOnly:true,clock:()=>new Date('2026-10-13T04:00Z')})`,context);
    assert.equal(result.status,'already_signed');assert.equal(calls.length,3);
    assert.equal(result.evidence.accountVerified,true);assert.doesNotMatch(JSON.stringify(result),/12345|67890/);
  }
});
