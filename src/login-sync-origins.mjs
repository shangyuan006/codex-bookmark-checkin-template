import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readBookmarkPlanWithBackup } from "./bookmarks.mjs";

function httpsOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) return url.origin;
  } catch { }
  return null;
}

export function selectSavedLoginSyncOrigins(explicitOrigins, targets, scope = null) {
  const scoped = scope === null ? null : new Set(scope.map(httpsOrigin).filter(Boolean));
  const origins = new Set(explicitOrigins.map(httpsOrigin).filter(origin => origin && (!scoped || scoped.has(origin))));
  for (const target of targets) {
    const origin = httpsOrigin(target.origin);
    if (!origin || (scoped && !scoped.has(origin))) continue;
    origins.add(origin);
    for (const related of target.allowedOrigins ?? []) {
      const approved = httpsOrigin(related);
      if (approved) origins.add(approved);
    }
  }
  return [...origins].sort();
}

const sourcePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === sourcePath) {
  const rootDirectory = path.dirname(path.dirname(sourcePath));
  const config = JSON.parse(await fs.readFile(path.join(rootDirectory, 'config', 'config.json'), 'utf8'));
  const argv = process.argv.slice(2);
  if (argv.length && (argv.length !== 2 || argv[0] !== '--origins' || !argv[1])) throw new Error('Invalid saved-login sync arguments');
  const scope = argv.length ? argv[1].split(',') : null;
  const plan = config.syncBookmarkSavedLogins !== false
    ? await readBookmarkPlanWithBackup(config.bookmarksPath, config)
    : { targets: [] };
  process.stdout.write(JSON.stringify(selectSavedLoginSyncOrigins(config.syncSavedLoginOrigins ?? [], plan.targets, scope)));
}
