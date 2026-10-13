import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { atomicWriteJson } from './security.mjs';
import { acquireRunLock, releaseRunLock } from './run-lock.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const validHash = value => value===null || /^[a-f0-9]{64}$/.test(value);
const publicRoots = new Set(['src','scripts','shared','skills','docs']);
const publicFiles = new Set(['README.md','LICENSE','package.json','package-lock.json','AGENTS.md','config/defaults.json']);

export function validateReleasePath(value) {
  if (typeof value!=='string' || value!==value.trim() || value.includes('\\') || value.includes(':')
    || value.startsWith('/') || value.split('/').some(part=>!part||part==='.'||part==='..'||/[. ]$/.test(part))
    || value.split('/').some(part=>/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part))
    || /(^|\/)\.|\.local\.|\.(jsonl|db|sqlite|png|jpe?g|webp|zip|exe|dll)$/i.test(value)
    || (!publicRoots.has(value.split('/')[0])&&!publicFiles.has(value))) throw new Error('Release path is outside the public code allowlist');
  return value;
}

async function safeFile(root,relative,{missing=false}={}) {
  validateReleasePath(relative);
  const resolved = path.resolve(root);
  let current = resolved;
  const rootStat = await fs.lstat(current);
  if (rootStat.isSymbolicLink()||!rootStat.isDirectory()) throw new Error('Unsafe release root');
  for (const part of relative.split('/')) {
    current = path.join(current,part);
    const stat = await fs.lstat(current).catch(error=>{if(error.code==='ENOENT'&&missing)return null;throw error;});
    if (stat?.isSymbolicLink()) throw new Error('Release paths must not follow symlinks or junctions');
  }
  if (!current.startsWith(`${resolved}${path.sep}`)) throw new Error('Release path escaped root');
  return current;
}

async function codeBytes(root,relative,{missing=false}={}) {
  const file = await safeFile(root,relative,{missing});
  const stat = await fs.lstat(file).catch(error=>{if(error.code==='ENOENT'&&missing)return null;throw error;});
  if (!stat) return null;
  if (!stat.isFile()||stat.size>5*1024*1024) throw new Error('Unsafe code file');
  return fs.readFile(file);
}

export async function createReleaseBundle(baseline,candidate,files,bundle) {
  if (!Array.isArray(files)||files.length===0||files.length>500||new Set(files).size!==files.length) throw new Error('Invalid release file list');
  // New directory only. A failed build never overwrites a previous package.
  await fs.mkdir(bundle,{recursive:false});
  await fs.mkdir(path.join(bundle,'files'));
  const entries = [];
  for (const relative of files) {
    const before = await codeBytes(baseline,relative,{missing:true});
    const after = await codeBytes(candidate,relative);
    if (before && hash(before)===hash(after)) continue;
    const output = await safeFile(path.join(bundle,'files'),relative,{missing:true});
    await fs.mkdir(path.dirname(output),{recursive:true});
    await fs.writeFile(output,after,{flag:'wx',mode:0o600});
    entries.push({path:relative,beforeHash:before?hash(before):null,afterHash:hash(after)});
  }
  const manifest = {version:1,id:randomUUID(),createdAt:new Date().toISOString(),files:entries};
  if (!entries.length) throw new Error('Selected files have no code changes');
  await atomicWriteJson(path.join(bundle,'manifest.json'),manifest);
  return manifest;
}

async function readManifest(directory) {
  const file = path.join(directory,'manifest.json');
  const stat = await fs.lstat(file);
  if (!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024) throw new Error('Unsafe release manifest');
  const manifest = JSON.parse(await fs.readFile(file,'utf8'));
  if (manifest.version!==1||!/^[a-f0-9-]{36}$/.test(manifest.id)||!Array.isArray(manifest.files)
    || manifest.files.length===0||manifest.files.length>500||new Set(manifest.files.map(entry=>entry.path)).size!==manifest.files.length) throw new Error('Invalid release manifest');
  for (const entry of manifest.files) {
    validateReleasePath(entry.path);
    if (!validHash(entry.beforeHash)||!validHash(entry.afterHash)||entry.afterHash===null) throw new Error('Invalid release hash');
  }
  return manifest;
}

export async function previewRelease(root,bundle,{rollback=false}={}) {
  const manifest = await readManifest(bundle);
  const files = [];
  for (const entry of manifest.files) {
    const current = await codeBytes(root,entry.path,{missing:true});
    const expected = rollback ? entry.afterHash : entry.beforeHash;
    const currentHash = current?hash(current):null;
    const alreadyOriginal = rollback && currentHash===entry.beforeHash;
    if (currentHash!==expected && !alreadyOriginal) throw new Error(`Code drift: ${entry.path}`);
    const payloadHash = rollback ? entry.beforeHash : entry.afterHash;
    if (payloadHash!==null) {
      const payload = await codeBytes(path.join(bundle,'files'),entry.path);
      if (hash(payload)!==payloadHash) throw new Error(`Package hash mismatch: ${entry.path}`);
    }
    files.push({path:entry.path,operation:alreadyOriginal?'keep':rollback&&entry.beforeHash===null?'remove_created_file':current?'replace':'create',beforeHash:currentHash,afterHash:payloadHash});
  }
  return {manifest,files};
}

async function assertNoManualSession(root) {
  // Updating while a user is handing over a profile risks losing a new rule or
  // evidence. Refuse even a stale pending handoff; the operator must resolve it.
  for (const relative of ['tmp/manual-handoff.json','tmp/manual-verification.json']) {
    const document = await fs.readFile(path.join(root,relative),'utf8').then(JSON.parse).catch(error=>{
      if(error.code==='ENOENT')return {};throw error;
    });
    if (['pending','pending_verification','waiting_for_user','awaiting_user'].includes(document.state)) throw new Error('Resolve the manual handoff before updating code');
  }
}

async function acquireWrapperMutex(root) {
  if (process.platform!=='win32') return async()=>{};
  const config = await fs.readFile(path.join(root,'config/config.json'),'utf8').then(JSON.parse).catch(error=>{
    if(error.code==='ENOENT')return {};throw error;
  });
  const name = config.runMutexName ?? 'Local\\CodexBookmarkCheckinRun';
  // The helper holds the same wrapper mutex through preflight/native stages,
  // not merely the later Node lock. No string interpolation of local values.
  const code = "$m=[Threading.Mutex]::new($false,$env:CHECKIN_UPDATE_MUTEX); $owned=$false; try { try{$owned=$m.WaitOne(0)}catch [Threading.AbandonedMutexException]{$owned=$true}; if(-not $owned){exit 3}; [Console]::Out.WriteLine('READY'); [Console]::Out.Flush(); [void][Console]::In.ReadLine() } finally {if($owned){$m.ReleaseMutex()};$m.Dispose()}";
  const executable = path.join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const child = spawn(executable,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],
    {windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,CHECKIN_UPDATE_MUTEX:String(name)}});
  await new Promise((resolve,reject)=>{
    let ready = false, output = '';
    const timer = setTimeout(()=>{child.kill();reject(new Error('Update wrapper mutex timed out'));},5000);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.stdout.on('data',chunk=>{output=(output+String(chunk)).slice(-64);if(!ready&&output.includes('READY')){ready=true;clearTimeout(timer);resolve();}});
    child.once('exit',code=>{clearTimeout(timer);if(!ready)reject(new Error(`签到 wrapper 正在运行或互斥不可用 (${code})`));});
  });
  return async()=>{
    if(child.exitCode!==null)return;
    await new Promise(resolve=>{
      const timer=setTimeout(()=>{child.kill();resolve();},3000);
      child.once('exit',()=>{clearTimeout(timer);resolve();});
      child.stdin.end('\n');
    });
  };
}

export async function applyRelease(root,bundle,{rollback=false}={}) {
  const releaseWrapper = await acquireWrapperMutex(root);
  let lease;
  let backup = null;
  const changed = [];
  try {
    lease = await acquireRunLock(path.join(root,'tmp/run.lock'));
    await assertNoManualSession(root);
    const {manifest,files} = await previewRelease(root,bundle,{rollback});
    if (!rollback) {
      const backups = path.join(root,'data/code-update-backups');
      let directory = path.resolve(root);
      for (const part of ['data','code-update-backups']) {
        directory = path.join(directory,part);
        const stat = await fs.lstat(directory).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
        if (stat?.isSymbolicLink() || (stat&&!stat.isDirectory())) throw new Error('Unsafe backup directory');
        if (!stat) await fs.mkdir(directory);
      }
      const parent = await fs.realpath(backups);
      const expected = path.resolve(root,'data/code-update-backups');
      if (parent.toLowerCase()!==expected.toLowerCase()) throw new Error('Unsafe backup directory');
      backup = path.join(backups,`${Date.now()}-${manifest.id}`);
      await fs.mkdir(backup);
      await fs.mkdir(path.join(backup,'files'));
      for (const entry of manifest.files) if (entry.beforeHash!==null) {
        const bytes = await codeBytes(root,entry.path);
        const output = await safeFile(path.join(backup,'files'),entry.path,{missing:true});
        await fs.mkdir(path.dirname(output),{recursive:true});
        await fs.writeFile(output,bytes,{flag:'wx',mode:0o600});
      }
      await atomicWriteJson(path.join(backup,'manifest.json'),manifest);
    }
    for (const entry of files) {
      if (entry.operation==='keep') continue;
      const target = await safeFile(root,entry.path,{missing:true});
      const original = await codeBytes(root,entry.path,{missing:true});
      if ((original?hash(original):null)!==entry.beforeHash) throw new Error(`Code drift before write: ${entry.path}`);
      changed.push({target,original,relative:entry.path,afterHash:entry.afterHash});
      if (entry.afterHash===null) await fs.unlink(target); // exact, hash-validated file created by this release
      else {
        const bytes = await codeBytes(path.join(bundle,'files'),entry.path);
        await fs.mkdir(path.dirname(target),{recursive:true});
        const temporary = `${target}.${randomUUID()}.update-tmp`;
        await fs.writeFile(temporary,bytes,{flag:'wx'});
        try { await fs.rename(temporary,target); } finally { await fs.unlink(temporary).catch(()=>{}); }
      }
      const actual = await codeBytes(root,entry.path,{missing:true});
      if ((actual?hash(actual):null)!==entry.afterHash) throw new Error('Post-update hash mismatch');
    }
    return {id:manifest.id,files:changed.length,backup,rollback};
  } catch (error) {
    // Restore only the files changed by this invocation, never runtime state.
    for (const entry of changed.reverse()) {
      const current = await codeBytes(root,entry.relative,{missing:true}).catch(()=>undefined);
      // A concurrent human edit is preserved instead of overwritten by repair.
      if (current===undefined || (current?hash(current):null)!==entry.afterHash) continue;
      if (entry.original) await fs.writeFile(entry.target,entry.original);
      else await fs.unlink(entry.target).catch(()=>{});
    }
    throw error;
  } finally { await releaseRunLock(lease); await releaseWrapper(); }
}

if (process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const option = name=>process.argv[process.argv.indexOf(name)+1];
  const command = process.argv[2];
  const bundle = process.argv[3];
  if (command==='build') console.log(JSON.stringify(await createReleaseBundle(option('--baseline'),option('--candidate'),option('--files').split(','),bundle)));
  else if (command==='preview') console.log(JSON.stringify(await previewRelease(root,bundle,{rollback:process.argv.includes('--rollback')}),null,2));
  else if (['apply','rollback'].includes(command)) {
    if (!process.argv.includes('--confirm')) throw new Error('Mutation requires an explicit --confirm after preview');
    console.log(JSON.stringify(await applyRelease(root,bundle,{rollback:command==='rollback'})));
  } else throw new Error('Usage: release build|preview|apply|rollback <bundle> [--confirm]');
}
