import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  connectOverCdpWithRetry,
  evaluateOverRawCdp,
  selectNewestRawCdpTarget,
} from "../src/native-cdp.mjs";

test("轻量 CDP 只选择同源页面和本机调试套接字", () => {
  const targets = [
    { type: "page", url: "https://target.test/old", webSocketDebuggerUrl: "ws://127.0.0.1:12345/old" },
    { type: "page", url: "https://outside.test/", webSocketDebuggerUrl: "ws://127.0.0.1:12345/outside" },
    { type: "page", url: "https://target.test/new", webSocketDebuggerUrl: "ws://127.0.0.1:12345/new" },
    { type: "page", url: "https://target.test/remote", webSocketDebuggerUrl: "ws://outside.test:12345/remote" },
  ];
  assert.equal(selectNewestRawCdpTarget(targets, "https://target.test", 12345), targets[2]);
  assert.equal(selectNewestRawCdpTarget(targets, "https://target.test", 54321), null);
});

test("轻量 CDP 仅发送一次有返回值的 Runtime.evaluate", async () => {
  const commands = [];
  class FakeWebSocket {
    listeners = new Map();
    constructor() { queueMicrotask(() => this.emit("open", {})); }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    emit(type, event) { this.listeners.get(type)?.(event); }
    send(raw) {
      const command = JSON.parse(raw);
      commands.push(command);
      queueMicrotask(() => this.emit("message", {
        data: JSON.stringify({ id: command.id, result: { result: { value: { status: "already_signed" } } } }),
      }));
    }
    close() {}
  }
  const result = await evaluateOverRawCdp(12345, "https://target.test", "Promise.resolve(1)", {
    timeoutMs: 1000,
    retryDelayMs: 1,
    fetchImpl: async () => ({
      ok: true,
      json: async () => [{
        type: "page",
        url: "https://target.test/profile",
        webSocketDebuggerUrl: "ws://127.0.0.1:12345/page",
      }],
    }),
    WebSocketImpl: FakeWebSocket,
  });
  assert.deepEqual(result, { status: "already_signed" });
  assert.deepEqual(commands.map(({ method }) => method), ["Runtime.evaluate"]);
  assert.equal(commands[0].params.awaitPromise, true);
  assert.equal(commands[0].params.returnByValue, true);
});

test("原生浏览器调试端口冷启动时会重试直到连接成功", async () => {
  let attempts = 0;
  const endpoints = [];
  const expected = { connected: true };
  const chromium = {
    connectOverCDP: async (endpoint) => {
      endpoints.push(endpoint);
      attempts += 1;
      if (attempts < 3) throw new Error("ECONNREFUSED");
      return expected;
    },
  };
  assert.equal(await connectOverCdpWithRetry(chromium, 12345, {
    timeoutMs: 1000, attemptTimeoutMs: 50, retryDelayMs: 1,
  }), expected);
  assert.equal(attempts, 3);
  assert.deepEqual(new Set(endpoints), new Set(["http://127.0.0.1:12345"]));
});

test("原生浏览器调试连接拒绝无效端口和连接器", async () => {
  await assert.rejects(() => connectOverCdpWithRetry({ connectOverCDP() {} }, 0), /参数无效/);
  await assert.rejects(() => connectOverCdpWithRetry({ connectOverCDP() {} }, 65536), /参数无效/);
  await assert.rejects(() => connectOverCdpWithRetry({}, 12345), /参数无效/);
});

test("原生浏览器调试连接在总时限内有界失败", async () => {
  let attempts = 0;
  await assert.rejects(() => connectOverCdpWithRetry({
    connectOverCDP: async () => { attempts += 1; throw new Error("ECONNREFUSED"); },
  }, 12345, {
    timeoutMs: 20,
    attemptTimeoutMs: 5,
    retryDelayMs: 5,
  }), /限定时间/);
  assert.ok(attempts >= 1);
  assert.ok(attempts <= 6);
});

test("原生登录与检查器统一使用浏览器中性的 CDP 冷启动重试", async () => {
  for (const file of ["native-login.mjs", "native-browser-inspect.mjs"]) {
    const source = await fs.readFile(new URL(`../src/${file}`, import.meta.url), "utf8");
    assert.match(source, /import \{[^}]*connectOverCdpWithRetry[^}]*\} from "\.\/native-cdp\.mjs"/);
    assert.match(source, /await connectOverCdpWithRetry\(chromium, port,/);
    assert.doesNotMatch(source, /chromium\.connectOverCDP\(/);
  }
});
