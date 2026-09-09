import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { powershellExecutable } from "./helpers/powershell.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scriptPath = path.join(root, "scripts", "Set-TodayAbandonment.ps1");
const helperPath = path.join(root, "scripts", "ManualAbandonment.ps1");
const verificationHelperPath = path.join(root, "scripts", "ManualVerification.ps1");
const runtimePath = path.join(root, "scripts", "Resolve-Runtime.ps1");

function localDateKey() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("");
}

const attentionStub = String.raw`const origins = [];
for (let index = 2; index < process.argv.length; index += 1) {
  if (process.argv[index] === "--origin") origins.push(process.argv[++index]);
}
const now = new Date();
const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("");
process.stdout.write(JSON.stringify({
  sourceRunId: date + "-120000",
  targets: origins.map((origin) => ({ origin, previousStatus: "no_action" })),
}));
`;

async function createFixture({ activeSession = false, pendingVerificationOrigins = [] } = {}) {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "today-abandonment-"));
  const scriptsDirectory = path.join(fixtureRoot, "scripts");
  const configDirectory = path.join(fixtureRoot, "config");
  const sourceDirectory = path.join(fixtureRoot, "src");
  const tmpDirectory = path.join(fixtureRoot, "tmp");
  await Promise.all([
    fs.mkdir(scriptsDirectory, { recursive: true }),
    fs.mkdir(configDirectory, { recursive: true }),
    fs.mkdir(sourceDirectory, { recursive: true }),
    fs.mkdir(tmpDirectory, { recursive: true }),
  ]);
  const date = localDateKey();
  await Promise.all([
    fs.copyFile(scriptPath, path.join(scriptsDirectory, "Set-TodayAbandonment.ps1")),
    fs.copyFile(helperPath, path.join(scriptsDirectory, "ManualAbandonment.ps1")),
    fs.copyFile(verificationHelperPath, path.join(scriptsDirectory, "ManualVerification.ps1")),
    fs.copyFile(runtimePath, path.join(scriptsDirectory, "Resolve-Runtime.ps1")),
    fs.writeFile(path.join(configDirectory, "config.json"), JSON.stringify({
      nodeExecutable: process.execPath,
    }), "utf8"),
    fs.writeFile(path.join(sourceDirectory, "attention-urls.mjs"), attentionStub, "utf8"),
    fs.writeFile(path.join(tmpDirectory, "manual-abandon.json"), JSON.stringify({
      schemaVersion: 1,
      date,
      createdAt: new Date().toISOString(),
      origins: ["https://one.example"],
    }), "utf8"),
    fs.writeFile(path.join(tmpDirectory, "manual-handoff.json"), JSON.stringify({
      schemaVersion: 1,
      state: "awaiting_manual_handoff",
      sourceRunId: `${date}-120000`,
      targetCount: 2,
      targets: [
        { origin: "https://two.example", previousStatus: "no_action" },
        { origin: "https://three.example", previousStatus: "needs_attention" },
      ],
    }), "utf8"),
    ...(activeSession
      ? [fs.writeFile(path.join(tmpDirectory, "manual-session.json"), "{}", "utf8")]
      : []),
    ...(pendingVerificationOrigins.length > 0
      ? [fs.writeFile(path.join(tmpDirectory, "manual-verification.json"), JSON.stringify({
        schemaVersion: 1,
        state: "pending_verification",
        createdAt: new Date().toISOString(),
        sourceRunId: `${date}-120000`,
        sourceFinishedAt: new Date().toISOString(),
        authoritativeEvidenceRequired: true,
        targets: pendingVerificationOrigins.map((origin) => ({
          origin,
          previousStatus: "no_action",
          verificationStatus: "no_action",
        })),
      }), "utf8")]
      : []),
  ]);
  return fixtureRoot;
}

test("direct today abandonment validates without opening a browser and preserves other handoff targets", async () => {
  const fixtureRoot = await createFixture();
  try {
    const result = spawnSync(powershellExecutable, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", path.join(fixtureRoot, "scripts", "Set-TodayAbandonment.ps1"),
      "-Origins", "https://two.example",
    ], { cwd: fixtureRoot, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.recorded, true);
    assert.equal(output.addedCount, 1);
    assert.equal(result.stdout.includes("two.example"), false);

    const [abandonment, handoff] = await Promise.all([
      fs.readFile(path.join(fixtureRoot, "tmp", "manual-abandon.json"), "utf8").then(JSON.parse),
      fs.readFile(path.join(fixtureRoot, "tmp", "manual-handoff.json"), "utf8").then(JSON.parse),
    ]);
    assert.deepEqual(abandonment.origins, ["https://one.example", "https://two.example"]);
    assert.equal(handoff.targetCount, 1);
    assert.deepEqual(handoff.targets.map((target) => target.origin), ["https://three.example"]);
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("direct today abandonment consumes the same pending verification target", async () => {
  const fixtureRoot = await createFixture({
    pendingVerificationOrigins: ["https://two.example"],
  });
  try {
    const result = spawnSync(powershellExecutable, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", path.join(fixtureRoot, "scripts", "Set-TodayAbandonment.ps1"),
      "-Origins", "https://two.example",
    ], { cwd: fixtureRoot, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(
      fs.access(path.join(fixtureRoot, "tmp", "manual-verification.json")),
      { code: "ENOENT" },
    );
    const abandonment = JSON.parse(await fs.readFile(
      path.join(fixtureRoot, "tmp", "manual-abandon.json"),
      "utf8",
    ));
    assert.deepEqual(abandonment.origins, ["https://one.example", "https://two.example"]);
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("direct today abandonment preserves unselected pending verification targets", async () => {
  const fixtureRoot = await createFixture({
    pendingVerificationOrigins: ["https://two.example", "https://three.example"],
  });
  try {
    const result = spawnSync(powershellExecutable, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", path.join(fixtureRoot, "scripts", "Set-TodayAbandonment.ps1"),
      "-Origins", "https://two.example",
    ], { cwd: fixtureRoot, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    const verification = JSON.parse(await fs.readFile(
      path.join(fixtureRoot, "tmp", "manual-verification.json"),
      "utf8",
    ));
    assert.equal(verification.state, "pending_verification");
    assert.deepEqual(
      verification.targets.map((target) => target.origin),
      ["https://three.example"],
    );
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("direct today abandonment refuses to race an active manual browser session", async () => {
  const fixtureRoot = await createFixture({ activeSession: true });
  try {
    const result = spawnSync(powershellExecutable, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", path.join(fixtureRoot, "scripts", "Set-TodayAbandonment.ps1"),
      "-Origins", "https://two.example",
    ], { cwd: fixtureRoot, encoding: "utf8", timeout: 30_000 });
    assert.notEqual(result.status, 0);
    const abandonment = JSON.parse(await fs.readFile(
      path.join(fixtureRoot, "tmp", "manual-abandon.json"),
      "utf8",
    ));
    assert.deepEqual(abandonment.origins, ["https://one.example"]);
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});
