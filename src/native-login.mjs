import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectOverCdpWithRetry } from "./native-cdp.mjs";
import { expandSavedPasswordLogin } from "./login-form.mjs";
import { verifyConfiguredSavedLoginSession } from "./saved-login-session.mjs";
import { createLoginDiagnostics } from './login-diagnostics.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const rootDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = Number.parseInt(process.argv[2], 10);
const expectedOrigin = new URL(process.argv[3]).origin;
if (!Number.isInteger(port) || port <= 0) throw new Error("用法: node src/native-login.mjs <port> <origin>");

const diagnostics = createLoginDiagnostics({ expectedOrigin,
  emit: checkpoint => process.stderr.write(`${JSON.stringify(checkpoint)}\n`) });
let browser = null;
let status = "needs_attention";
let page = null;
try {
  diagnostics.checkpoint('navigation');
  const config = JSON.parse(fs.readFileSync(path.join(rootDirectory, "config", "config.json"), "utf8"));
  browser = await connectOverCdpWithRetry(chromium, port, {
    timeoutMs: 15000, attemptTimeoutMs: 2000, retryDelayMs: 500,
  });
  page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => {
    try { return new URL(candidate.url()).origin === expectedOrigin; } catch { return false; }
  });
  if (!page) throw new Error("原生浏览器中没有找到目标登录页");
  page.on('request', diagnostics.observeRequest);
  page.on('response', diagnostics.observeResponse);
  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  diagnostics.checkpoint('form_expand');
  await expandSavedPasswordLogin(page, expectedOrigin, config);
  const password = page.locator('input[type="password"]:visible');
  const username = page.locator('input[type="email"]:visible, input[name*="user" i]:visible, input[name*="login" i]:visible, input[name*="email" i]:visible, input[type="text"]:visible');
  const formUnique = await password.count() === 1 && await username.count() === 1;
  diagnostics.checkpoint('form_fields', { formUnique });
  if (!formUnique) {
    status = "unsupported";
  } else {
    const fieldsFilled = async () => Boolean(
      await username.evaluate((element) => Boolean(element.value))
      && await password.evaluate((element) => Boolean(element.value))
    );
    let filled = await fieldsFilled();
    if (!filled) {
      diagnostics.checkpoint('autofill');
      await username.click();
      await username.press("ArrowDown").catch(() => {});
      await username.press("Enter").catch(() => {});
      await page.waitForTimeout(800);
      filled = await fieldsFilled();
    }

    diagnostics.checkpoint('credentials_ready', { credentialsReady: filled });
    if (!filled) {
      status = "no_saved_credential";
    } else {
      const challengeDeadline = Date.now() + 55000;
      const challengeStartedAt = Date.now();
      let checkboxClicked = false;
      let challengeReady = false;
      while (Date.now() < challengeDeadline) {
        const challenge = await page.evaluate(() => {
          const response = document.querySelector('input[name="cf-turnstile-response"], textarea[name="g-recaptcha-response"], textarea[name="h-captcha-response"]');
          const frame = document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile" i], iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i]');
          const widget = document.querySelector('.cf-turnstile, .g-recaptcha, .h-captcha, [data-sitekey]');
          return { solved: Boolean(response?.value && response.value.length > 20), hasFrame: Boolean(frame), hasWidget: Boolean(widget) };
        });
        if (challenge.solved) { challengeReady = true; break; }
        if (!challenge.hasFrame && !challenge.hasWidget && Date.now() - challengeStartedAt > 8000) {
          challengeReady = true;
          break;
        }
        if (!checkboxClicked) {
          const frame = page.frameLocator('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile" i]');
          const checkbox = frame.locator('input[type="checkbox"]');
          if (await checkbox.count().catch(() => 0) === 1) {
            await checkbox.click({ timeout: 5000 }).catch(() => {});
            checkboxClicked = true;
          }
        }
        await page.waitForTimeout(1500);
      }

      if (!challengeReady) {
        status = "needs_attention";
      }
      diagnostics.checkpoint(challengeReady ? 'challenge_ready' : 'challenge_blocked');
      let submit = null;
      for (const label of ["登录", "登入", "Log in", "Sign in"]) {
        const candidate = page.getByRole("button", { name: label, exact: true });
        if (await candidate.count() === 1) { submit = candidate; break; }
      }
      if (!submit) {
        const candidate = page.locator('button[type="submit"]:visible, input[type="submit"]:visible');
        if (await candidate.count() === 1) submit = candidate;
      }
      diagnostics.checkpoint('submit_control', { submitAvailable: Boolean(submit) });
      if (!challengeReady) diagnostics.checkpoint('challenge_blocked');
      if (submit && challengeReady) {
        diagnostics.checkpoint('submit_click', { submitAttempts: 1 });
        await submit.click();
        diagnostics.checkpoint('post_submit', { submitClicksCompleted: 1 });
        await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(1500);
        let stillHasPassword = await page.locator('input[type="password"]:visible').count() > 0;
        if (stillHasPassword) {
          // Some forms render Turnstile only after the first submit.  Give the
          // newly-created widget one bounded native-browser pass, then submit
          // once more when its response token is present.
          const secondDeadline = Date.now() + 55000;
          let secondSolved = false;
          let secondCheckboxClicked = false;
          while (Date.now() < secondDeadline) {
            const challenge = await page.evaluate(() => {
              const response = document.querySelector('input[name="cf-turnstile-response"], textarea[name="g-recaptcha-response"], textarea[name="h-captcha-response"]');
              const frame = document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile" i]');
              const widget = document.querySelector('.cf-turnstile, [data-sitekey]');
              return { solved: Boolean(response?.value && response.value.length > 20), hasFrame: Boolean(frame), hasWidget: Boolean(widget) };
            });
            if (challenge.solved) { secondSolved = true; break; }
            if (!challenge.hasFrame && !challenge.hasWidget) {
              await page.waitForTimeout(1500);
              continue;
            }
            if (!secondCheckboxClicked) {
              const frame = page.frameLocator('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile" i]');
              const checkbox = frame.locator('input[type="checkbox"]');
              if (await checkbox.count().catch(() => 0) === 1) {
                await checkbox.click({ timeout: 5000 }).catch(() => {});
                secondCheckboxClicked = true;
              }
            }
            await page.waitForTimeout(1500);
          }
          if (secondSolved) {
            diagnostics.checkpoint('submit_click', { submitAttempts: 2 });
            await submit.click();
            diagnostics.checkpoint('post_submit', { submitClicksCompleted: 2 });
            await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
            await page.waitForTimeout(1500);
            stillHasPassword = await page.locator('input[type="password"]:visible').count() > 0;
          }
        }
        status = stillHasPassword ? "needs_attention" : "logged_in";
      }
    }
  }

  const finalLocation = new URL(page.url());
  const visiblePassword = await page.locator('input[type="password"]:visible').count() > 0;
  if (finalLocation.origin === expectedOrigin
    && !/\/(?:log[-_]?in|sign[-_]?in|auth)(?:[/?#]|$)/i.test(finalLocation.href)
    && !visiblePassword) {
    status = "logged_in";
  }
  diagnostics.checkpoint(undefined, { postLoginReadback: true });
  if (status === "logged_in") {
    diagnostics.checkpoint('session_present');
    diagnostics.checkpoint('session_verification');
    const verifiedSession = await verifyConfiguredSavedLoginSession(page, expectedOrigin, config);
    diagnostics.checkpoint('session_verification', { configuredSessionCheck: Boolean(verifiedSession),
      sessionAccepted: !verifiedSession || verifiedSession.status === 'valid' });
    if (verifiedSession && verifiedSession.status !== "valid") {
      status = "needs_attention";
    } else {
      diagnostics.checkpoint('completed');
      await page.waitForTimeout(3000);
    }
  }
} catch {
  status = 'needs_attention';
  diagnostics.checkpoint(undefined, { helperError: true });
} finally {
  page?.off('request', diagnostics.observeRequest);
  page?.off('response', diagnostics.observeResponse);
  await browser?.close().catch(() => {});
}
console.log(JSON.stringify({ origin: expectedOrigin, status, ...diagnostics.snapshot() }));
if (status !== 'logged_in') process.exitCode = 2;
