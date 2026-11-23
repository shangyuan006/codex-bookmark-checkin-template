import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function resolveHealthPowerShell(config = {}, { env = process.env, platform = process.platform,
  exists = file => { try { return fs.statSync(file).isFile(); } catch { return false; } } } = {}) {
  const locate = command => {
    if (!command || typeof command !== 'string') return null;
    if (path.isAbsolute(command)) return exists(command) ? command : null;
    if (/[\\/]/.test(command)) return null;
    for (const directory of (env.Path ?? env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
      const candidate = path.join(directory, command);
      if (exists(candidate)) return candidate;
    }
    return null;
  };
  return locate(config.powershellExecutable)
    ?? locate(platform === 'win32' ? 'pwsh.exe' : 'pwsh')
    ?? (platform === 'win32' && env.SystemRoot
      ? locate(path.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')) : null)
    ?? locate(platform === 'win32' ? 'powershell.exe' : 'powershell');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  let config = {};
  try { config = JSON.parse(fs.readFileSync(path.join(root, 'config/config.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Health runtime configuration is unreadable'); }
  const shell = resolveHealthPowerShell(config);
  if (!shell) { process.stderr.write('PowerShell runtime is unavailable\n'); process.exitCode = 3; }
  else {
    const result = spawnSync(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(root, 'scripts/Test-CheckinHealth.ps1'), ...process.argv.slice(2)], { cwd: root, stdio: 'inherit', windowsHide: true });
    if (result.error) process.stderr.write('PowerShell health check could not start\n');
    process.exitCode = result.status ?? 3;
  }
}
