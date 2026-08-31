function positiveInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function validPort(port) {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

function isLoopbackDebuggerSocket(rawUrl, port) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "ws:"
      && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      && Number.parseInt(url.port, 10) === port;
  } catch {
    return false;
  }
}

export function selectNewestRawCdpTarget(targets, expectedOrigin, port) {
  if (!Array.isArray(targets) || !validPort(port)) return null;
  const matches = targets.filter((target) => {
    if (target?.type !== "page" || !isLoopbackDebuggerSocket(target.webSocketDebuggerUrl, port)) return false;
    try {
      return new URL(target.url).origin === expectedOrigin;
    } catch {
      return false;
    }
  });
  return matches.at(-1) ?? null;
}

function evaluateRawCdpSocket(webSocketUrl, expression, WebSocketImpl, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(webSocketUrl);
    const commandId = 1;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      callback(value);
    };
    const timer = setTimeout(() => finish(reject, new Error("raw CDP evaluation timed out")), timeoutMs);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        id: commandId,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      }));
    });
    socket.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.id !== commandId) return;
      if (message.error || message.result?.exceptionDetails) {
        finish(reject, new Error("raw CDP evaluation failed"));
        return;
      }
      finish(resolve, message.result?.result?.value ?? null);
    });
    socket.addEventListener("error", () => finish(reject, new Error("raw CDP socket failed")));
    socket.addEventListener("close", () => finish(reject, new Error("raw CDP socket closed before evaluation")));
  });
}

export async function evaluateOverRawCdp(port, expectedOrigin, expression, options = {}) {
  if (!validPort(port)
    || typeof expectedOrigin !== "string"
    || new URL(expectedOrigin).origin !== expectedOrigin
    || typeof expression !== "string"
    || !expression.trim()) {
    throw new Error("原生浏览器轻量调试参数无效");
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;
  if (typeof fetchImpl !== "function" || typeof WebSocketImpl !== "function") {
    throw new Error("原生浏览器轻量调试运行时不可用");
  }
  const timeoutMs = positiveInteger(options.timeoutMs, 15000, 60000);
  const retryDelayMs = positiveInteger(options.retryDelayMs, 500, 5000);
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  do {
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
      if (!response?.ok) throw new Error("raw CDP target list unavailable");
      const target = selectNewestRawCdpTarget(await response.json(), expectedOrigin, port);
      if (!target) throw new Error("raw CDP target origin not found");
      return await evaluateRawCdpSocket(
        target.webSocketDebuggerUrl,
        expression,
        WebSocketImpl,
        Math.max(1, deadline - Date.now()),
      );
    } catch (error) {
      lastError = error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(retryDelayMs, remaining)));
    }
  } while (Date.now() < deadline);
  throw new Error("原生浏览器轻量调试未在限定时间内完成", { cause: lastError });
}

export async function connectOverCdpWithRetry(chromium, port, options = {}) {
  if (!chromium?.connectOverCDP
    || !validPort(port)) {
    throw new Error("原生浏览器调试连接参数无效");
  }

  const timeoutMs = positiveInteger(options.timeoutMs, 15000, 60000);
  const attemptTimeoutMs = positiveInteger(options.attemptTimeoutMs, 2000, 10000);
  const retryDelayMs = positiveInteger(options.retryDelayMs, 500, 5000);
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  do {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
        timeout: Math.min(attemptTimeoutMs, Math.max(1, deadline - Date.now())),
      });
    } catch (error) {
      lastError = error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(retryDelayMs, remaining)));
    }
  } while (Date.now() < deadline);

  throw new Error("原生浏览器未在限定时间内开放调试端口", { cause: lastError });
}
