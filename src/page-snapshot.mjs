// This function is serialized into the page. Keep it self-contained and return
// only fixed signals from the full text before truncating diagnostic text.
export const PAGE_CHALLENGE_SELECTOR = 'iframe[src*="captcha" i], iframe[src*="turnstile" i], iframe[src*="challenge" i], .cf-turnstile, .h-captcha, .g-recaptcha, cap-widget, .cap-verify, altcha-widget, .altcha, [data-altcha], [data-cap-api-endpoint], [class*="captcha" i]';

export function readPageSnapshot(challengeSelector) {
  const visible = element => {
    const style = getComputedStyle(element), rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  const fullText = String(document.body?.innerText ?? '');
  const boundedText = fullText.length <= 2 * 1024 * 1024 ? fullText : '';
  // Exact current-day lines cannot be supplied by a cumulative count, a page
  // title, or prose explaining what happens after signing in.
  const confirmedDailyText = boundedText.split(/\r?\n/).some(line =>
    /^(?:您\s*)?(?:今日|今天|当日|當日)\s*已\s*(?:(?:经|經)\s*)?(?:完成\s*)?(?:签到|簽到)[。！!]?$/i.test(line.trim()));
  const unsignedTextObserved = /(?:尚未|还未|還未|未|没有|沒有|not|hasn['’]?t|haven['’]?t)\s*(?:完成)?\s*(?:签到|簽到|打卡|checked[ -]?in|signed[ -]?in)/i.test(boundedText);
  const loginRequiredTextObserved = /未登录|尚未登录|请先登录|請先登入|not logged in|sign in to continue/i.test(boundedText);
  const passwordInputs = [...document.querySelectorAll('input[type="password"]')].some(visible);
  const hasTwoFactorControl = [...document.querySelectorAll(
    'input[autocomplete="one-time-code"], input[name*="otp" i], input[name*="two_factor" i], input[name*="twofactor" i]',
  )].some(visible);
  const controlTexts = [...document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]')]
    .filter(visible).map(element => String(element.innerText || element.value || element.getAttribute('aria-label') || '')
      .replace(/\s+/g, ' ').trim());
  const confirmedCheckinControl = controlTexts.some(text =>
    /^(?:(?:今日|今天|当日|當日)\s*)?已\s*(?:完成\s*)?(?:签到|簽到)$/i.test(text));
  const matches = [...document.querySelectorAll(challengeSelector)];
  const roots = matches.filter(element => !matches.some(other => other !== element && other.contains(element)));
  const challengeEvidence = roots.map(element => {
    const scopes = [element, element.shadowRoot].filter(Boolean);
    const states = [element, ...scopes.flatMap(root => [...root.querySelectorAll(
      'input[type="checkbox"], [aria-checked], [data-state], [data-status], [class*="success" i], [class*="verified" i], [class*="solved" i], [class*="complete" i], [class*="passed" i]',
    )])];
    const resolvedState = states.some(candidate => candidate.checked === true
      || candidate.getAttribute('aria-checked') === 'true'
      || /(?:^|[-_\s])(?:success|verified|solved|complete|completed|passed)(?:$|[-_\s])/i.test([
        candidate.getAttribute('data-state'), candidate.getAttribute('data-status'),
        typeof candidate.className === 'string' ? candidate.className : '',
      ].filter(Boolean).join(' ')));
    const responses = scopes.flatMap(root => [...root.querySelectorAll(
      'textarea[name*="response" i], input[name*="response" i], textarea[name*="captcha" i], input[name*="captcha" i], input[name="altcha" i], [data-response]',
    )]);
    const responsePresent = responses.some(candidate => String(
      'value' in candidate ? candidate.value : candidate.getAttribute('data-response') || '',
    ).trim().length > 0);
    const explicitWidget = element.matches(
      'iframe, .cf-turnstile, .h-captcha, .g-recaptcha, cap-widget, .cap-verify, altcha-widget, [data-altcha], [data-cap-api-endpoint]',
    );
    const challengeLike = explicitWidget || responses.length > 0 || scopes.some(root => root.querySelector(
      'iframe[src*="captcha" i], iframe[src*="turnstile" i], iframe[src*="challenge" i], img[src*="captcha" i], img[alt*="captcha" i], canvas, input[type="checkbox"], [role="checkbox"], input[type="text"][name*="captcha" i], input[type="text"][id*="captcha" i], [data-sitekey]',
    ));
    let cloudflare = element.matches('.cf-turnstile');
    try { const url = new URL(element.getAttribute('src'));
      cloudflare ||= url.protocol === 'https:' && (url.hostname === 'challenges.cloudflare.com'
        || url.hostname.endsWith('.challenges.cloudflare.com'));
    } catch { /* Non-frame widgets keep their own evidence. */ }
    return { visible: visible(element), challengeLike, resolvedState, responsePresent, cloudflare };
  });
  return {
    bodyText: fullText.slice(0, 30000), confirmedDailyText, unsignedTextObserved, hasTwoFactorControl, loginRequiredTextObserved,
    passwordInputs, hasPassword: passwordInputs, controlTexts, confirmedCheckinControl, challengeEvidence,
    loaded: document.readyState === 'complete',
    authenticated: [...document.querySelectorAll('a')].some(element => visible(element)
      && /(?:^|\/)(?:log[-_]?out(?:\.php|\/|$)|exit\.php)(?:[?#]|$)/i.test(element.getAttribute('href') || '')),
    safeLinePrompt: Boolean(document.querySelector('#sl-text')),
    safeLineControlEnabled: [...document.querySelectorAll('button#sl-check')]
      .some(element => visible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true'),
  };
}
