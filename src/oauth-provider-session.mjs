import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findBookmarkTarget } from "./bookmarks.mjs";
import { launchAutomationContext } from "./browser.mjs";
import { normalizeReauthProvider } from "./result-identity.mjs";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.dirname(sourceDirectory);

export function classifyLinuxDoSession(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "unknown";
  const currentUser = value.current_user;
  return currentUser && typeof currentUser === "object" && !Array.isArray(currentUser)
    ? "valid"
    : "invalid";
}

export function providerSessionProbeUrl(provider) {
  return normalizeReauthProvider(provider, "OAuth provider") === "LinuxDO"
    ? "https://linux.do/session/current.json"
    : null;
}

export async function probeProviderSession({ origin, provider, automationUserDataDir, config }) {
  const endpoint = providerSessionProbeUrl(provider);
  if (!endpoint) return { status: "not_supported" };
  await findBookmarkTarget(config.bookmarksPath, origin, config);
  const context = await launchAutomationContext({
    ...config,
    automationUserDataDir: path.resolve(rootDirectory, automationUserDataDir),
  });
  try {
    const page = await context.newPage();
    const response = await page.goto(endpoint, {
      waitUntil: "domcontentloaded",
      timeout: config.navigationTimeoutMs,
    });
    if (!response) return { status: "unknown" };
    if ([401, 403].includes(response.status())) return { status: "invalid" };
    if (!response.ok()) return { status: "unknown" };
    const value = await response.json().catch(() => null);
    return { status: classifyLinuxDoSession(value) };
  } catch {
    return { status: "unknown" };
  } finally {
    await context.close().catch(() => {});
  }
}

async function main() {
  const requestedOrigin = process.argv[2];
  const provider = process.argv[3];
  const profileIndex = process.argv.indexOf("--automation-user-data-dir");
  const automationUserDataDir = profileIndex >= 0
    ? String(process.argv[profileIndex + 1] ?? "").trim()
    : "";
  if (!requestedOrigin || !provider || !automationUserDataDir) {
    throw new Error("Usage: node src/oauth-provider-session.mjs <origin> <provider> --automation-user-data-dir <path>");
  }
  const config = JSON.parse(await fs.readFile(path.join(rootDirectory, "config", "config.json"), "utf8"));
  const result = await probeProviderSession({
    origin: new URL(requestedOrigin).origin,
    provider,
    automationUserDataDir,
    config,
  });
  console.log(JSON.stringify(result));
  if (result.status === "unknown") process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
