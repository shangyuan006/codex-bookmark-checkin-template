import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readPageSnapshot,PAGE_CHALLENGE_SELECTOR} from '../src/page-snapshot.mjs';
import {classifyPageText} from '../src/detector.mjs';
import {waitForPendingCheckinState} from '../src/browser.mjs';
import {readNativeCheckinState} from '../src/native-checkin-state.mjs';

function snapshot(bodyText) {
  return vm.runInNewContext(`(${readPageSnapshot.toString()})(selector)`,{
    selector:PAGE_CHALLENGE_SELECTOR,
    document:{body:{innerText:bodyText},readyState:'complete',querySelectorAll:()=>[],querySelector:()=>null},
  });
}

test('full-page daily evidence survives diagnostic truncation without copying the tail',()=>{
  const result=snapshot('正文'.repeat(16000)+'\n今日已签到\nprivate-tail');
  assert.equal(result.bodyText.length,30000);assert.equal(result.confirmedDailyText,true);
  assert.doesNotMatch(JSON.stringify(result),/private-tail/);
  assert.equal(classifyPageText(result).status,'already_signed');
  assert.equal(classifyPageText({...result,challengeSelectors:true}).status,'interactive_challenge');
  assert.equal(classifyPageText({...result,hasPassword:true}).status,'login_required');
});

test('historical descriptions, titles and contradictory unsigned text cannot supply daily completion',()=>{
  for(const body of ['历史：昨日已签到','签到说明：今日已签到用户可领取奖励','累计签到成功 100 次']) {
    const result=snapshot('正文'.repeat(16000)+'\n'+body);
    assert.equal(result.confirmedDailyText,false);
    assert.notEqual(classifyPageText(result).status,'already_signed');
  }
  const result=snapshot('正文'.repeat(16000)+'\n今日已签到\n今日未签到');
  assert.equal(result.unsignedTextObserved,true);
  assert.equal(classifyPageText(result).status,'ready');
  assert.equal(classifyPageText(snapshot('正文'.repeat(16000)+'\n今日已签到\n请先登录')).status,'login_required');
});

test('offline Edge normal and native readers use the same daily and visible-gate evidence',{
  skip:process.env.CHECKIN_BROWSER_FIXTURES!=='1',timeout:30000,
},async t=>{
  const {chromium}=await import('playwright-core');
  const browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.route('**/*',route=>route.fulfill({status:200,contentType:'text/html',body:'<body>fixture</body>'}));
  const origin='https://snapshot.example';await page.goto(origin+'/profile');
  for(const [html,status] of [
    ['<div>'+ '正文'.repeat(16000) +'</div><p>今日已签到</p>','already_signed'],
    ['<div>'+ '正文'.repeat(16000) +'</div><p>今日已签到</p><p>今日未签到</p>','ready'],
    ['<p>请输入二级验证代码</p><input autocomplete="one-time-code">','needs_attention'],
    ['<p>安全设置中可以开启 2FA</p><input autocomplete="one-time-code" style="display:none">','ready'],
    ['<p>今日已签到</p><div class="cf-turnstile" style="width:300px;height:65px"></div>','interactive_challenge'],
  ]) {
    await page.setContent(html);
    assert.equal((await waitForPendingCheckinState(page,{})).status,status);
    assert.equal((await readNativeCheckinState(page,origin,{})).state.status,status);
  }
});
