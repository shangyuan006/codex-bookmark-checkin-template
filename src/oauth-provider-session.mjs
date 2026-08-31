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

function normalizeProbeStatus(value) {
  return ["valid", "invalid", "unknown"].includes(value) ? value : "unknown";
}

export async function probeSessionWithRetry(readSession, options = {}) {
  if (typeof readSession !== "function") throw new TypeError("readSession must be a function");
  const retryDelaysMs = Array.isArray(options.retryDelaysMs)
    ? options.retryDelaysMs.slice(0, 2).map((value) => Math.max(0, Math.min(5_000, Number(value) || 0)))
    : [1_000, 1_500];
  const wait = options.wait ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  if (typeof wait !== "function") throw new TypeError("wait must be a function");

  const observed = [];
  const attempts = retryDelaysMs.length + 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const status = normalizeProbeStatus(await Promise.resolve().then(readSession).catch(() => "unknown"));
    observed.push(status);
    if (status === "valid") return { status, attempts: observed.length };
    if (attempt < retryDelaysMs.length) await wait(retryDelaysMs[attempt]);
  }
  return {
    status: observed.every((status) => status === "invalid") ? "invalid" : "unknown",
    attempts: observed.length,
  };
}

export async function readProviderSession(requestContext, endpoint, navigationTimeoutMs) {
  const response = await requestContext.get(endpoint, {
    timeout: navigationTimeoutMs,
  }).catch(() => null);
  if (!response) return "unknown";
  if ([401, 403].includes(response.status())) return "invalid";
  if (!response.ok()) return "unknown";
  const value = await response.json().catch(() => null);
  return classifyLinuxDoSession(value);
}

export async function readProviderSessionPage(page, endpoint, navigationTimeoutMs) {
  const response = await page.goto(endpoint, {
    waitUntil: "domcontentloaded",
    timeout: navigationTimeoutMs,
  }).catch(() => null);
  if (!response) return "unknown";
  if ([401, 403].includes(response.status())) return "invalid";
  if (!response.ok()) return "unknown";
  const value = await response.json().catch(() => null);
  return classifyLinuxDoSession(value);
}

export async function probeProviderSessionInContext(
  context,
  endpoint,
  navigationTimeoutMs,
  options = {},
) {
  const requestProbe = await probeSessionWithRetry(
    () => readProviderSession(context.request, endpoint, navigationTimeoutMs),
    options,
  );
  if (requestProbe.status === "valid") return requestProbe;

  // A cold persistent Edge profile can expose its encrypted cookies to a
  // renderer navigation before BrowserContext.request sees them. Confirm the
  // same fixed endpoint through one background page before opening login UI.
  const page = await context.newPage();
  let pageProbe = { status: "unknown", attempts: 0 };
  try {
    const pageRetryDelaysMs = Array.isArray(options.pageRetryDelaysMs)
      ? options.pageRetryDelaysMs
      : options.retryDelaysMs;
    pageProbe = await probeSessionWithRetry(
      () => readProviderSessionPage(page, endpoint, navigationTimeoutMs),
      {
        ...(Array.isArray(pageRetryDelaysMs) ? { retryDelaysMs: pageRetryDelaysMs } : {}),
        ...(typeof options.wait === "function" ? { wait: options.wait } : {}),
      },
    );
  } finally {
    await page.close().catch(() => {});
  }
  if (pageProbe.status === "valid") {
    return { status: "valid", attempts: requestProbe.attempts + pageProbe.attempts };
  }
  return {
    status: requestProbe.status === "invalid" && pageProbe.status === "invalid"
      ? "invalid"
      : "unknown",
    attempts: requestProbe.attempts + pageProbe.attempts,
  };
}

export async function probeProviderSessionContext(context, endpoint, navigationTimeoutMs) {
  try {
    return await probeProviderSessionInContext(context, endpoint, navigationTimeoutMs);
  } finally {
    await context.close().catch(() => {});
  }
}

export async function probeProviderSession({ origin, provider, automationUserDataDir, config }) {
  const endpoint = providerSessionProbeUrl(provider);
  if (!endpoint) return { status: "not_supported" };
  await findBookmarkTarget(config.bookmarksPath, origin, config);
  const context = await launchAutomationContext({
    ...config,
    automationUserDataDir: path.resolve(rootDirectory, automationUserDataDir),
  });
  return probeProviderSessionContext(context, endpoint, config.navigationTimeoutMs);
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
