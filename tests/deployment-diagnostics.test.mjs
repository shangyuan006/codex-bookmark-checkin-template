import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { analyzeModules, extractModuleReferences } from '../src/module-reachability.mjs';
import { checkRuntimeIntegrity, recordRuntimeBaseline, captureRuntimeCode, sanitizeRuntimeCode } from '../src/runtime-integrity.mjs';
import { buildTimeoutReport } from '../src/finalize-timeout-report.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployment-diagnostics-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const directory of ['src', 'scripts', 'shared', 'node_modules/example-dependency']) {
    await fs.mkdir(path.join(root, directory), { recursive: true });
  }
  const manifest = { name: 'fixture', version: '1.0.0', dependencies: { 'example-dependency': '^1.2.3' } };
  const lock = { lockfileVersion: 3, packages: { '': manifest,
    'node_modules/example-dependency': { version: '1.2.3' } } };
  for (const [file, content] of Object.entries({
    'src/index.mjs': "import './helper.mjs';\nthrow new Error('inventory must not execute');\n",
    'src/helper.mjs': 'export const value = 1;\n',
    'src/tool.mjs': 'export const tool = true;\n',
    'package.json': JSON.stringify(manifest), 'package-lock.json': JSON.stringify(lock),
    'node_modules/example-dependency/package.json': JSON.stringify({ version: '1.2.3' }),
  })) await fs.writeFile(path.join(root, file), content);
  return root;
}

const policy = { schemaVersion: 1, production: ['src/index.mjs'], manual: ['src/tool.mjs'], historical: [] };

test('module inventory follows static and literal loads without executing source', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'src/index.mjs'), [
    "import { value } from './helper.mjs';", "export { tool } from './tool.mjs';",
    "await import('./dynamic.mjs');", "require('./required.mjs');",
    "const script = path.join(rootDirectory, 'scripts', 'Helper.ps1');",
    "const manifest = ['unused.mjs'];", '// import "./nonexistent.mjs";',
  ].join('\n'));
  await fs.writeFile(path.join(root, 'src/dynamic.mjs'), '');
  await fs.writeFile(path.join(root, 'src/required.mjs'), '');
  await fs.writeFile(path.join(root, 'src/unused.mjs'), '');
  await fs.writeFile(path.join(root, 'scripts/Helper.ps1'), ". (Join-Path $PSScriptRoot 'Dependency.ps1')\n");
  await fs.writeFile(path.join(root, 'scripts/Dependency.ps1'), '');
  const result = await analyzeModules(root, policy);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.modules.find(item => item.file === 'scripts/Dependency.ps1').category, 'runtime');
  assert.equal(result.modules.find(item => item.file === 'src/unused.mjs').category, 'unknown');
  assert.ok(result.edges.some(edge => edge.to === 'src/dynamic.mjs'));
});

test('module inventory rejects production paths into historical code and missing imports', async t => {
  const root = await fixture(t);
  let result = await analyzeModules(root, { ...policy, historical: ['src/helper.mjs'] });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(item => item.reason === 'production_reaches_historical'));
  await fs.writeFile(path.join(root, 'src/tool.mjs'), "import './missing.mjs';\n");
  result = await analyzeModules(root, policy);
  assert.ok(result.issues.some(item => item.reason === 'code_reference_missing'));
  const dynamic = extractModuleReferences('await import(variable);\nrequire(`./${name}.mjs`);', 'src/index.mjs');
  assert.equal(dynamic.references.length, 0);
  assert.equal(dynamic.unknown.length, 2);
});

test('runtime check verifies dependency versions and does not create a baseline', async t => {
  const root = await fixture(t);
  const result = await checkRuntimeIntegrity(root);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.baseline.status, 'absent');
  assert.equal(result.dependencies[0].status, 'matching');
  await assert.rejects(fs.access(path.join(root, 'data')));
  assert.doesNotMatch(JSON.stringify(result), /deployment-diagnostics-|Users|author|remote/);
  await fs.writeFile(path.join(root, 'node_modules/example-dependency/package.json'), '{"version":"9.9.9"}');
  const mismatch = await checkRuntimeIntegrity(root);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.issues[0].reason, 'installed_dependency_version_mismatch');
  await assert.rejects(recordRuntimeBaseline(root), /inconsistent dependencies/);
});

test('run metadata records safe code identity and survives timeout finalization', async t => {
  const root = await fixture(t);
  const runtimeCode = await captureRuntimeCode(root);
  assert.equal(runtimeCode.status, 'recorded');
  assert.equal(runtimeCode.codeFingerprint, (await checkRuntimeIntegrity(root)).codeFingerprint);
  const report = buildTimeoutReport({ sources: [], targets: [{ origin: 'https://fixture.test', candidates: [] }] }, {
    runId: '20261103-fixture', results: [], runtimeCode: { ...runtimeCode, privateText: 'must not pass' },
  });
  assert.deepEqual(report.runtimeCode, runtimeCode);
  assert.doesNotMatch(JSON.stringify(report.runtimeCode), /must not pass|privateText/);
  assert.equal(sanitizeRuntimeCode({ ...runtimeCode, codeFingerprint: 'invalid' }), null);
  const missing = await captureRuntimeCode(path.join(root, 'missing'));
  assert.deepEqual(missing, { schemaVersion: 1, status: 'unavailable' });
});

test('explicit baseline detects modified, added and removed code; local state is outside the hash', async t => {
  const root = await fixture(t);
  const recorded = await recordRuntimeBaseline(root);
  let result = await checkRuntimeIntegrity(root);
  assert.equal(result.baseline.status, 'matching');
  assert.equal(recorded.codeFingerprint, result.codeFingerprint);
  await fs.writeFile(path.join(root, 'data/local-state.json'), '{"changed":true}');
  assert.equal((await checkRuntimeIntegrity(root)).baseline.status, 'matching');
  await fs.appendFile(path.join(root, 'src/helper.mjs'), '// modified\n');
  await fs.writeFile(path.join(root, 'src/added.mjs'), '');
  await fs.unlink(path.join(root, 'src/tool.mjs'));
  result = await checkRuntimeIntegrity(root);
  assert.equal(result.ok, false);
  assert.equal(result.baseline.status, 'drift');
  assert.deepEqual(result.baseline.changedFiles, ['src/added.mjs', 'src/helper.mjs', 'src/tool.mjs']);
});

test('runtime check fails closed for bad lock data, baselines and dependency path traversal', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0',
    dependencies: { '../outside': '1.0.0' } }));
  let result = await checkRuntimeIntegrity(root);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(item => item.reason === 'invalid_dependency_name'));
  assert.ok(result.issues.some(item => item.reason === 'package_lock_manifest_mismatch'));
  await fs.mkdir(path.join(root, 'data'));
  await fs.writeFile(path.join(root, 'data/code-integrity.json'), '{invalid');
  result = await checkRuntimeIntegrity(root);
  assert.equal(result.baseline.status, 'invalid');
});

test('code inventories reject directory junctions instead of reading outside the deployment', async t => {
  const root = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'integrity-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.symlink(outside, path.join(root, 'src/external'), 'junction');
  await assert.rejects(analyzeModules(root, policy), /links/);
  assert.equal((await checkRuntimeIntegrity(root)).ok, false);
});
