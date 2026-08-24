import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { powershellExecutable } from "./helpers/powershell.mjs";

const execFileAsync = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const helper = path.join(root, "scripts", "TaskRetryPolicy.ps1");

function base64Json(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

async function accountComplete(report, accountKey) {
  const command = [
    `. ${JSON.stringify(helper)}`,
    `$report = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${base64Json(report)}')) | ConvertFrom-Json`,
    `[bool](Test-ReauthAccountAuthoritativelyComplete $report '${accountKey}') | ConvertTo-Json -Compress`,
  ].join("; ");
  const { stdout } = await execFileAsync(powershellExecutable, [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command,
  ], { cwd: root, encoding: "utf8" });
  return JSON.parse(stdout.trim());
}

test("targeted Agent Router completion ignores unrelated site failures", async () => {
  const report = {
    results: [
      { origin: "https://network-failure.example", status: "error" },
      {
        origin: "https://agentrouter.org",
        status: "signed",
        accountResults: [
          { accountKey: "github", status: "already_signed" },
          { accountKey: "linuxdo", status: "signed" },
        ],
      },
    ],
  };
  assert.equal(await accountComplete(report, "linuxdo"), true);
});

test("targeted Agent Router completion remains fail-closed for unresolved accounts", async () => {
  const report = {
    results: [{
      origin: "https://agentrouter.org",
      status: "needs_attention",
      accountResults: [{ accountKey: "linuxdo", status: "needs_attention" }],
    }],
  };
  assert.equal(await accountComplete(report, "linuxdo"), false);
  assert.equal(await accountComplete(report, "missing"), false);
});
