// Inspect only the widget document. No page text or verification response leaves
// the browser; iframe geometry alone is never evidence of a ready checkbox.
export async function readChallengeWidgetReadiness(frame, { includeDiagnostics = false } = {}) {
  const result = await frame.evaluate(() => {
    const visible = element => {
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none'
        && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
    };
    const roots = [document];
    for (let index = 0; index < roots.length; index++) {
      for (const element of roots[index].querySelectorAll('*')) {
        if (element.shadowRoot) roots.push(element.shadowRoot);
      }
    }
    const select = selector => roots.flatMap(root => [...root.querySelectorAll(selector)]);
    const text = roots.map(root => [...root.querySelectorAll('*')].filter(visible)
      .flatMap(element => [...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE)
        .map(node => node.textContent)).join(' ')).join(' ');
    const failed = /验证失败|驗證失敗|verification failed|failure!|unable to verify/i.test(text);
    const loading = /正在验证|正在驗證|verifying|just a moment/i.test(text)
      || select('[aria-busy="true"], #verifying').some(visible);
    const resolvedState = select('input[type="checkbox"]:checked, [role="checkbox"][aria-checked="true"], [data-state="success"], [data-status="verified"]').length > 0;
    const checkboxReady = select('input[type="checkbox"], [role="checkbox"], label').some(element => {
      const control = element.matches('label') ? element.control : element;
      return control?.matches('input[type="checkbox"], [role="checkbox"]') && visible(element)
        && !control.disabled && control.getAttribute('aria-disabled') !== 'true'
        && !control.checked && control.getAttribute('aria-checked') !== 'true';
    });
    const ready = checkboxReady && !failed && !loading && !resolvedState;
    return { failed, loading, resolvedState, checkboxReady: ready,
      documentLoaded: document.readyState === 'complete',
      documentEmpty: !text.trim() && !select('input[type="checkbox"], [role="checkbox"]').length,
      checkboxCandidateCount: Math.min(100, select('input[type="checkbox"], [role="checkbox"]').length),
      inspectionState: failed ? 'failed' : resolvedState ? 'resolved' : loading ? 'loading' : ready ? 'ready' : 'not_ready' };
  }).catch(error => {
    const message = String(error?.message ?? '');
    const inspectionError = /detach|closed/i.test(message) ? 'detached'
      : /context.*destroy|cannot find context/i.test(message) ? 'context_unavailable'
      : /timeout/i.test(message) ? 'timeout' : 'evaluation_failed';
    return { failed: false, loading: false, resolvedState: false, checkboxReady: false,
      inspectionState: 'unreadable', inspectionError };
  });
  if (includeDiagnostics) return result;
  const { documentLoaded, documentEmpty, checkboxCandidateCount, ...state } = result;
  return state;
}

// Hit test the actual click point, including open shadow roots and the host of
// a closed-shadow frame. A tour overlay or clipped frame must not receive it.
export async function challengePointIsUnobstructed(page, box, frameElement) {
  if (!frameElement) return false;
  return page.evaluate(({ x, y, frameElement }) => {
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
    let element = document.elementFromPoint(x, y);
    while (element?.shadowRoot?.elementFromPoint) {
      const inner = element.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === element) break;
      element = inner;
    }
    if (!element) return false;
    let expected = frameElement;
    while (expected) {
      if (element === expected) return true;
      expected = expected.getRootNode()?.host;
    }
    return false;
  }, { x: box.x + Math.min(38, box.width * 0.15), y: box.y + box.height / 2, frameElement }).catch(() => false);
}
