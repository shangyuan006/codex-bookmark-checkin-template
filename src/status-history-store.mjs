import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteJson } from './security.mjs';
import { acquireRunLock, releaseRunLock } from './run-lock.mjs';

const countKeys = ['authoritative','user_rule','unbound','pending','unavailable','uncertain'];
function summary(value) {
  if (!/^\d{8}$/.test(value?.date ?? '') || !Number.isFinite(Date.parse(value.finishedAt ?? ''))
    || !Number.isSafeInteger(value.accounts) || value.accounts < 0 || value.accounts > 100000
    || countKeys.some(key => !Number.isSafeInteger(value.counts?.[key]) || value.counts[key] < 0 || value.counts[key] > value.accounts)
    || countKeys.filter(key=>key!=='uncertain').reduce((total,key)=>total+value.counts[key],0)!==value.accounts) {
    throw new Error('Invalid daily history summary');
  }
  return { date:value.date, finishedAt:value.finishedAt, accounts:value.accounts, complete:value.complete === true,
    counts:Object.fromEntries(countKeys.map(key => [key,value.counts[key]])) };
}
async function read(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Unsafe history summary');
  const value = JSON.parse(await fs.readFile(file,'utf8'));
  if (value?.version !== 1 || !Array.isArray(value.days) || value.days.length > 180) throw new Error('Invalid history archive');
  const days = value.days.map(summary);
  if (new Set(days.map(day => day.date)).size !== days.length) throw new Error('Duplicate history day');
  return {version:1,days};
}

export async function loadStatusHistoryArchive(root) {
  const file = path.join(root,'data/status-history.json');
  try { return {...await read(file),recovered:false,unreadable:false}; }
  catch (error) {
    try { return {...await read(`${file}.previous`),recovered:true,unreadable:true}; }
    catch { return {version:1,days:[],recovered:false,unreadable:error.code !== 'ENOENT'}; }
  }
}

// Only aggregate counters and dates enter this archive: no origins, account
// identities, page text, rewards, browser paths or credentials.
export async function recordStatusHistory(root, day) {
  const incoming = summary(day), file = path.join(root,'data/status-history.json');
  await fs.mkdir(path.dirname(file),{recursive:true});
  const lease = await acquireRunLock(`${file}.lock`);
  try {
    const prior = await loadStatusHistoryArchive(root);
    if (prior.unreadable && !prior.recovered) throw new Error('History archive is unreadable; preserve it');
    const current = prior.days.find(value => value.date === incoming.date);
    if (current && (Date.parse(current.finishedAt) > Date.parse(incoming.finishedAt)
      || current.complete && !incoming.complete)) return;
    const days = prior.days.filter(value => value.date !== incoming.date).concat(incoming)
      .sort((a,b) => b.date.localeCompare(a.date)).slice(0,180);
    if (prior.days.length) await atomicWriteJson(`${file}.previous`,{version:1,days:prior.days});
    await atomicWriteJson(file,{version:1,days});
  } finally { await releaseRunLock(lease); }
}
