import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { collectPrivateValues, scanPrivateValues } from '../src/private-value-scan.mjs';
import { powershellExecutable } from './helpers/powershell.mjs';

async function fixture(t, config = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'private-scan-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'config'));
  await fs.writeFile(path.join(root, 'config/config.local.json'), JSON.stringify(config));
  return root;
}

test('private scan selects identity, secret and bookmark fields, not origins or button labels', () => {
  const values = collectPrivateValues({ accountId: 'github', userId: 23456,
    expectedAccountId: 'private-member', username: '<username>', apiKey: ['synthetic', 'value'].join('-'),
    containerFolderNames: ['PersonalScope'], targetFolderNames: ['Daily custom'],
    url: 'https://private.test', checkinText: 'click this label', path: 'C:/private/profile' });
  assert.deepEqual(values.map(item => item.rule).sort(), ['Private bookmark scope', 'Private bookmark scope',
    'Private identity value', 'Private identity value', 'Private secret value'].sort());
});

test('private scan redacts exact values and filenames, includes UTF16 and ignores runtime data', async t => {
  const root = await fixture(t, { expectedAccountId: 'member-sentinel', userId: 23456, targetFolderNames: ['PrivateFolder'] });
  await fs.writeFile(path.join(root, 'member-sentinel.txt'), 'member-sentinel\nPrivateFolder\n23456\n1234567');
  await fs.writeFile(path.join(root, 'utf16.txt'), Buffer.concat([Buffer.from([255, 254]), Buffer.from('member-sentinel', 'utf16le')]));
  await fs.mkdir(path.join(root, 'data'));
  await fs.writeFile(path.join(root, 'data/ignored.json'), 'member-sentinel');
  const report = await scanPrivateValues(root);
  assert.equal(report.safe, false);
  assert.equal(report.scannedFiles, 2);
  assert.equal(report.privateValueCount, 3);
  assert.equal(report.findings.filter(item => item.rule === 'Private identity value').length, 3);
  assert.doesNotMatch(JSON.stringify(report), /member-sentinel|PrivateFolder|23456/);
  assert.ok(report.findings.some(item => item.file === '[redacted-file]' && item.line === 0));
});

test('private scan fails closed on invalid private configuration and symbolic directory', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'config/config.local.json'), '{invalid');
  let report = await scanPrivateValues(root);
  assert.equal(report.safe, false);
  assert.equal(report.findings[0].rule, 'Private configuration unreadable or unsafe');
  await fs.unlink(path.join(root, 'config/config.local.json'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'private-scan-link-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'config.local.json'), '{}');
  await fs.rmdir(path.join(root, 'config'));
  await fs.symlink(outside, path.join(root, 'config'), 'junction');
  report = await scanPrivateValues(root);
  assert.equal(report.safe, false);
  assert.ok(report.findings.some(item => item.rule === 'Private configuration unreadable or unsafe'));
});

test('Git inventory includes Unicode untracked paths and rejects tracked private files', async t => {
  const root = await fixture(t);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { windowsHide: true, stdio: 'pipe' });
  git('init');
  await fs.writeFile(path.join(root, 'config/config.local.json'), JSON.stringify({ expectedAccountId: 'private-sentinel' }));
  git('add', 'config/config.local.json');
  await fs.writeFile(path.join(root, '公开 文件.txt'), 'private-sentinel');
  const report = await scanPrivateValues(root);
  assert.equal(report.safe, false);
  assert.ok(report.findings.some(item => item.file === '公开 文件.txt' && item.rule === 'Private identity value'));
  assert.ok(report.findings.some(item => item.rule === 'Private runtime file in public scope'));
  assert.doesNotMatch(JSON.stringify(report), /private-sentinel/);
});

test('PowerShell scan retains regex and binary checks while using actual private values', async t => {
  const root = await fixture(t, { expectedAccountId: 'test-personal-identity' });
  await fs.writeFile(path.join(root, 'source.txt'), 'test-personal-identity\n' + ['test', 'synthetic.invalid'].join('@'));
  await fs.writeFile(path.join(root, 'image.png'), Buffer.from([0, 1, 2]));
  await fs.writeFile(path.join(root, ['person', 'synthetic.invalid.txt'].join('@')), '');
  let result;
  try {
    execFileSync(powershellExecutable, ['-NoProfile', '-File', 'scripts/Scan-PublicSafety.ps1', '-Root', root],
      { windowsHide: true, encoding: 'utf8' });
    assert.fail('scan should reject fixture');
  } catch (error) { result = JSON.parse(error.stdout); }
  assert.equal(result.safe, false);
  assert.ok(result.findings.some(item => item.rule === 'Private identity value'));
  assert.ok(result.findings.some(item => item.rule === 'Binary file in public scope'));
  assert.ok(result.findings.some(item => item.rule === 'Email address'));
  assert.ok(result.findings.some(item => item.file === '[redacted-file]' && item.line === 0));
  assert.ok(!JSON.stringify(result).includes(['person', 'synthetic.invalid.txt'].join('@')));
  assert.doesNotMatch(JSON.stringify(result), /test-personal-identity/);
});

test('copyright email exception requires the complete reviewed license at its exact path', async t => {
  const root = await fixture(t);
  const license = (await fs.readFile(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const emailRule = { rule: 'Email address', pattern: '\\b[^\\s@]+@[^\\s@]+\\.[A-Za-z]{2,}\\b' };
  const options = { patterns: [emailRule] };
  const file = path.join(root, 'THIRD_PARTY_NOTICES.md');
  for (const contents of [license, license.replaceAll('\n', '\r\n')]) {
    await fs.writeFile(file, contents);
    assert.equal((await scanPrivateValues(root, options)).safe, true);
  }
  await fs.writeFile(path.join(root, 'source.mjs'), license);
  let report = await scanPrivateValues(root, options);
  assert.ok(report.findings.some(item => item.file === 'source.mjs' && item.rule === 'Email address'));
  await fs.unlink(path.join(root, 'source.mjs'));
  await fs.writeFile(file, license + '\n' + ['private-person', 'synthetic.invalid'].join('@'));
  report = await scanPrivateValues(root, options);
  assert.equal(report.safe, false);
  assert.ok(report.findings.some(item => item.file === 'THIRD_PARTY_NOTICES.md' && item.rule === 'Email address'));
});

test('reviewed public license still undergoes private-value and non-email checks', async t => {
  const root = await fixture(t, { username: 'Libor Skarvada' });
  await fs.copyFile(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), path.join(root, 'THIRD_PARTY_NOTICES.md'));
  const report = await scanPrivateValues(root, { patterns: [{ rule: 'Other sentinel', pattern: 'libgd' }] });
  assert.equal(report.safe, false);
  assert.ok(report.findings.some(item => item.rule === 'Private identity value'));
  assert.ok(report.findings.some(item => item.rule === 'Other sentinel'));
});
