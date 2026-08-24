import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findBookmarkTarget } from "./bookmarks.mjs";
import { launchAutomationContext } from "./browser.mjs";
import { acceptConfiguredLoginTerms, waitForLoginSubmitEnabled } from "./protected-login-flow.mjs";
import { expandSavedPasswordLogin } from "./login-form.mjs";
import { verifyConfiguredSavedLoginSession } from "./saved-login-session.mjs";
import { assertBookmarkNavigation, safeLogUrl } from "./security.mjs";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.dirname(sourceDirectory);
const config = JSON.parse(await fs.readFile(path.join(rootDirectory, "config", "config.json"), "utf8"));
const requestedOrigin = process.argv[2];
const requestedUrl = process.argv[3] || null;
if (!requestedOrigin) throw new Error("用法: node src/saved-password-login.mjs <origin> [login-url]");
const origin = new URL(requestedOrigin).origin;
const { target } = await findBookmarkTarget(config.bookmarksPath, origin, config);
const allowedOrigins = target.allowedOrigins ?? [origin];

let loginUrl = config.savedLoginUrls?.[origin] ?? null;
if (!loginUrl && requestedUrl) {
  try {
    const candidate = new URL(requestedUrl);
    if (/\/(?:log[-_]?in|sign[-_]?in|auth)(?:[/?#]|$)|#\/(?:log[-_]?in|sign[-_]?in)(?:[/?#]|$)/i.test(candidate.href)) {
      loginUrl = candidate.href;
    }
  } catch { /* ignore invalid diagnostic URL */ }
}
loginUrl ??= `${origin}/login`;
loginUrl = assertBookmarkNavigation(loginUrl, allowedOrigins);

function pageMatchesOrigin(page) {
  try { return new URL(page.url()).origin === origin; } catch { return false; }
}

function challengeConfigured() {
  return (config.autoClickTurnstileOrigins ?? []).some((value) => {
    try {
      const candidate = new URL(value);
      return candidate.protocol === "https:"
        && !candidate.username
        && !candidate.password
        && candidate.origin === origin;
    } catch {
      return false;
    }
  });
}

const context = await launchAutomationContext(config);
try {
  const page = await context.newPage();
  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs });
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  if (!pageMatchesOrigin(page)) throw new Error("保存密码登录页面离开目标 origin");
  await acceptConfiguredLoginTerms(page, origin, config);
  if (!pageMatchesOrigin(page)) throw new Error("保存密码登录条款处理后离开目标 origin");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!await expandSavedPasswordLogin(page, origin, config)) break;
  }
  await page.locator('input[type="password"]:visible').first().waitFor({ state: "visible", timeout: 5000 }).catch(() => {});

  const password = page.locator('input[type="password"]:visible').first();
  const username = page.locator('input:visible:not([type="password"]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"])').first();
  await username.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  const initialSession = await verifyConfiguredSavedLoginSession(page, origin, config);
  let status = initialSession?.status === "valid" ? "logged_in" : "unsupported";
  if (status !== "logged_in" && await password.count() >= 1 && await username.count() >= 1) {
    const fieldsFilled = async () => Boolean(
      await username.evaluate((element) => Boolean(element.value))
      && await password.evaluate((element) => Boolean(element.value))
    );
    let filled = await fieldsFilled();
    if (!filled) {
      await username.click();
      await username.press("ArrowDown").catch(() => {});
      await username.press("Enter").catch(() => {});
      await page.waitForTimeout(800);
      if (!await password.evaluate((element) => Boolean(element.value))) {
        await password.click();
        await password.press("ArrowDown").catch(() => {});
        await password.press("Enter").catch(() => {});
        await page.waitForTimeout(800);
      }
      filled = await fieldsFilled();
    }

    if (filled) {
      let submit = null;
      for (const label of ["登录", "登入", "用户登录", "用戶登入", "Log in", "Sign in"]) {
        const candidate = page.getByRole("button", { name: label, exact: true });
        if (await candidate.count() === 1) { submit = candidate; break; }
      }
      if (!submit) {
        const candidate = page.locator('button[type="submit"]:visible, input[type="submit"]:visible');
        if (await candidate.count() === 1) submit = candidate;
      }
      if (submit) {
        const requireChallengeReady = challengeConfigured();
        const submitReady = await waitForLoginSubmitEnabled(page, submit, origin, config);
        if (!pageMatchesOrigin(page)) throw new Error("保存密码登录验证后离开目标 origin");
        if (requireChallengeReady && !submitReady) status = "needs_attention";
        else {
          await submit.click();
          await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
          await page.waitForFunction(() => {
            const visiblePassword = [...document.querySelectorAll('input[type="password"]')].some((element) => {
              const style = getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
            });
            return !visiblePassword || !/(?:^|#\/)login(?:[/?#]|$)/i.test(location.href);
          }, null, { timeout: 15000 }).catch(() => {});
          const stillHasPassword = await page.locator('input[type="password"]:visible').count() > 0;
          if (!pageMatchesOrigin(page) || stillHasPassword) status = "needs_attention";
          else {
            const finalSession = await verifyConfiguredSavedLoginSession(page, origin, config);
            status = finalSession == null || finalSession.status === "valid"
              ? "logged_in"
              : "needs_attention";
          }
        }
      } else {
        status = "needs_attention";
      }
    } else {
      status = "no_saved_credential";
    }
  }

  console.log(JSON.stringify({
    origin,
    status,
    finalUrl: safeLogUrl(page.url()),
    title: await page.title(),
  }, null, 2));
  if (status !== "logged_in") process.exitCode = 2;
} finally {
  await context.close();
}
