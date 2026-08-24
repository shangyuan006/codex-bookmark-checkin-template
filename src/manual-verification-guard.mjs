function normalizeOrigin(value) {
  try {
    const url = new URL(String(value ?? ""));
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function pendingManualVerificationOrigins(document) {
  if (document?.state !== "pending_verification" || document?.authoritativeEvidenceRequired !== true) {
    return [];
  }
  const origins = [];
  for (const target of document.targets ?? []) {
    if (["signed", "already_signed", "not_available"].includes(String(target?.verificationStatus))) continue;
    const origin = normalizeOrigin(target?.origin);
    if (!origin) return [];
    origins.push(origin);
  }
  return [...new Set(origins)].sort();
}

export function assertManualVerificationExecution(document, options = {}) {
  if (document?.state !== "pending_verification" || document?.authoritativeEvidenceRequired !== true) return;

  const expectedRunDate = String(options.runDate ?? "");
  const sourceRunId = String(document?.sourceRunId ?? "");
  if (expectedRunDate && /^\d{8}-/.test(sourceRunId) && !sourceRunId.startsWith(`${expectedRunDate}-`)) return;
  if (expectedRunDate && !sourceRunId.startsWith(`${expectedRunDate}-`)) {
    throw new Error("当天人工复核记录缺少有效的来源运行编号；拒绝绕过复核状态");
  }

  const pendingOrigins = pendingManualVerificationOrigins(document);
  if (pendingOrigins.length === 0) {
    throw new Error("人工复核记录没有有效的待复核站点；拒绝绕过复核状态");
  }
  if (options.consume !== true) {
    throw new Error("检测到待人工复核记录；请通过 scripts/Run-Checkin.ps1 执行，避免遗漏复核状态收尾");
  }
  if (options.resumeRequested !== true) {
    throw new Error("人工复核消费必须携带当天完整报告");
  }
  const selectedOrigins = [...new Set([...(options.selectedOrigins ?? [])]
    .map(normalizeOrigin)
    .filter(Boolean))].sort();
  if (selectedOrigins.length !== pendingOrigins.length
    || selectedOrigins.some((origin, index) => origin !== pendingOrigins[index])) {
    throw new Error("人工复核消费范围必须与待复核记录完全一致");
  }
}
