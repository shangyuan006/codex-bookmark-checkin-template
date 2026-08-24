import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workflowUrl = new URL("../.github/workflows/ci.yml", import.meta.url);
const gitleaksConfigUrl = new URL("../.gitleaks.toml", import.meta.url);

test("CI pins third-party actions and grants read-only repository access", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.match(workflow, /^permissions:\s*\r?\n\s+contents: read$/m);
  assert.ok(workflow.includes(
    "uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  ));
  assert.ok(workflow.includes(
    "uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
  ));
  assert.doesNotMatch(workflow, /uses: actions\/(?:checkout|setup-node)@v\d+\b/);
});

test("CI verifies Gitleaks before scanning the complete Git history", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /\$version = '8\.30\.1'/);
  assert.match(workflow, /Get-FileHash -Algorithm SHA256/);
  assert.match(workflow, /d29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e/);
  assert.match(workflow, /gitleaks git --config \.gitleaks\.toml --redact --no-banner --exit-code 1 \./);
});

test("CI retains dependency, test, public-safety, and audit gates", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  for (const command of [
    "npm ci",
    "npm test",
    "./scripts/Scan-PublicSafety.ps1",
    "npm audit --omit=dev",
  ]) {
    assert.ok(workflow.includes(command), `missing CI gate: ${command}`);
  }
});

test("Gitleaks keeps default rules and narrowly allows the public OCR alphabet", async () => {
  const config = await readFile(gitleaksConfigUrl, "utf8");

  assert.match(config, /^\[extend\]\s*\r?\nuseDefault = true$/m);
  assert.match(config, /regexTarget = "secret"/);
  assert.match(config, /\^ABCDEFGHJKLMNPQRSTUVWXYZ23456789\$/);
});
