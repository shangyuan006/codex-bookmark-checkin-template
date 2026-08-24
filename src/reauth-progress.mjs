function safeNestedAccountResult(result) {
  const {
    accountId: _accountId,
    accountLabel: _accountLabel,
    authoritativeAccountId: _authoritativeAccountId,
    siteAccountId: _siteAccountId,
    ...safeResult
  } = result ?? {};
  return { ...safeResult };
}

export function buildReauthProgressResult(target, completedResults, accountCount, now = new Date()) {
  const accountResults = Array.isArray(completedResults)
    ? completedResults.map(safeNestedAccountResult)
    : [];
  const total = Math.max(accountResults.length, Math.max(1, Number(accountCount) || 1));
  return {
    origin: target.origin,
    title: target.title,
    folderNames: target.folderNames,
    status: "deferred",
    retryCause: "task_timeout",
    reason: `多账号签到尚未形成完整父结果；已保留 ${accountResults.length}/${total} 个账号进度`,
    nextEligibleAt: now.toISOString(),
    attempt: 0,
    durationMs: 0,
    accountProgress: {
      completed: accountResults.length,
      total,
    },
    accountResults,
  };
}

export function buildCompletedReauthProgressResult(target, result, accountCount, durationMs = 0) {
  const safeResult = safeNestedAccountResult(result);
  const accountResults = Array.isArray(safeResult.accountResults)
    ? safeResult.accountResults.map(safeNestedAccountResult)
    : [];
  const total = Math.max(accountResults.length, Math.max(1, Number(accountCount) || 1));
  return {
    ...safeResult,
    origin: target.origin,
    title: target.title,
    folderNames: target.folderNames,
    attempt: 1,
    durationMs: Math.max(0, Number(durationMs) || 0),
    accountProgress: {
      completed: total,
      total,
    },
    accountResults,
  };
}
