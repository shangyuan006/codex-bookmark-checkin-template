import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { powershellExecutable } from "./helpers/powershell.mjs";

const execFileAsync = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const helper = path.join(root, "scripts", "NativeFallbackPolicy.ps1");

function base64Json(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

test("native fallback selects only configured unresolved origins", async () => {
  const config = {
    nativeWafPreflightUrls: [],
    nativeChallengePreflight: [
      { url: "https://fallback.test/dashboard", fallbackOnly: true },
      { url: "https://normal.test/", fallbackOnly: false },
    ],
  };
  const report = {
    runState: "final",
    isComplete: true,
    plannedTotal: 4,
    processedTotal: 4,
    results: [
      { origin: "https://fallback.test", status: "needs_attention" },
      { origin: "https://normal.test", status: "needs_attention" },
      { origin: "https://login.test", status: "login_required" },
      { origin: "https://done.test", status: "signed" },
    ],
  };
  const command = [
    `. ${JSON.stringify(helper)}`,
    "function Test-IsCompleteFinalReport($Report) { return $Report.runState -eq 'final' -and $Report.isComplete -eq $true -and $Report.processedTotal -ge $Report.plannedTotal }",
    `$config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${base64Json(config)}')) | ConvertFrom-Json`,
    `$report = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${base64Json(report)}')) | ConvertFrom-Json`,
    "$origins = @(Get-NativeFallbackOnlyOrigins $config)",
    "[pscustomobject]@{ origins = $origins; retry = @(Get-NativeFallbackRetryOrigins $report $origins); needsRetry = (Test-NeedsNativeFallbackRetry $report $origins) } | ConvertTo-Json -Compress",
  ].join("; ");
  const { stdout } = await execFileAsync(powershellExecutable, [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command,
  ], { cwd: root, encoding: "utf8" });
  const result = JSON.parse(stdout.trim());
  assert.deepEqual(result.origins, ["https://fallback.test"]);
  assert.deepEqual(result.retry, ["https://fallback.test"]);
  assert.equal(result.needsRetry, true);
});
