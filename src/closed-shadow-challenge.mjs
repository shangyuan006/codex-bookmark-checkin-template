import { assertBookmarkNavigation } from './security.mjs';

const attributes = node => Object.fromEntries(Array.from({ length: (node.attributes?.length ?? 0) / 2 },
  (_, i) => [node.attributes[i * 2], node.attributes[i * 2 + 1]]));
function descendants(root) {
  const result = [];
  const visit = node => {
    result.push(node);
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? []),
      ...(node.contentDocument ? [node.contentDocument] : [])]) visit(child);
  };
  visit(root);
  return result;
}
const allowedUrl = raw => {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && (url.hostname === 'challenges.cloudflare.com'
      || url.hostname.endsWith('.challenges.cloudflare.com'));
  } catch { return false; }
};
const box = model => {
  const q = model?.content;
  // Coordinates below are derived from the actual control, never widget size.
  if (!q || q.length !== 8 || !q.every(Number.isFinite) || model.width <= 0 || model.height <= 0
    || Math.abs(q[1] - q[3]) > 1 || Math.abs(q[0] - q[6]) > 1
    || Math.abs(q[4] - q[2]) > 1 || Math.abs(q[5] - q[7]) > 1
    || model.border && (Math.abs(model.border[2] - model.border[0] - model.width) > 2
      || Math.abs(model.border[5] - model.border[3] - model.height) > 2)) return null;
  return q;
};
const stable = (a, b) => a?.length === b?.length && a.every((n, i) => Math.abs(n - b[i]) < 2);

// The spinner and success/failure panels can replace the checkbox entirely.
// Read their rendered state inside each closed root without returning its text.
async function readWidgetState(command, nodes) {
  const state = { failed: false, loading: false, resolved: false, expired: false };
  for (const node of nodes.filter(node => node.nodeName === 'BODY' || node.shadowRootType)) {
    const resolved = await command('DOM.resolveNode', { backendNodeId: node.backendNodeId });
    try {
      const observed = await command('Runtime.callFunctionOn', { objectId: resolved.object.objectId,
        functionDeclaration: `function() {
          const visible = e => {
            const r=e.getBoundingClientRect(), s=getComputedStyle(e);
            return e.isConnected && r.width>0 && r.height>0 && s.display!=='none'
              && s.visibility!=='hidden' && Number(s.opacity)!==0
              && (!e.checkVisibility || e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}));
          };
          const text=[...this.querySelectorAll('*')].filter(visible)
            .flatMap(e=>[...e.childNodes].filter(n=>n.nodeType===3).map(n=>n.nodeValue)).join(' ');
          return { failed:/verification failed|验证失败|驗證失敗|failure!|unable to verify/i.test(text),
            loading:/verifying|正在验证|正在驗證|just a moment/i.test(text),
            resolved:/verification (?:successful|complete)|验证成功|驗證成功|验证已通过|驗證已通過|(?:^|\\s)(?:success|成功)[!！.]?(?=\\s|$)/i.test(text),
            expired:/verification expired|验证已过期|驗證已過期|验证超时|驗證逾時/i.test(text) };
        }`, returnByValue: true });
      if (!observed.result?.value || observed.exceptionDetails) throw new Error('widget_state_unreadable');
      for (const key of Object.keys(state)) state[key] ||= observed.result.value[key] === true;
    } finally { await command('Runtime.releaseObject', { objectId: resolved.object.objectId }).catch(() => {}); }
  }
  return state;
}

// Read-only CDP inspection penetrates both closed roots. Interaction remains a
// normal mouse click on one visible, stable, unobstructed checkbox/label.
export async function clickClosedShadowChallengeControl(page, expectedOrigin, { stableMs = 4000 } = {}) {
  if (typeof page.context?.()?.newCDPSession !== 'function') return null;
  let client, childSession, frame, commandId = 0;
  const pending = new Map();
  const receive = event => {
    if (event.sessionId !== childSession) return;
    let message;
    try { message = JSON.parse(event.message); } catch { return; }
    const operation = pending.get(message.id);
    if (operation) operation.finish(message.error ? new Error('widget_command_failed') : null, message.result);
  };
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++commandId;
    const finish = (error, result) => {
      clearTimeout(timer); pending.delete(id);
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('widget_command_timeout')), 2000);
    pending.set(id, { finish });
    client.send('Target.sendMessageToTarget', { sessionId: childSession,
      message: JSON.stringify({ id, method, params }) }).catch(() => finish(new Error('widget_command_failed')));
  });
  const details = { closedShadowFrameCount: 0, readyFrameCount: 0, directCandidateCount: 0,
    failedFrameCount: 0, loadingFrameCount: 0, resolvedFrameCount: 0, expiredFrameCount: 0,
    frameReplacementCount: 0 };
  const result = outcome => ({ clicked: false, outcome, details });
  const unbind = async () => {
    for (const operation of [...pending.values()]) operation.finish(new Error('widget_session_closed'));
    if (childSession) await client.send('Target.detachFromTarget', { sessionId: childSession }).catch(() => {});
    childSession = null;
  };
  try {
    assertBookmarkNavigation(page.url(), [expectedOrigin]);
    client = await page.context().newCDPSession(page);
    const inspectFrames = async () => {
      const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
      const frames = descendants(root).filter(node => node.nodeName === 'IFRAME' && allowedUrl(attributes(node).src)
        && new URL(attributes(node).src).origin !== expectedOrigin);
      const visible = [];
      for (const candidate of frames) {
        const geometry = await client.send('DOM.getBoxModel', { backendNodeId: candidate.backendNodeId }).catch(() => null);
        if (!box(geometry?.model)) continue;
        const resolved = await client.send('DOM.resolveNode', { backendNodeId: candidate.backendNodeId });
        try {
          const state = await client.send('Runtime.callFunctionOn', { objectId: resolved.object.objectId,
            functionDeclaration: 'function(){return this.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});}', returnByValue: true });
          if (state.result?.value === true) visible.push(candidate);
        } finally { await client.send('Runtime.releaseObject', { objectId: resolved.object.objectId }).catch(() => {}); }
      }
      return visible;
    };
    const visibleFrames = await inspectFrames();
    details.closedShadowFrameCount = visibleFrames.length;
    if (visibleFrames.length > 1) return result('challenge_frame_not_unique');
    if (visibleFrames.length !== 1 || !visibleFrames[0].frameId) return null;
    client.on('Target.receivedMessageFromTarget', receive);
    const bind = async candidate => {
      await unbind();
      const { targetInfo } = await client.send('Target.getTargetInfo', { targetId: candidate.frameId });
      if (!allowedUrl(targetInfo.url) || targetInfo.type !== 'iframe') throw new Error('widget_target_changed');
      childSession = (await client.send('Target.attachToTarget', { targetId: candidate.frameId, flatten: false })).sessionId;
      if (frame && (frame.frameId !== candidate.frameId || frame.backendNodeId !== candidate.backendNodeId)) details.frameReplacementCount++;
      frame = candidate;
    };
    await bind(visibleFrames[0]);
    const deadline = Date.now() + stableMs + 5000;
    let previous = null, stableSince = 0, unreadable = false;
    do {
      try {
        assertBookmarkNavigation(page.url(), [expectedOrigin]);
        const currentFrames = await inspectFrames();
        details.closedShadowFrameCount = currentFrames.length;
        details.readyFrameCount = details.directCandidateCount = details.failedFrameCount = details.loadingFrameCount = 0;
        details.resolvedFrameCount = details.expiredFrameCount = 0;
        if (currentFrames.length > 1) return result('challenge_frame_not_unique');
        if (currentFrames.length !== 1 || !currentFrames[0].frameId) {
          previous = null; stableSince = 0;
          await unbind();
          await page.waitForTimeout(250);
          continue;
        }
        const current = currentFrames[0];
        if (!childSession || current.frameId !== frame.frameId || current.backendNodeId !== frame.backendNodeId) {
          previous = null; stableSince = 0;
          await bind(current);
        }
        const tree = await command('DOM.getDocument', { depth: -1, pierce: true });
        const nodes = descendants(tree.root);
        const widget = await readWidgetState(command, nodes);
        unreadable = false;
        details.failedFrameCount = Number(widget.failed);
        details.loadingFrameCount = Number(widget.loading);
        details.resolvedFrameCount = Number(widget.resolved);
        details.expiredFrameCount = Number(widget.expired);
        if (widget.failed) return result('challenge_verification_failed');
        if (widget.expired) return result('challenge_expired');
        if (widget.resolved) return result('challenge_already_resolved');
        const controls = nodes.filter(node => {
          const a = attributes(node);
          return node.nodeName === 'INPUT' && a.type === 'checkbox' || a.role === 'checkbox';
        });
        details.directCandidateCount = controls.length;
        if (controls.length > 1) return result('challenge_not_unique');
        if (controls.length === 1) {
          const control = controls[0];
          const resolved = await command('DOM.resolveNode', { backendNodeId: control.backendNodeId });
          let state;
          try {
            const observed = await command('Runtime.callFunctionOn', { objectId: resolved.object.objectId,
              functionDeclaration: `function() {
                const visible = e => {
                  const r=e.getBoundingClientRect(), s=getComputedStyle(e);
                  return e.isConnected && r.width>0 && r.height>0 && s.display!=='none'
                    && s.visibility!=='hidden' && Number(s.opacity)!==0
                    && (!e.checkVisibility || e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}));
                };
                return {visible:visible(this)||[...(this.labels||[])].some(visible),
                  disabled:!!this.disabled||this.getAttribute('aria-disabled')==='true',
                  checked:!!this.checked||this.getAttribute('aria-checked')==='true'};
              }`, returnByValue: true });
            state = observed.result?.value;
          } finally { await command('Runtime.releaseObject', { objectId: resolved.object.objectId }).catch(() => {}); }
          if (state?.checked) { details.resolvedFrameCount = 1; return result('challenge_already_resolved'); }
          const f = box((await client.send('DOM.getBoxModel', { backendNodeId: frame.backendNodeId })).model);
          const c = box((await command('DOM.getBoxModel', { backendNodeId: control.backendNodeId })).model);
          const ready = state?.visible && !state.disabled && !widget.loading && f && c;
          details.readyFrameCount = Number(!!ready);
          if (ready) {
            if (previous?.id !== control.backendNodeId || !stable(previous.f, f) || !stable(previous.c, c)) {
              previous = { id: control.backendNodeId, f, c }; stableSince = Date.now();
            } else if (Date.now() - stableSince >= stableMs) {
              const latestFrames = await inspectFrames();
              if (latestFrames.length > 1) return result('challenge_frame_not_unique');
              if (latestFrames.length !== 1 || latestFrames[0].backendNodeId !== frame.backendNodeId
                || latestFrames[0].frameId !== frame.frameId) {
                previous = null; stableSince = 0;
                await page.waitForTimeout(250);
                continue;
              }
              const currentTarget = await client.send('Target.getTargetInfo', { targetId: frame.frameId });
              if (!allowedUrl(currentTarget.targetInfo.url)) return result('challenge_frame_unreadable');
              const localX = (c[0]+c[2]+c[4]+c[6])/4, localY = (c[1]+c[3]+c[5]+c[7])/4;
              const x = f[0] + localX, y = f[1] + localY;
              const associated = nodes.filter(node => node.nodeName === 'LABEL'
                && (attributes(node).for && attributes(node).for === attributes(control).id
                  || descendants(node).some(n => n.backendNodeId === control.backendNodeId)));
              const allowed = new Set([control.backendNodeId, ...associated.flatMap(n => descendants(n).map(n => n.backendNodeId))]);
              const hit = await command('DOM.getNodeForLocation', { x: Math.floor(localX), y: Math.floor(localY), includeUserAgentShadowDOM: true });
              const parentHit = await client.send('DOM.getNodeForLocation', { x: Math.floor(x), y: Math.floor(y), includeUserAgentShadowDOM: true });
              // Backend IDs from different target sessions are not comparable.
              // A child control ID is meaningful only with its bound frame ID.
              const parentClear = parentHit.backendNodeId === frame.backendNodeId
                || parentHit.frameId === frame.frameId && allowed.has(parentHit.backendNodeId);
              if (!allowed.has(hit.backendNodeId) || !parentClear) return result('challenge_obstructed');
              assertBookmarkNavigation(page.url(), [expectedOrigin]);
              try { await page.mouse.click(x, y); }
              catch { return result('challenge_click_failed'); }
              return { clicked: true, outcome: 'challenge_checkbox_clicked', details: { ...details, frameStableMs: Date.now()-stableSince } };
            }
          } else { previous = null; stableSince = 0; }
        } else { previous = null; stableSince = 0; }
      } catch {
        // The widget can replace its control between DOM inspection and box
        // reading. Drop the old identity and start a fresh stability interval.
        previous = null; stableSince = 0;
        details.readyFrameCount = 0;
        details.unreadableFrameCount = (details.unreadableFrameCount ?? 0) + 1;
        unreadable = true;
        await unbind();
        assertBookmarkNavigation(page.url(), [expectedOrigin]);
      }
      await page.waitForTimeout(250);
    } while (Date.now() < deadline);
    return result(unreadable ? 'challenge_frame_unreadable' : details.loadingFrameCount ? 'challenge_loading' : 'challenge_not_ready');
  } catch { return childSession ? result('challenge_frame_unreadable') : null; }
  finally {
    await unbind();
    client?.off('Target.receivedMessageFromTarget', receive);
    await client?.detach().catch(() => {});
  }
}
