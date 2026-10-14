import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { redactPrivateResultText, ensurePrivateDirectory, atomicWriteText } from './security.mjs';
import { CHECKIN_CONTRACT } from './checkin-contract.generated.mjs';
import { completionEvidenceKind, normalizeBoundEvidenceResult } from './checkin-evidence.mjs';
import { loadStatusHistory } from './status-history.mjs';
import { readSubmissionJournal } from './submission-guard.mjs';
import { isConfirmedNotAvailable } from './result-contract.mjs';

const states=new Set(CHECKIN_CONTRACT.statuses);
const statusLabel=value=>CHECKIN_CONTRACT.statusLabels[value]??value;
const conditionLabel=value=>CHECKIN_CONTRACT.conditionLabels[value]??value;
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

export function statusPageModel(report={},handoff={},verification={},profiles=[],abandonment={}, {now=new Date(),history={days:[]},expectedOrigins=[],quarantineCount=0}={}) {
  const displayResults=(report.results??[]).map(result=>normalizeBoundEvidenceResult(result,undefined,now));
  const reportDay=String(report.runId??'').match(/^(\d{8})-/)?.[1];
  const abandoned=new Set(abandonment.date===reportDay&&reportDay===localDateKey(now)
    &&Array.isArray(abandonment.origins)?abandonment.origins.map(canonicalOrigin).filter(Boolean):[]);
  for(const result of displayResults) {
    if(['signed','already_signed','not_available'].includes(result.status)) abandoned.delete(result.origin);
  }
  const pending=new Set((handoff.targets??[]).map(target=>target.origin));
  if(verification.state==='pending_verification') for(const target of verification.targets??[]){
    if(!['signed','already_signed','not_available'].includes(target.verificationStatus)) pending.add(target.origin);
  }
  return {
    generatedAt:now.toISOString(),finishedAt:time(report.finishedAt),history,quarantineCount,
    stale:reportDay!==localDateKey(now)||!Number.isFinite(Date.parse(report.finishedAt??''))
      ||Date.parse(report.finishedAt)>now.getTime()||now.getTime()-Date.parse(report.finishedAt)>26*60*60*1000,
    missingCount:expectedOrigins.filter(origin=>!(report.results??[]).some(result=>result.origin===origin)).length,
    complete:report.isComplete===true&&report.runState==='final',
    rows:displayResults.map(result=>({
      host:host(result.origin),status:abandoned.has(result.origin)?'abandoned':states.has(result.status)?result.status:'unconfirmed',
      reason:abandoned.has(result.origin)?'今日按用户要求跳过，不再重试':redactPrivateResultText(String(result.reason??'')).slice(0,240),
      evidence:abandoned.has(result.origin)?'user_today_skip':code(result.evidence?.source??result.evidence?.sources?.[0]),
      evidenceKind:completionEvidenceKind(result,now),
      excluded:isConfirmedNotAvailable(result,now)||abandoned.has(result.origin)||result.status==='abandoned',
      observedAt:time(result.observedAt??result.evidence?.confirmedAt),nextRetry:abandoned.has(result.origin)?'—':time(result.nextEligibleAt),
      failureCode:abandoned.has(result.origin)?'—':code(result.failureCode),manual:!abandoned.has(result.origin)&&pending.has(result.origin)&&!['signed','already_signed','not_available','abandoned'].includes(result.status),
      condition:code(result.failureCode??result.retryCause),
      historicalWarningCount:Math.max(0,Number(result.historicalSubmissionWarning?.pendingCount)||0)
        +(result.accountResults??[]).reduce((n,a)=>n+Math.max(0,Number(a.historicalSubmissionWarning?.pendingCount)||0),0),
      durationMs:Number.isFinite(result.durationMs)?Math.max(0,result.durationMs):null,
      requests:Number.isFinite(result.metrics?.requests)?Math.max(0,result.metrics.requests):null,adapter:code(result.metrics?.adapter),
      accounts:(result.accountResults??[]).map(account=>({provider:['GitHub','LinuxDO'].includes(account.provider)?account.provider:'账号',status:abandoned.has(result.origin)?'abandoned':states.has(account.status)?account.status:'unconfirmed',evidenceKind:completionEvidenceKind({...account,origin:account.origin??result.origin},now),
        excluded:abandoned.has(result.origin)||account.status==='abandoned'||isConfirmedNotAvailable(account,now)})),
    })),profiles:profiles.map((p,index)=>({label:`隔离配置 ${index+1}`,sizeBytes:p.sizeBytes,partial:p.partial===true})),
  };
}

export function renderStatusPage(model) {
  const displayModel={...model,rows:model.rows.map(row=>row.historicalWarningCount ? {...row,
    reason:`${row.reason}；历史未确认记录 ${row.historicalWarningCount} 条（与本周期状态分开记录）`} : row)};
  const history = (model.history?.days??[]).map(day=>`<tr><td>${escape(day.date)}</td><td>${day.accounts}</td><td>${day.counts.authoritative}</td><td>${day.counts.user_rule}</td><td>${day.counts.unbound}</td><td>${day.counts.pending}</td><td>${day.counts.uncertain}</td></tr>`).join('');
  const banner = `${model.stale?'<p class="pending">今日没有有效报告：报告已过期、缺少有效时间或时间异常；请运行只读核验后重新生成快照。站点周期证据单独校验。</p>':''}${model.missingCount?`<p class="pending">当前计划中有 ${escape(model.missingCount)} 个站点缺少报告。</p>`:''}${model.quarantineCount?`<p class="pending">有 ${escape(model.quarantineCount)} 次不确定提交处于持久隔离中。</p>`:''}`;
  const rows = model.rows.flatMap(row => row.accounts.length ? row.accounts : [row]);
  const count = kind => rows.filter(row=>row.evidenceKind===kind).length;
  const total=rows.length+model.missingCount, eligible=total-rows.filter(row=>row.excluded).length;
  const rate=denominator=>denominator?`${(100*count('authoritative')/denominator).toFixed(1)}%`:'—';
  const summary = `<p class="hint">权威确认 ${count('authoritative')} · 用户规则完成 ${count('user_rule')} · 缺少完整证据 ${count('unbound')}。三者分开统计。<br>全部任务权威完成率 ${rate(total)}（${count('authoritative')}/${total}）；可执行任务权威完成率 ${rate(eligible)}（${count('authoritative')}/${eligible}）。仅排除有证据的未开放任务和明确跳过任务；站点故障与未核验结果仍计入分母。</p>`;
  const calendar = `<h2>每日历史（按账号统计，最近 31 天）</h2><div class="table"><table><thead><tr><th>日期</th><th>账号数</th><th>权威确认</th><th>用户规则</th><th>证据不完整</th><th>待处理</th><th>提交不确定</th></tr></thead><tbody>${history}</tbody></table></div><p class="hint">${model.history?.unreadableReports??0} 个历史报告不可读取${model.history?.truncated?'；已达到读取上限':''}。</p>`;
  const archiveWarning=model.history?.archiveUnreadable?`<p class="pending">历史摘要损坏${model.history.archiveRecovered?'，已读取上一份有效摘要':'，保留原文件并回退读取运行日志'}。</p>`:'';
  return renderCurrentStatusPage(displayModel).replace('<div class="toolbar">',`${banner}${summary}<div class="toolbar">`).replace('<footer>',`${calendar}${archiveWarning}<footer>`);
}

function renderCurrentStatusPage(model) {
  const script=`const q=document.querySelector('#search'),s=document.querySelector('#status');function filter(){for(const r of document.querySelectorAll('tr[data-status]'))r.hidden=!(r.textContent.toLowerCase().includes(q.value.toLowerCase())&&(!s.value||r.dataset.status===s.value));}q.addEventListener('input',filter);s.addEventListener('change',filter);`;
  const hash=createHash('sha256').update(script).digest('base64');
  const rows=model.rows.map(r=>`<tr data-status="${escape(r.status)}"><td>${escape(r.host)}${r.accounts.map(a=>`<small>${escape(a.provider)} · ${escape(statusLabel(a.status))}</small>`).join('')}</td><td>${escape(statusLabel(r.status))}${r.manual?'<small class="pending">待人工处理</small>':''}</td><td>${escape(r.evidence)}<small>${escape(r.observedAt)}</small></td><td>${escape(r.reason)}<small>${escape(conditionLabel(r.condition))}</small></td><td>${escape(r.nextRetry)}</td><td>${r.durationMs==null?'—':(r.durationMs/1000).toFixed(1)+'s'}<small>${escape(r.adapter)} · ${r.requests==null?'—':r.requests} 次协议请求</small></td></tr>`).join('');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${hash}'; base-uri 'none'; form-action 'none'"><title>签到状态</title><style>body{font:15px system-ui,sans-serif;background:#f3f6fa;color:#182539;margin:0;padding:32px}main{max-width:1400px;margin:auto}h1{margin:0 0 12px}.hint,small{color:#586b82}small{display:block;font-size:12px;margin-top:6px}.pending{color:#985800}.toolbar{display:flex;gap:12px;margin:24px 0}input,select{padding:10px;border:1px solid #c5ceda;border-radius:6px;background:white}input{flex:1}.table{overflow:auto;background:white;border:1px solid #dce2eb;border-radius:10px}table{border-collapse:collapse;width:100%;min-width:1000px}th,td{text-align:left;padding:14px;border-bottom:1px solid #e3e8f0;vertical-align:top}th{background:#eaf0f7}tr[data-status=signed] td:nth-child(2),tr[data-status=already_signed] td:nth-child(2){color:#087547}footer{margin-top:24px;line-height:1.8}</style><main><h1>签到状态</h1><p class="hint">报告时间：${escape(model.finishedAt)} · ${model.rows.length} 个站点 · ${model.complete?'报告已完整生成':'报告尚不完整或暂无结果'}</p><p class="hint">本地只读快照。重新生成后更新；没有记录的证据显示为 —，不据此补判成功。</p><div class="toolbar"><input id="search" aria-label="搜索站点或原因" placeholder="搜索站点、原因或错误码"><select id="status" aria-label="状态筛选"><option value="">全部状态</option>${[...new Set(model.rows.map(r=>r.status))].map(s=>`<option value="${escape(s)}">${escape(statusLabel(s))}</option>`).join('')}</select></div><div class="table"><table><thead><tr><th>站点 / 账号类型</th><th>状态</th><th>证据 / 观察时间</th><th>原因</th><th>下次重试</th><th>耗时 / 执行方式</th></tr></thead><tbody>${rows}</tbody></table></div><footer>${model.profiles.map(p=>`<div>${escape(p.label)}：${(p.sizeBytes/1048576).toFixed(1)} MiB${p.partial?'（仅统计已读取部分）':''}</div>`).join('')}只展示运行结果和配置目录大小；不包含登录凭证、余额或操作按钮。<br>快照生成时间：${escape(model.generatedAt)}</footer></main><script>${script}</script></html>`;
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
  const [history,plan,journal]=await Promise.all([loadStatusHistory(root),json(path.join(root,'data/last-valid-bookmark-plan.json')),
    readSubmissionJournal(path.join(root,'data/submission-journal.json')).catch(()=>({entries:[],unreadable:true}))]);
  const model=statusPageModel(report,currentHandoff,currentVerification,profiles,abandonment,{history,
    expectedOrigins:(plan.targets??[]).map(target=>target.origin),
    quarantineCount:journal.unreadable?'未知（隔离记录不可读取）':journal.entries.filter(entry=>['intent','uncertain'].includes(entry.state)).length});
  const output=path.join(root,'outputs/status.html');
  await ensurePrivateDirectory(path.dirname(output));
  await atomicWriteText(output,renderStatusPage(model));
  return {output,sites:model.rows.length};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  console.log(JSON.stringify(await generateStatusPage(root,{includeProfiles:process.argv.includes('--profiles')})));
}
