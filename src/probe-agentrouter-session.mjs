import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getConfiguredReauthAccounts,
  inspectConfiguredReauthLogin,
} from "./reauth-checkin.mjs";

const rootDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const originArgument = process.argv[2];
const accountKey = String(process.argv[3] ?? "").trim();

function print(status) {
  process.stdout.write(`${JSON.stringify({ status })}\n`);
}

try {
  const origin = new URL(originArgument).origin;
  const config = JSON.parse(await fs.readFile(path.join(rootDirectory, "config", "config.json"), "utf8"));
  const rawRule = config.reauthCheckinRules?.[origin];
  const target = {
    origin,
    candidates: [rawRule?.pageUrl ?? origin],
    allowedOrigins: [origin],
  };
  const account = getConfiguredReauthAccounts(target, config)
    .find((candidate) => candidate.accountKey === accountKey);
  if (!account) throw new Error("configured Agent Router account was not found");
  const login = await inspectConfiguredReauthLogin({
    ...config,
    automationUserDataDir: account.automationUserDataDir,
  }, account);
  print(login.valid && login.explicitLoginSuccess ? "already_signed" : "needs_attention");
} catch {
  print("needs_attention");
  process.exitCode = 2;
}
