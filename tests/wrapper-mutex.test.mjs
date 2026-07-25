import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { powershellExecutable } from "./helpers/powershell.mjs";

const execFileAsync = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runner = path.join(root, "scripts", "Run-Checkin.ps1");
const mutexName = "Local\\CodexBookmarkCheckinRun";

test("第二个 wrapper 在命名互斥被占用时快速退出且不启动签到", async () => {
  const holderCommand = [
    `$mutex=[System.Threading.Mutex]::new($false,'${mutexName}')`,
    "$owned=$mutex.WaitOne()",
    "[Console]::Out.WriteLine('READY')",
    "[Console]::Out.Flush()",
    "try { Start-Sleep -Seconds 20 } finally { if($owned){$mutex.ReleaseMutex()};$mutex.Dispose() }",
  ].join("; ");
  const holder = spawn(powershellExecutable, ["-NoProfile", "-NonInteractive", "-Command", holderCommand], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    let startupTimer;
    const startupTimeout = new Promise((_, reject) => {
      startupTimer = setTimeout(() => reject(new Error("mutex holder startup timeout")), 5000);
    });
    const [ready] = await Promise.race([once(holder.stdout, "data"), startupTimeout])
      .finally(() => clearTimeout(startupTimer));
    assert.match(String(ready), /READY/);
    const started = Date.now();
    const { stdout } = await execFileAsync(powershellExecutable, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", runner, "-DryRun", "-SuppressReport",
    ], { cwd: root, encoding: "utf8", windowsHide: true });
    assert.ok(Date.now() - started < 5000);
    assert.equal(stdout.trim(), "");
  } finally {
    holder.kill();
    await once(holder, "exit").catch(() => {});
  }
});
