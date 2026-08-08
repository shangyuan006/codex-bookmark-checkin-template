import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findBookmarkTarget } from "./bookmarks.mjs";
import { launchAutomationContext } from "./browser.mjs";
import { assertBookmarkNavigation } from "./security.mjs";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.dirname(sourceDirectory);
const config = JSON.parse(await fs.readFile(path.join(rootDirectory, "config", "config.json"), "utf8"));
const requestedOrigin = process.argv[2];
const shouldPost = process.argv.includes("--post");
if (!requestedOrigin) throw new Error("用法: node src/checkin-api.mjs <origin> [--post]");

const origin = new URL(requestedOrigin).origin;
const { target } = await findBookmarkTarget(config.bookmarksPath, origin, config);
const allowedOrigins = target.allowedOrigins ?? [target.origin];
const startUrl = assertBookmarkNavigation(new URL(requestedOrigin, origin).href, allowedOrigins);

const context = await launchAutomationContext(config);
try {
  const page = await context.newPage();
  await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs });
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  assertBookmarkNavigation(page.url(), allowedOrigins);
  const month = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
  }).format(new Date());
  const result = await page.evaluate(async ({ month, shouldPost }) => {
    let userId = null;
    for (const key of ["user", "user_info", "userInfo"]) {
      try {
        const value = JSON.parse(localStorage.getItem(key) || "null");
        userId = value?.id ?? value?.user?.id ?? null;
        if (userId != null) break;
      } catch { /* continue */ }
    }
    if (userId == null) {
      try {
        const selfResponse = await fetch("/api/user/self", { credentials: "include", headers: { Accept: "application/json" } });
        const selfBody = await selfResponse.json();
        userId = selfBody?.data?.id ?? selfBody?.data?.user?.id ?? null;
      } catch { /* continue without user header */ }
    }
    const endpoint = shouldPost ? "/api/user/checkin" : `/api/user/checkin?month=${month}`;
    const response = await fetch(endpoint, {
      method: shouldPost ? "POST" : "GET",
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(userId == null ? {} : { "New-Api-User": String(userId) }),
      },
    });
    const responseText = await response.text();
    return {
      httpStatus: response.status,
      ok: response.ok,
      userHeaderApplied: userId != null,
      evidence: {
        signed: /签到成功|簽到成功|check.?in success|successfully checked/i.test(responseText),
        alreadySigned: /已签到|已簽到|already checked|already signed/i.test(responseText),
        featureDisabled: /未启用|未啟用|not enabled/i.test(responseText),
        challengeRequired: /turnstile|captcha|人机|人機/i.test(responseText),
      },
    };
  }, { month, shouldPost });
  console.log(JSON.stringify({ method: shouldPost ? "POST" : "GET", ...result }));
} finally {
  await context.close();
}
