import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const treeHelper = fileURLToPath(new URL('../scripts/RecoveryProcessTree.ps1', import.meta.url));

export async function captureRecoveryTree(pid, powershellExecutable = 'pwsh.exe') {
  if (process.platform !== 'win32') return [];
  const {stdout} = await exec(powershellExecutable, ['-NoProfile', '-NonInteractive', '-File', treeHelper,
    '-Mode', 'Snapshot', '-RootProcessId', String(pid)], {windowsHide:true,timeout:15000,maxBuffer:1024*1024});
  return JSON.parse(stdout);
}

export async function terminateCapturedRecoveryTree(snapshot, powershellExecutable = 'pwsh.exe') {
  if (!snapshot?.length) return;
  const encoded = Buffer.from(JSON.stringify(snapshot)).toString('base64');
  await exec(powershellExecutable, ['-NoProfile', '-NonInteractive', '-File', treeHelper,
    '-Mode', 'Stop', '-SnapshotBase64', encoded], {windowsHide:true,timeout:30000,maxBuffer:65536});
}

export async function terminateRecoveryTree(pid, platform = process.platform) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid recovery process PID');
  if (platform === 'win32') {
    await exec('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15000 });
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

// Keep the parent alive until timeout cleanup has addressed its descendants.
// execFile's built-in timeout kills only the parent on Windows.
export function runRecoveryProcess(executable, args, {
  timeout = 180000, maxBuffer = 1024 * 1024, beforeTerminate,
  terminateTree = terminateRecoveryTree, captureTree = captureRecoveryTree,
  terminateCapturedTree = terminateCapturedRecoveryTree, powershellExecutable = 'pwsh.exe', ...options
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { ...options, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0, stopping = false, closed = false;
    const timer = setTimeout(() => void stop('ETIMEDOUT'), timeout);
    const errorResult = (code, cleanupFailed = false) => Object.assign(new Error('Login recovery process failed'), { code, stdout, stderr, cleanupFailed });
    async function stop(code) {
      if (stopping || closed) return;
      stopping = true;
      clearTimeout(timer);
      let cleanupFailed = false;
      let snapshot = [];
      try { snapshot = await captureTree(child.pid, powershellExecutable); } catch { cleanupFailed = true; }
      try { await beforeTerminate?.(); } catch { cleanupFailed = true; }
      try {
        // The helper can finish while its browser is being closed gracefully.
        if (!closed) await terminateTree(child.pid);
      } catch { if (!closed) cleanupFailed = true; }
      try { await terminateCapturedTree(snapshot, powershellExecutable); } catch { cleanupFailed = true; }
      reject(errorResult(code, cleanupFailed));
    }
    const collect = name => chunk => {
      bytes += chunk.length;
      if (bytes > maxBuffer) { void stop('ERR_CHILD_PROCESS_STDIO_MAXBUFFER'); return; }
      if (name === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.once('error', error => { clearTimeout(timer); if (!stopping) reject(Object.assign(error, { stdout, stderr })); });
    child.once('close', code => {
      closed = true;
      clearTimeout(timer);
      if (stopping) return;
      if (code === 0) resolve({ stdout, stderr });
      else reject(errorResult(code));
    });
  });
}
