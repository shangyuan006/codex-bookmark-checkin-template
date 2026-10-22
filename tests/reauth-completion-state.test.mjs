import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { persistVerifiedReauthCompletion, inspectConfiguredReauthRecovery } from '../src/reauth-checkin.mjs';

const origin = 'https://reauth.example';
const key = `${origin}::linuxdo`;
const now = new Date('2026-10-01T03:00:00Z');
const previous = {date:'20261001',status:'logged_out',updatedAt:'2026-10-01T02:00:00Z',
  loginEvidenceReset:true,logoutConfirmed:true};
const login = {valid:true,explicitLoginSuccess:true};

async function fixture(t, entry = previous) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reauth-completion-'));
  t.after(() => fs.rm(directory, {recursive:true,force:true}));
  const statePath = path.join(directory, 'state.json');
  const other = {date:'20261001',status:'completed',updatedAt:'2026-10-01T01:00:00Z'};
  await fs.writeFile(statePath, JSON.stringify({version:2,entries:{[key]:entry,[`${origin}::github`]:other}}));
  return {statePath,other};
}

test('verified read-only recovery persists completion and makes the next recovery complete', async t => {
  const {statePath,other} = await fixture(t);
  assert.equal(await persistVerifiedReauthCompletion(statePath,key,previous,login,now),true);
  const saved = JSON.parse(await fs.readFile(statePath,'utf8'));
  assert.deepEqual(saved.entries[key],{date:'20261001',status:'completed',updatedAt:now.toISOString()});
  assert.deepEqual(saved.entries[`${origin}::github`],other);
  const recovery = await inspectConfiguredReauthRecovery({origin,accountKey:'linuxdo',statePath},now);
  assert.equal(recovery.action,'complete');
  assert.doesNotMatch(JSON.stringify(saved),/quota|balance|cookie|token|password/i);
});

test('ordinary login without the explicit daily reward evidence cannot complete a checkpoint', async t => {
  const {statePath} = await fixture(t);
  const before = await fs.readFile(statePath,'utf8');
  for (const observation of [{valid:true,explicitLoginSuccess:false},{valid:false,explicitLoginSuccess:true},null]) {
    assert.equal(await persistVerifiedReauthCompletion(statePath,key,previous,observation,now),false);
  }
  assert.equal(await fs.readFile(statePath,'utf8'),before);
});

test('read-only evidence cannot complete an unverified logout, another account, or an older day', async t => {
  const {statePath} = await fixture(t);
  const before = await fs.readFile(statePath,'utf8');
  for (const entry of [{...previous,loginEvidenceReset:false},{...previous,logoutConfirmed:false},
    {...previous,date:'20260930',updatedAt:'2026-09-30T02:00:00Z'}]) {
    assert.equal(await persistVerifiedReauthCompletion(statePath,key,entry,login,now),false);
  }
  assert.equal(await persistVerifiedReauthCompletion(statePath,`${origin}::other`,previous,login,now),false);
  assert.equal(await persistVerifiedReauthCompletion(statePath,key,previous,login,new Date('2026-10-01T16:00:00Z')),false);
  assert.equal(await fs.readFile(statePath,'utf8'),before);
});

test('a newer logout checkpoint is never overwritten with evidence from the previous logout', async t => {
  const newer = {...previous,updatedAt:'2026-10-01T02:30:00Z'};
  const {statePath} = await fixture(t,newer);
  assert.equal(await persistVerifiedReauthCompletion(statePath,key,previous,login,now),false);
  assert.deepEqual(JSON.parse(await fs.readFile(statePath,'utf8')).entries[key],newer);
});
