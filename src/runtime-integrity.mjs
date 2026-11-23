import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { listCodeFiles, readCodeFile } from './code-inventory.mjs';
import { atomicWriteJson } from './security.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const run = promisify(execFile);
const baselinePath = 'data/code-integrity.json';
const packageName = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const sameMap = (a = {}, b = {}) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

export async function runtimeSnapshot(root) {
  const files = [];
  for (const file of await listCodeFiles(root)) files.push({ file, sha256: hash(await readCodeFile(root, file)) });
  if (!files.some(entry => entry.file === 'src/index.mjs') || !files.some(entry => entry.file === 'package-lock.json')) {
    throw new Error('Incomplete runtime deployment');
  }
  const fingerprint = hash(JSON.stringify(files));
  let gitCommit = null;
  try {
    const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true, timeout: 5000, maxBuffer: 1024 });
    if (/^[a-f0-9]{40,64}$/.test(stdout.trim())) gitCommit = stdout.trim();
  } catch { /* exported deployments need not contain Git metadata */ }
  return { schemaVersion: 1, nodeVersion: process.versions.node, gitCommit, fingerprint, files };
}

async function checkDependencies(root) {
  const manifest = JSON.parse(await readCodeFile(root, 'package.json'));
  const lock = JSON.parse(await readCodeFile(root, 'package-lock.json'));
  const lockedRoot = lock.packages?.[''];
  const issues = [];
  if (!lockedRoot || manifest.name !== lockedRoot.name || manifest.version !== lockedRoot.version
    || ![2, 3].includes(lock.lockfileVersion)
    || ['dependencies', 'devDependencies', 'optionalDependencies'].some(key => !sameMap(manifest[key], lockedRoot[key]))) {
    issues.push({ reason: 'package_lock_manifest_mismatch' });
  }
  const dependencies = [];
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }).sort()) {
    if (!packageName.test(name) || name.split('/').some(part => part === '.' || part === '..')) {
      issues.push({ reason: 'invalid_dependency_name' }); continue;
    }
    const expected = lock.packages?.[`node_modules/${name}`]?.version;
    if (typeof expected !== 'string' || !versionPattern.test(expected)) {
      dependencies.push({ name, status: 'invalid_lock_version' });
      issues.push({ reason: 'dependency_lock_missing', name }); continue;
    }
    try {
      const installed = JSON.parse(await readCodeFile(root, `node_modules/${name}/package.json`));
      const actual = typeof installed.version === 'string' && versionPattern.test(installed.version) ? installed.version : null;
      const matches = actual === expected;
      dependencies.push({ name, expected, installed: actual, status: matches ? 'matching' : 'mismatch' });
      if (!matches) issues.push({ reason: 'installed_dependency_version_mismatch', name });
    } catch (error) {
      const optionalMissing = error.code === 'ENOENT' && Object.hasOwn(manifest.optionalDependencies ?? {}, name);
      dependencies.push({ name, expected, installed: null, status: optionalMissing ? 'optional_absent' : 'unreadable' });
      if (!optionalMissing) issues.push({ reason: 'installed_dependency_unreadable', name });
    }
  }
  return { dependencies, issues };
}

function validBaseline(value) {
  return value?.schemaVersion === 1 && /^[a-f0-9]{64}$/.test(value.fingerprint)
    && Array.isArray(value.files) && value.files.length > 0
    && value.files.every(entry => typeof entry.file === 'string'
      && /^(?:(?:src|scripts|shared)\/[^:]+|package(?:-lock)?\.json|config\/(?:defaults|qa-rules|site-rules\.public)\.json)$/.test(entry.file)
      && !entry.file.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\\'))
      && /^[a-f0-9]{64}$/.test(entry.sha256))
    && new Set(value.files.map(entry => entry.file)).size === value.files.length
    && hash(JSON.stringify(value.files)) === value.fingerprint;
}

export async function checkRuntimeIntegrity(root) {
  try {
    const snapshot = await runtimeSnapshot(root);
    const dependencyCheck = await checkDependencies(root);
    const issues = [...dependencyCheck.issues];
    let baseline = { status: 'absent' };
    try {
      const saved = JSON.parse(await readCodeFile(root, baselinePath));
      if (!validBaseline(saved)) throw new Error('Invalid integrity baseline');
      const matches = saved.fingerprint === snapshot.fingerprint;
      const before = new Map(saved.files.map(entry => [entry.file, entry.sha256]));
      const after = new Map(snapshot.files.map(entry => [entry.file, entry.sha256]));
      baseline = { status: matches ? 'matching' : 'drift',
        changedFiles: [...new Set([...before.keys(), ...after.keys()])].filter(file => before.get(file) !== after.get(file)).sort() };
      if (!matches) issues.push({ reason: 'code_baseline_drift' });
    } catch (error) {
      if (error.code !== 'ENOENT') { baseline = { status: 'invalid' }; issues.push({ reason: 'code_baseline_unreadable' }); }
    }
    return { schemaVersion: 1, ok: issues.length === 0, nodeVersion: snapshot.nodeVersion,
      gitCommit: snapshot.gitCommit, codeFingerprint: snapshot.fingerprint,
      fileCount: snapshot.files.length, baseline, dependencies: dependencyCheck.dependencies, issues };
  } catch {
    return { schemaVersion: 1, ok: false, baseline: { status: 'unknown' },
      issues: [{ reason: 'runtime_integrity_unreadable' }] };
  }
}

export async function recordRuntimeBaseline(root) {
  // This is an explicit operator action. A read-only health check never calls it.
  const dependencies = await checkDependencies(root);
  if (dependencies.issues.length) throw new Error('Cannot baseline inconsistent dependencies');
  const snapshot = await runtimeSnapshot(root);
  const data = path.join(root, 'data');
  const stat = await fs.lstat(data).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw new Error('Unsafe integrity directory');
  if (!stat) await fs.mkdir(data);
  const existing = await fs.lstat(path.join(root, baselinePath)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new Error('Unsafe integrity baseline');
  await atomicWriteJson(path.join(root, baselinePath), { ...snapshot, recordedAt: new Date().toISOString() });
  return { schemaVersion: 1, recorded: true, codeFingerprint: snapshot.fingerprint, fileCount: snapshot.files.length };
}

export function sanitizeRuntimeCode(value) {
  if (value?.schemaVersion !== 1) return null;
  if (value.status === 'unavailable') return { schemaVersion: 1, status: 'unavailable' };
  if (value.status !== 'recorded' || !/^[a-f0-9]{64}$/.test(value.codeFingerprint)
    || !versionPattern.test(value.nodeVersion)) return null;
  return { schemaVersion: 1, status: 'recorded', codeFingerprint: value.codeFingerprint,
    nodeVersion: value.nodeVersion, gitCommit: /^[a-f0-9]{40,64}$/.test(value.gitCommit) ? value.gitCommit : null,
    dependencies: (Array.isArray(value.dependencies) ? value.dependencies : []).filter(entry =>
      typeof entry.name === 'string' && packageName.test(entry.name)
      && ['matching', 'mismatch', 'optional_absent', 'unreadable', 'invalid_lock_version'].includes(entry.status))
      .map(entry => ({ name: entry.name, status: entry.status,
        expected: versionPattern.test(entry.expected) ? entry.expected : null,
        installed: versionPattern.test(entry.installed) ? entry.installed : null })) };
}

export async function captureRuntimeCode(root) {
  const report = await checkRuntimeIntegrity(root);
  return sanitizeRuntimeCode({ ...report, status: 'recorded' })
    ?? { schemaVersion: 1, status: 'unavailable' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const index = args.indexOf('--root');
    const root = index < 0 ? path.dirname(path.dirname(fileURLToPath(import.meta.url))) : args[index + 1];
    const report = args.includes('--record') ? await recordRuntimeBaseline(root) : await checkRuntimeIntegrity(root);
    console.log(JSON.stringify(report));
    if (report.ok === false) process.exitCode = 1;
  } catch {
    console.log(JSON.stringify({ ok: false, issues: [{ reason: 'runtime_integrity_failed' }] }));
    process.exitCode = 2;
  }
}
