import { createRequire } from "node:module";
import { classifyPageText } from "./detector.mjs";
import { safeLogUrl } from "./security.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const port = Number.parseInt(process.argv[2], 10);
const expectedOrigin = new URL(process.argv[3]).origin;
const maxWaitSeconds = Math.max(0, Math.min(60, Number.parseInt(process.argv[4] || "0", 10) || 0));
const allowEndpointReady = process.argv[5] === "allow-endpoint";
if (!Number.isInteger(port) || port <= 0) throw new Error("用法: node src/native-browser-inspect.mjs <port> <origin> [max-wait-seconds] [allow-endpoint]");

let browser = null;
const connectDeadline = Date.now() + Math.max(5000, Math.min(15000, maxWaitSeconds * 1000));
while (!browser && Date.now() < connectDeadline) {
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 2000 });
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
if (!browser) throw new Error("无法连接原生浏览器调试端口");
try {
  const deadline = Date.now() + maxWaitSeconds * 1000;
  let page = null;
  while (!page && Date.now() <= deadline) {
    page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => {
      try { return new URL(candidate.url()).origin === expectedOrigin; } catch { return false; }
    });
    if (!page) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!page) throw new Error("原生浏览器中没有找到目标站点页面");

  let output = null;
  do {
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {});
      const snapshot = await page.evaluate(() => ({
      bodyText: String(document.body?.innerText || "").slice(0, 30000),
      htmlLength: String(document.documentElement?.outerHTML || "").length,
      readyState: document.readyState,
      webdriver: navigator.webdriver === true,
      leichiButton: Boolean(document.querySelector("#sl-check")),
      leichiText: String(document.querySelector("#sl-text")?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300),
      hasPassword: [...document.querySelectorAll('input[type="password"]')].some((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      }),
      challengeSelectors: [...document.querySelectorAll('iframe[src*="captcha" i], iframe[src*="turnstile" i], iframe[src*="challenge" i], .cf-turnstile, .h-captcha, .g-recaptcha')]
        .some((element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        }),
      }));
      const title = await page.title();
      const state = classifyPageText({
        url: page.url(),
        title,
        bodyText: snapshot.bodyText,
        hasPassword: snapshot.hasPassword,
        challengeSelectors: snapshot.challengeSelectors,
      });
      const attendanceEndpoint = /\/(?:attendance|check[-_]?in|showup)(?:\.php)?(?:[/?#]|$)/i.test(page.url());
      const siteBodyLoaded = snapshot.bodyText.trim().length > 80;
      output = {
        origin: expectedOrigin,
        url: safeLogUrl(page.url()),
        title,
        status: state.status,
        reason: state.reason,
        siteBodyLoaded,
        htmlLength: snapshot.htmlLength,
        readyState: snapshot.readyState,
        webdriver: snapshot.webdriver,
        leichiButton: snapshot.leichiButton,
        leichiText: snapshot.leichiText,
        challengeSelectors: snapshot.challengeSelectors,
        attendanceEndpoint,
      };
      const explicitlyConfirmed = ["signed", "already_signed"].includes(state.status);
      const endpointReady = allowEndpointReady && state.status === "ready" && siteBodyLoaded && attendanceEndpoint;
      if (explicitlyConfirmed || endpointReady || Date.now() >= deadline) break;
    } catch {
      if (Date.now() >= deadline) throw new Error("原生页面在导航完成前超时");
    }
    await page.waitForTimeout(1000);
  } while (true);
  console.log(JSON.stringify(output));
} finally {
  await browser.close().catch(() => {});
}
