import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { siteMigrationResult, unapprovedBookmarkRedirect, inspectSiteMigrationPage } from '../src/site-migration.mjs';
import { classifyPageText } from '../src/detector.mjs';
import { buildAttentionHandoff, requiresManualAttention, canExplicitlyRequestManualAttention } from '../src/attention-urls.mjs';
import { powershellExecutable } from './helpers/powershell.mjs';
import { processCandidate } from '../src/browser.mjs';

const origin = 'https://old.example';
const target = {origin,candidates:[`${origin}/personal`],allowedOrigins:[origin]};
const migrated = siteMigrationResult({title:'站点已迁移 - Example',url:`${origin}/personal`,
  destinationOrigins:['https://new.example/private?token=secret','https://new.example/v1']});

test('dedicated migration pages remain unresolved and retain only a destination origin', () => {
  assert.equal(migrated.status,'needs_attention');
  assert.equal(migrated.failureCode,'site_migration');
  assert.equal(migrated.retryable,false);
  assert.deepEqual(migrated.migration,{destinationOrigin:'https://new.example'});
  assert.doesNotMatch(JSON.stringify(migrated),/secret|private|token=|personal/);
  assert.equal(classifyPageText({title:'站点已迁移',url:`${origin}/login`,bodyText:'今日已签到'}).failureCode,'site_migration');
  assert.equal(siteMigrationResult({title:'Notice',bodyText:'本站已迁移。将在数秒后自动跳转到新地址。'}).failureCode,'site_migration');
  assert.equal(siteMigrationResult({title:'This site has moved'}).failureCode,'site_migration');
});

test('historical notices inside a working console do not hide daily check-in or ordinary login', () => {
  for (const bodyText of ['账户概览 公告：本站已迁移到新域名。立即签到',
    `帮助文档 ${'历史公告 '.repeat(500)} 本站已迁移，前往新地址。`, '明天计划迁移至新域名']) {
    assert.equal(siteMigrationResult({title:'Console',bodyText}),null);
  }
  assert.equal(classifyPageText({title:'Login',url:`${origin}/login`,hasPassword:true}).status,'login_required');
  assert.equal(classifyPageText({title:'Console',bodyText:'今日已签到'}).status,'already_signed');
});

test('an unexpected final origin is blocked while configured related origins remain allowed', () => {
  const blocked = unapprovedBookmarkRedirect('https://new.example/callback?code=private',target);
  assert.equal(blocked.failureCode,'bookmark_origin_changed');
  assert.deepEqual(blocked.migration,{destinationOrigin:'https://new.example'});
  assert.doesNotMatch(JSON.stringify(blocked),/callback|code=|private/);
  assert.equal(unapprovedBookmarkRedirect(`${origin}/other`,target),null);
  assert.equal(unapprovedBookmarkRedirect('https://related.example/profile',
    {...target,allowedOrigins:[origin,'https://related.example']}),null);
});

test('migration and unexpected redirects cannot open automatic or explicit login handoffs, but can be abandoned', () => {
  for (const result of [migrated,unapprovedBookmarkRedirect('https://new.example',target)]) {
    const latest = {results:[{...result,origin}]};
    const plan = {targets:[target]};
    assert.equal(requiresManualAttention(result),false);
    assert.equal(canExplicitlyRequestManualAttention(result),false);
    assert.deepEqual(buildAttentionHandoff({plan,latest,handoffOrigins:[origin]}).targets,[]);
    assert.throws(()=>buildAttentionHandoff({plan,latest,requestedOrigins:[origin]}),/核对并更新收藏地址/);
    assert.equal(buildAttentionHandoff({plan,latest,requestedOrigins:[origin],forAbandonment:true}).targets.length,1);
  }
  assert.equal(requiresManualAttention({status:'login_required'}),true);
});

test('PowerShell handoff applies the same migration exclusion without suppressing ordinary login', async () => {
  const helper = fileURLToPath(new URL('../scripts/ManualVerification.ps1',import.meta.url));
  const command = `. '${helper.replaceAll("'","''")}'; @('site_migration','bookmark_origin_changed','login_recovery_requires_manual') | ForEach-Object { Test-ManualVerificationHandoffResult ([pscustomobject]@{status='needs_attention';failureCode=$_}) } | ConvertTo-Json -Compress`;
  const {stdout} = await promisify(execFile)(powershellExecutable,['-NoProfile','-NonInteractive','-Command',command],{timeout:15000});
  assert.deepEqual(JSON.parse(stdout),[false,false,true]);
});

test('offline Edge detects a countdown migration before any check-in action and recognizes an actual external redirect', {
  skip:process.env.CHECKIN_BROWSER_FIXTURES!=='1',timeout:30000,
},async t=>{
  const {chromium} = createRequire(import.meta.url)('playwright-core');
  const browser = await chromium.launch({channel:'msedge',headless:true});
  t.after(()=>browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  await context.route('https://**/*',async route=>{
    const url=new URL(route.request().url());
    const body=url.origin===origin
      ? '<title>站点已迁移 - Example</title><h1>站点已迁移</h1><a href="https://new.example">前往新地址</a><button onclick="window.actions++">立即签到</button><script>window.actions=0;setTimeout(()=>location.href="https://new.example",1000)</script>'
      : '<title>New site login</title><input type="password">';
    await route.fulfill({status:200,contentType:'text/html; charset=utf-8',body});
  });
  for (const checkinReadOnly of [false,true]) {
    const result=await processCandidate(page,target,`${origin}/personal`,{navigationTimeoutMs:5000,checkinReadOnly},{});
    assert.equal(result.failureCode,'site_migration');
    assert.equal(await page.evaluate(()=>window.actions),0);
  }
  await page.waitForURL('https://new.example/');
  assert.equal((await inspectSiteMigrationPage(page,target)).failureCode,'bookmark_origin_changed');
});

test('navigation timeouts retain observed foreign origins while ordinary load failures remain errors', async () => {
  for (const currentUrl of ['https://new.example/slow','about:blank',`${origin}/personal`]) {
    const error = new Error('navigation timeout');
    const page = {url:()=>currentUrl,goto:async()=>{throw error;}};
    if (currentUrl.startsWith('https://new.example')) {
      assert.equal((await processCandidate(page,target,`${origin}/personal`,{},{})).failureCode,'bookmark_origin_changed');
    } else {
      await assert.rejects(processCandidate(page,target,`${origin}/personal`,{},{}),e=>e===error);
    }
  }
});
