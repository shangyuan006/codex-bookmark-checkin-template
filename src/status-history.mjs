import fs from 'node:fs/promises';
import path from 'node:path';
import { completionEvidenceKind, reconcileCheckinResult } from './checkin-evidence.mjs';
import { mergeAuthoritativeDailyResults } from './logger.mjs';
import { isConfirmedNotAvailable } from './result-contract.mjs';
import { loadStatusHistoryArchive } from './status-history-store.mjs';

const dayOf = report => String(report.runId??'').match(/^(\d{8})-/)?.[1];
const asRows = result => result.accountResults?.length ? result.accountResults.map(account => ({...account,origin:result.origin})) : [result];

export function historyModel(reports,{now=new Date(),maxDays=31}={}) {
  const days = new Map();
  for (const report of [...reports].sort((a,b)=>Date.parse(a.finishedAt??a.updatedAt??'')-Date.parse(b.finishedAt??b.updatedAt??''))) {
    const date = dayOf(report);
    if (!date || !Array.isArray(report.results)) continue;
    const at = Date.parse(report.finishedAt??report.updatedAt??'');
    if (!Number.isFinite(at) || at > now.getTime()) continue;
    const current = days.get(date);
    if (!current) days.set(date,{report,at});
    else if (at > current.at) {
      const merged = mergeAuthoritativeDailyResults(current.report,report,new Date(at));
      // A scoped retry is not a replacement for a complete daily plan. Retain
      // that day's other accounts even if the retry could not prove anything.
      const retained = current.report.isComplete===true&&report.isComplete!==true
        ? current.report : report;
      days.set(date,{report:merged??retained,at});
    }
  }
  return [...days.entries()].sort(([a],[b])=>b.localeCompare(a)).slice(0,maxDays).map(([date,{report,at}])=>{
    const counts = {authoritative:0,user_rule:0,unbound:0,pending:0,unavailable:0,uncertain:0};
    let accounts = 0;
    for (const result of report.results) for (const row of asRows(result)) {
      accounts++;
      // Historical evidence is checked at its report time, not restamped today.
      const verified = reconcileCheckinResult(row,row.evidence,new Date(at));
      if (row.status === 'not_available' && isConfirmedNotAvailable(row,new Date(at))) counts.unavailable++;
      else if (['signed','already_signed'].includes(row.status)&&verified.status==='unconfirmed') counts.unbound++;
      else counts[completionEvidenceKind(verified,new Date(at))]++;
      if (row.failureCode === 'submission_quarantined' || row.submissionLockWarning?.submissionBlocked === true
        || row.submissionAttempted && completionEvidenceKind(verified,new Date(at)) !== 'authoritative') counts.uncertain++;
    }
    return {date,finishedAt:new Date(at).toISOString(),accounts,complete:report.isComplete===true&&report.runState==='final',counts};
  });
}

export async function loadStatusHistory(root,{maxReports=200,maxDays=31,now=new Date()}={}) {
  const logs = path.join(root,'logs');
  const entries = (await fs.readdir(logs,{withFileTypes:true}).catch(error => {
    if (error.code==='ENOENT') return []; throw error;
  })).filter(entry=>entry.isDirectory()&&!entry.isSymbolicLink()&&/^\d{8}-\d{6}$/.test(entry.name))
    .sort((a,b)=>b.name.localeCompare(a.name)).slice(0,maxReports);
  const reports = [];
  let unreadableReports = 0;
  for (const entry of entries) {
    const file = path.join(logs,entry.name,'result.json');
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile()||stat.isSymbolicLink()||stat.size>10*1024*1024) throw new Error('Unsafe history file');
      reports.push(JSON.parse(await fs.readFile(file,'utf8')));
    } catch { unreadableReports++; }
  }
  const archive = await loadStatusHistoryArchive(root);
  const days = new Map(archive.days.filter(day => Date.parse(day.finishedAt) <= now.getTime()).map(day => [day.date,day]));
  for (const day of historyModel(reports,{now,maxDays})) {
    const saved = days.get(day.date);
    if (!saved || Date.parse(day.finishedAt) > Date.parse(saved.finishedAt) && (!saved.complete || day.complete)) days.set(day.date,day);
  }
  return {days:[...days.values()].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,maxDays),maxDays,
    unreadableReports,truncated:entries.length===maxReports,archiveRecovered:archive.recovered,archiveUnreadable:archive.unreadable};
}
