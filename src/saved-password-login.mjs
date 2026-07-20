import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readBookmarkPlan } from "./bookmarks.mjs";
import { launchAutomationContext } from "./browser.mjs";
import { assertBookmarkNavigation, safeLogUrl } from "./security.mjs";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.dirname(sourceDirectory);
const config = JSON.parse(await fs.readFile(path.join(rootDirectory, "config", "config.json"), "utf8"));
const requestedOrigin = process.argv[2];
const requestedUrl = process.argv[3] || null;
if (!requestedOrigin) throw new Error("用法: node src/saved-password-login.mjs <origin> [login-url]");
const origin = new URL(requestedOrigin).origin;
const plan = await readBookmarkPlan(config.bookmarksPath, config);
const target = plan.targets.find((candidate) => candidate.origin === origin);
if (!target) throw new Error("目标不在签到书签范围内");
const allowedOrigins = target.allowedOrigins ?? [origin];

let loginUrl = config.savedLoginUrls?.[origin] ?? null;
if (!loginUrl && requestedUrl) {
  try {
    const candidate = new URL(requestedUrl);
    if (/\/(?:log[-_]?in|sign[-_]?in|auth)(?:[/?#]|$)/i.test(candidate.href)) loginUrl = candidate.href;
  } catch { /* ignore invalid diagnostic URL */ }
}
loginUrl ??= `${origin}/login`;
loginUrl = assertBookmarkNavigation(loginUrl, allowedOrigins);

const context = await launchAutomationContext(config);
try {
  const page = await context.newPage();
  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs });
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});

  const password = page.locator('input[type="password"]:visible');
  const username = page.locator([
    'input[type="email"]:visible',
    'input[name*="user" i]:visible',
    'input[name*="login" i]:visible',
    'input[name*="email" i]:visible',
    'input[type="text"]:visible',
  ].join(", "));
  let status = "unsupported";
  if (await password.count() === 1 && await username.count() === 1) {
    let filled = await page.evaluate(() => {
      const secret = document.querySelector('input[type="password"]');
      const identity = document.querySelector('input[type="email"], input[name*="user" i], input[name*="login" i], input[name*="email" i], input[type="text"]');
      return Boolean(secret?.value && identity?.value);
    });
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
      filled = await page.evaluate(() => {
        const secret = document.querySelector('input[type="password"]');
        const identity = document.querySelector('input[type="email"], input[name*="user" i], input[name*="login" i], input[name*="email" i], input[type="text"]');
        return Boolean(secret?.value && identity?.value);
      });
    }

    if (filled) {
      let submit = null;
      for (const label of ["登录", "登入", "Log in", "Sign in"]) {
        const candidate = page.getByRole("button", { name: label, exact: true });
        if (await candidate.count() === 1) { submit = candidate; break; }
      }
      if (!submit) {
        const candidate = page.locator('button[type="submit"]:visible, input[type="submit"]:visible');
        if (await candidate.count() === 1) submit = candidate;
      }
      if (submit) {
        await submit.click();
        await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(1000);
        const stillHasPassword = await page.locator('input[type="password"]:visible').count() > 0;
        status = stillHasPassword ? "needs_attention" : "logged_in";
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
