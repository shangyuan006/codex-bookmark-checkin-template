// Return fixed, non-sensitive diagnostics; raw browser errors can contain URLs.
export function classifyNavigationFailure(error) {
  const text = String(error?.message ?? error ?? '');
  if (/\b(?:ERR_CERT_[A-Z_]+|CERT_HAS_EXPIRED|CERT_NOT_YET_VALID|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|ERR_TLS_CERT_ALTNAME_INVALID)\b/.test(text)) {
    return { status: 'deferred', retryCause: 'upstream_unavailable', failureCode: 'tls_certificate_invalid',
      retryableLoginRecovery: false, reason: '站点证书无效，今日暂停重试，次日再核验' };
  }
  if (/\b(?:ERR_SSL_[A-Z_]+|ERR_TLS_[A-Z_]+|EPROTO)\b/.test(text)) {
    return { status: 'deferred', retryCause: 'upstream_unavailable', failureCode: 'tls_handshake_failed',
      retryableLoginRecovery: false, reason: '站点 TLS 连接失败，等待站点恢复后再检查' };
  }
  return null;
}

export function isActiveSiteMaintenance({ title = '', bodyText = '' } = {}) {
  const lines = [title, ...String(bodyText).slice(0, 30000).split(/\r?\n/)]
    .map(value => String(value).replace(/\s+/g, ' ').trim()).filter(value => value.length <= 240);
  return lines.some((line,index) => {
    // Notices about past or planned work are not a current service outage.
    const context = lines.slice(Math.max(0,index-1),index+2).join(' ');
    if (/历史|歷史|计划|計劃|将于|將於|预计|預計|维护完成|維護完成|维护结束|維護結束|恢复正常|恢復正常|maintenance (?:completed|scheduled for)/i.test(context)) return false;
    return /^(?:系统|系統|站点|站點|网站|網站|服务|服務)?\s*(?:正在)?\s*(?:维护|維護)中[。.!！]?$/.test(line)
      || /^(?:scheduled |under |site |system |service )?maintenance(?: in progress)?[.!]?$/.test(line.toLowerCase())
      || /(?:正在|系统|系統|站点|站點|服务|服務).{0,8}(?:维护|維護).{0,40}(?:暂时无法访问|暫時無法訪問|暂停服务|暫停服務|暂不可用|暫不可用)/.test(line)
      || /^(?:维护|維護)通知.{0,100}(?:暂时无法访问|暫時無法訪問)/.test(line)
      || /(?:site|system|service) (?:is )?(?:currently )?(?:under|down for) maintenance/i.test(line);
  });
}

export function pausesUntilNextDay(result) {
  return result?.siteCondition === 'site_maintenance'
    || ['site_maintenance', 'tls_certificate_invalid'].includes(result?.failureCode);
}
