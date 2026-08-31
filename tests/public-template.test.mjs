import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("公开默认配置不启用外部通知", async () => {
  const defaults = JSON.parse(await fs.readFile(new URL("../config/defaults.json", import.meta.url), "utf8"));
  const localExample = JSON.parse(await fs.readFile(new URL("../config/config.local.example.json", import.meta.url), "utf8"));
  assert.equal(defaults.notification.mode, "none");
  assert.equal(defaults.notification.executable, "");
  assert.equal(defaults.syncBookmarkSavedLogins, false);
  assert.deepEqual(defaults.syncSavedLoginOrigins, []);
  assert.equal(defaults.qaWebSearchEnabled, false);
  assert.equal(defaults.disableOptimizationGuideOnDeviceModel, true);
  assert.equal(defaults.failureScreenshots, false);
  assert.equal(Object.hasOwn(defaults, "siteStorageBootstrap"), false);
  assert.deepEqual(defaults.agentrouterAccounts, []);
  assert.deepEqual(defaults.reauthCheckinRules, {});
  assert.deepEqual(defaults.preCheckinDismissRules, {});
  assert.deepEqual(defaults.challengeInteractionRules, {});
  assert.deepEqual(defaults.checkinCaptchaDialogRules, {});
  assert.deepEqual(defaults.newApiCaptchaRules, {});
  assert.deepEqual(defaults.newApiSignInRules, {});
  assert.deepEqual(defaults.bearerCheckinRules, {});
  assert.deepEqual(defaults.nativeOAuthCheckinOrigins, []);
  assert.deepEqual(defaults.savedLoginSessionRules, {});
  assert.deepEqual(defaults.preCheckinNavigationRules, {});
  assert.deepEqual(defaults.calendarDayCheckinOrigins, []);
  assert.deepEqual(defaults.calendarDayCheckinPaths, {});
  assert.deepEqual(Object.keys(localExample.newApiCaptchaRules), ["https://captcha.example.com"]);
  assert.deepEqual(Object.keys(localExample.newApiSignInRules), ["https://signin.example.com"]);
  assert.deepEqual(Object.keys(localExample.bearerCheckinRules), ["https://bearer.example.com"]);
  assert.deepEqual(Object.keys(localExample.savedLoginSessionRules), [
    "https://example.com",
    "https://bearer.example.com",
  ]);
});

test("OAuth 恢复始终不保存页面截图或正文摘录", async () => {
  const oauth = await fs.readFile(new URL("../src/oauth-login.mjs", import.meta.url), "utf8");
  const adapter = await fs.readFile(new URL("../src/reauth-checkin.mjs", import.meta.url), "utf8");
  const runner = await fs.readFile(new URL("../src/index.mjs", import.meta.url), "utf8");
  assert.match(adapter, /"--private-result"/);
  assert.match(runner, /oauth-login\.mjs"\), current\.origin, provider, "--private-result"/);
  assert.doesNotMatch(oauth, /page\.screenshot|screenshotPath|excerpt|bodyText/);
  assert.match(oauth, /waitUntil: "commit"/);
  assert.match(oauth, /verifyConfiguredSavedLoginSession\(page, origin, config\)/);
  assert.match(oauth, /verifiedSession\?\.status === "valid"/);
  assert.match(oauth, /clickConfiguredLoginChallengeControl\(currentPage, origin, config\)/);
});

test("原生同会话 OAuth 签到默认关闭并使用短生命周期本机调试", async () => {
  const [defaultsSource, helper, oauth, runner] = await Promise.all([
    fs.readFile(new URL("../config/defaults.json", import.meta.url), "utf8"),
    fs.readFile(new URL("../scripts/Recover-NativeOAuthCheckin.ps1", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/oauth-login.mjs", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/index.mjs", import.meta.url), "utf8"),
  ]);
  const defaults = JSON.parse(defaultsSource);
  assert.deepEqual(defaults.nativeOAuthCheckinOrigins, []);
  assert.match(helper, /nativeOAuthCheckinOrigins/);
  assert.match(helper, /-RemoteDebuggingPort \$debugPort/);
  assert.match(helper, /--checkin-after-login/);
  assert.match(helper, /Get-CheckinAutomationBrowserProcesses/);
  assert.match(oauth, /connectOverCdpWithRetry/);
  assert.match(oauth, /\(config\.nativeOAuthCheckinOrigins \?\? \[\]\)\.includes\(origin\)/);
  assert.match(runner, /native_oauth_checkin/);
  assert.doesNotMatch(helper, /cookie|password|localStorage|sessionStorage/i);
});

test("Agent Router account login helper does not request or persist secrets", async () => {
  const [opener, accountHelper] = await Promise.all([
    fs.readFile(new URL("../scripts/Open-AgentRouterLogin.ps1", import.meta.url), "utf8"),
    fs.readFile(new URL("../scripts/AgentRouterAccount.ps1", import.meta.url), "utf8"),
  ]);
  assert.match(opener, /agentrouterAccounts/);
  assert.match(opener, /\[Alias\('AccountId'\)\]/);
  assert.match(accountHelper, /\.accountKey/);
  assert.match(accountHelper, /\.accountId/);
  assert.match(opener, /user-data-dir=/);
  assert.match(opener, /oauth-provider-session\.mjs/);
  assert.doesNotMatch(`${opener}\n${accountHelper}`, /password|cookie|token|current_user|username|email/i);
});

test("保存密码同步必须经过显式总开关授权", async () => {
  const runner = await fs.readFile(new URL("../scripts/Run-Checkin.ps1", import.meta.url), "utf8");
  const syncer = await fs.readFile(new URL("../scripts/Sync-ChromeSavedLogins.ps1", import.meta.url), "utf8");
  assert.match(runner, /syncBookmarkSavedLogins -eq \$true/);
  assert.doesNotMatch(runner, /syncSavedLoginOrigins\)\.Count -gt 0 -or/);
  assert.match(syncer, /\$parsedOrigins = \$discoveredText \| ConvertFrom-Json/);
  assert.match(syncer, /\$origins = @\(\$parsedOrigins\)/);
  assert.match(syncer, /populated_origins/);
  assert.match(syncer, /没有保存记录/);
  assert.doesNotMatch(syncer, /\$origins = @\(\$discoveredText \| ConvertFrom-Json\)/);
});

test("原生预热只能访问当前书签目标或其显式关联 origin", async () => {
  const runner = await fs.readFile(new URL("../scripts/Run-Checkin.ps1", import.meta.url), "utf8");
  const preheater = await fs.readFile(new URL("../scripts/Prepare-NativeWafSession.ps1", import.meta.url), "utf8");
  const fallbackPolicy = await fs.readFile(new URL("../scripts/NativeFallbackPolicy.ps1", import.meta.url), "utf8");
  const indexSource = await fs.readFile(new URL("../src/index.mjs", import.meta.url), "utf8");
  const preheatCalls = [...runner.matchAll(/Prepare-NativeWafSession\.ps1'\)([^\r\n]*)/g)];

  assert.match(indexSource, /--list-preflight-targets/);
  assert.match(runner, /--list-preflight-targets/);
  assert.ok(preheatCalls.length > 0);
  for (const [, argumentsText] of preheatCalls) assert.match(argumentsText, /-Origins\s+\$preflightOrigins/);
  assert.match(preheater, /\[Parameter\(Mandatory\)\][\s\S]*?\[string\[\]\]\$Origins/);
  assert.doesNotMatch(preheater, /if \(\$Origins\.Count -gt 0\)/);
  assert.match(fallbackPolicy, /function Get-NativeFallbackOnlyOrigins\(\$Config\)/);
  assert.match(runner, /NativeFallbackPolicy\.ps1/);
  assert.match(runner, /if \(\$attempt -eq 1 -and \$nativeFallbackOnlyOrigins\.Count -gt 0\)/);
  assert.match(runner, /-not \(\$nativeFallbackOnlyOrigins -contains \[string\]\$_.origin\)/);
});

test("人工定向复核时原生预热与指定 origin 取交集", async () => {
  const runner = await fs.readFile(new URL("../scripts/Run-Checkin.ps1", import.meta.url), "utf8");
  const manualScope = runner.match(/if \(\$null -ne \$manualVerification\) \{\s*\$manualOriginSet = @\{\}([\s\S]*?)\n\s*\}/)?.[1] ?? "";

  assert.match(runner, /\$parsedPreflightTargets = \(\$targetOutput -join \[Environment\]::NewLine\) \| ConvertFrom-Json/);
  assert.match(runner, /\$currentPreflightTargets = @\(\$parsedPreflightTargets\)/);
  assert.doesNotMatch(runner, /\$currentPreflightTargets = @\(\(\$targetOutput -join/);
  assert.match(manualScope, /foreach \(\$origin in @\(\$manualVerification\.Origins\)\)/);
  assert.match(manualScope, /\$manualOriginSet\[\[string\]\$origin\] = \$true/);
  assert.match(runner, /\$preflightTargets = @\(\$preflightTargets \| Where-Object \{\s*\$manualOriginSet\.ContainsKey\(\[string\]\$_\.origin\)/);
});

test("手动登录使用无 Playwright 和无远程调试的最小原生浏览器", async () => {
  const opener = await fs.readFile(new URL("../scripts/Open-ManualLogin.ps1", import.meta.url), "utf8");
  const nativeLauncher = await fs.readFile(new URL("../scripts/Open-PlainLoginChrome.ps1", import.meta.url), "utf8");
  const closer = await fs.readFile(new URL("../scripts/Close-ManualLogin.ps1", import.meta.url), "utf8");
  const runtimeResolver = await fs.readFile(new URL("../scripts/Resolve-Runtime.ps1", import.meta.url), "utf8");
  const attentionUrls = await fs.readFile(new URL("../src/attention-urls.mjs", import.meta.url), "utf8");

  assert.doesNotMatch(opener, /manual-session\.mjs|launchAutomationContext/);
  assert.match(opener, /\[string\[\]\]\$Origins/);
  assert.match(opener, /\[int\[\]\]\$Selection/);
  assert.match(opener, /Open-PlainLoginChrome\.ps1'\) @launchOptions/);
  assert.match(nativeLauncher, /\$TrackManualSession -and \(-not \$NativeMinimal -or \$Offscreen -or \$RemoteDebuggingPort -gt 0\)/);
  assert.match(nativeLauncher, /\$TrackManualSession -and \$Urls\.Count -gt 0/);
  assert.match(nativeLauncher, /--origin/);
  assert.match(nativeLauncher, /--selection/);
  assert.match(nativeLauncher, /mode = 'native'/);
  assert.match(nativeLauncher, /processStartedAt = \$processStartedAt/);
  assert.match(nativeLauncher, /launchMarker = \$launchMarker/);
  assert.match(nativeLauncher, /--checkin-launch=/);
  assert.match(nativeLauncher, /prepare-native-browser-profile\.mjs/);
  assert.match(nativeLauncher, /manual-precheckin-extension\.mjs/);
  assert.match(nativeLauncher, /--load-extension=\$navigationExtensionPath/);
  assert.doesNotMatch(nativeLauncher, /manualNavigationEnabled[\s\S]{0,500}remote-debugging-port/);
  assert.match(nativeLauncher, /targets = @\(\$items/);
  assert.match(closer, /Get-CheckinManualSessionBrowserProcesses/);
  assert.doesNotMatch(runtimeResolver, /Where-Object\s*\{[\s\S]*?if \(-not \$candidate\) \{ return \$false \}/);
  assert.match(closer, /\[int\]::TryParse\(\[string\]\$state\.pid/);
  assert.match(closer, /\$_.ProcessId -eq \$trackedPid/);
  assert.match(closer, /\[string\]::Equals\(\$recordedProfile, \$configuredProfile/);
  assert.match(closer, /\$trackedProcess\.StartTime\.ToUniversalTime\(\)/);
  assert.match(closer, /保留状态记录/);
  assert.match(closer, /CloseMainWindow\(\)/);
  assert.doesNotMatch(closer, /Stop-Process/);
  assert.match(closer, /state = 'pending_verification'/);
  assert.match(closer, /successInferredFromManualInteraction = \$false/);
  assert.match(closer, /authoritativeEvidenceRequired = \$true/);
  assert.doesNotMatch(closer, /verificationStatus = '(?:signed|already_signed|clicked)'/);
  assert.match(attentionUrls, /export const ATTENTION_STATUSES = new Set/);
  assert.match(attentionUrls, /readBookmarkPlan\(config\.bookmarksPath, config\)/);
  assert.doesNotMatch(attentionUrls, /readBookmarkPlanWithBackup/);
  const automaticAttentionStatuses = attentionUrls.match(
    /export const ATTENTION_STATUSES = new Set\(\[[\s\S]*?\]\);/,
  )?.[0] ?? "";
  assert.doesNotMatch(automaticAttentionStatuses, /"no_action"/);
});

test("定向补跑同时报告本轮统计和今日累计统计", async () => {
  const runner = await fs.readFile(new URL("../src/index.mjs", import.meta.url), "utf8");
  assert.match(runner, /selectedSummary = summarizeResults/);
  assert.match(runner, /JSON\.stringify\(\{ resultPath, selectedSummary, summary \}/);
});

test("targeted timeout and notification code retain selected-scope fields", async () => {
  const finalizer = await fs.readFile(new URL("../src/finalize-timeout-report.mjs", import.meta.url), "utf8");
  const reporter = await fs.readFile(new URL("../scripts/Submit-UnifiedCheckinReport.ps1", import.meta.url), "utf8");
  assert.match(finalizer, /selectedOrigins/);
  assert.match(finalizer, /selectedResults/);
  assert.match(finalizer, /selectedSummary/);
  assert.match(finalizer, /reconcileLatest: !updateLatest && report\.scopeComplete/);
  assert.match(reporter, /\$selectedResults/);
  assert.match(reporter, /selectedProblemCount/);
  assert.match(reporter, /本轮/);
  assert.match(reporter, /今日累计/);
  assert.match(reporter, /selectedSummary/);
});

test("原生登录生命周期脚本保留 Windows PowerShell 5.1 可识别的 UTF-8 BOM", async () => {
  for (const script of [
    "Open-ManualLogin.ps1",
    "Open-PlainLoginChrome.ps1",
    "Close-ManualLogin.ps1",
    "Recover-NativeOAuthCheckin.ps1",
  ]) {
    const contents = await fs.readFile(new URL(`../scripts/${script}`, import.meta.url));
    assert.deepEqual([...contents.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  }
});

test("CF 被动预热使用最小原生浏览器且不开放调试端口", async () => {
  const preheater = await fs.readFile(new URL("../scripts/Prepare-NativeWafSession.ps1", import.meta.url), "utf8");
  const passiveBlock = preheater.match(/if \(\[bool\]\$item\.passiveOnly\) \{([\s\S]*?)\n\s*continue\r?\n\s*\}/)?.[1];

  assert.ok(passiveBlock);
  assert.match(passiveBlock, /Open-PlainLoginChrome\.ps1'\) -Offscreen -NativeMinimal/);
  assert.doesNotMatch(passiveBlock, /RemoteDebuggingPort|native-browser-inspect/);
});

test("机器人浏览器缓存清理有目录边界和会话数据保护", async () => {
  const cleaner = await fs.readFile(new URL("../scripts/Clear-AutomationChromeCache.ps1", import.meta.url), "utf8");
  assert.match(cleaner, /Join-Path \$root 'data'/);
  assert.match(cleaner, /机器人 .*正在运行/);
  assert.match(cleaner, /\[switch\]\$Apply/);
  assert.match(cleaner, /FileAttributes\]::ReparsePoint/);
  assert.match(cleaner, /Assert-NoReparsePointInPath \$profileRoot \$allowedParent/);
  assert.match(cleaner, /Assert-NoReparsePointTree \$target/);
  for (const protectedName of ["Cookies", "Local Storage", "Session Storage", "IndexedDB", "Service Worker", "Login Data"]) {
    assert.match(cleaner, new RegExp(protectedName.replace(" ", "\\s")));
  }
  assert.doesNotMatch(cleaner, /Remove-Item\s+-LiteralPath\s+\$profileRoot\b/);
});

test("wrapper 覆盖前置步骤并且只在子进程退出后清理运行锁", async () => {
  const defaults = JSON.parse(await fs.readFile(new URL("../config/defaults.json", import.meta.url), "utf8"));
  const runner = await fs.readFile(new URL("../scripts/Run-Checkin.ps1", import.meta.url), "utf8");
  assert.match(defaults.runMutexName, /^Local\\/);
  assert.match(runner, /WaitOne\(0\)/);
  assert.match(runner, /AbandonedMutexException/);
  assert.match(runner, /\$processExited\s*=\s*\$process\.WaitForExit\(10000\)/);
  assert.match(runner, /if \(-not \$processExited\)[\s\S]*?保留运行锁/);
  assert.match(runner, /Remove-RunLockOwnedByProcess/);
});

test("调度器执行上限使用完整任务预算而非固定一小时", async () => {
  const installer = await fs.readFile(new URL("../scripts/Install-ScheduledTask.ps1", import.meta.url), "utf8");
  const helper = await fs.readFile(new URL("../scripts/TaskRuntimeBudget.ps1", import.meta.url), "utf8");
  const watchdog = await fs.readFile(new URL("../scripts/Ensure-UserScheduler.ps1", import.meta.url), "utf8");
  const scheduler = await fs.readFile(new URL("../scripts/Start-UserScheduler.ps1", import.meta.url), "utf8");
  const health = await fs.readFile(new URL("../scripts/Test-CheckinHealth.ps1", import.meta.url), "utf8");
  assert.match(helper, /function Get-CheckinTaskRuntimeBudgetMinutes/);
  for (const source of [installer, watchdog, scheduler, health]) {
    assert.match(source, /TaskRuntimeBudget\.ps1/);
    assert.match(source, /Get-CheckinTaskRuntimeBudgetMinutes/);
  }
  assert.match(installer, /-ExecutionTimeLimit \(New-TimeSpan -Minutes \$executionLimitMinutes\)/);
  assert.doesNotMatch(installer, /-ExecutionTimeLimit \(New-TimeSpan -Hours 1\)/);
});

test("安装配置优先使用 PowerShell 7，5.1 仅作为可用回退", async () => {
  const setup = await fs.readFile(new URL("../src/setup-config.mjs", import.meta.url), "utf8");
  const preflight = await fs.readFile(new URL("../scripts/Test-Environment.ps1", import.meta.url), "utf8");
  const watchdog = await fs.readFile(new URL("../scripts/Ensure-UserScheduler.ps1", import.meta.url), "utf8");
  assert.match(setup, /findOnPath\("pwsh\.exe"\)/);
  assert.match(setup, /answers\.powershellExecutable \|\| preferredPowerShell/);
  assert.match(preflight, /--scope-json-base64/);
  assert.match(watchdog, /config\.powershellExecutable/);
  assert.match(watchdog, /Get-Command pwsh,powershell/);
  assert.match(watchdog, /Start-Process -FilePath \$shell/);
  assert.doesNotMatch(watchdog, /Start-Process -FilePath 'pwsh\.exe'/);
});

test("已确认书签范围的预检不输出用户目录或范围外收藏夹候选", async () => {
  const preflight = await fs.readFile(new URL("../src/preflight.mjs", import.meta.url), "utf8");
  assert.match(preflight, /if \(plan\) \{[\s\S]*?scopeMatch:[\s\S]*?sources: plan\.sources\.map/);
  assert.match(preflight, /else \{[\s\S]*?listBookmarkFolderCandidatesWithBackup\(bookmarksPath\)/);
  assert.match(preflight, /return requestedScopeProvided \? \{ \.\.\.browser, executable \} : \{ \.\.\.browser, executable, userDataDir \}/);
  assert.match(preflight, /requestedScopeProvided[\s\S]*?bookmark_scope_unreadable[\s\S]*?: \{ bookmarksPath/);
  assert.match(preflight, /if \(configuredMultiSource\) return \{ \.\.\.browser, installed: Boolean\(executable\) \}/);
});

test("健康检查区分暂停调度并严格验证完整日报合同", async () => {
  const health = await fs.readFile(new URL("../scripts/Test-CheckinHealth.ps1", import.meta.url), "utf8");
  assert.match(health, /scheduledTaskEnabled/);
  assert.match(health, /windows_task_disabled/);
  assert.match(health, /schedulerStatus/);
  for (const contract of [
    /runState -eq 'final'/,
    /isComplete -eq \$true/,
    /latestProcessedTotal -eq \$latestPlannedTotal/,
    /results\)\.Count -eq \$latestPlannedTotal/,
  ]) assert.match(health, contract);
  assert.match(health, /latestResultConfirmed = \[bool\]\$latestResultComplete/);
});

test("公开安全扫描不会静默跳过截图或其他二进制文件", async () => {
  const scanner = await fs.readFile(new URL("../scripts/Scan-PublicSafety.ps1", import.meta.url), "utf8");
  assert.match(scanner, /Binary file in public scope/);
  assert.match(scanner, /png\|jpg\|jpeg\|gif\|webp/);
  assert.doesNotMatch(scanner, /GetExtension\(\$fullPath\)[^\n]+\{\s*continue\s*\}/);
});

test("诊断工具只输出分类证据并服从当前书签同源边界", async () => {
  const inspector = await fs.readFile(new URL("../src/inspect-target.mjs", import.meta.url), "utf8");
  const api = await fs.readFile(new URL("../src/checkin-api.mjs", import.meta.url), "utf8");
  const scriptSearch = await fs.readFile(new URL("../src/search-site-checkin.mjs", import.meta.url), "utf8");
  for (const source of [inspector, api, scriptSearch]) {
    assert.match(source, /findBookmarkTarget/);
    assert.match(source, /assertBookmarkNavigation/);
    assert.doesNotMatch(source, /page\.screenshot|screenshotPath|outerHTML|excerpt/);
  }
  assert.doesNotMatch(inspector, /pageFunctions|specialHtml|showupHtml|visibleSurfaces/);
  assert.doesNotMatch(api, /return \{[^}]*\bbody\b/);
  const searchOutput = scriptSearch.match(/console\.log\(JSON\.stringify\(\{([\s\S]*?)\}\)\);/)?.[1] ?? "";
  assert.doesNotMatch(searchOutput, /\b(?:requestedUrl|scriptUrl|excerpt)\s*[,}]/);
  await assert.rejects(fs.access(new URL("../src/open-captcha-session.mjs", import.meta.url)));
  await assert.rejects(fs.access(new URL("../src/u2-captcha-session.mjs", import.meta.url)));
});

test("原生预热检查器不向父进程返回页面标题或正文片段", async () => {
  const inspector = await fs.readFile(new URL("../src/native-browser-inspect.mjs", import.meta.url), "utf8");
  const outputBlock = inspector.match(/output = \{([\s\S]*?)\n\s*\};/)?.[1] ?? "";
  assert.match(outputBlock, /status: (?:state|current\.state)\.status/);
  assert.match(outputBlock, /siteBodyLoaded/);
  assert.match(outputBlock, /attendanceEndpoint/);
  assert.doesNotMatch(outputBlock, /origin|url|title|reason|bodyText|leichiText/);
});

test("公开模板不预设任何用户的书签文件夹名称", async () => {
  const defaults = JSON.parse(await fs.readFile(new URL("../config/defaults.json", import.meta.url), "utf8"));
  const answers = JSON.parse(await fs.readFile(new URL("../setup/answers.example.json", import.meta.url), "utf8"));
  const questions = JSON.parse(await fs.readFile(new URL("../setup/questions.json", import.meta.url), "utf8"));
  assert.deepEqual(defaults.mobileFolderNames, []);
  assert.deepEqual(defaults.targetFolderNames, []);
  assert.deepEqual(answers.mobileFolderNames, []);
  assert.deepEqual(answers.targetFolderNames, []);
  const scope = questions.groups.find((group) => group.id === "bookmark_scope");
  assert.deepEqual(scope.askBefore, ["automation_policy", "notification"]);

  const bookmarksSource = await fs.readFile(new URL("../src/bookmarks.mjs", import.meta.url), "utf8");
  const browserSource = await fs.readFile(new URL("../src/browser.mjs", import.meta.url), "utf8");
  const runnerSource = await fs.readFile(new URL("../src/index.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(bookmarksSource, /options\.mobileFolderNames\s*\?\?\s*\[\s*["']移动设备书签/);
  assert.doesNotMatch(bookmarksSource, /options\.targetFolderNames\s*\?\?\s*\[\s*["']签到/);
  assert.doesNotMatch(browserSource, /folderNames\.includes\(["']公益站["']\)/);
  assert.doesNotMatch(runnerSource, /folderNames\.includes\(["']公益站["']\)/);
});

test("公开站点规则只包含无凭据 HTTPS URL", async () => {
  const rules = JSON.parse(await fs.readFile(new URL("../config/site-rules.public.json", import.meta.url), "utf8"));
  const serialized = JSON.stringify(rules);
  assert.doesNotMatch(serialized, /(?:password|passwd|cookie|access_token|authorization)[=:]/i);
  const collectStrings = (value) => typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(collectStrings)
      : value && typeof value === "object"
        ? Object.entries(value).flatMap(([key, nested]) => [key, ...collectStrings(nested)])
        : [];
  for (const value of collectStrings(rules).filter((item) => item.startsWith("http"))) {
    const url = new URL(value);
    assert.equal(url.protocol, "https:");
    assert.equal(url.username, "");
    assert.equal(url.password, "");
  }
});

test("lyclaude keeps the registered OAuth redirect and rewrites only the returned callback origin", async () => {
  const rules = JSON.parse(await fs.readFile(new URL("../config/site-rules.public.json", import.meta.url), "utf8"));
  const target = "https://free.lyclaude.site";
  assert.equal(rules.oauthRedirectOverrides?.[target], undefined);
  assert.deepEqual(rules.oauthCallbackOriginAliases?.[target], ["https://free.vipclaude.codes"]);
});

test("显式目标公开示例只扩展已确认目录内的无凭据 HTTPS 站点", async () => {
  const example = JSON.parse(await fs.readFile(new URL("../config/config.local.example.json", import.meta.url), "utf8"));
  const readme = await fs.readFile(new URL("../README.md", import.meta.url), "utf8");
  const confirmedFolderNames = new Set((example.additionalBookmarkSources ?? [])
    .flatMap((source) => source.targetFolderNames ?? []));

  assert.ok(example.configuredTargets.length > 0);
  for (const target of example.configuredTargets) {
    const url = new URL(target.url);
    assert.equal(url.protocol, "https:");
    assert.equal(url.username, "");
    assert.equal(url.password, "");
    assert.ok(confirmedFolderNames.has(target.folderName));
  }
  assert.match(readme, /configuredTargets/);
  assert.match(readme, /folderName.*targetFolderNames/);
  assert.match(readme, /扩展浏览器实际导航和网络访问范围/);
});

test("本机配置、结果和凭据目录被 Git 忽略", async () => {
  const ignore = await fs.readFile(new URL("../.gitignore", import.meta.url), "utf8");
  for (const pattern of ["config/config.json", "config/config.local.json", "setup/answers.json", "data/", "logs/*", "tmp/*"]) {
    assert.match(ignore, new RegExp(pattern.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")));
  }
});

test("DPAPI 凭据恢复默认关闭且强制同源验证", async () => {
  const defaults = JSON.parse(await fs.readFile(new URL("../config/defaults.json", import.meta.url), "utf8"));
  const loginSource = await fs.readFile(new URL("../src/credential-login.mjs", import.meta.url), "utf8");
  const setter = await fs.readFile(new URL("../scripts/Set-ProtectedSiteCredential.ps1", import.meta.url), "utf8");
  const recovery = await fs.readFile(new URL("../scripts/Recover-ProtectedLogin.ps1", import.meta.url), "utf8");

  assert.deepEqual(defaults.protectedCredentialOrigins, []);
  assert.deepEqual(defaults.protectedLoginVerificationPaths, {});
  assert.doesNotMatch(loginSource, /siteStorageBootstrap|Object\.entries\(localStorage\)|Object\.entries\(sessionStorage\)/);
  assert.match(loginSource, /new URL\(loginUrl\)\.origin !== origin/);
  assert.match(loginSource, /verificationUrl\.origin !== origin/);
  assert.match(recovery, /\$PSVersionTable\.PSVersion\.Major -lt 7/);
  assert.match(recovery, /Get-Command pwsh\.exe/);
  assert.match(recovery, /-Origin \$Origin -LoginUrl \$LoginUrl/);
  assert.match(setter, /ConvertFrom-SecureString/);
  assert.match(recovery, /RedirectStandardInput = \$true/);
  assert.doesNotMatch(recovery, /ArgumentList\.Add\(\$passwordPlain\)/);
});

test("任务级重试不会为空动作或人工处理状态重复空转", async () => {
  const runner = await fs.readFile(new URL("../scripts/Run-Checkin.ps1", import.meta.url), "utf8");
  const fallbackPolicy = await fs.readFile(new URL("../scripts/NativeFallbackPolicy.ps1", import.meta.url), "utf8");
  const statuses = runner.match(/\$immediateRetryStatuses\s*=\s*@\(([^)]*)\)/)?.[1] ?? "";
  assert.match(statuses, /'error'/);
  assert.match(statuses, /'managed_challenge_timeout'/);
  assert.doesNotMatch(statuses, /'no_action'|'interactive_challenge'|'needs_attention'/);
  assert.match(runner, /NativeFallbackPolicy\.ps1/);
  assert.match(fallbackPolicy, /function Get-NativeFallbackRetryOrigins/);
  assert.match(fallbackPolicy, /function Test-NeedsNativeFallbackRetry/);
  assert.match(runner, /--origins', \(\$fallbackRetryOrigins -join ','\)/);
  assert.match(runner, /-not \$needsNativeFallbackRetry/);
  assert.match(runner, /继续第二轮原生签到复核/);
  assert.match(runner, /后续任务触发且达到 nextEligibleAt/);
});

test("任务级超时会将最新进度补全为可续跑的最终报告", async () => {
  const runner = await fs.readFile(new URL("../scripts/Run-Checkin.ps1", import.meta.url), "utf8");
  const finalizer = await fs.readFile(new URL("../src/finalize-timeout-report.mjs", import.meta.url), "utf8");
  assert.match(runner, /finalize-timeout-report\.mjs/);
  assert.match(runner, /--progress-report/);
  assert.match(runner, /timeoutProgress\.Report\.runState -eq 'in_progress'/);
  assert.match(finalizer, /retryCause: "task_timeout"/);
  assert.match(finalizer, /runState: "final"/);
  assert.match(finalizer, /const isComplete =/);
});

test("手动操作后的续跑强制复核记录中的 origin 且不从点击推断成功", async () => {
  const runner = await fs.readFile(new URL("../scripts/Run-Checkin.ps1", import.meta.url), "utf8");
  const stateMachine = await fs.readFile(new URL("../scripts/ManualVerification.ps1", import.meta.url), "utf8");
  assert.match(runner, /tmp\\manual-verification\.json/);
  assert.match(stateMachine, /state -ne 'pending_verification'/);
  assert.match(stateMachine, /authoritativeEvidenceRequired -ne \$true/);
  assert.match(runner, /if \(\$requestedOrigins\.Count -eq 0\) \{[\s\S]*?\$runArguments \+= @\('--origins', \(@\(\$manualVerification\.Origins\) -join ','\)\)[\s\S]*?\}/);
  assert.match(runner, /--consume-manual-verification/);
  assert.match(runner, /--consume-manual-verification-subset/);
  assert.match(stateMachine, /verificationStatus = \[string\]\$result\.status/);
  assert.match(stateMachine, /if \(\$allConfirmed\) \{ 'verification_complete' \} else \{ 'pending_verification' \}/);
  assert.doesNotMatch(`${runner}\n${stateMachine}`, /verificationStatus\s*=\s*'(?:signed|already_signed|clicked)'/);
});
