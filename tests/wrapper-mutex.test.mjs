import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { powershellExecutable } from "./helpers/powershell.mjs";

const execFileAsync = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dependencies = ["Run-Checkin", "Resolve-Runtime", "RunLock", "ManualVerification", "ResultContract",
  "ManualAbandonment", "NativeFallbackPolicy", "PreflightScope", "CheckinCycle", "TaskRetryPolicy", "TaskRuntimeBudget"];

test("第二个 wrapper 在命名互斥被占用时快速退出且不启动签到", async () => {
  const tmpRoot = path.join(root, "tmp");
  await fs.mkdir(tmpRoot, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(tmpRoot, "wrapper-mutex-"));
  const mutexName = `Local\\CheckinMutexFixture-${randomUUID()}`;
  let holder;
  try {
    for (const folder of ["scripts", "src", "config", "tmp"]) await fs.mkdir(path.join(fixture, folder));
    for (const name of dependencies) {
      await fs.copyFile(path.join(root, "scripts", `${name}.ps1`), path.join(fixture, "scripts", `${name}.ps1`));
    }
    await fs.writeFile(path.join(fixture, "config", "config.json"), JSON.stringify({
      nodeExecutable: process.execPath, runMutexName: mutexName,
    }));
    await fs.writeFile(path.join(fixture, "src", "current-plan.mjs"),
      "import fs from 'node:fs'; fs.writeFileSync('tmp/plan-invoked', 'true'); await new Promise(resolve => setTimeout(resolve, 10_000));");
    await fs.writeFile(path.join(fixture, "src", "index.mjs"),
      "import fs from 'node:fs'; fs.writeFileSync('tmp/worker-invoked', 'true');");
    const holderCommand = [
      `$mutex=[System.Threading.Mutex]::new($false,'${mutexName}')`,
      "$owned=$mutex.WaitOne()",
      "[Console]::Out.WriteLine('READY')",
      "[Console]::Out.Flush()",
      "try { Start-Sleep -Seconds 20 } finally { if($owned){$mutex.ReleaseMutex()};$mutex.Dispose() }",
    ].join("; ");
    holder = spawn(powershellExecutable, ["-NoProfile", "-NonInteractive", "-Command", holderCommand], {
      cwd: fixture, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
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
      "-File", path.join(fixture, "scripts", "Run-Checkin.ps1"), "-DryRun", "-SuppressReport",
    ], { cwd: fixture, encoding: "utf8", windowsHide: true, timeout: 15_000 });
    assert.ok(Date.now() - started < 5000);
    assert.equal(stdout.trim(), "");
    for (const marker of ["plan-invoked", "worker-invoked"]) {
      assert.equal(await fs.access(path.join(fixture, "tmp", marker)).then(() => true).catch(() => false), false);
    }
  } finally {
    if (holder && holder.exitCode === null && holder.signalCode === null) {
      const exited = once(holder, "exit");
      holder.kill();
      await exited.catch(() => {});
    }
    await fs.rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
