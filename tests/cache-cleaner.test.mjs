import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { powershellExecutable } from "./helpers/powershell.mjs";

const execFileAsync = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cleaner = path.join(root, "scripts", "Clear-AutomationChromeCache.ps1");

const quotePowerShell = value => `'${value.replaceAll("'", "''")}'`;

async function runCleaner(configPath, apply = false, queryFails = false) {
  const { stdout } = await execFileAsync(powershellExecutable, [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-Command", `function Get-CimInstance { param($ClassName,$Filter,$ErrorAction)
      if ($ClassName -ne 'Win32_Process' -or $Filter -ne "Name='chrome.exe'") { throw 'Unexpected process query' }
      ${queryFails ? "throw 'Fixture process query failed'" : 'return @()'}
    }; function Get-WmiObject { param($Class,$Filter,$ErrorAction) throw 'Fixture WMI query failed' }
    ${queryFails ? "function Get-Process { param($ErrorAction) throw 'Fixture local inventory failed' }" : ''}
    & ${quotePowerShell(cleaner)} -ConfigPath ${quotePowerShell(configPath)} ${apply ? '-Apply' : ''}`,
  ], { cwd: root, encoding: "utf8" });
  return JSON.parse(stdout);
}

async function createSandbox(prefix) {
  const dataRoot = path.join(root, "data");
  await fs.mkdir(dataRoot, { recursive: true });
  const sandbox = await fs.mkdtemp(path.join(dataRoot, prefix));
  const profile = path.join(sandbox, "profile");
  const cache = path.join(profile, "Default", "Cache");
  const configPath = path.join(sandbox, "config.json");
  await fs.mkdir(cache, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ automationUserDataDir: profile }), "utf8");
  return { sandbox, profile, cache, configPath };
}

test("缓存清理 dry-run 不删除，Apply 只删除白名单目录", async () => {
  const value = await createSandbox("cache-cleaner-apply-");
  const cacheFile = path.join(value.cache, "entry.bin");
  try {
    await fs.writeFile(cacheFile, Buffer.alloc(128, 7));
    const preview = await runCleaner(value.configPath);
    assert.equal(preview.mode, "dry_run");
    assert.equal(preview.totalBytes, 128);
    assert.equal(await fs.stat(cacheFile).then(() => true), true);

    const applied = await runCleaner(value.configPath, true);
    assert.equal(applied.mode, "applied");
    assert.equal(applied.totalBytes, 128);
    assert.equal(await fs.stat(value.cache).then(() => true).catch(() => false), false);
    assert.equal(await fs.stat(value.profile).then(() => true), true);
  } finally {
    await fs.rm(value.sandbox, { recursive: true, force: true });
  }
});

test("缓存白名单子树含 junction 时拒绝清理且保留目标", { skip: process.platform !== "win32" }, async () => {
  const value = await createSandbox("cache-cleaner-junction-");
  const outside = path.join(value.sandbox, "outside");
  const junction = path.join(value.cache, "linked");
  const protectedFile = path.join(outside, "keep.txt");
  try {
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(protectedFile, "keep", "utf8");
    await fs.symlink(outside, junction, "junction");
    await assert.rejects(runCleaner(value.configPath, true), /联接点|符号链接|reparse/i);
    assert.equal(await fs.readFile(protectedFile, "utf8"), "keep");
  } finally {
    await fs.unlink(junction).catch(() => {});
    await fs.rm(value.sandbox, { recursive: true, force: true });
  }
});

test("进程查询持续失败时拒绝清理并保留缓存", async () => {
  const value = await createSandbox("cache-cleaner-query-");
  const cacheFile = path.join(value.cache, "entry.bin");
  try {
    await fs.writeFile(cacheFile, Buffer.alloc(16, 7));
    await assert.rejects(runCleaner(value.configPath, true, true), /CheckinProcessQueryFailed|无法确认项目浏览器进程/);
    assert.equal((await fs.stat(cacheFile)).size, 16);
  } finally { await fs.rm(value.sandbox, { recursive: true, force: true }); }
});
