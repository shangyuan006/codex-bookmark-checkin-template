import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { publicBookmarkReport } from "./bookmarks.mjs";
import { launchAutomationContext, processTarget } from "./browser.mjs";
import { readEffectiveBookmarkPlan } from "./effective-bookmark-plan.mjs";
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
  await atomicWriteJson(lastValidBookmarkPlanPath, publicBookmarkReport(plan));
  return plan;
}

async function readFreshNativeWafPreflight() {
  if (ignoreNativePreflight) return new Map();
  const configuredUrls = [
    ...(config.nativeWafPreflightUrls ?? []).map((value) => typeof value === "string" ? value : value?.url),
    ...(config.nativeChallengePreflight ?? []).map((value) => value?.url),
  ].filter(Boolean);
  const allowedOrigins = new Set(configuredUrls.map((value) => new URL(value).origin));
  const report = await fs.readFile(nativeWafPreflightPath, "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => null);
  const generatedAt = Date.parse(report?.generatedAt ?? "");
  if (!Number.isFinite(generatedAt) || Date.now() - generatedAt > 10 * 60 * 1000) return new Map();
  return new Map((report?.results ?? [])
    .filter((result) => allowedOrigins.has(result?.origin) && result?.status === "signed")
    .map((result) => [result.origin, result]));
}

const lockLease = await acquireRunLock(lockPath);
try {
  const plan = await readValidatedBookmarkPlan();
  const report = publicBookmarkReport(plan);
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
    const nativeWafPreflight = await readFreshNativeWafPreflight();
    const preferredTargets = applyPreferredCandidates(plan.targets, siteState);
    const originFilteredTargets = selectedOrigins
      ? preferredTargets.filter((target) => selectedOrigins.has(target.origin))
      : preferredTargets;
    const selectedTargets = limit
      ? originFilteredTargets.slice(offset, offset + limit)
      : originFilteredTargets.slice(offset);
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
    const configuredReauthTargets = selectedTargets.filter((target) => getConfiguredReauthRule(target, config));
    for (let index = 0; index < configuredReauthTargets.length; index += 1) {
      const target = configuredReauthTargets[index];
      const accountCount = getConfiguredReauthAccounts(target, config).length;
      console.log(`[reauth ${index + 1}/${configuredReauthTargets.length}] ${target.origin} (${accountCount} isolated accounts)`);
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
    const needsGenericBrowser = selectedTargets.some((target) => !reauthResults.has(target.origin));
    const context = needsGenericBrowser ? await launchAutomationContext(config) : null;

    const rememberLogicalCompletion = (target, result) => {
      const group = config.logicalCheckinGroups?.[target.origin];
      if (group && ["signed", "already_signed"].includes(result.status)) {
        logicalCompletions.set(group, { origin: target.origin, result });
      }
    };

    const runOneTarget = async (activeContext, target, allowReuse = true) => {
      const started = Date.now();
      const reauthResult = reauthResults.get(target.origin);
      if (reauthResult) return { ...reauthResult, attempt: 1, durationMs: Date.now() - started };
      const group = config.logicalCheckinGroups?.[target.origin];
      const reused = allowReuse && group ? logicalCompletions.get(group) : null;
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
      const result = await runWithRecentNotAvailableCache(target, siteState, config, async () => {
        const preflight = nativeWafPreflight.get(target.origin);
        return preflight
          ? { status: "signed", reason: preflight.reason, url: preflight.url, attempt: 1, nativePreflight: true }
          : processTarget(activeContext, target, config, qaRules, runLog.directory);
      });
      const timed = { ...result, durationMs: Date.now() - started };
      rememberLogicalCompletion(target, timed);
      return timed;
    };

    try {
      for (let index = 0; index < selectedTargets.length; index += 1) {
        const target = selectedTargets[index];
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
      const recoveryIndexes = results
        .map((result, index) => isRetryEligible(result) ? index : -1)
        .filter((index) => index >= 0);
      if (recoveryIndexes.length === 0) break;
      console.log(`[recovery ${round + 1}/${recoveryRounds}] 将复查 ${recoveryIndexes.length} 个异常站点`);
      const loginOutcomes = new Map();
      for (const resultIndex of recoveryIndexes) {
        const current = results[resultIndex];
        const target = selectedTargets[resultIndex];
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
            const helperOutput = await execFileAsync(method.executable, method.args, {
              cwd: rootDirectory,
              windowsHide: true,
              timeout: 180000,
              maxBuffer: 1024 * 1024,
            });
            const outcome = loginHelperOutcomeFromStreams(helperOutput.stdout, helperOutput.stderr);
            attempts.push({ method: method.method, ...outcome });
            if (outcome.succeeded) {
              succeeded = true;
              authoritativeCheckinStatus = outcome.checkinStatus ?? null;
              break;
            }
          } catch (error) {
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
      if (delayMs > 0) await wait(delayMs);
      const needsRecoveryBrowser = recoveryIndexes.some((resultIndex) => {
        const origin = selectedTargets[resultIndex].origin;
        return !["signed", "already_signed"].includes(loginOutcomes.get(origin)?.authoritativeCheckinStatus);
      });
      const recoveryContext = needsRecoveryBrowser ? await launchAutomationContext(config) : null;
      try {
        for (let recoveryIndex = 0; recoveryIndex < recoveryIndexes.length; recoveryIndex += 1) {
          const resultIndex = recoveryIndexes[recoveryIndex];
          const target = selectedTargets[resultIndex];
          const initialResult = results[resultIndex];
          console.log(`[recovery ${round + 1}.${recoveryIndex + 1}/${recoveryIndexes.length}] ${target.origin}`);
          const loginOutcome = loginOutcomes.get(target.origin);
          const sameSessionStatus = loginOutcome?.authoritativeCheckinStatus;
          const recoveredResult = ["signed", "already_signed"].includes(sameSessionStatus)
            ? {
                status: sameSessionStatus,
                reason: sameSessionStatus === "signed"
                  ? "原生同会话 OAuth 后由签到接口确认今日签到完成"
                  : "原生同会话 OAuth 后由签到接口确认今日已签到",
              }
            : await runOneTarget(recoveryContext, target);
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
            recoveryTotal: recoveryIndexes.length,
          });
        }
      } finally {
        await recoveryContext?.close();
      }
    }

    const finishedAt = new Date();
    const assembledResults = resumeBase
      ? preferredTargets.map((target) => results.find((result) => result.origin === target.origin)
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
    await fs.rm(nativeWafPreflightPath, { force: true }).catch(() => {});
    console.log(JSON.stringify({ resultPath, selectedSummary, summary }, null, 2));
    if (!isComplete || finalResults.some((result) => !TERMINAL_STATUSES.has(result.status))) {
      process.exitCode = 2;
    }
  }
} finally {
  await releaseRunLock(lockLease).catch(() => {});
}
