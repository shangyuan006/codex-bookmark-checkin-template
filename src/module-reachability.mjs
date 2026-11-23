import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listCodeFiles, readCodeFile } from './code-inventory.mjs';

const codeExtension = /\.(?:mjs|cjs|js|ps1|py)$/i;
const lineAt = (text, offset) => text.slice(0, offset).split('\n').length;
const normalize = value => value.replaceAll('\\', '/');

function withoutComments(source, powershell) {
  // Preserve line numbers and quoted literals. This is a conservative source
  // inventory, not a complete JS/PowerShell interpreter.
  const pattern = powershell
    ? /("(?:`.|[^"`])*"|'(?:''|[^'])*')|<#[\s\S]*?#>|#[^\r\n]*/g
    : /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g;
  return source.replace(pattern, (match, quoted) => quoted ? match : match.replace(/[^\r\n]/g, ' '));
}

export function extractModuleReferences(source, file) {
  const powershell = file.endsWith('.ps1');
  const text = withoutComments(source, powershell);
  const references = [];
  const unknown = [];
  const add = (value, offset, kind, base = path.posix.dirname(file)) => {
    references.push({ value: normalize(value), base, line: lineAt(text, offset), kind });
  };
  if (/\.[cm]?js$/.test(file)) {
    const staticPattern = /\b(?:import|export)\s+(?:[^;"'`]*?\s+from\s*)?(["'])([^"'\r\n]+)\1/g;
    for (const match of text.matchAll(staticPattern)) {
      if (match[2].startsWith('.')) add(match[2], match.index, 'import');
    }
    for (const match of text.matchAll(/\b(import|require)\s*\(([^\n;]*)/g)) {
      const literal = match[2].match(/^\s*(["'])([^"']+)\1\s*\)/);
      if (literal) {
        if (literal[2].startsWith('.')) add(literal[2], match.index, 'literal_load');
      } else unknown.push({ file, line: lineAt(text, match.index), reason: 'dynamic_module_load' });
    }
    for (const match of text.matchAll(/new\s+URL\(\s*(["'])([^"']+\.(?:mjs|js|ps1|py))\1\s*,\s*import\.meta\.url\s*\)/g)) {
      add(match[2], match.index, 'url_path');
    }
    for (const match of text.matchAll(/path\.(?:join|resolve)\(\s*(rootDirectory|root|sourceDirectory)\s*,([^)]*)\)/g)) {
      const tail = match[2].trim();
      const parts = [...tail.matchAll(/(["'])([^"']+)\1/g)].map(item => item[2]);
      if (!/^(?:\s*["'][^"']+["']\s*,?\s*)+$/.test(tail)) {
        unknown.push({ file, line: lineAt(text, match.index), reason: 'dynamic_code_path' }); continue;
      }
      if (!parts.some(part => codeExtension.test(part))) continue;
      add(parts.join('/'), match.index, 'code_path', match[1] === 'sourceDirectory' ? path.posix.dirname(file) : '');
    }
  } else if (powershell) {
    for (const match of text.matchAll(/Join-Path\s+([^\r\n)]*)/gi)) {
      if (!/^\$(?:PSScriptRoot|root)\s+(["'])[^"']+\1\s*$/i.test(match[1].trim())) {
        unknown.push({ file, line: lineAt(text, match.index), reason: 'dynamic_code_path' });
      }
    }
    for (const match of text.matchAll(/Join-Path\s+\$(PSScriptRoot|root)\s+(["'])([^"']+)\2/gi)) {
      if (codeExtension.test(match[3])) add(match[3], match.index, 'script_path',
        match[1].toLowerCase() === 'psscriptroot' ? path.posix.dirname(file) : '');
    }
    for (const match of text.matchAll(/^\s*[.&]\s+(["'])(\.?\.?[/\\][^"']+)\1/gm)) {
      add(match[2], match.index, 'script_call');
    }
    for (const match of text.matchAll(/(?:^|\n)\s*&\s+\$|\bStart-Process\b/g)) {
      unknown.push({ file, line: lineAt(text, match.index), reason: 'dynamic_process_command' });
    }
  } else if (file.endsWith('.py')) {
    unknown.push({ file, line: 1, reason: 'python_dependencies_not_analyzed' });
  }
  return { references, unknown };
}

export async function analyzeModules(root, policy = null) {
  if (!policy) policy = JSON.parse(await readCodeFile(root, 'shared/module-policy.json'));
  if (policy.schemaVersion !== 1 || ['production', 'manual', 'historical'].some(key =>
    !Array.isArray(policy[key]) || policy[key].some(item => typeof item !== 'string'))) throw new Error('Invalid module policy');
  const files = (await listCodeFiles(root)).filter(file => codeExtension.test(file));
  const inventory = new Set(files);
  const issues = [];
  for (const category of ['production', 'manual', 'historical']) {
    for (const file of policy[category]) if (!inventory.has(file)) issues.push({ file, reason: 'policy_file_missing' });
  }
  const edges = [];
  const unknown = [];
  for (const file of files) {
    const source = (await readCodeFile(root, file)).toString('utf8');
    const extracted = extractModuleReferences(source, file);
    unknown.push(...extracted.unknown);
    for (const ref of extracted.references) {
      const target = path.posix.normalize(path.posix.join(ref.base, ref.value));
      if (target.startsWith('../') || path.posix.isAbsolute(ref.value)) {
        issues.push({ file, line: ref.line, reason: 'code_reference_outside_root' }); continue;
      }
      const resolved = [target, `${target}.mjs`, `${target}.js`, `${target}/index.mjs`].find(item => inventory.has(item));
      if (!resolved) issues.push({ file, target, line: ref.line, reason: 'code_reference_missing' });
      else if (!edges.some(edge => edge.from === file && edge.to === resolved)) edges.push({ from: file, to: resolved, kind: ref.kind, line: ref.line });
    }
  }
  const reachable = seeds => {
    const seen = new Set(seeds.filter(file => inventory.has(file)));
    const queue = [...seen];
    for (let index = 0; index < queue.length; index += 1) {
      for (const edge of edges.filter(item => item.from === queue[index])) {
        if (!seen.has(edge.to)) { seen.add(edge.to); queue.push(edge.to); }
      }
    }
    return seen;
  };
  const production = reachable(policy.production);
  const manual = reachable(policy.manual);
  const historical = new Set(policy.historical);
  for (const file of historical) if (production.has(file)) issues.push({ file, reason: 'production_reaches_historical' });
  return { schemaVersion: 1, ok: issues.length === 0, fileCount: files.length, edgeCount: edges.length,
    modules: files.map(file => ({ file, category: historical.has(file) ? 'historical'
      : production.has(file) ? 'runtime' : manual.has(file) ? 'manual' : 'unknown' })),
    edges, unknown, issues };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const index = args.indexOf('--root');
    const report = await analyzeModules(index < 0 ? path.dirname(path.dirname(fileURLToPath(import.meta.url))) : args[index + 1]);
    const output = args.includes('--json') ? report : {
      schemaVersion: report.schemaVersion, ok: report.ok, fileCount: report.fileCount, edgeCount: report.edgeCount,
      categories: Object.fromEntries(['runtime', 'manual', 'historical', 'unknown'].map(category =>
        [category, report.modules.filter(item => item.category === category).length])),
      unknownReferenceCount: report.unknown.length, issues: report.issues,
    };
    console.log(JSON.stringify(output));
    if (!report.ok) process.exitCode = 1;
  } catch {
    console.log(JSON.stringify({ ok: false, issues: [{ reason: 'module_inventory_failed' }] }));
    process.exitCode = 2;
  }
}
