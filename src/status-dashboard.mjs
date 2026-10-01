import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { redactPrivateResultText, ensurePrivateDirectory } from './security.mjs';

const states=new Set(['signed','already_signed','not_available','abandoned','deferred','needs_attention','interactive_challenge','managed_challenge_timeout','login_required','unconfirmed','error','no_action','visited','clicked']);
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const code=value=>/^[a-z][a-z0-9_.-]{0,79}$/i.test(String(value??''))?value:'—';
const time=value=>Number.isFinite(Date.parse(value??''))?new Date(value).toISOString():'—';
const host=value=>{try{const u=new URL(value);return /^https?:$/.test(u.protocol)&&!u.username&&!u.password?u.hostname:'未知站点';}catch{return '未知站点';}};

function canonicalOrigin(value) {
  try {
    const url=new URL(value);
    return /^https?:$/.test(url.protocol)&&!url.username&&!url.password&&value===url.origin?url.origin:null;
  } catch { return null; }
}

function localDateKey(now) {
  return [now.getFullYear(),String(now.getMonth()+1).padStart(2,'0'),String(now.getDate()).padStart(2,'0')].join('');
}

export function statusPageModel(report={},handoff={},verification={},profiles=[],abandonment={}, {now=new Date()}={}) {
  const reportDay=String(report.runId??'').match(/^(\d{8})-/)?.[1];
  const abandoned=new Set(abandonment.date===reportDay&&reportDay===localDateKey(now)
    &&Array.isArray(abandonment.origins)?abandonment.origins.map(canonicalOrigin).filter(Boolean):[]);
  for(const result of report.results??[]) {
    if(['signed','already_signed','not_available'].includes(result.status)) abandoned.delete(result.origin);
  }
  const pending=new Set((handoff.targets??[]).map(target=>target.origin));
  if(verification.state==='pending_verification') for(const target of verification.targets??[]){
    if(!['signed','already_signed','not_available'].includes(target.verificationStatus)) pending.add(target.origin);
  }
  return {
    generatedAt:new Date().toISOString(),finishedAt:time(report.finishedAt),
    complete:report.isComplete===true&&report.runState==='final',
    rows:(report.results??[]).map(result=>({
      host:host(result.origin),status:abandoned.has(result.origin)?'abandoned':states.has(result.status)?result.status:'unconfirmed',
      reason:abandoned.has(result.origin)?'今日按用户要求跳过，不再重试':redactPrivateResultText(String(result.reason??'')).slice(0,240),
      evidence:abandoned.has(result.origin)?'user_today_skip':code(result.evidence?.source??result.evidence?.sources?.[0]),
      observedAt:time(result.observedAt??result.evidence?.confirmedAt),nextRetry:abandoned.has(result.origin)?'—':time(result.nextEligibleAt),
      failureCode:abandoned.has(result.origin)?'—':code(result.failureCode),manual:!abandoned.has(result.origin)&&pending.has(result.origin)&&!['signed','already_signed','not_available','abandoned'].includes(result.status),
      durationMs:Number.isFinite(result.durationMs)?Math.max(0,result.durationMs):null,
      requests:Number.isFinite(result.metrics?.requests)?Math.max(0,result.metrics.requests):null,adapter:code(result.metrics?.adapter),
      accounts:(result.accountResults??[]).map(account=>({provider:['GitHub','LinuxDO'].includes(account.provider)?account.provider:'账号',status:abandoned.has(result.origin)?'abandoned':states.has(account.status)?account.status:'unconfirmed'})),
    })),profiles:profiles.map((p,index)=>({label:`隔离配置 ${index+1}`,sizeBytes:p.sizeBytes,partial:p.partial===true})),
  };
}

export function renderStatusPage(model) {
  const script=`const q=document.querySelector('#search'),s=document.querySelector('#status');function filter(){for(const r of document.querySelectorAll('tbody tr'))r.hidden=!(r.textContent.toLowerCase().includes(q.value.toLowerCase())&&(!s.value||r.dataset.status===s.value));}q.addEventListener('input',filter);s.addEventListener('change',filter);`;
  const hash=createHash('sha256').update(script).digest('base64');
  const rows=model.rows.map(r=>`<tr data-status="${escape(r.status)}"><td>${escape(r.host)}${r.accounts.map(a=>`<small>${escape(a.provider)} · ${escape(a.status)}</small>`).join('')}</td><td>${escape(r.status==='abandoned'?'今日跳过':r.status)}${r.manual?'<small class="pending">待人工处理</small>':''}</td><td>${escape(r.evidence)}<small>${escape(r.observedAt)}</small></td><td>${escape(r.reason)}<small>${escape(r.failureCode)}</small></td><td>${escape(r.nextRetry)}</td><td>${r.durationMs==null?'—':(r.durationMs/1000).toFixed(1)+'s'}<small>${escape(r.adapter)} · ${r.requests==null?'—':r.requests} 次协议请求</small></td></tr>`).join('');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${hash}'; base-uri 'none'; form-action 'none'"><title>签到状态</title><style>body{font:15px system-ui,sans-serif;background:#f3f6fa;color:#182539;margin:0;padding:32px}main{max-width:1400px;margin:auto}h1{margin:0 0 12px}.hint,small{color:#586b82}small{display:block;font-size:12px;margin-top:6px}.pending{color:#985800}.toolbar{display:flex;gap:12px;margin:24px 0}input,select{padding:10px;border:1px solid #c5ceda;border-radius:6px;background:white}input{flex:1}.table{overflow:auto;background:white;border:1px solid #dce2eb;border-radius:10px}table{border-collapse:collapse;width:100%;min-width:1000px}th,td{text-align:left;padding:14px;border-bottom:1px solid #e3e8f0;vertical-align:top}th{background:#eaf0f7}tr[data-status=signed] td:nth-child(2),tr[data-status=already_signed] td:nth-child(2){color:#087547}footer{margin-top:24px;line-height:1.8}</style><main><h1>签到状态</h1><p class="hint">报告时间：${escape(model.finishedAt)} · ${model.rows.length} 个站点 · ${model.complete?'报告已完整生成':'报告尚不完整或暂无结果'}</p><p class="hint">本地只读快照。重新生成后更新；没有记录的证据显示为 —，不据此补判成功。</p><div class="toolbar"><input id="search" aria-label="搜索站点或原因" placeholder="搜索站点、原因或错误码"><select id="status" aria-label="状态筛选"><option value="">全部状态</option>${[...new Set(model.rows.map(r=>r.status))].map(s=>`<option>${escape(s)}</option>`).join('')}</select></div><div class="table"><table><thead><tr><th>站点 / 账号类型</th><th>状态</th><th>证据 / 观察时间</th><th>原因</th><th>下次重试</th><th>耗时 / 执行方式</th></tr></thead><tbody>${rows}</tbody></table></div><footer>${model.profiles.map(p=>`<div>${escape(p.label)}：${(p.sizeBytes/1048576).toFixed(1)} MiB${p.partial?'（仅统计已读取部分）':''}</div>`).join('')}只展示运行结果和配置目录大小；不包含登录凭证、余额或操作按钮。<br>快照生成时间：${escape(model.generatedAt)}</footer></main><script>${script}</script></html>`;
}

async function json(file,fallback={}){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return fallback;throw error;}}
async function profileSize(directory){
  let sizeBytes=0,count=0,partial=false;
  const queue=[directory];
  while(queue.length&&count<100000){
    const dir=queue.pop();
    try{
      if((await fs.lstat(dir)).isSymbolicLink())continue;
      for(const entry of await fs.readdir(dir,{withFileTypes:true})){
        if(++count>100000){partial=true;break;}
        if(entry.isSymbolicLink())continue;
        const file=path.join(dir,entry.name);
        if(entry.isDirectory())queue.push(file);else if(entry.isFile())sizeBytes+=(await fs.stat(file)).size;
      }
    }catch{partial=true;}
  }
  return {sizeBytes,partial:partial||queue.length>0};
}

export async function generateStatusPage(root,{includeProfiles=false}={}){
  const [report,handoff,verification,abandonment]=await Promise.all(['logs/latest.json','tmp/manual-handoff.json','tmp/manual-verification.json','tmp/manual-abandon.json'].map(file=>json(path.join(root,file))));
  const profiles=[];
  if(includeProfiles){
    const config=await json(path.join(root,'config/config.json'));
    const data=path.resolve(root,'data')+path.sep;
    const dirs=[config.automationUserDataDir,...(config.agentrouterAccounts??[]).map(a=>a.automationUserDataDir),...(config.nativeChallengePreflight??[]).map(r=>r.automationUserDataDir)].filter(Boolean);
    for(const dir of new Set(dirs.map(dir=>path.resolve(root,dir)))){
      const actual=await fs.realpath(dir).catch(()=>null);
      if(actual&&actual.toLowerCase().startsWith(data.toLowerCase())) profiles.push(await profileSize(actual));
    }
  }
  // Old handoffs must not make current confirmed sites appear pending.
  const sameDay=document=>/^\d{8}-/.test(report.runId??'')&&String(document.sourceRunId??'').slice(0,8)===report.runId.slice(0,8);
  const currentHandoff=sameDay(handoff)?handoff:{};
  const currentVerification=sameDay(verification)?verification:{};
  const model=statusPageModel(report,currentHandoff,currentVerification,profiles,abandonment);
  const output=path.join(root,'outputs/status.html');
  await ensurePrivateDirectory(path.dirname(output));
  await fs.writeFile(output,renderStatusPage(model),{encoding:'utf8',mode:0o600});
  return {output,sites:model.rows.length};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  console.log(JSON.stringify(await generateStatusPage(root,{includeProfiles:process.argv.includes('--profiles')})));
}
