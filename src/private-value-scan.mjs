import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const privateFiles = new Set(['config/config.json', 'config/config.local.json',
  'config/qa-rules.local.json', 'setup/answers.json']);
const excludedDirectories = new Set(['.git', 'node_modules', 'data', 'logs', 'tmp', 'outputs', 'work']);
const identityKeys = /^(?:accountId|siteAccountId|expectedAccountId|userId|username|email)$/i;
const secretKeys = /^(?:token|botToken|telegramToken|webhook|webhookUrl|apiKey|accessToken|secret|password)$/i;
const scopeKeys = /^(?:mobileFolderNames|containerFolderNames|targetFolderNames|folderPath|bookmarkFolderPath)$/i;
const genericValues = new Set(['github', 'linuxdo', 'linux-do', 'default', 'example', 'placeholder', 'changeme', 'yourname', 'username']);

function decode(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(2));
  if (bytes.includes(0)) throw new Error('binary');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function collectPrivateValues(document) {
  const entries = new Map();
  const add = (value, rule) => {
    if (Array.isArray(value)) { for (const item of value) add(item, rule); return; }
    if (typeof value !== 'string' && typeof value !== 'number') return;
    const text = String(value).trim();
    if (text.length < 5 || genericValues.has(text.toLowerCase())
      || /^(?:<.*>|\$\{.*\}|%.*%|example(?:[._-].*)?|your[ _-].*|https?:\/\/[^/]*\.example(?:[/:].*)?)$/i.test(text)) return;
    entries.set(text, { value: text, rule });
  };
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (identityKeys.test(key)) add(child, 'Private identity value');
      else if (secretKeys.test(key)) add(child, 'Private secret value');
      else if (scopeKeys.test(key)) add(child, 'Private bookmark scope');
      else visit(child);
    }
  };
  visit(document);
  return [...entries.values()];
}

async function safeRead(root, relative, { optional = false } = {}) {
  if (!relative || relative.includes('\\') || path.isAbsolute(relative)
    || relative.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':'))) throw new Error('unsafe_path');
  let current = path.resolve(root);
  const rootStat = await fs.lstat(current);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('unsafe_root');
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch(error => { if (optional && error.code === 'ENOENT') return null; throw error; });
    if (!stat) return null;
    if (stat.isSymbolicLink()) throw new Error('unsafe_link');
  }
  const stat = await fs.stat(current);
  if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new Error('unsafe_file');
  return fs.readFile(current);
}

async function inventory(root) {
  const gitPresent = await fs.lstat(path.join(root, '.git')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (gitPresent) {
    const options = { cwd: root, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 };
    const tracked = await run('git', ['ls-files', '-z'], options);
    const untracked = await run('git', ['ls-files', '-z', '--others', '--exclude-standard'], options);
    return [...new Set(`${tracked.stdout}\0${untracked.stdout}`.split('\0').filter(Boolean))];
  }
  const files = [];
  const walk = async relative => {
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (!relative && excludedDirectories.has(entry.name)) continue;
      if (entry.isDirectory()) await walk(next);
      else if (!privateFiles.has(next) && !/(?:^|\/)\.env(?:\.|$)|\.local\.json$/i.test(next)) files.push(next);
    }
  };
  await walk('');
  return files;
}

function contains(text, value) {
  // Avoid interpreting a short numeric ID as a substring of a longer number.
  if (/^\d+$/.test(value)) return new RegExp(`(?<![0-9])${value}(?![0-9])`).test(text);
  return text.includes(value);
}

export async function scanPrivateValues(root, { patterns = [], binaryExtensions = '' } = {}) {
  root = path.resolve(root);
  const findings = [];
  const values = [];
  const privateErrors = [];
  let privateConfigCount = 0;
  for (const relative of privateFiles) {
    try {
      const bytes = await safeRead(root, relative, { optional: true });
      if (bytes === null) continue;
      const document = JSON.parse(decode(bytes));
      if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('invalid_config');
      privateConfigCount += 1;
      values.push(...collectPrivateValues(document));
    } catch { privateErrors.push({ file: relative, line: 0, rule: 'Private configuration unreadable or unsafe' }); }
  }
  const regexes = patterns.map(entry => ({ rule: entry.rule, regex: new RegExp(entry.pattern.replace(/^\(\?i\)/, ''), 'i') }));
  const safeName = name => values.some(entry => contains(name, entry.value)) || regexes.some(entry => entry.regex.test(name))
    ? '[redacted-file]' : name;
  let files;
  try { files = await inventory(root); }
  catch { return { safe: false, scannedFiles: 0, privateConfigCount, findings: [
    ...privateErrors, { file: '[inventory]', line: 0, rule: 'Public file inventory unavailable' },
  ] }; }
  const binary = binaryExtensions ? new RegExp(binaryExtensions, 'i') : null;
  for (const relative of files.sort()) {
    if (relative === 'logs/.gitkeep') continue;
    const file = safeName(relative);
    if (file !== relative) findings.push({ file, line: 0, rule: 'Private value in public filename' });
    if (privateFiles.has(relative) || /(?:^|\/)\.env(?:\.|$)/i.test(relative) && relative !== '.env.example') {
      findings.push({ file, line: 0, rule: 'Private runtime file in public scope' });
      continue;
    }
    let bytes;
    try { bytes = await safeRead(root, relative, { optional: true }); }
    catch { findings.push({ file, line: 0, rule: 'Unreadable or unsafe public file' }); continue; }
    if (bytes === null) continue; // tracked deletion
    if (binary?.test(path.extname(relative))) {
      findings.push({ file, line: 0, rule: 'Binary file in public scope' }); continue;
    }
    let text;
    try { text = decode(bytes); }
    catch { findings.push({ file, line: 0, rule: 'Binary or invalid text in public scope' }); continue; }
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const rules = new Set(values.filter(entry => contains(lines[index], entry.value)).map(entry => entry.rule));
      for (const entry of regexes) {
        if (relative === 'scripts/Scan-PublicSafety.ps1' && entry.rule === 'Assigned secret') continue;
        if (entry.regex.test(lines[index])) rules.add(entry.rule);
      }
      for (const rule of rules) findings.push({ file, line: index + 1, rule });
    }
  }
  findings.push(...privateErrors.map(entry => ({ ...entry, file: safeName(entry.file) })));
  return { safe: findings.length === 0, scannedFiles: files.length, privateConfigCount,
    privateValueCount: new Set(values.map(entry => entry.value)).size, findings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const rootIndex = args.indexOf('--root');
    const root = rootIndex >= 0 ? args[rootIndex + 1] : path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    let policy = {};
    if (args.includes('--patterns-stdin')) {
      let input = '';
      for await (const chunk of process.stdin) input += chunk;
      policy = JSON.parse(input.replace(/^\uFEFF/, ''));
    }
    const report = await scanPrivateValues(root, policy);
    console.log(JSON.stringify(report));
    if (!report.safe) process.exitCode = 1;
  } catch {
    console.log(JSON.stringify({ safe: false, scannedFiles: 0,
      findings: [{ file: '[scanner]', line: 0, rule: 'Public safety scan failed' }] }));
    process.exitCode = 2;
  }
}
