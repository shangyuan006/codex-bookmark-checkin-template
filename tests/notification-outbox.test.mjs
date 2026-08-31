import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { powershellExecutable } from "./helpers/powershell.mjs";

const execFileAsync = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmpRoot = path.join(root, "tmp");
const reporter = path.join(root, "scripts", "Submit-UnifiedCheckinReport.ps1");
const abandonmentHelper = path.join(root, "scripts", "ManualAbandonment.ps1");
const worker = path.join(root, "scripts", "Invoke-CheckinNotificationOutbox.ps1");

async function runPowerShell(script, args = []) {
  const { stdout } = await execFileAsync(powershellExecutable, [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...args,
  ], { cwd: root, encoding: "utf8" });
  return stdout.trim();
}

function completeReport(result) {
  return {
    runId: "20260723-230000", runState: "final", plannedTotal: 1,
    processedTotal: 1, isComplete: true, results: [result],
  };
}

async function writeConfig(filePath, notification) {
  await fs.writeFile(filePath, JSON.stringify({ notification }), "utf8");
}

async function enqueue(outboxPath, configPath, report, preview = false) {
  await fs.mkdir(tmpRoot, { recursive: true });
  const fixtureRoot = await fs.mkdtemp(path.join(tmpRoot, "public-outbox-report-"));
  const scriptsDirectory = path.join(fixtureRoot, "scripts");
  const reportDirectory = path.join(fixtureRoot, "logs", "run");
  const fixtureReporter = path.join(scriptsDirectory, "Submit-UnifiedCheckinReport.ps1");
  const reportPath = path.join(reportDirectory, "report.json");
  try {
    await fs.mkdir(scriptsDirectory, { recursive: true });
    await fs.mkdir(reportDirectory, { recursive: true });
    await Promise.all([
      fs.copyFile(reporter, fixtureReporter),
      fs.copyFile(abandonmentHelper, path.join(scriptsDirectory, "ManualAbandonment.ps1")),
    ]);
    await fs.writeFile(reportPath, JSON.stringify(report), "utf8");
    return JSON.parse(await runPowerShell(fixtureReporter, [
      "-ReportPath", reportPath, "-OutboxPath", outboxPath, "-ConfigPath", configPath,
      ...(preview ? ["-Preview"] : []),
    ]));
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
}

async function readItem(outboxPath) {
  const files = (await fs.readdir(outboxPath)).filter((name) => name.endsWith(".json"));
  assert.equal(files.length, 1);
  return JSON.parse(await fs.readFile(path.join(outboxPath, files[0]), "utf8"));
}

async function readItems(outboxPath) {
  const files = (await fs.readdir(outboxPath)).filter((name) => name.endsWith(".json"));
  return Promise.all(files.map(async (name) => JSON.parse(await fs.readFile(path.join(outboxPath, name), "utf8"))));
}

async function readQuarantineItems(outboxPath) {
  const quarantinePath = path.join(outboxPath, "quarantine");
  const files = await fs.readdir(quarantinePath).catch(() => []);
  return files.filter((name) => name.endsWith(".invalid.json"));
}

async function writeOutboxItem(outboxPath, overrides = {}) {
  const item = {
    schemaVersion: 1,
    eventKey: "external:test-suite:public_test:2026-07-23:0000000000000000",
    taskId: "public_test",
    name: "公开模板测试",
    source: "test-suite",
    status: "success",
    summary: "test summary",
    createdAt: "2026-07-23T10:00:00.000Z",
    updatedAt: "2026-07-23T10:00:00.000Z",
    nextAttemptAt: "2026-07-23T10:00:00.000Z",
    attempts: 0,
    delivered: false,
    deliveredAt: null,
    disposition: null,
    lastError: null,
    ...overrides,
  };
  item.payloadHash = createHash("sha256").update([
    item.eventKey, item.taskId, item.name, item.source, item.status, item.summary,
  ].join("\n"), "utf8").digest("hex");
  await fs.mkdir(outboxPath, { recursive: true });
  const fileName = `${createHash("sha256").update(item.eventKey, "utf8").digest("hex")}.json`;
  await fs.writeFile(path.join(outboxPath, fileName), JSON.stringify(item), "utf8");
  return item;
}

async function writeFakeCommand(filePath, acknowledgement, exitCode = 0) {
  const body = `console.log(${JSON.stringify(JSON.stringify(acknowledgement))}); process.exit(${exitCode});\n`;
  await fs.writeFile(filePath, body, "utf8");
}

async function writeHangingCommand(filePath) {
  const body = "setInterval(() => {}, 1000);\n";
  await fs.writeFile(filePath, body, "utf8");
}

async function writeArgumentCheckingCommand(filePath, expected) {
  const body = `const expected = ${JSON.stringify(expected)};\n`
    + "const actual = process.argv.slice(2, 2 + expected.length);\n"
    + "const accepted = JSON.stringify(actual) === JSON.stringify(expected);\n"
    + "console.log(JSON.stringify({ accepted, duplicate: false }));\n"
    + "process.exit(accepted ? 0 : 11);\n";
  await fs.writeFile(filePath, body, "utf8");
}

function commandNotification(executable, prefixArguments = []) {
  return {
    mode: "command", executable,
    arguments: [...prefixArguments, "--task-id", "{taskId}", "--name", "{name}", "--source", "{source}", "--status", "{status}", "--event-key", "{eventKey}", "--summary", "{summary}"],
    taskId: "public_test", name: "公开模板测试", source: "test-suite",
  };
}

test("none 和 Preview 模式不创建通知 outbox", async () => {
  await fs.mkdir(tmpRoot, { recursive: true });
  const sandbox = await fs.mkdtemp(path.join(tmpRoot, "public-outbox-none-"));
  const configPath = path.join(sandbox, "config.json");
  const outboxPath = path.join(sandbox, "outbox");
  try {
    await writeConfig(configPath, { mode: "none", executable: "", arguments: [] });
    const report = completeReport({ origin: "https://none.test", status: "signed" });
    await enqueue(outboxPath, configPath, report);
    assert.equal(await fs.stat(outboxPath).then(() => true).catch(() => false), false);

    await writeConfig(configPath, commandNotification("missing-command"));
    await enqueue(outboxPath, configPath, report, true);
    assert.equal(await fs.stat(outboxPath).then(() => true).catch(() => false), false);
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

test("command 报告先以最小脱敏 payload 原子写入 outbox", async () => {
  await fs.mkdir(tmpRoot, { recursive: true });
  const sandbox = await fs.mkdtemp(path.join(tmpRoot, "public-outbox-persist-"));
  const outboxPath = path.join(sandbox, "outbox");
  const configPath = path.join(sandbox, "config.json");
  try {
    await writeConfig(configPath, commandNotification("not-invoked-during-enqueue"));
    await enqueue(outboxPath, configPath, completeReport({
      origin: "https://attention.test", status: "needs_attention",
      reason: "password=NeverPersist token=SecretToken 密码：ChineseSecret",
    }));
    const item = await readItem(outboxPath);
    assert.equal(item.schemaVersion, 1);
    assert.equal(item.taskId, "public_test");
    assert.equal(item.source, "test-suite");
    assert.match(item.payloadHash, /^[a-f0-9]{64}$/);
    assert.equal(item.delivered, false);
    assert.equal(item.attempts, 0);
    assert.match(item.summary, /\[REDACTED\]/);
    assert.doesNotMatch(JSON.stringify(item), /NeverPersist|SecretToken|ChineseSecret/);
    assert.equal((await fs.readdir(outboxPath)).some((name) => name.endsWith(".tmp")), false);
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

for (const disposition of ["accepted", "duplicate"]) {
  test(`${disposition}=true 会将 outbox 标记为已送达`, async () => {
    await fs.mkdir(tmpRoot, { recursive: true });
    const sandbox = await fs.mkdtemp(path.join(tmpRoot, `public-outbox-${disposition}-`));
    const outboxPath = path.join(sandbox, "outbox");
    const configPath = path.join(sandbox, "config.json");
    const commandPath = path.join(sandbox, "receiver.mjs");
    try {
      await writeFakeCommand(commandPath, { accepted: disposition === "accepted", duplicate: disposition === "duplicate" });
      await writeConfig(configPath, commandNotification(process.execPath, [commandPath]));
      await writeOutboxItem(outboxPath);
      const result = JSON.parse(await runPowerShell(worker, [
        "-OutboxPath", outboxPath, "-ConfigPath", configPath,
        "-MutexName", `Local\\PublicOutbox${process.pid}${disposition}`,
      ]));
      assert.equal(result.delivered, 1);
      const item = await readItem(outboxPath);
      assert.equal(item.delivered, true);
      assert.equal(item.disposition, disposition);
      assert.equal(item.attempts, 1);
      assert.equal(item.nextAttemptAt, null);
      assert.ok(item.deliveredAt);
    } finally {
      await fs.rm(sandbox, { recursive: true, force: true });
    }
  });
}

test("payloadHash 不匹配的 outbox 条目会被隔离且不会发送", async () => {
  await fs.mkdir(tmpRoot, { recursive: true });
  const sandbox = await fs.mkdtemp(path.join(tmpRoot, "public-outbox-integrity-"));
  const outboxPath = path.join(sandbox, "outbox");
  const configPath = path.join(sandbox, "config.json");
  const commandPath = path.join(sandbox, "receiver.mjs");
  try {
    await writeFakeCommand(commandPath, { accepted: true, duplicate: false });
    await writeConfig(configPath, commandNotification(process.execPath, [commandPath]));
    await writeOutboxItem(outboxPath);
    const [itemFile] = await fs.readdir(outboxPath);
    const itemPath = path.join(outboxPath, itemFile);
    const item = JSON.parse(await fs.readFile(itemPath, "utf8"));
    item.summary += " altered";
    await fs.writeFile(itemPath, JSON.stringify(item), "utf8");

    const output = JSON.parse(await runPowerShell(worker, [
      "-OutboxPath", outboxPath, "-ConfigPath", configPath,
      "-MutexName", `Local\\PublicOutboxIntegrity${process.pid}`,
    ]));
    assert.equal(output.processed, 0);
    assert.equal(output.delivered, 0);
    assert.equal(output.invalid, 1);
    assert.equal((await fs.readdir(outboxPath)).filter((name) => name.endsWith(".json")).length, 0);
    assert.equal((await readQuarantineItems(outboxPath)).length, 1);
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

test("缺失 payloadHash 的 outbox 条目会被隔离", async () => {
  await fs.mkdir(tmpRoot, { recursive: true });
  const sandbox = await fs.mkdtemp(path.join(tmpRoot, "public-outbox-missing-hash-"));
  const outboxPath = path.join(sandbox, "outbox");
  const configPath = path.join(sandbox, "config.json");
  const commandPath = path.join(sandbox, "receiver.mjs");
  try {
    await writeFakeCommand(commandPath, { accepted: true, duplicate: false });
    await writeConfig(configPath, commandNotification(process.execPath, [commandPath]));
    await writeOutboxItem(outboxPath);
    const [itemFile] = await fs.readdir(outboxPath);
    const itemPath = path.join(outboxPath, itemFile);
    const item = JSON.parse(await fs.readFile(itemPath, "utf8"));
    delete item.payloadHash;
    await fs.writeFile(itemPath, JSON.stringify(item), "utf8");
    const output = JSON.parse(await runPowerShell(worker, [
      "-OutboxPath", outboxPath, "-ConfigPath", configPath,
      "-MutexName", `Local\\PublicOutboxMissingHash${process.pid}`,
    ]));
    assert.equal(output.invalid, 1);
    assert.equal((await readQuarantineItems(outboxPath)).length, 1);
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

test("通知命令超时会记录 timeout 并进入退避，不会卡住 worker", async () => {
  await fs.mkdir(tmpRoot, { recursive: true });
  const sandbox = await fs.mkdtemp(path.join(tmpRoot, "public-outbox-timeout-"));
  const outboxPath = path.join(sandbox, "outbox");
  const configPath = path.join(sandbox, "config.json");
  const commandPath = path.join(sandbox, "hanging.mjs");
  try {
    await writeHangingCommand(commandPath);
    await writeConfig(configPath, commandNotification(process.execPath, [commandPath]));
    await writeOutboxItem(outboxPath, { nextAttemptAt: "2026-07-23T12:00:00.000Z" });

    const started = Date.now();
    const result = JSON.parse(await runPowerShell(worker, [
      "-OutboxPath", outboxPath, "-ConfigPath", configPath,
      "-NowUtc", "2026-07-23T12:00:00Z", "-TimeoutSeconds", "1",
      "-MutexName", `Local\\PublicOutboxTimeout${process.pid}`,
    ]));
    assert.ok(Date.now() - started < 10000);
    assert.equal(result.deferred, 1);
    const deferred = await readItem(outboxPath);
    assert.equal(deferred.lastError, "timeout");
    assert.equal(deferred.attempts, 1);
    assert.equal(deferred.delivered, false);
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

test("命令失败只延后通知并按 nextAttemptAt 重试", async () => {
  await fs.mkdir(tmpRoot, { recursive: true });
  const sandbox = await fs.mkdtemp(path.join(tmpRoot, "public-outbox-retry-"));
  const outboxPath = path.join(sandbox, "outbox");
  const configPath = path.join(sandbox, "config.json");
  const commandPath = path.join(sandbox, "receiver.mjs");
  const mutex = `Local\\PublicOutboxRetry${process.pid}`;
  try {
    await writeFakeCommand(commandPath, {}, 9);
    await writeConfig(configPath, commandNotification(process.execPath, [commandPath]));
    await writeOutboxItem(outboxPath, { nextAttemptAt: "2026-07-23T12:00:00.000Z" });

    const failed = JSON.parse(await runPowerShell(worker, [
      "-OutboxPath", outboxPath, "-ConfigPath", configPath, "-NowUtc", "2026-07-23T12:00:00Z",
      "-BaseRetryMinutes", "2", "-MutexName", mutex,
    ]));
    assert.equal(failed.deferred, 1);
    let item = await readItem(outboxPath);
    assert.equal(item.attempts, 1);
    assert.equal(item.lastError, "exit_code_9");

    await writeFakeCommand(commandPath, { accepted: true, duplicate: false });
    const early = JSON.parse(await runPowerShell(worker, [
      "-OutboxPath", outboxPath, "-ConfigPath", configPath, "-NowUtc", "2026-07-23T12:01:00Z", "-MutexName", mutex,
    ]));
    assert.equal(early.processed, 0);
    const retried = JSON.parse(await runPowerShell(worker, [
      "-OutboxPath", outboxPath, "-ConfigPath", configPath, "-NowUtc", "2026-07-23T12:02:00Z", "-MutexName", mutex,
    ]));
    assert.equal(retried.delivered, 1);
    item = await readItem(outboxPath);
    assert.equal(item.delivered, true);
    assert.equal(item.attempts, 2);
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

test("ForceDue 可立即重试尚未到期的通知", async () => {
  await fs.mkdir(tmpRoot, { recursive: true });
  const sandbox = await fs.mkdtemp(path.join(tmpRoot, "public-outbox-force-due-"));
  const outboxPath = path.join(sandbox, "outbox");
  const configPath = path.join(sandbox, "config.json");
  const commandPath = path.join(sandbox, "receiver.mjs");
  try {
    await writeFakeCommand(commandPath, { accepted: true, duplicate: false });
    await writeConfig(configPath, commandNotification(process.execPath, [commandPath]));
    await writeOutboxItem(outboxPath, { nextAttemptAt: "2099-01-01T00:00:00.000Z" });

    const result = JSON.parse(await runPowerShell(worker, [
      "-OutboxPath", outboxPath, "-ConfigPath", configPath, "-ForceDue",
      "-MutexName", `Local\\PublicOutboxForceDue${process.pid}`,
    ]));
    assert.equal(result.delivered, 1);
    assert.equal((await readItem(outboxPath)).delivered, true);
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

test("同一 source task date 只发送最新状态并将旧状态标记为 superseded", async () => {
  await fs.mkdir(tmpRoot, { recursive: true });
  const sandbox = await fs.mkdtemp(path.join(tmpRoot, "public-outbox-supersede-"));
  const outboxPath = path.join(sandbox, "outbox");
  const configPath = path.join(sandbox, "config.json");
  const commandPath = path.join(sandbox, "receiver.mjs");
  try {
    await writeFakeCommand(commandPath, { accepted: true, duplicate: false });
    await writeConfig(configPath, commandNotification(process.execPath, [commandPath]));
    await writeOutboxItem(outboxPath, {
      eventKey: "external:test-suite:public_test:2026-07-23:1111111111111111",
      status: "needs_attention", summary: "old state", createdAt: "2026-07-23T10:00:00.000Z",
    });
    await writeOutboxItem(outboxPath, {
      eventKey: "external:test-suite:public_test:2026-07-23:2222222222222222",
      status: "success", summary: "new state", createdAt: "2026-07-23T10:01:00.000Z",
    });

    const result = JSON.parse(await runPowerShell(worker, [
      "-OutboxPath", outboxPath, "-ConfigPath", configPath, "-ForceDue",
      "-MutexName", `Local\\PublicOutboxSupersede${process.pid}`,
    ]));
    assert.equal(result.processed, 1);
    assert.equal(result.delivered, 1);
    assert.equal(result.superseded, 1);
    const items = await readItems(outboxPath);
    assert.equal(items.length, 2);
    assert.equal(items.filter((item) => item.disposition === "superseded").length, 1);
    assert.equal(items.find((item) => item.disposition === "superseded").status, "needs_attention");
    assert.equal(items.filter((item) => item.disposition === "accepted").length, 1);
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

test("RetentionDays 清理超过保留期的已送达记录", async () => {
  await fs.mkdir(tmpRoot, { recursive: true });
  const sandbox = await fs.mkdtemp(path.join(tmpRoot, "public-outbox-retention-"));
  const outboxPath = path.join(sandbox, "outbox");
  const configPath = path.join(sandbox, "config.json");
  const commandPath = path.join(sandbox, "receiver.mjs");
  try {
    await writeFakeCommand(commandPath, { accepted: true, duplicate: false });
    await writeConfig(configPath, commandNotification(process.execPath, [commandPath]));
    await writeOutboxItem(outboxPath, {
      delivered: true, deliveredAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z", nextAttemptAt: null, disposition: "accepted",
    });

    const result = JSON.parse(await runPowerShell(worker, [
      "-OutboxPath", outboxPath, "-ConfigPath", configPath,
      "-NowUtc", "2026-07-23T12:00:00Z", "-RetentionDays", "14",
      "-MutexName", `Local\\PublicOutboxRetentionPrune${process.pid}`,
    ]));
    assert.equal(result.pruned, 1);
    assert.deepEqual((await fs.readdir(outboxPath)).filter((name) => name.endsWith(".json")), []);
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

test("PowerShell 5.1 fallback 安全传递空值、引号与尾随反斜杠参数", async () => {
  await fs.mkdir(tmpRoot, { recursive: true });
  const sandbox = await fs.mkdtemp(path.join(tmpRoot, "public-outbox-arguments-"));
  const outboxPath = path.join(sandbox, "outbox");
  const configPath = path.join(sandbox, "config.json");
  const commandPath = path.join(sandbox, "receiver.mjs");
  const expected = ["space value", 'quote"value', "trailing slash \\", ""];
  try {
    await writeArgumentCheckingCommand(commandPath, expected);
    await writeConfig(configPath, commandNotification(process.execPath, [commandPath, ...expected]));
    await writeOutboxItem(outboxPath);
    const result = JSON.parse(await runPowerShell(worker, [
      "-OutboxPath", outboxPath, "-ConfigPath", configPath, "-ForceDue",
      "-MutexName", `Local\\PublicOutboxArguments${process.pid}`,
    ]));
    assert.equal(result.delivered, 1);
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

test("ordinary.json 不会被隔离、处理或 retention 删除", async () => {
  await fs.mkdir(tmpRoot, { recursive: true });
  const sandbox = await fs.mkdtemp(path.join(tmpRoot, "public-outbox-ordinary-json-"));
  const outboxPath = path.join(sandbox, "outbox");
  const configPath = path.join(sandbox, "config.json");
  const commandPath = path.join(sandbox, "receiver.mjs");
  const ordinaryPath = path.join(outboxPath, "ordinary.json");
  try {
    await writeFakeCommand(commandPath, { accepted: true, duplicate: false });
    await writeConfig(configPath, commandNotification(process.execPath, [commandPath]));
    await fs.mkdir(outboxPath, { recursive: true });
    const ordinary = JSON.stringify({
      eventKey: "external:test-suite:public_test:2026-07-23:ordinary",
      delivered: true,
      deliveredAt: "2020-01-01T00:00:00.000Z",
    });
    await fs.writeFile(ordinaryPath, ordinary, "utf8");

    const result = JSON.parse(await runPowerShell(worker, [
      "-OutboxPath", outboxPath, "-ConfigPath", configPath,
      "-NowUtc", "2026-07-23T12:00:00Z", "-RetentionDays", "1",
      "-MutexName", `Local\\PublicOutboxOrdinary${process.pid}`,
    ]));
    assert.equal(result.skipped, 1);
    assert.equal(result.invalid, 0);
    assert.equal(result.quarantined, 0);
    assert.equal(result.pruned, 0);
    assert.equal(await fs.readFile(ordinaryPath, "utf8"), ordinary);
    assert.deepEqual(await readQuarantineItems(outboxPath), []);
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

test("合法 hash 文件名与 eventKey 不匹配时 fail closed 并隔离", async () => {
  await fs.mkdir(tmpRoot, { recursive: true });
  const sandbox = await fs.mkdtemp(path.join(tmpRoot, "public-outbox-event-hash-mismatch-"));
  const outboxPath = path.join(sandbox, "outbox");
  const configPath = path.join(sandbox, "config.json");
  const commandPath = path.join(sandbox, "receiver.mjs");
  try {
    await writeFakeCommand(commandPath, { accepted: true, duplicate: false });
    await writeConfig(configPath, commandNotification(process.execPath, [commandPath]));
    await writeOutboxItem(outboxPath);
    const [originalName] = await fs.readdir(outboxPath);
    const mismatchedName = `${"0".repeat(64)}.json`;
    assert.notEqual(originalName, mismatchedName);
    await fs.rename(path.join(outboxPath, originalName), path.join(outboxPath, mismatchedName));

    const result = JSON.parse(await runPowerShell(worker, [
      "-OutboxPath", outboxPath, "-ConfigPath", configPath, "-ForceDue",
      "-MutexName", `Local\\PublicOutboxEventHashMismatch${process.pid}`,
    ]));
    assert.equal(result.processed, 0);
    assert.equal(result.delivered, 0);
    assert.equal(result.invalid, 1);
    assert.equal(result.quarantined, 1);
    assert.equal(result.skipped, 0);
    assert.deepEqual((await fs.readdir(outboxPath)).filter((name) => name.endsWith(".json")), []);
    assert.equal((await readQuarantineItems(outboxPath)).length, 1);
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});
