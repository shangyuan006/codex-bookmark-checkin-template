import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ptPassiveReadPolicy,classifyPtPassiveState,readPtPassiveState } from '../src/pt-passive-read.mjs';
import { processTarget } from '../src/browser.mjs';

const target={origin:'https://pt.example',accountKey:'primary'},now=new Date('2026-10-13T04:00Z');
const rule={url:'/index.php',selector:'#daily',authenticatedSelector:'#logout',
  signedTextPattern:'{date} 已签到',unsignedTextPattern:'{date} 未签到'};
const config={ptPassiveReadRules:{[target.origin]:rule}};
const observation=text=>({authenticated:true,sectionCount:1,text});

test('PT policy rejects action URLs, redirects, cross-origin reads and undated signals before requesting',()=>{
  assert.equal(ptPassiveReadPolicy(target,{}),null);
  for(const url of ['/attendance.php','/%61ttendance.php','/%2561ttendance.php','/check-in','/index.php?action=checkin',
    'https://other.example/index.php','http://pt.example/index.php','/index.php#daily']) {
    assert.throws(()=>ptPassiveReadPolicy(target,{ptPassiveReadRules:{[target.origin]:{...rule,url}}},now));
  }
  assert.throws(()=>ptPassiveReadPolicy(target,{ptPassiveReadRules:{[target.origin]:{...rule,signedTextPattern:'已签到'}}},now));
  assert.throws(()=>ptPassiveReadPolicy(target,{ptPassiveReadRules:{[target.origin]:{...rule,signedTextPattern:'[private-pattern'}}},now),e=>!e.message.includes('private-pattern'));
});

test('PT proof requires authenticated, unique, noncontradictory current-day section',()=>{
  const signed=classifyPtPassiveState(observation('2026-10-13 已签到'),target,config,now);
  assert.equal(signed.status,'already_signed');assert.equal(signed.evidence.binding.accountKey,'primary');
  assert.equal(classifyPtPassiveState(observation('2026-10-13 未签到'),target,config,now).status,'not_signed');
  for(const input of [observation('2026-10-12 已签到'),observation('2026-10-13 已签到 2026-10-13 未签到'),
    {...observation('2026-10-13 已签到'),authenticated:false},{...observation('2026-10-13 已签到'),sectionCount:2}]) {
    assert.equal(classifyPtPassiveState(input,target,config,now).status,'unconfirmed');
  }
});

test('PT reader sends one bounded GET and disposes redirect/error responses',async()=>{
  for(const status of [302,401,429,503]) {
    let requests=0,disposed=0;
    const context={request:{fetch:async(url,options)=>{requests++;assert.equal(url,target.origin+'/index.php');
      assert.equal(options.method,'GET');assert.equal(options.maxRedirects,0);
      return {url:()=>url,status:()=>status,dispose:async()=>{disposed++;}};}}};
    const result=await readPtPassiveState(context,target,config,{now:()=>now});
    assert.equal(requests,1);assert.equal(disposed,1);assert.notEqual(result.status,'already_signed');
  }
});

test('unconfirmed PT passive result stops the normal target before any action page is opened',async()=>{
  let pages=0;
  const context={request:{fetch:async url=>({url:()=>url,status:()=>302,dispose:async()=>{}})},newPage:async()=>{pages++;throw new Error('unexpected action');}};
  const result=await processTarget(context,target,config,{},'.');
  assert.equal(result.failureCode,'pt_passive_redirect_blocked');assert.equal(pages,0);
});

test('offline Edge PT reader disables scripts, subresource traffic and credential transfer',{
  skip:process.env.CHECKIN_BROWSER_FIXTURES!=='1',timeout:30000,
},async t=>{
  const {chromium}=createRequire(import.meta.url)('playwright-core');
  const browser=await chromium.launch({channel:'msedge',headless:true});
  t.after(()=>browser.close());
  const created=[],originalNewContext=browser.newContext.bind(browser);
  browser.newContext=async options=>{created.push(options);const context=await originalNewContext(options);
    assert.deepEqual(await context.cookies(),[]);return context;};
  let reads=0,disposed=0,html='<a id="logout">退出</a><section id="daily">2026-10-13 已签到</section>';
  html+='<script>document.querySelector("#daily").textContent="2026-10-13 未签到";fetch("/attendance.php",{method:"POST"})</script>';
  html+='<img src="/attendance.php"><iframe src="https://other.example/action"></iframe><link rel="stylesheet" href="/style.css">';
  const context={browser:()=>browser,request:{fetch:async url=>{reads++;return {url:()=>url,status:()=>200,text:async()=>html,dispose:async()=>{disposed++;}};}}};
  const result=await readPtPassiveState(context,target,config,{now:()=>now});
  assert.equal(result.status,'already_signed');assert.equal(reads,1);assert.equal(disposed,1);
  assert.deepEqual(created,[{javaScriptEnabled:false,serviceWorkers:'block',acceptDownloads:false}]);
  assert.equal(browser.contexts().length,0);assert.doesNotMatch(JSON.stringify(result),/退出|2026-10-13 已签到/);
});
