import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findBookmarkTarget } from "./bookmarks.mjs";
import {
  CHALLENGE_SELECTOR,
  challengeEvidenceIsUnresolved,
  launchAutomationContext,
} from "./browser.mjs";
import { classifyPageText } from "./detector.mjs";
import { assertBookmarkNavigation } from "./security.mjs";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.dirname(sourceDirectory);
const config = JSON.parse(await fs.readFile(path.join(rootDirectory, "config", "config.json"), "utf8"));
const requestedOrigin = process.argv[2];
const requestedUrl = process.argv[3] || null;
if (!requestedOrigin) throw new Error("用法: node src/inspect-target.mjs <origin> [url]");

const { target } = await findBookmarkTarget(config.bookmarksPath, requestedOrigin, config);
const allowedOrigins = target.allowedOrigins ?? [target.origin];
const candidates = requestedUrl
  ? [assertBookmarkNavigation(requestedUrl, allowedOrigins)]
  : target.candidates.map((candidate) => assertBookmarkNavigation(candidate, allowedOrigins));

const context = await launchAutomationContext(config);
try {
  for (let index = 0; index < candidates.length; index += 1) {
    const page = await context.newPage();
    try {
      const response = await page.goto(candidates[index], {
        waitUntil: "domcontentloaded",
        timeout: config.navigationTimeoutMs,
      });
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      const evidence = await page.evaluate((challengeSelector) => {
        const visible = (element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const bodyText = String(document.body?.innerText ?? "").slice(0, 30000);
        const controls = [...document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')]
          .filter(visible);
        const controlText = (element) => String(
          element.innerText || element.value || element.getAttribute("aria-label") || "",
        ).replace(/\s+/g, " ").trim();
        const challengeMatches = [...document.querySelectorAll(challengeSelector)];
        const challengeRoots = challengeMatches.filter((element) => !challengeMatches.some((candidate) => (
          candidate !== element && candidate.contains(element)
        )));
        const challengeEvidence = challengeRoots.map((element) => {
          const roots = [element, element.shadowRoot].filter(Boolean);
          const stateElements = [element, ...roots.flatMap((root) => [...root.querySelectorAll(
            'input[type="checkbox"], [aria-checked], [data-state], [data-status], [class*="success" i], [class*="verified" i], [class*="solved" i], [class*="complete" i], [class*="passed" i]',
          )])];
          const responseElements = roots.flatMap((root) => [...root.querySelectorAll(
            'textarea[name*="response" i], input[name*="response" i], textarea[name*="captcha" i], input[name*="captcha" i], input[name="altcha" i], [data-response]',
          )]);
          const explicitWidget = element.matches(
            'iframe, .cf-turnstile, .h-captcha, .g-recaptcha, cap-widget, altcha-widget, [data-altcha], [data-cap-api-endpoint]',
          );
          return {
            visible: visible(element),
            challengeLike: explicitWidget || responseElements.length > 0 || roots.some((root) => root.querySelector(
              'iframe[src*="captcha" i], iframe[src*="turnstile" i], iframe[src*="challenge" i], img[src*="captcha" i], img[alt*="captcha" i], canvas, input[type="checkbox"], [role="checkbox"], input[type="text"][name*="captcha" i], input[type="text"][id*="captcha" i], [data-sitekey]',
            )),
            resolvedState: stateElements.some((candidate) => {
              const className = typeof candidate.className === "string" ? candidate.className : "";
              const stateText = [candidate.getAttribute("data-state"), candidate.getAttribute("data-status"), className]
                .filter(Boolean).join(" ");
              return candidate.checked === true
                || candidate.getAttribute("aria-checked") === "true"
                || /(?:^|[-_\s])(?:success|verified|solved|complete|completed|passed)(?:$|[-_\s])/i.test(stateText);
            }),
            responsePresent: responseElements.some((candidate) => {
              const value = "value" in candidate ? candidate.value : candidate.getAttribute("data-response");
              return String(value || "").trim().length > 0;
            }),
          };
        });
        return {
          bodyText,
          passwordVisible: [...document.querySelectorAll('input[type="password"]')].some(visible),
          challengeEvidence,
          actionControlCount: controls.filter((element) => /签到|簽到|打卡|check[ -]?in|claim/i.test(controlText(element))).length,
          completedControlCount: controls.filter((element) => /^(?:今日|今天|当日|當日)?\s*已\s*(?:签到|簽到)$/i.test(controlText(element))).length,
        };
      }, CHALLENGE_SELECTOR);
      const challengeVisible = evidence.challengeEvidence.some(challengeEvidenceIsUnresolved);
      const classification = classifyPageText({
        url: page.url(),
        title: await page.title(),
        bodyText: evidence.bodyText,
        hasPassword: evidence.passwordVisible,
        challengeSelectors: challengeVisible,
        confirmedCheckinControl: evidence.completedControlCount > 0,
      });
      assertBookmarkNavigation(page.url(), allowedOrigins);
      console.log(JSON.stringify({
        candidateIndex: index + 1,
        httpStatus: response?.status() ?? null,
        classification: classification.status,
        evidence: {
          passwordVisible: evidence.passwordVisible,
          challengeVisible,
          actionControlPresent: evidence.actionControlCount > 0,
          completedControlPresent: evidence.completedControlCount > 0,
        },
      }));
    } finally {
      await page.close().catch(() => {});
    }
  }
} finally {
  await context.close();
}
