import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("all JavaScript module entrypoints pass Node syntax checking", async () => {
  const sourceDirectory = path.join(root, "src");
  const modules = (await fs.readdir(sourceDirectory))
    .filter((name) => name.endsWith(".mjs"))
    .sort();
  assert.ok(modules.length > 0);
  for (const moduleName of modules) {
    await execFileAsync(process.execPath, ["--check", path.join(sourceDirectory, moduleName)], {
      cwd: root,
      windowsHide: true,
      timeout: 10_000,
    });
  }
});
