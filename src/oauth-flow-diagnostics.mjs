import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {OAUTH_DIAGNOSTIC_STAGES, loginHelperOutcome} from './login-recovery.mjs';
import {ensurePrivateDirectory} from './security.mjs';
import {sanitizeOAuthPageObservation} from './oauth-target-state.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const flows = new Set(['automatic_provider', 'automatic_provider_after_refresh', 'automatic_target',
  'manual_provider', 'manual_target', 'manual_target_oauth', 'automatic_logout']);

export function sanitizeOAuthFlowDiagnostic(entry, now = new Date()) {
  if (!flows.has(entry?.flow)) return null;
  const outcome = loginHelperOutcome(JSON.stringify(entry));
  return {
    recordedAt:now.toISOString(), flow:entry.flow,
    provider:entry.provider==='LinuxDO' ? 'LinuxDO' : entry.provider==='GitHub' ? 'GitHub' : 'other',
    status:entry.flow==='automatic_logout' ? (entry.logoutConfirmed===true ? 'logged_out' : 'needs_attention') : outcome.status,
    oauthStage:outcome.oauthStage ?? 'helper_failed',
    stages:(Array.isArray(entry.stages) ? entry.stages : []).filter(stage=>OAUTH_DIAGNOSTIC_STAGES.has(stage)).slice(-64),
    elapsedMs:Number.isFinite(entry.elapsedMs) ? Math.max(0,Math.min(600_000,Math.round(entry.elapsedMs))) : null,
    ...sanitizeOAuthPageObservation(entry),
    ...(outcome.authorizationOutcome ? {authorizationOutcome:outcome.authorizationOutcome} : {}),
    ...(outcome.providerAuthorizationChallengeOutcome
      ? {providerAuthorizationChallengeOutcome:outcome.providerAuthorizationChallengeOutcome} : {}),
    ...(outcome.providerAuthorizationChallengeClicks != null
      ? {providerAuthorizationChallengeClicks:outcome.providerAuthorizationChallengeClicks} : {}),
  };
}

export async function writeOAuthFlowDiagnostic(entry, {logsRoot=path.join(root,'logs'), now=new Date()}={}) {
  const safe=sanitizeOAuthFlowDiagnostic(entry,now);
  if (!safe) return false;
  try {
    await ensurePrivateDirectory(logsRoot);
    const date=`${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
    const file=path.join(logsRoot,`oauth-flows-${date}.jsonl`);
    const stat=await fs.lstat(file).catch(()=>null);
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) return false;
    await fs.appendFile(file,`${JSON.stringify(safe)}\n`,{encoding:'utf8',mode:0o600});
    for (const item of await fs.readdir(logsRoot,{withFileTypes:true})) {
      if (!item.isFile() || !/^oauth-flows-\d{8}\.jsonl$/.test(item.name)) continue;
      const oldFile=path.join(logsRoot,item.name), old=await fs.lstat(oldFile);
      if (!old.isSymbolicLink() && old.mtimeMs < now.getTime()-14*86400_000) await fs.unlink(oldFile);
    }
    return true;
  } catch { return false; }
}
