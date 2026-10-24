// Opt-in, reviewed same-origin GET endpoints only. Values and response bodies
// stay in memory; reports contain fixed outcomes rather than private JSON.
export function normalizeSequentialStatusCheck(raw, stepUrl) {
  if (raw == null) return null;
  let url;
  try { url = new URL(raw.url); } catch { throw new Error('顺序动作状态接口地址无效'); }
  if (raw.readOnly !== true || url.protocol !== 'https:' || url.origin !== new URL(stepUrl).origin
    || url.username || url.password || url.search || url.hash || url.pathname.length > 300 || url.pathname.includes('%')
    || /(?:logout|sign[-_]?out|delete|revoke|claim|draw|lottery)(?:\b|_)/i.test(url.pathname)
    || typeof raw.signedField !== 'string' || !/^[A-Za-z0-9_.-]{1,120}$/.test(raw.signedField)) {
    throw new Error('顺序动作状态接口必须为已审查的同源只读接口和布尔完成字段');
  }
  return { url: url.href, signedField: raw.signedField, readOnly: true };
}

export async function readSequentialStatus(request, rule) {
  let response;
  const unknown = { status: 'unconfirmed', failureCode: 'sequential_status_unconfirmed' };
  try {
    response = await request.get(rule.url, { maxRedirects: 0, timeout: 5000,
      failOnStatusCode: false, headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' } });
    if (response.url() !== rule.url) return unknown;
    if (response.status() === 401) return { status: 'login_required', failureCode: 'sequential_status_login_required' };
    if (response.status() !== 200) return unknown;
    const text = await response.text();
    if (text.length > 65536) return unknown;
    const json = JSON.parse(text);
    const value = rule.signedField.split('.').reduce((current, key) => (
      current && typeof current === 'object' && Object.hasOwn(current, key) ? current[key] : undefined
    ), json);
    return value === true ? { status: 'already_signed' } : value === false ? { status: 'not_signed' } : unknown;
  } catch { return unknown; }
  finally { await response?.dispose().catch(() => {}); }
}
