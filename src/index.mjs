import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { publicBookmarkReport } from "./bookmarks.mjs";
import { launchAutomationContext, processTarget } from "./browser.mjs";
import { readEffectiveBookmarkPlan } from "./effective-bookmark-plan.mjs";
import { buildCurrentPlan } from "./current-plan.mjs";
import { logicalCompletionKey } from "./logical-checkin.mjs";
import {
  aggregateReauthResults,
  getConfiguredReauthAccounts,
  getConfiguredReauthRule,
  mergeSelectedReauthAccountResult,
  runConfiguredReauthCheckin,
} from "./reauth-checkin.mjs";
import { buildCompletedReauthProgressResult, buildReauthProgressResult } from "./reauth-progress.mjs";
import {
  cleanupOldLogs,
  createRunLog,
  sanitizeForPersistence,
  summarizeResults,
  writeRunResult,
} from "./logger.mjs";
import { loginHelperOutcome, loginHelperOutcomeFromStreams, resolveLoginRecoveryUrl } from "./login-recovery.mjs";
import { runRecoveryProcess } from "./recovery-process.mjs";
import { continueNativeCheckinAfterLogin } from "./native-login-continuation.mjs";
import { configuredNoCheckinResult, isTerminalResult } from "./result-contract.mjs";
import { freshNativePreflightResults, freshNativePreflightHandoffs, nativePreflightProgress } from "./native-preflight-state.mjs";
import { assertManualVerificationExecution } from "./manual-verification-guard.mjs";
import { atomicWriteJson, ensurePrivateDirectory, safeErrorMessage } from "./security.mjs";
import { acquireRunLock, releaseRunLock } from "./run-lock.mjs";
import {
  applyPreferredCandidates,
  loadSiteState,
  runWithRecentNotAvailableCache,
  updateSiteState,
  writeSiteState,
} from "./site-state.mjs";
import { loadQaCache, updateQaCache, writeQaCache } from "./qa-solver.mjs";
import {
  TERMINAL_STATUSES,
  advanceAttemptedDeferredRetries,
  deferUnresolvedLogin,
  isCurrentLocalRunId,
  localRunDate,
  isRetryEligible,
  recoveryEntriesForResults,
  filterAutomaticRetryOrigins,
  isResumeRetryEligible,
  nextDeferredRetryAt,
} from "./retry-policy.mjs";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.dirname(sourceDirectory);
const execFileAsync = promisify(execFile);
const config = JSON.parse(await fs.readFile(path.join(rootDirectory, "config", "config.json"), "utf8"));
const qaConfig = JSON.parse(await fs.readFile(path.join(rootDirectory, "config", "qa-rules.json"), "utf8"));
const localQaConfig = await fs.readFile(path.join(rootDirectory, "config", "qa-rules.local.json"), "utf8")
  .then(JSON.parse)
  .catch((error) => {
    if (error.code === "ENOENT") return { rules: [] };
    throw error;
  });
const dryRun = process.argv.includes("--dry-run");
const listPreflightTargets = process.argv.includes("--list-preflight-targets");
const ignoreNativePreflight = process.argv.includes("--ignore-native-preflight");
const automaticRetry = process.argv.includes("--automatic-retry");
const nativePreflightAttemptIndex = process.argv.indexOf("--native-preflight-attempt");
const nativePreflightAttemptId = nativePreflightAttemptIndex >= 0 ? process.argv[nativePreflightAttemptIndex + 1] : null;
const limitIndex = process.argv.indexOf("--limit");
const offsetIndex = process.argv.indexOf("--offset");
const originsIndex = process.argv.indexOf("--origins");
const resumeIndex = process.argv.indexOf("--resume-report");
const consumeManualVerification = process.argv.includes("--consume-manual-verification");
const consumeManualVerificationSubset = process.argv.includes("--consume-manual-verification-subset");
const reauthAccountKeyIndex = process.argv.indexOf("--reauth-account-key");
const reauthAccountKey = reauthAccountKeyIndex >= 0
  ? String(process.argv[reauthAccountKeyIndex + 1] ?? "").trim() || null
  : null;
const forceReauth = process.argv.includes("--force-reauth");
const postOAuthVerify = process.argv.includes("--post-oauth-verify");
if (forceReauth && !reauthAccountKey) {
  throw new Error("--force-reauth requires --reauth-account-key");
}
if (postOAuthVerify && !reauthAccountKey) {
  throw new Error("--post-oauth-verify requires --reauth-account-key");
}
const limit = limitIndex >= 0 ? Math.max(1, Number.parseInt(process.argv[limitIndex + 1], 10) || 1) : null;
const offset = offsetIndex >= 0 ? Math.max(0, Number.parseInt(process.argv[offsetIndex + 1], 10) || 0) : 0;
let selectedOrigins = originsIndex >= 0
  ? new Set(String(process.argv[originsIndex + 1] ?? "").split(",").map((value) => value.trim()).filter(Boolean))
  : null;
const requestedResumePath = resumeIndex >= 0 ? String(process.argv[resumeIndex + 1] ?? "").trim() : null;
const lockPath = path.join(rootDirectory, "tmp", "run.lock");
const manualVerificationPath = path.join(rootDirectory, "tmp", "manual-verification.json");
const nativeWafPreflightPath = path.join(rootDirectory, "tmp", "native-waf-preflight.json");
const lastValidBookmarkPlanPath = path.join(rootDirectory, "data", "last-valid-bookmark-plan.json");
function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

if (!dryRun && !listPreflightTargets && !reauthAccountKey) {
  const manualVerification = await fs.readFile(manualVerificationPath, "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  assertManualVerificationExecution(manualVerification, {
    consume: consumeManualVerification,
    allowSubset: consumeManualVerificationSubset,
    resumeRequested: Boolean(requestedResumePath),
    selectedOrigins,
    runDate: localRunDate(),
  });
}

async function readValidatedBookmarkPlan() {
  const plan = await readEffectiveBookmarkPlan(config.bookmarksPath, config, lastValidBookmarkPlanPath);
  plan.planFingerprint = buildCurrentPlan(plan, config).planFingerprint;
  await atomicWriteJson(lastValidBookmarkPlanPath, publicBookmarkReport(plan));
  return plan;
}

async function readFreshNativeWafPreflight(includeHandoffs = false, attemptId = nativePreflightAttemptId) {
  if (ignoreNativePreflight) return new Map();
  const configuredUrls = [
    ...(config.nativeWafPreflightUrls ?? []).map((value) => typeof value === "string" ? value : value?.url),
    ...(config.nativeChallengePreflight ?? []).map((value) => value?.url),
  ].filter(Boolean);
  const allowedOrigins = new Set(configuredUrls.map((value) => new URL(value).origin));
  const report = await fs.readFile(nativeWafPreflightPath, "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => null);
  const confirmations = freshNativePreflightResults(report, allowedOrigins);
  if (!includeHandoffs) return confirmations;
  const handoffs = freshNativePreflightHandoffs(report, allowedOrigins, attemptId);
  return new Map([...handoffs, ...confirmations]);
}

const lockLease = await acquireRunLock(lockPath);
try {
  const plan = await readValidatedBookmarkPlan();
  const planMetadata = buildCurrentPlan(plan, config);
  const report = { ...publicBookmarkReport(plan), planFingerprint: planMetadata.planFingerprint };
  const reportPath = path.join(rootDirectory, "outputs", "bookmark-comparison.json");
  await atomicWriteJson(reportPath, report);

  if (listPreflightTargets) {
    console.log(JSON.stringify(plan.targets.map((target) => ({
      origin: target.origin,
      allowedOrigins: target.allowedOrigins ?? [target.origin],
    }))));
  } else if (dryRun) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const profileMarker = path.join(config.automationUserDataDir, "Local State");
    await fs.access(profileMarker).catch(() => {
      throw new Error("独立登录会话尚未初始化，请先运行 scripts/Initialize-BrowserProfile.ps1");
    });

    const logsRoot = path.join(rootDirectory, "logs");
    const siteStatePath = path.join(rootDirectory, "data", "site-state.json");
    const qaCachePath = path.join(rootDirectory, "data", "qa-cache.json");
    await ensurePrivateDirectory(logsRoot);
    let resumeBase = null;
    if (requestedResumePath) {
      const resolvedResume = path.resolve(requestedResumePath);
      const resolvedLogs = path.resolve(logsRoot);
      if (!resolvedResume.startsWith(`${resolvedLogs}${path.sep}`)) throw new Error("续跑报告必须位于本任务 logs 目录内");
      resumeBase = JSON.parse(await fs.readFile(resolvedResume, "utf8"));
      if (!Array.isArray(resumeBase?.results)) throw new Error("续跑报告缺少站点结果");
      if (!isCurrentLocalRunId(resumeBase.runId)) throw new Error("续跑报告不是今天生成的，拒绝复用旧签到结果");
      const resumeFingerprint = String(
        resumeBase.planFingerprint ?? resumeBase.bookmarkSummary?.planFingerprint ?? "",
      ).trim();
      if (resumeFingerprint && resumeFingerprint !== planMetadata.planFingerprint) {
        throw new Error("续跑报告与当前签到计划不一致，拒绝混用旧结果");
      }
      if (!selectedOrigins) {
        const currentOrigins = new Set(plan.targets.map((target) => target.origin));
        const previousOrigins = new Set(resumeBase.results.map((result) => result.origin));
        const reauthOrigins = new Set(plan.targets
          .filter((target) => getConfiguredReauthRule(target, config))
          .map((target) => target.origin));
        selectedOrigins = new Set([
          ...resumeBase.results
            .filter((result) => isResumeRetryEligible(result, reauthOrigins))
            .map((result) => result.origin),
          ...[...currentOrigins].filter((origin) => !previousOrigins.has(origin)),
        ]);
      }
    }
    if (automaticRetry && resumeBase && selectedOrigins) {
      selectedOrigins = filterAutomaticRetryOrigins(selectedOrigins, resumeBase.results);
    }
    await cleanupOldLogs(logsRoot, config.logRetentionDays);
    const runLog = await createRunLog(logsRoot);
    const startedAt = new Date();
    const siteState = await loadSiteState(siteStatePath);
    const qaCache = await loadQaCache(qaCachePath);
    const qaRules = [
      ...(qaConfig.rules ?? []),
      ...(localQaConfig.rules ?? []),
      ...qaCache.entries.map((entry) => ({ ...entry, source: "verified_cache" })),
    ];
    const results = [];
    const nativeWafPreflight = await readFreshNativeWafPreflight(true);
    const preferredTargets = applyPreferredCandidates(plan.targets, siteState);
    const originFilteredTargets = selectedOrigins
      ? preferredTargets.filter((target) => selectedOrigins.has(target.origin))
      : preferredTargets;
    const selectedTargets = limit
      ? originFilteredTargets.slice(offset, offset + limit)
      : originFilteredTargets.slice(offset);
    // Persist native confirmations before OAuth or browser startup can fail.
    // Origin-only evidence cannot replace a multi-account reauthentication result.
    const nativeResults = nativePreflightProgress(
      selectedTargets.filter(target => !getConfiguredReauthRule(target, config)
        && !configuredNoCheckinResult(target, config)), nativeWafPreflight,
    );
    const nativeCompletedResults = nativeResults.filter(result => ['signed', 'already_signed'].includes(result.status));
    const nativeHandoffResults = nativeResults.filter(result => result.retryable === false);
    results.push(...nativeCompletedResults);
    results.push(...nativeHandoffResults);
    results.push(...selectedTargets.map(target => configuredNoCheckinResult(target, config)).filter(Boolean));
    const precompletedOrigins = new Set(results.map(result => result.origin));
    const selectedOriginList = selectedTargets.map((target) => target.origin);
    const plannedTotal = preferredTargets.length;
    const logicalCompletions = new Map();
    const reauthResults = new Map();
    const reauthProgressResults = new Map();
    const completedReauthProgressResults = new Map();

    const mergedProgressResults = (includeReauthProgress = true) => {
      const currentByOrigin = new Map(results.map((result) => [result.origin, result]));
      const previousByOrigin = new Map((resumeBase?.results ?? []).map((result) => [result.origin, result]));
      return preferredTargets
        .map((target) => currentByOrigin.get(target.origin)
          ?? completedReauthProgressResults.get(target.origin)
          ?? (includeReauthProgress ? reauthProgressResults.get(target.origin) : null)
          ?? previousByOrigin.get(target.origin))
        .filter(Boolean);
    };

    const selectedProgressResults = () => {
      const currentByOrigin = new Map(results.map((result) => [result.origin, result]));
      return selectedTargets
        .map((target) => currentByOrigin.get(target.origin)
          ?? completedReauthProgressResults.get(target.origin)
          ?? reauthProgressResults.get(target.origin))
        .filter(Boolean);
    };

    const selectedCompletedProgressResults = () => {
      const currentByOrigin = new Map(results.map((result) => [result.origin, result]));
      return selectedTargets
        .map((target) => currentByOrigin.get(target.origin) ?? completedReauthProgressResults.get(target.origin))
        .filter(Boolean);
    };

    const writeProgress = async (phase, details = {}) => {
      const progressResults = mergedProgressResults();
      const completedProgressResults = mergedProgressResults(false);
      const completedSelectedResults = selectedCompletedProgressResults();
      await atomicWriteJson(path.join(runLog.directory, "progress.json"), sanitizeForPersistence({
        runId: runLog.runId,
        planFingerprint: planMetadata.planFingerprint,
        runState: "in_progress",
        isComplete: false,
        phase,
        plannedTotal,
        processedTotal: completedProgressResults.length,
        completed: completedProgressResults.length,
        total: plannedTotal,
        selectedOrigins: selectedOriginList,
        selectedTotal: selectedTargets.length,
        selectedProcessedTotal: completedSelectedResults.length,
        selectedResults: selectedProgressResults(),
        updatedAt: new Date().toISOString(),
        ...details,
        results: progressResults,
      }));
    };

    await writeProgress("initial");
    const configuredReauthTargets = selectedTargets.filter((target) => !precompletedOrigins.has(target.origin)
      && getConfiguredReauthRule(target, config));
    for (let index = 0; index < configuredReauthTargets.length; index += 1) {
      const target = configuredReauthTargets[index];
      const accountCount = getConfiguredReauthAccounts(target, config).length;
      const accountScope = reauthAccountKey
        ? "1 selected account"
        : `${accountCount} isolated accounts`;
      console.log(`[reauth ${index + 1}/${configuredReauthTargets.length}] ${target.origin} (${accountScope})`);
      try {
        const startedAt = Date.now();
        const runOptions = reauthAccountKey
          ? { accountKey: reauthAccountKey, forceReauth, postOAuthVerify }
          : { onAccountResult: async (_accountResult, completedResults, accounts) => {
            if (completedResults.length === accounts.length) {
              const aggregate = aggregateReauthResults(completedResults);
              completedReauthProgressResults.set(target.origin, buildCompletedReauthProgressResult(
                target,
                aggregate,
                accounts.length,
                Date.now() - startedAt,
              ));
              reauthProgressResults.delete(target.origin);
            } else {
              reauthProgressResults.set(target.origin, buildReauthProgressResult(
                target,
                completedResults,
                accounts.length,
              ));
            }
            await writeProgress("reauth_account", {
              activeOrigin: target.origin,
              activeAccountCount: accounts.length,
              activeCompletedAccountCount: completedResults.length,
            });
          } };
        const selectedAccountResult = await runConfiguredReauthCheckin(target, config, runOptions);
        const result = reauthAccountKey
          ? mergeSelectedReauthAccountResult(
            getConfiguredReauthAccounts(target, config),
            resumeBase?.results?.find((entry) => entry.origin === target.origin),
            selectedAccountResult,
          )
          : selectedAccountResult;
        reauthResults.set(target.origin, result);
        completedReauthProgressResults.set(target.origin, buildCompletedReauthProgressResult(
          target,
          result,
          accountCount,
          Date.now() - startedAt,
        ));
        reauthProgressResults.delete(target.origin);
        await writeProgress("reauth_complete");
      } catch (error) {
        reauthResults.set(target.origin, { status: "needs_attention", reason: safeErrorMessage(error) });
      }
    }
    const needsGenericBrowser = selectedTargets.some((target) => !reauthResults.has(target.origin)
      && !precompletedOrigins.has(target.origin));
    const context = needsGenericBrowser ? await launchAutomationContext(config) : null;

    const rememberLogicalCompletion = (target, result) => {
      const key = logicalCompletionKey(result, config.logicalCheckinGroups);
      if (key && ["signed", "already_signed"].includes(result.status)) {
        logicalCompletions.set(key, { origin: target.origin, result });
      }
    };
    for (const result of nativeCompletedResults) rememberLogicalCompletion(result, result);

    const runOneTarget = async (activeContext, target, allowReuse = true) => {
      const started = Date.now();
      const reauthResult = reauthResults.get(target.origin);
      if (reauthResult) return { ...reauthResult, attempt: 1, durationMs: Date.now() - started };
      const groupKey = logicalCompletionKey(target, config.logicalCheckinGroups);
      const reused = allowReuse && groupKey ? logicalCompletions.get(groupKey) : null;
      if (reused && reused.origin !== target.origin) {
        return {
          status: "already_signed",
          reason: `共用签到入口已由 ${new URL(reused.origin).hostname} 完成`,
          url: reused.result.url,
          attempt: 0,
          reusedFrom: reused.origin,
          durationMs: Date.now() - started,
        };
      }
      const result = await runWithRecentNotAvailableCache(target, siteState, config,
        () => processTarget(activeContext, target, config, qaRules, runLog.directory));
      const timed = { ...result, durationMs: Date.now() - started };
      rememberLogicalCompletion(target, timed);
      return timed;
    };

    try {
      for (let index = 0; index < selectedTargets.length; index += 1) {
        const target = selectedTargets[index];
        if (precompletedOrigins.has(target.origin)) continue;
        console.log(`[${index + 1}/${selectedTargets.length}] ${target.origin}`);
        const targetResult = await runOneTarget(context, target);
        results.push({
          origin: target.origin,
          title: target.title,
          folderNames: target.folderNames,
          ...targetResult,
        });
        reauthProgressResults.delete(target.origin);
        completedReauthProgressResults.delete(target.origin);
        await writeProgress("checkin");
      }
    } finally {
      await context?.close();
    }

    // Only unresolved sites enter recovery.  Login repair is attempted before
    // each isolated round, and reporting remains deferred until all rounds end.
    const recoveryRounds = Math.max(1, Math.min(3, Number(config.recoveryRounds) || 2));
    const recoveryDelays = Array.isArray(config.recoveryDelaysMs) ? config.recoveryDelaysMs : [5000, 30000];
    for (let round = 0; round < recoveryRounds; round += 1) {
      const recoveryEntries = recoveryEntriesForResults(results, selectedTargets);
      if (recoveryEntries.length === 0) break;
      console.log(`[recovery ${round + 1}/${recoveryRounds}] 将复查 ${recoveryEntries.length} 个异常站点`);
      const loginOutcomes = new Map();
      for (const { resultIndex } of recoveryEntries) {
        const current = results[resultIndex];
        const provider = config.automaticOAuthProviders?.[current.origin];
        const nativeOAuthCheckinEnabled = Boolean(provider)
          && (config.nativeOAuthCheckinOrigins ?? []).includes(current.origin);
        const nativeChallengeRecovery = current.status === "interactive_challenge"
          && nativeOAuthCheckinEnabled;
        if (current.status !== "login_required" && !nativeChallengeRecovery) continue;
        const savedLoginUrl = resolveLoginRecoveryUrl(
          current.origin,
          config.savedLoginUrls?.[current.origin],
          current.url,
        );
        const methods = [];
        if (current.status === "login_required"
          && (config.protectedCredentialOrigins ?? []).includes(current.origin)) {
          methods.push({
            method: "protected_credential",
            executable: config.powershellExecutable || "pwsh.exe",
            args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(rootDirectory, "scripts", "Recover-ProtectedLogin.ps1"), "-Origin", current.origin, "-LoginUrl", savedLoginUrl],
          });
        }
        if (nativeOAuthCheckinEnabled) {
          methods.push({
            method: "native_oauth_checkin",
            executable: config.powershellExecutable || "pwsh.exe",
            args: [
              "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
              "-File", path.join(rootDirectory, "scripts", "Recover-NativeOAuthCheckin.ps1"),
              "-Origin", current.origin,
              "-Provider", provider,
              "-LoginUrl", savedLoginUrl,
            ],
          });
        }
        if (current.status === "login_required") {
          if (provider) methods.push({ method: "oauth", executable: process.execPath, args: [path.join(sourceDirectory, "oauth-login.mjs"), current.origin, provider, "--private-result"] });
          else if (config.autoDetectLinuxDoOAuth !== false
            && (config.autoDetectOAuthOrigins ?? []).includes(current.origin)) {
            methods.push({ method: "oauth_autodetect", executable: process.execPath, args: [path.join(sourceDirectory, "oauth-login.mjs"), current.origin, "LinuxDO", "--private-result"] });
          }
          methods.push({
            method: "saved_password",
            executable: process.execPath,
            args: [path.join(sourceDirectory, "saved-password-login.mjs"), current.origin, savedLoginUrl],
          });
          methods.push({
            method: "native_saved_password",
            executable: config.powershellExecutable || "pwsh.exe",
            args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(rootDirectory, "scripts", "Recover-NativeLogin.ps1"), "-Origin", current.origin, "-LoginUrl", savedLoginUrl],
          });
        }

        const attempts = [];
        let succeeded = false;
        let authoritativeCheckinStatus = null;
        for (const method of methods) {
          try {
            const helperOutput = await runRecoveryProcess(method.executable, method.args, {
              cwd: rootDirectory,
              powershellExecutable: config.powershellExecutable || "pwsh.exe",
              windowsHide: true,
              timeout: 180000,
              maxBuffer: 1024 * 1024,
              beforeTerminate: () => execFileAsync(config.powershellExecutable || "pwsh.exe", [
                "-NoProfile", "-NonInteractive", "-File", path.join(rootDirectory, "scripts", "Close-RecoveryBrowser.ps1"),
              ], { cwd: rootDirectory, windowsHide: true, timeout: 25000, maxBuffer: 65536 }),
            });
            const outcome = loginHelperOutcomeFromStreams(helperOutput.stdout, helperOutput.stderr);
            attempts.push({ method: method.method, ...outcome });
            if (outcome.succeeded) {
              succeeded = true;
              authoritativeCheckinStatus = outcome.checkinStatus ?? null;
              break;
            }
          } catch (error) {
            if (error.cleanupFailed) throw new Error("登录恢复超时后未能安全释放浏览器或子进程，停止本轮以避免并发占用");
            const fallback = error?.code === "ETIMEDOUT" ? "timeout" : "failed";
            const outcome = loginHelperOutcomeFromStreams(error?.stdout, error?.stderr, fallback);
            const failedOutcome = outcome.status === "logged_in" ? loginHelperOutcome("", fallback) : outcome;
            attempts.push({
              method: method.method,
              ...failedOutcome,
              succeeded: false,
            });
          }
        }
        loginOutcomes.set(current.origin, {
          attempted: true,
          succeeded,
          ...(authoritativeCheckinStatus ? { authoritativeCheckinStatus } : {}),
          attempts,
        });
      }

      const delayMs = Math.max(0, Number(recoveryDelays[Math.min(round, recoveryDelays.length - 1)]) || 0);
      const nativeContinuations = new Map();
      for (const { target } of recoveryEntries) {
        const continuation = await continueNativeCheckinAfterLogin(target, config, loginOutcomes.get(target.origin), {
          runPreflight: (origin, attemptId) => runRecoveryProcess(config.powershellExecutable || 'pwsh.exe', [
            '-NoProfile', '-NonInteractive', '-File', path.join(rootDirectory, 'scripts', 'Prepare-NativeWafSession.ps1'),
            '-Origins', origin, '-AttemptId', attemptId,
          ], {
            cwd: rootDirectory, powershellExecutable: config.powershellExecutable || 'pwsh.exe',
            windowsHide: true, timeout: 360000, maxBuffer: 1024 * 1024,
            beforeTerminate: () => execFileAsync(config.powershellExecutable || 'pwsh.exe', [
              '-NoProfile', '-NonInteractive', '-File', path.join(rootDirectory, 'scripts', 'Close-RecoveryBrowser.ps1'),
            ], { cwd: rootDirectory, windowsHide: true, timeout: 25000, maxBuffer: 65536 }),
          }),
          readConfirmations: attemptId => readFreshNativeWafPreflight(true, attemptId),
        });
        if (continuation) nativeContinuations.set(target.origin, continuation);
      }
      if (delayMs > 0) await wait(delayMs);
      const needsRecoveryBrowser = recoveryEntries.some(({ target }) => {
        const origin = target.origin;
        return !nativeContinuations.has(origin)
          && !["signed", "already_signed"].includes(loginOutcomes.get(origin)?.authoritativeCheckinStatus);
      });
      const recoveryContext = needsRecoveryBrowser ? await launchAutomationContext(config) : null;
      try {
        for (let recoveryIndex = 0; recoveryIndex < recoveryEntries.length; recoveryIndex += 1) {
          const { resultIndex, target } = recoveryEntries[recoveryIndex];
          const initialResult = results[resultIndex];
          console.log(`[recovery ${round + 1}.${recoveryIndex + 1}/${recoveryEntries.length}] ${target.origin}`);
          const loginOutcome = loginOutcomes.get(target.origin);
          const sameSessionStatus = loginOutcome?.authoritativeCheckinStatus;
          const recoveredResult = nativeContinuations.get(target.origin) ?? (["signed", "already_signed"].includes(sameSessionStatus)
            ? {
                status: sameSessionStatus,
                reason: sameSessionStatus === "signed"
                  ? "原生同会话 OAuth 后由签到接口确认今日签到完成"
                  : "原生同会话 OAuth 后由签到接口确认今日已签到",
              }
            : await runOneTarget(recoveryContext, target));
          const priorHistory = initialResult.recovery?.history ?? [];
          results[resultIndex] = {
            origin: target.origin,
            title: target.title,
            folderNames: target.folderNames,
            ...recoveredResult,
            recovery: {
              attempted: true,
              initialStatus: initialResult.recovery?.initialStatus ?? initialResult.status,
              history: [...priorHistory, {
                round: round + 1,
                status: recoveredResult.status,
                login: loginOutcome ?? { attempted: false },
              }],
            },
          };
          await writeProgress(`recovery_${round + 1}`, {
            recoveryCompleted: recoveryIndex + 1,
            recoveryTotal: recoveryEntries.length,
          });
        }
      } finally {
        await recoveryContext?.close();
      }
    }

    const finishedAt = new Date();
    const assembledResults = resumeBase
      ? preferredTargets.map((target) => configuredNoCheckinResult(target, config)
        ?? results.find((result) => result.origin === target.origin)
        ?? resumeBase.results.find((result) => result.origin === target.origin)
        ?? { origin: target.origin, title: target.title, folderNames: target.folderNames, status: "error", reason: "续跑未生成站点结果" })
      : results;
    const currentOrigins = new Set(results.map((result) => result.origin));
    const finalResults = advanceAttemptedDeferredRetries(
      assembledResults.map((result) => currentOrigins.has(result.origin) ? deferUnresolvedLogin(result, config, finishedAt) : result),
      currentOrigins,
      resumeBase?.results,
      config,
      finishedAt,
    );
    const summary = summarizeResults(finalResults);
    const processedTotal = finalResults.length;
    const isComplete = processedTotal === plannedTotal;
    const selectedTotal = selectedTargets.length;
    const selectedProcessedTotal = results.length;
    const selectedSummary = summarizeResults(finalResults.filter((result) => currentOrigins.has(result.origin)));
    const scopeComplete = selectedTotal > 0 && selectedProcessedTotal === selectedTotal;
    const output = {
      runId: runLog.runId,
      planFingerprint: planMetadata.planFingerprint,
      runState: "final",
      plannedTotal,
      processedTotal,
      isComplete,
      selectedTotal,
      selectedProcessedTotal,
      selectedOrigins: selectedOriginList,
      selectedSummary,
      scopeComplete,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      bookmarkSummary: report,
      summary,
      nextRetryAt: nextDeferredRetryAt(finalResults, finishedAt),
      results: finalResults,
    };
    const minimumTargets = Math.max(1, Number(config.minimumBookmarkTargetCount) || 1);
    const updateLatest = isComplete && finalResults.length >= minimumTargets;
    const resultPath = await writeRunResult(logsRoot, runLog, output, {
      updateLatest,
      reconcileLatest: !updateLatest && scopeComplete,
    });
    await writeSiteState(siteStatePath, updateSiteState(siteState, results, finishedAt));
    await writeQaCache(qaCachePath, updateQaCache(qaCache, results, finishedAt));
    // Keep same-day confirmations for scoped retries; readers reject prior-day evidence.
    console.log(JSON.stringify({ resultPath, selectedSummary, summary }, null, 2));
    if (!isComplete || finalResults.some((result) => !isTerminalResult(result))) {
      process.exitCode = 2;
    }
  }
} finally {
  await releaseRunLock(lockLease).catch(() => {});
}
