import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findBookmarkTarget } from "./bookmarks.mjs";
import { launchAutomationContext } from "./browser.mjs";
import { assertBookmarkNavigation } from "./security.mjs";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.dirname(sourceDirectory);
const config = JSON.parse(await fs.readFile(path.join(rootDirectory, "config", "config.json"), "utf8"));
const requestedUrl = process.argv[2];
if (!requestedUrl) throw new Error("用法: node src/search-site-checkin.mjs <url>");

const requestedOrigin = new URL(requestedUrl).origin;
const { target } = await findBookmarkTarget(config.bookmarksPath, requestedOrigin, config);
const allowedOrigins = target.allowedOrigins ?? [target.origin];
const startUrl = assertBookmarkNavigation(requestedUrl, allowedOrigins);
const patterns = {
  setting: /checkin_setting/gi,
  api: /\/api\/user\/(?:checkin|sign)/gi,
  state: /checkin[-_](?:status|history)|daily[-_]sign/gi,
  localizedText: /签到|簽到/gi,
};

const context = await launchAutomationContext(config);
try {
  const page = await context.newPage();
  await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs });
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  assertBookmarkNavigation(page.url(), allowedOrigins);
  const scriptUrls = await page.evaluate(() => [...new Set([
    ...[...document.querySelectorAll("script[src]")].map((element) => element.src),
    ...performance.getEntriesByType("resource").map((entry) => entry.name).filter((url) => /\.js(?:[?#]|$)/i.test(url)),
  ].filter(Boolean))]);
  const matchCounts = Object.fromEntries(Object.keys(patterns).map((key) => [key, 0]));
  let inspectedScriptCount = 0;
  let totalBytes = 0;
  for (const scriptUrl of scriptUrls.slice(0, 40)) {
    if (!allowedOrigins.includes(new URL(scriptUrl).origin)) continue;
    const response = await context.request.get(scriptUrl, { timeout: config.navigationTimeoutMs }).catch(() => null);
    if (!response?.ok()) continue;
    const body = await response.body();
    totalBytes += body.length;
    if (totalBytes > 35 * 1024 * 1024) break;
    inspectedScriptCount += 1;
    const text = body.toString("utf8");
    for (const [key, pattern] of Object.entries(patterns)) {
      pattern.lastIndex = 0;
      matchCounts[key] += [...text.matchAll(pattern)].length;
    }
  }
  console.log(JSON.stringify({
    discoveredScriptCount: scriptUrls.length,
    inspectedScriptCount,
    totalBytes,
    matchCounts,
  }));
} finally {
  await context.close();
}
