import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyNavigationFailure,isActiveSiteMaintenance} from '../src/site-availability.mjs';
import {classifyPageText} from '../src/detector.mjs';
import {advanceDeferredRetry,applyUpstreamGroupCircuitBreakers,withRetrySchedule,isRetryEligible,isResumeRetryEligible,deferUnresolvedLogin} from '../src/retry-policy.mjs';
import {processTarget} from '../src/browser.mjs';

test('active maintenance differs from historical notices, planned work and ordinary site content',()=>{
  for(const bodyText of ['系统维护中','服务正在维护，暂时无法访问','Service is currently under maintenance']) {
    assert.equal(isActiveSiteMaintenance({bodyText}),true);
    assert.equal(classifyPageText({url:'https://example.test/login',bodyText}).failureCode,'site_maintenance');
  }
  for(const bodyText of ['历史维护公告：系统维护中','历史维护公告\n系统维护中','系统维护完成，恢复正常','计划明日系统维护中','安全设置：开启 2FA','签到服务维护完成后将另行通知']) {
    assert.equal(isActiveSiteMaintenance({bodyText}),false);
    assert.notEqual(classifyPageText({bodyText}).failureCode,'two_factor_required');
  }
  assert.equal(classifyPageText({bodyText:'系统维护中',confirmedCheckinControl:true}).status,'already_signed');
  assert.equal(classifyPageText({bodyText:'系统维护中',challengeSelectors:true}).status,'interactive_challenge');
});

test('2FA gates are classified before login routes without treating login CAPTCHA or setup copy as a gate',()=>{
  for(const state of [
    {url:'https://example.test/login',hasPassword:true,bodyText:'请输入二级验证代码'},
    {bodyText:'二级验证代码',hasTwoFactorControl:true},
    {bodyText:'2FA verification required'},
  ]) {
    const result=classifyPageText(state);
    assert.equal(result.status,'needs_attention');assert.equal(result.retryableLoginRecovery,false);
    assert.equal(isResumeRetryEligible(result,new Set(['https://example.test'])),false);
  }
  for(const bodyText of ['设置中可以开启 2FA','忘记二级验证请查看帮助','2FA is available in security settings','帮助：请输入二级验证代码后继续登录']) {
    assert.equal(classifyPageText({bodyText,hasPassword:true}).status,'login_required');
  }
  const result=deferUnresolvedLogin({status:'login_required',retryableLoginRecovery:false});
  assert.equal(result.status,'needs_attention');assert.equal(isRetryEligible(result),false);
});

test('maintenance and invalid certificates skip same-day retries without postponing untouched records',()=>{
  const now=new Date('2026-10-22T00:00:00Z'),config={schedule:'08:05'};
  for(const failureCode of ['site_maintenance','tls_certificate_invalid']) {
    const result=advanceDeferredRetry({status:'deferred',retryCause:'upstream_unavailable',failureCode},null,config,now);
    assert.equal(result.nextEligibleAt,'2026-10-23T00:05:00.000Z');
    assert.equal(result.retryExhaustedForDay,true);assert.equal(result.lateRetryPending,false);
    assert.equal(isRetryEligible(result,now),false);
    assert.equal(isRetryEligible(result,new Date(result.nextEligibleAt)),true);
    const [untouched]=applyUpstreamGroupCircuitBreakers([result],config,new Date('2026-10-24T01:00Z'));
    assert.equal(untouched.nextEligibleAt,result.nextEligibleAt);
  }
  const handshake=withRetrySchedule({status:'deferred',failureCode:'tls_handshake_failed',retryableLoginRecovery:false},config,now);
  assert.equal(handshake.nextEligibleAt,'2026-10-22T00:30:00.000Z');
  assert.equal(isResumeRetryEligible(handshake,new Set(),new Date('2026-10-22T01:00Z')),true);
});

test('TLS errors use fixed diagnostics and stop the candidate loop before opening another page',async()=>{
  for(const code of ['ERR_CERT_DATE_INVALID','ERR_CERT_AUTHORITY_INVALID','ERR_TLS_CERT_ALTNAME_INVALID','CERT_HAS_EXPIRED','ERR_SSL_PROTOCOL_ERROR']) {
    let opened=0,closed=0;
    const context={newPage:async()=>{opened++;return {on(){},off(){},route:async()=>{},unroute:async()=>{},
      url:()=> 'about:blank',goto:async()=>{throw new Error(`net::${code} at https://private.example/?token=private`);},close:async()=>{closed++;}};}};
    const result=await processTarget(context,{origin:'https://example.test',candidates:['https://example.test/','https://example.test/profile']},
      {retryCount:2,retryDelayMs:0,navigationTimeoutMs:1000},{},'.');
    assert.equal(result.status,'deferred');assert.equal(opened,1);assert.equal(closed,1);
    assert.doesNotMatch(JSON.stringify(result),/private/);
  }
  assert.equal(classifyNavigationFailure(new Error('net::ERR_CONNECTION_TIMED_OUT')),null);
});
