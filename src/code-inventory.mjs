import fs from 'node:fs/promises';
import path from 'node:path';

export async function readCodeFile(root, relative) {
  if (typeof relative !== 'string' || relative.includes('\\') || path.isAbsolute(relative)
    || relative.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':'))) throw new Error('Unsafe code path');
  let current = path.resolve(root);
  for (const part of ['', ...relative.split('/')]) {
    if (part) current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error('Code paths must not follow links');
  }
  const stat = await fs.stat(current);
  if (!stat.isFile() || stat.size > 5 * 1024 * 1024) throw new Error('Invalid code file');
  return fs.readFile(current);
}

export async function listCodeFiles(root) {
  const files = [];
  const walk = async relative => {
    const stat = await fs.lstat(path.join(root, relative)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new Error('Code inventory must not follow links');
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(path.join(root, relative))).sort()) await walk(`${relative}/${name}`);
    } else if (stat.isFile()) files.push(relative);
    else throw new Error('Invalid code inventory entry');
  };
  for (const directory of ['src', 'scripts', 'shared']) await walk(directory);
  for (const relative of ['package.json', 'package-lock.json', 'config/defaults.json', 'config/qa-rules.json', 'config/site-rules.public.json']) {
    const stat = await fs.lstat(path.join(root, relative)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat) { await readCodeFile(root, relative); files.push(relative); }
  }
  return files.sort();
}
