import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  isGitHubInteractiveVerificationUrl,
  isGitHubLoginUrl,
  restoreSavedGitHubLogin,
} from "../src/github-saved-login.mjs";
import { loginHelperOutcomeFromStreams } from '../src/login-recovery.mjs';
import { reauthLoginFailureReason, shouldRetryOAuthFailureStage } from '../src/reauth-checkin.mjs';

test("GitHub 保存登录只接受官方 HTTPS 登录页", () => {
  assert.equal(isGitHubLoginUrl("https://github.com/login?return_to=%2Flogin%2Foauth%2Fauthorize"), true);
  assert.equal(isGitHubLoginUrl("http://github.com/login"), false);
  assert.equal(isGitHubLoginUrl("https://github.example/login"), false);
  assert.equal(isGitHubLoginUrl("https://github.com/login/oauth/authorize?client_id=fixture"), false);
  assert.equal(isGitHubLoginUrl("https://github.com/login/device"), false);
});

function loginFixture({ filled=true, formCount=1, submitCount=1, chooser=false, destination='https://github.com/login/oauth/authorize', verification=false }={}) {
  let url='https://github.com/login';
  let clicks=0;
  const collection=(count, first)=>({count:async()=>count,first:()=>first});
  const field={evaluate:async fn=>fn({value:filled ? 'fixture' : ''}),click:async()=>{},press:async()=>{}};
  const submit={click:async()=>{clicks++;url=destination;}};
  const form={locator:()=>collection(submitCount,submit)};
  const forms={...collection(formCount,form),filter:()=>forms};
  const page={
    url:()=>url,isClosed:()=>false,waitForTimeout:async()=>{},waitForLoadState:async()=>{},
    locator:selector=>{
      if(selector==='form')return forms;
      if(selector.startsWith('#login_field')||selector.startsWith('#password'))return collection(1,field);
      if(selector.includes('switch_account'))return collection(chooser ? 1 : 0);
      if(selector.includes('one-time-code'))return {count:async()=>verification && clicks>0 ? 1 : 0};
      // Three submit controls exist globally, but only one belongs to password login.
      if(selector.includes('[type="submit"]'))return collection(3,submit);
      throw new Error('Unexpected fixture selector');
    },
  };
  return {page,clicks:()=>clicks};
}

test('GitHub password login ignores submit buttons outside its own form',async()=>{
  const f=loginFixture();const state={attempted:false};
  assert.equal(await restoreSavedGitHubLogin(f.page,state),true);
  assert.equal(f.clicks(),1);assert.equal(state.failureStage,null);
});

test('GitHub failure stages survive helper parsing and stop futile account retries',async()=>{
  for(const [options,stage] of [
    [{filled:false},'github_autofill_missing'],
    [{chooser:true},'github_account_selection'],
    [{formCount:2},'github_form_not_unique'],
    [{submitCount:2},'github_submit_not_unique'],
    [{destination:'https://github.com/login'},'github_login_not_completed'],
    [{destination:'https://github.com/sessions/two-factor/app'},'github_interactive_verification'],
    [{verification:true},'github_interactive_verification'],
  ]){
    const f=loginFixture(options),state={attempted:false};
    assert.equal(await restoreSavedGitHubLogin(f.page,state),false,stage);
    assert.equal(state.failureStage,stage);
    const outcome=loginHelperOutcomeFromStreams(JSON.stringify({status:'needs_attention',oauthStage:stage}));
    assert.equal(outcome.oauthStage,stage);
    assert.equal(shouldRetryOAuthFailureStage(stage),false);
    assert.match(reauthLoginFailureReason('GitHub',stage),/GitHub/);
    if(['github_autofill_missing','github_account_selection','github_form_not_unique','github_submit_not_unique'].includes(stage))assert.equal(f.clicks(),0);
  }
});

test("GitHub 二次验证和 Passkey 页面必须人工处理", () => {
  for (const url of [
    "https://github.com/sessions/two-factor/app",
    "https://github.com/sessions/verified-device",
    "https://github.com/login/device",
    "https://github.com/passkeys/1",
  ]) {
    assert.equal(isGitHubInteractiveVerificationUrl(url), true, url);
  }
  assert.equal(isGitHubInteractiveVerificationUrl("https://github.com/login/oauth/authorize"), false);
});

test("GitHub 恢复器只读取字段是否填充且拒绝账号选择界面", async () => {
  const source = await fs.readFile(new URL("../src/github-saved-login.mjs", import.meta.url), "utf8");
  assert.match(source, /Boolean\(element\.value\)/);
  assert.doesNotMatch(source, /inputValue\(|console\.(?:log|error)|process\.(?:stdout|stderr)/);
  assert.match(source, /accountChooser/);
  assert.match(source, /one-time-code/);
  assert.match(source, /data-webauthn/);
});
