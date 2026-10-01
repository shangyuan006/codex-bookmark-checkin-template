import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findBookmarkTarget } from "./bookmarks.mjs";
import { launchAutomationContext } from "./browser.mjs";
import { normalizeReauthProvider } from "./result-identity.mjs";
import { writeLinuxDoProbeDiagnostic } from "./linuxdo-probe-diagnostics.mjs";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.dirname(sourceDirectory);

export function classifyLinuxDoSession(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "unknown";
  if (!Object.hasOwn(value, "current_user")) return "unknown";
  const currentUser = value.current_user;
  if (currentUser === null) return "invalid";
  return currentUser && typeof currentUser === "object" && !Array.isArray(currentUser)
    ? "valid"
    : "unknown";
}

export function linuxDoProbeFailureStage(result) {
  if (result?.status === "valid") return null;
  // Historical challenge observations do not override an authoritative
  // logged-out response. Only an unresolved probe may stop automatic retries.
  if (result?.status === "unknown") {
    if (result.rateLimited === true) return "linuxdo_session_rate_limited";
    if (result.challengeObserved === true) return "linuxdo_session_challenge";
  }
  return "linuxdo_session";
}

export function providerSessionProbeUrl(provider) {
  return normalizeReauthProvider(provider, "OAuth provider") === "LinuxDO"
    ? "https://linux.do/session/current.json"
    : null;
}

function normalizeProbeStatus(value) {
  return ["valid", "invalid", "unknown"].includes(value) ? value : "unknown";
}

function responseType(contentType) {
  if (/json/i.test(contentType ?? "")) return "json";
  if (/html/i.test(contentType ?? "")) return "html";
  return contentType ? "other" : "unavailable";
}

function observe(callback, value) {
  try { callback?.(value); } catch { /* Diagnostics must not change the probe result. */ }
}

export async function probeSessionWithRetry(readSession, options = {}) {
  if (typeof readSession !== "function") throw new TypeError("readSession must be a function");
  const retryDelaysMs = Array.isArray(options.retryDelaysMs)
    ? options.retryDelaysMs.slice(0, 2).map((value) => Math.max(0, Math.min(5_000, Number(value) || 0)))
    : [1_000, 1_500];
  const wait = options.wait ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  if (typeof wait !== "function") throw new TypeError("wait must be a function");
  if (options.shouldStop !== undefined && typeof options.shouldStop !== "function") {
    throw new TypeError("shouldStop must be a function");
  }

  const observed = [];
  const attempts = retryDelaysMs.length + 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const status = normalizeProbeStatus(await Promise.resolve().then(readSession).catch(() => "unknown"));
    observed.push(status);
    if (status === "valid") return { status, attempts: observed.length };
    if (options.shouldStop?.()) break;
    if (attempt < retryDelaysMs.length) await wait(retryDelaysMs[attempt]);
  }
  return {
    status: observed.every((status) => status === "invalid") ? "invalid" : "unknown",
    attempts: observed.length,
  };
}

export async function readProviderSession(requestContext, endpoint, navigationTimeoutMs, onObservation) {
  const started = Date.now();
  const response = await requestContext.get(endpoint, {
    timeout: navigationTimeoutMs,
  }).catch(() => null);
  if (!response) {
    observe(onObservation, { step: "session", classification: "unknown", responseType: "unavailable",
      error: "request_failed", elapsedMs: Date.now() - started });
    return "unknown";
  }
  const headers = await Promise.resolve().then(() => response.headers?.()).catch(() => ({})) ?? {};
  const metadata = { step: "session", httpStatus: response.status(),
    responseType: responseType(headers["content-type"]), challenge: headers["cf-mitigated"] === "challenge" };
  // A WAF response describes the probe, not the encrypted login session.
  if (metadata.challenge || metadata.responseType === "html") {
    observe(onObservation, { ...metadata, classification: "unknown", elapsedMs: Date.now() - started });
    return "unknown";
  }
  // Discourse deliberately returns 404 from /session/current.json when the
  // browser is not authenticated. Treat it as a definitive logged-out state.
  if ([401, 403, 404].includes(response.status())) {
    observe(onObservation, { ...metadata, classification: "invalid", elapsedMs: Date.now() - started });
    return "invalid";
  }
  if (!response.ok()) {
    observe(onObservation, { ...metadata, classification: "unknown", elapsedMs: Date.now() - started });
    return "unknown";
  }
  let parsed = false;
  const value = await response.json().then((result) => {
    parsed = true;
    return result;
  }).catch(() => null);
  const classification = parsed ? classifyLinuxDoSession(value) : "unknown";
  observe(onObservation, { ...metadata, classification,
    ...(!parsed ? { error: "json_parse_failed" } : {}), elapsedMs: Date.now() - started });
  return classification;
}

export async function readProviderSessionPage(page, endpoint, navigationTimeoutMs, onObservation) {
  let endpointUrl;
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    return "unknown";
  }
  if (endpointUrl.protocol !== "https:") return "unknown";

  let currentOrigin = null;
  try { currentOrigin = new URL(page.url()).origin; } catch { /* navigate below */ }
  if (currentOrigin !== endpointUrl.origin) {
    const landingStarted = Date.now();
    const landingResponse = await page.goto(new URL("/", endpointUrl).href, {
      waitUntil: "domcontentloaded",
      timeout: navigationTimeoutMs,
    }).catch(() => null);
    if (!landingResponse) {
      observe(onObservation, { step: "landing", classification: "unknown", responseType: "unavailable",
        error: "navigation_failed", elapsedMs: Date.now() - landingStarted });
      return "unknown";
    }
    const headers = await Promise.resolve().then(() => landingResponse.headers?.()).catch(() => ({})) ?? {};
    observe(onObservation, { step: "landing", httpStatus: landingResponse.status?.(),
      responseType: responseType(headers["content-type"]), challenge: headers["cf-mitigated"] === "challenge",
      elapsedMs: Date.now() - landingStarted });
  }

  const timeoutMs = Math.max(1_000, Math.min(120_000, Number(navigationTimeoutMs) || 15_000));
  const sessionStarted = Date.now();
  const outcome = await page.evaluate(async ({ sessionEndpoint, requestTimeoutMs }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetch(sessionEndpoint, {
        cache: "no-store",
        credentials: "include",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      const contentType = response.headers.get("content-type") ?? "";
      const metadata = { httpStatus: response.status,
        responseType: /json/i.test(contentType) ? "json" : /html/i.test(contentType) ? "html"
          : contentType ? "other" : "unavailable",
        challenge: response.headers.get("cf-mitigated") === "challenge" };
      if (metadata.challenge || metadata.responseType === "html") return { ...metadata, status: "unknown" };
      if ([401, 403, 404].includes(response.status)) return { ...metadata, status: "invalid" };
      if (!response.ok) return { ...metadata, status: "unknown" };
      let parsed = false;
      const value = await response.json().then((result) => {
        parsed = true;
        return result;
      }).catch(() => null);
      if (!parsed) return { ...metadata, status: "unknown", error: "json_parse_failed" };
      const currentUser = value?.current_user;
      return { ...metadata,
        status: !value || typeof value !== "object" || Array.isArray(value)
          || !Object.hasOwn(value, "current_user") ? "unknown"
          : currentUser === null ? "invalid"
          : currentUser && typeof currentUser === "object" && !Array.isArray(currentUser)
            ? "valid" : "unknown" };
    } catch {
      return { status: "unknown", error: "fetch_failed" };
    } finally {
      clearTimeout(timer);
    }
  }, { sessionEndpoint: endpointUrl.href, requestTimeoutMs: timeoutMs })
    .catch(() => ({ status: "unknown", error: "fetch_failed" }));
  const classification = normalizeProbeStatus(typeof outcome === "string" ? outcome : outcome?.status);
  observe(onObservation, { step: "session", classification,
    ...(typeof outcome === "object" && outcome ? outcome : {}), elapsedMs: Date.now() - sessionStarted });
  return classification;
}

export async function waitForLinuxDoProbePage(page, {
  timeoutMs = 20_000, stableMs = 2_000, pollMs = 500, now = Date.now,
  wait = (delayMs) => page.waitForTimeout(delayMs), shouldStop,
} = {}) {
  const budget = Math.max(0, Math.min(20_000, Number(timeoutMs) || 0));
  const interval = Math.max(100, Math.min(1_000, Number(pollMs) || 500));
  const stableFor = Math.max(500, Math.min(5_000, Number(stableMs) || 2_000));
  const deadline = now() + budget;
  let readySince = null;
  for (let poll = 0; poll <= Math.ceil(budget / interval); poll += 1) {
    if (page.isClosed?.() || shouldStop?.()) return false;
    try {
      if (new URL(page.url()).origin !== "https://linux.do") return false;
    } catch { return false; }
    const ready = await page.evaluate(() => {
      if (location.origin !== "https://linux.do" || document.readyState === "loading") return false;
      const visible = (element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return box.width > 0 && box.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const challenge = [...document.querySelectorAll([
        '#challenge-running', '#challenge-stage', '#cf-challenge-running', '.cf-turnstile',
        'iframe[src*="challenges.cloudflare.com" i]',
        'iframe[src*="/cdn-cgi/challenge-platform/" i]',
      ].join(", "))].some(visible);
      return !challenge && Boolean(document.querySelector('#main-outlet, #main-outlet-wrapper'));
    }).catch(() => false);
    if (ready === true) {
      readySince ??= now();
      if (now() - readySince >= stableFor) return true;
    } else {
      readySince = null;
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await wait(Math.min(interval, remaining));
  }
  return false;
}

export async function probeProviderSessionInContext(
  context,
  endpoint,
  navigationTimeoutMs,
  options = {},
) {
  let requestAttempt = 0;
  const blocked = { request: false, page: false };
  let challengeObserved = false;
  let rateLimited = false;
  const report = (surface, attempt, item) => {
    challengeObserved ||= item.challenge === true;
    rateLimited ||= item.httpStatus === 429;
    blocked[surface] ||= item.challenge === true || item.httpStatus === 429;
    observe(options.onObservation, { surface, attempt, ...item });
  };
  const requestProbe = await probeSessionWithRetry(
    () => readProviderSession(context.request, endpoint, navigationTimeoutMs,
      (item) => report("request", ++requestAttempt, item)),
    { ...options, shouldStop: () => blocked.request || options.shouldStop?.() },
  );
  if (requestProbe.status === "valid") return requestProbe;

  // A cold persistent Edge profile can expose its encrypted cookies to a
  // renderer before BrowserContext.request sees them. Warm the provider home
  // page, then fetch the fixed endpoint in-page so the probe never navigates a
  // user-visible tab to Discourse's intentional logged-out 404 response.
  const page = await context.newPage();
  let pageProbe = { status: "unknown", attempts: 0 };
  try {
    let pageAttempt = 0;
    const pageRetryDelaysMs = Array.isArray(options.pageRetryDelaysMs)
      ? options.pageRetryDelaysMs
      : options.retryDelaysMs;
    pageProbe = await probeSessionWithRetry(
      () => {
        const attempt = ++pageAttempt;
        return readProviderSessionPage(page, endpoint, navigationTimeoutMs,
          (item) => report("page", attempt, item));
      },
      {
        ...(Array.isArray(pageRetryDelaysMs) ? { retryDelaysMs: pageRetryDelaysMs } : {}),
        ...(typeof options.wait === "function" ? { wait: options.wait } : {}),
        shouldStop: () => blocked.page || options.shouldStop?.(),
      },
    );
    // Wait on the existing document, not on repeated blocked endpoint requests.
    // A settled page only permits one fresh session read; it never proves login.
    if (pageProbe.status !== "valid" && blocked.page && !rateLimited
      && Number(options.challengeWaitMs) > 0 && !options.shouldStop?.()) {
      const started = Date.now();
      const pageReady = await waitForLinuxDoProbePage(page, {
        timeoutMs: options.challengeWaitMs,
        ...(options.challengeSettleOptions ?? {}),
        shouldStop: options.shouldStop,
      });
      observe(options.onObservation, { surface: "page", step: "settle", pageReady,
        elapsedMs: Date.now() - started });
      if (pageReady && !options.shouldStop?.()) {
        const classification = await readProviderSessionPage(page, endpoint, navigationTimeoutMs,
          (item) => report("page", pageProbe.attempts + 1, item));
        pageProbe = { status: classification, attempts: pageProbe.attempts + 1 };
      }
    }
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
    ...(challengeObserved ? { challengeObserved: true } : {}),
    ...(rateLimited ? { rateLimited: true } : {}),
  };
}

export async function probeProviderSessionContext(context, endpoint, navigationTimeoutMs, options = {}) {
  try {
    return await probeProviderSessionInContext(context, endpoint, navigationTimeoutMs, options);
  } finally {
    await context.close().catch(() => {});
  }
}

export async function probeProviderSession({ origin, provider, automationUserDataDir, config, onObservation }) {
  const endpoint = providerSessionProbeUrl(provider);
  if (!endpoint) return { status: "not_supported" };
  await findBookmarkTarget(config.bookmarksPath, origin, config);
  const context = await launchAutomationContext({
    ...config,
    automationUserDataDir: path.resolve(rootDirectory, automationUserDataDir),
  });
  return probeProviderSessionContext(context, endpoint, config.navigationTimeoutMs, {
    onObservation, challengeWaitMs: Math.min(20_000, Number(config.cloudflareWaitMs) || 20_000),
  });
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
  const origin = new URL(requestedOrigin).origin;
  const stageIndex = process.argv.indexOf("--diagnostic-stage");
  const stage = stageIndex >= 0 && origin === "https://agentrouter.org" && /linux\s*do/i.test(provider)
    ? process.argv[stageIndex + 1] : null;
  const observations = [];
  const started = Date.now();
  let result;
  try {
    result = await probeProviderSession({ origin, provider, automationUserDataDir, config,
      onObservation: (item) => observations.push(item) });
  } finally {
    if (stage) await writeLinuxDoProbeDiagnostic({ stage, status: result?.status ?? "unknown",
      attempts: result?.attempts ?? observations.length, elapsedMs: Date.now() - started, observations },
    { retentionDays: config.logRetentionDays });
  }
  console.log(JSON.stringify(result));
  if (result.status === "unknown") process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
