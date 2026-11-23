// Only structural login evidence may cross the helper process boundary.
export const LOGIN_DIAGNOSTIC_STAGES = new Set([
  'navigation', 'form_expand', 'form_fields', 'autofill', 'credentials_ready',
  'submit_control', 'challenge_ready', 'challenge_blocked', 'submit_click',
  'post_submit', 'session_present', 'session_verification', 'completed',
]);

const booleanFields = [
  'formUnique', 'credentialsReady', 'submitAvailable', 'postLoginReadback',
  'configuredSessionCheck', 'sessionAccepted', 'helperError',
];
const counterFields = [
  'submitAttempts', 'submitClicksCompleted', 'loginPostRequests', 'loginPostResponses',
];

export function sanitizeLoginDiagnostics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const key of booleanFields) {
    if (typeof value[key] === 'boolean') result[key] = value[key];
  }
  for (const key of counterFields) {
    if (Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= 1000) result[key] = value[key];
  }
  if (Number.isInteger(value.elapsedMs) && value.elapsedMs >= 0 && value.elapsedMs <= 3600000) {
    result.elapsedMs = value.elapsedMs;
  }
  if (Array.isArray(value.loginPostStatusCodes)) {
    result.loginPostStatusCodes = [...new Set(value.loginPostStatusCodes.filter(
      code => Number.isInteger(code) && code >= 100 && code <= 599,
    ))].slice(0, 8);
  }
  return Object.keys(result).length ? { loginDiagnostics: result } : {};
}

export function createLoginDiagnostics({ expectedOrigin, emit = () => {}, now = Date.now }) {
  const startedAt = now();
  let stage = 'navigation';
  let state = { submitAttempts: 0, submitClicksCompleted: 0, loginPostRequests: 0,
    loginPostResponses: 0, loginPostStatusCodes: [] };
  const snapshot = () => ({ loginStage: stage, ...sanitizeLoginDiagnostics({ ...state,
    elapsedMs: Math.min(3600000, Math.max(0, Math.floor(now() - startedAt))) }) });
  const checkpoint = (nextStage = stage, fields = {}) => {
    if (LOGIN_DIAGNOSTIC_STAGES.has(nextStage)) stage = nextStage;
    state = { ...state, ...sanitizeLoginDiagnostics(fields).loginDiagnostics };
    // Diagnostics must never interfere with login if a consumer closes stderr.
    try { emit(snapshot()); } catch { /* observation only */ }
  };
  const isLoginPost = request => {
    try {
      const url = new URL(request.url());
      return url.origin === expectedOrigin && request.method() === 'POST'
        && /(?:^|\/)(?:log[-_]?in|sign[-_]?in|auth|session)(?:[/.]|$)/i.test(url.pathname);
    } catch { return false; }
  };
  const observeRequest = request => {
    if (isLoginPost(request)) checkpoint(stage, { loginPostRequests: Math.min(1000, state.loginPostRequests + 1) });
  };
  const observeResponse = response => {
    try {
      if (!isLoginPost(response.request())) return;
      checkpoint(stage, { loginPostResponses: Math.min(1000, state.loginPostResponses + 1),
        loginPostStatusCodes: [...state.loginPostStatusCodes, response.status()] });
    } catch { /* no request, response, or exception contents are retained */ }
  };
  return { checkpoint, snapshot, observeRequest, observeResponse };
}
