import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readEffectiveBookmarkPlan } from "./effective-bookmark-plan.mjs";
import {
  normalizeReauthProvider,
  reauthAccountMetadataForOrigin,
  resultIdentity,
} from "./result-identity.mjs";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRootDirectory = path.dirname(moduleDirectory);

function readOption(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  return String(process.argv[index + 1] ?? "").trim() || fallback;
}

function enabledReauthRule(config, origin) {
  const raw = config?.reauthCheckinRules?.[new URL(origin).origin];
  if (!raw || raw.enabled === false) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("reauthCheckinRules entry must be an object");
  }
  return raw;
}

function sortedStrings(values) {
  return [...new Set((values ?? []).map((value) => String(value ?? "").trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

export function planFingerprintInput(plan, accountGroups = []) {
  const targets = (plan?.targets ?? []).map((target) => ({
    origin: String(target.origin),
    candidates: sortedStrings(target.candidates),
    allowedOrigins: sortedStrings(target.allowedOrigins),
    folderNames: sortedStrings(target.folderNames),
  })).sort((left, right) => left.origin.localeCompare(right.origin));
  const accounts = accountGroups.map((group) => ({
    origin: String(group.origin),
    identities: sortedStrings(group.identities),
    accounts: (group.accounts ?? []).map((account) => ({
      identity: String(account.identity),
      provider: String(account.provider),
    })).sort((left, right) => left.identity.localeCompare(right.identity)),
  })).sort((left, right) => left.origin.localeCompare(right.origin));
  return { version: 1, targets, accountGroups: accounts };
}

export function computePlanFingerprint(plan, accountGroups = []) {
  return createHash("sha256")
    .update(JSON.stringify(planFingerprintInput(plan, accountGroups)))
    .digest("hex");
}

export function buildCurrentPlan(plan, config = {}) {
  const targets = plan?.targets ?? [];
  const identities = targets.map((target) => resultIdentity({ origin: target.origin })).sort();
  if (new Set(identities).size !== identities.length) throw new Error("current check-in plan contains duplicate identities");

  const accountGroups = targets.flatMap((target) => {
    const rule = enabledReauthRule(config, target.origin);
    if (!rule) return [];
    const configuredAccounts = reauthAccountMetadataForOrigin(config, target.origin);
    const accounts = configuredAccounts.length > 0
      ? configuredAccounts
      : [{
        origin: new URL(target.origin).origin,
        accountKey: "default",
        provider: normalizeReauthProvider(rule.provider, "default reauth provider"),
      }];
    const plannedAccounts = accounts.map((account) => ({
      identity: resultIdentity(account),
      provider: normalizeReauthProvider(account.provider, "reauth account provider"),
    })).sort((left, right) => left.identity.localeCompare(right.identity));
    const accountIdentities = plannedAccounts.map((account) => account.identity);
    if (new Set(accountIdentities).size !== accountIdentities.length) {
      throw new Error(`current check-in plan contains duplicate account identities: ${target.origin}`);
    }
    return [{
      origin: new URL(target.origin).origin,
      identities: accountIdentities,
      accounts: plannedAccounts,
    }];
  });

  const result = {
    targetCount: targets.length,
    identities,
    accountGroupCount: accountGroups.length,
    accountIdentityCount: accountGroups.reduce((count, group) => count + group.identities.length, 0),
    accountGroups,
  };
  result.planFingerprint = computePlanFingerprint(plan, accountGroups);
  return result;
}

export async function loadCurrentPlan(rootDirectory = defaultRootDirectory) {
  const root = path.resolve(rootDirectory);
  const config = JSON.parse(await fs.readFile(path.join(root, "config", "config.json"), "utf8"));
  const plan = await readEffectiveBookmarkPlan(
    config.bookmarksPath,
    config,
    path.join(root, "data", "last-valid-bookmark-plan.json"),
  );
  return buildCurrentPlan(plan, config);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = readOption("--root", defaultRootDirectory);
  try {
    console.log(JSON.stringify(await loadCurrentPlan(root)));
  } catch (error) {
    console.error(String(error?.message ?? error));
    process.exitCode = 1;
  }
}
