import test from "node:test";
import assert from "node:assert/strict";
import {
  matchesNativeCompletedControlText,
  nativeActionCandidateIsSafe,
  nativeChallengeFrameIsAllowed,
  normalizeNativeCheckinActionRule,
} from "../src/native-checkin-action.mjs";
import { pagesForOrigin, selectNewestOriginPage } from "../src/native-page-selection.mjs";

test("native inspection selects the newest matching page and exposes older duplicates", () => {
  const oldPage = { url: () => "https://bookmark.test/dashboard?old=1" };
  const unrelatedPage = { url: () => "https://outside.test/" };
  const newPage = { url: () => "https://bookmark.test/dashboard" };
  const pages = [oldPage, unrelatedPage, newPage];
  assert.equal(selectNewestOriginPage(pages, "https://bookmark.test"), newPage);
  assert.deepEqual(pagesForOrigin(pages, "https://bookmark.test"), [oldPage, newPage]);
});

test("原生签到动作规则限制精确文本、公告数量和等待边界", () => {
  assert.deepEqual(normalizeNativeCheckinActionRule({
    actionTexts: [" Check in ", "Check in"],
    dismissButtonTexts: [" Close "],
    dismissSelectors: ["button.close"],
    maxDismissals: 99,
    dismissWaitMs: 99_999,
    clickChallenge: true,
  }), {
    actionTexts: ["Check in"],
    dismissButtonTexts: ["Close"],
    dismissSelectors: ["button.close"],
    maxDismissals: 5,
    dismissWaitMs: 10_000,
    clickChallenge: true,
  });
  assert.throws(() => normalizeNativeCheckinActionRule({}), /requires actionTexts/);
});

test("原生签到只允许 Cloudflare HTTPS challenge frame", () => {
  const origin = "https://bookmark.test";
  assert.equal(nativeChallengeFrameIsAllowed(
    "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile/if/ov2",
    origin,
  ), true);
  assert.equal(nativeChallengeFrameIsAllowed("https://bookmark.test/challenge", origin), false);
  assert.equal(nativeChallengeFrameIsAllowed("http://challenges.cloudflare.com/", origin), false);
  assert.equal(nativeChallengeFrameIsAllowed("https://cloudflare.example/challenge", origin), false);
});

test("原生签到动作拒绝隐藏、禁用和跨来源控件", () => {
  const origin = "https://bookmark.test";
  assert.equal(nativeActionCandidateIsSafe({ visible: true, href: "/check-in" }, origin), true);
  assert.equal(nativeActionCandidateIsSafe({ visible: false, href: "/check-in" }, origin), false);
  assert.equal(nativeActionCandidateIsSafe({ visible: true, disabled: true }, origin), false);
  assert.equal(nativeActionCandidateIsSafe({ visible: true, href: "https://outside.test/check-in" }, origin), false);
  assert.equal(nativeActionCandidateIsSafe({ visible: true, formAction: "https://outside.test/check-in" }, origin), false);
});

test("原生签到完成控件只接受明确的今日完成文本", () => {
  assert.equal(matchesNativeCompletedControlText("今日已签到"), true);
  assert.equal(matchesNativeCompletedControlText("已签到"), true);
  assert.equal(matchesNativeCompletedControlText("立即签到"), false);
  assert.equal(matchesNativeCompletedControlText("签到说明"), false);
});

test("原生预热脚本只对显式动作规则启用受限签到模式", async () => {
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(new URL("../scripts/Prepare-NativeWafSession.ps1", import.meta.url), "utf8");
  assert.match(source, /\$inspectionMode = if \(\$hasAction\) \{ 'execute-checkin' \}/);
  assert.match(source, /ToBase64String/);
  assert.match(source, /被动原生验证不能同时配置签到动作/);
  assert.match(source, /-not \$hasAction -and -not \[bool\]\$item\.trustAsSigned/);
  assert.match(source, /\$lastInspection = \$inspection/);
  assert.match(source, /\$reportedInspection = if \(\$null -ne \$inspection\)/);
  assert.match(source, /actionOutcome = if \(\$null -ne \$reportedInspection\)/);
});

test("原生签到从实际点击后重新计算完整确认等待窗口", async () => {
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(new URL("../src/native-browser-inspect.mjs", import.meta.url), "utf8");
  assert.match(source, /if \(actionAttempted\) confirmationDeadline = Date\.now\(\) \+ maxWaitSeconds \* 1000/);
  assert.match(source, /actionOutcome = "confirmation_timeout"/);
  assert.match(source, /clickVisibleNativeChallengeControl/);
  assert.match(source, /challengeOutcome === "pending"/);
  assert.doesNotMatch(source, /Date\.now\(\) >= deadline/);
});

test("Cloudflare 隐藏 checkbox 时只回退到与其关联的可见 label", async () => {
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(new URL("../src/native-checkin-action.mjs", import.meta.url), "utf8");
  assert.match(source, /label:has\(input\[type="checkbox"\]\), label\[for\]/);
  assert.match(source, /associatedWithChallengeControl/);
  assert.match(source, /directCandidates\.length > 0 \? directCandidates : labelCandidates/);
  assert.match(source, /allowedFrameCount/);
  assert.match(source, /directCandidateCount/);
  assert.match(source, /labelCandidateCount/);
  assert.match(source, /frameBox\.width < 180 \|\| frameBox\.width > 500/);
  assert.match(source, /frameBox\.height < 40 \|\| frameBox\.height > 180/);
  assert.match(source, /page\.locator\('iframe\[src\]'\)/);
  assert.match(source, /allowedParentFrameCount/);
  assert.match(source, /frameClickCandidates\.length === 1/);
  assert.match(source, /challenge_frame_clicked/);
});
