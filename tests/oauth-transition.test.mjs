import assert from "node:assert/strict";
import test from "node:test";
import { waitForFirstTransition, waitForOriginPage } from "../src/oauth-transition.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("OAuth transition waits past an early empty result for a later navigation", async () => {
  const popup = deferred();
  const navigation = deferred();
  const result = waitForFirstTransition([popup.promise, navigation.promise]);

  popup.resolve(null);
  await Promise.resolve();
  navigation.resolve("same-page-navigation");

  assert.equal(await result, "same-page-navigation");
});

test("OAuth transition returns the first usable page", async () => {
  const popup = deferred();
  const navigation = deferred();
  const result = waitForFirstTransition([popup.promise, navigation.promise]);

  navigation.resolve("same-page-navigation");
  popup.resolve("popup-page");

  assert.equal(await result, "same-page-navigation");
});

test("OAuth transition returns null only after every candidate fails", async () => {
  assert.equal(await waitForFirstTransition([
    Promise.resolve(null),
    Promise.reject(new Error("navigation timeout")),
  ]), null);
  assert.equal(await waitForFirstTransition([]), null);
});

test("OAuth callback can return in another page while the provider popup remains open", async () => {
  const providerPage = { url: () => "https://connect.linux.do/oauth", isClosed: () => false };
  const loginPage = { url: () => "https://target.example/login", isClosed: () => false };
  const callbackPage = { url: () => "https://target.example/oauth/callback?code=redacted", isClosed: () => false };
  const pages = [loginPage, providerPage];
  const context = { pages: () => pages };
  setTimeout(() => pages.push(callbackPage), 10);

  const result = await waitForOriginPage(context, "https://target.example", {
    timeoutMs: 200,
    pollMs: 5,
    preferredPage: providerPage,
    acceptPage: (page) => !/\/login(?:[/?#]|$)/.test(page.url()),
  });

  assert.equal(result, callbackPage);
});

test("OAuth callback lookup rejects other origins and target login pages", async () => {
  const context = {
    pages: () => [
      { url: () => "https://outside.example/oauth/callback", isClosed: () => false },
      { url: () => "https://target.example/login", isClosed: () => false },
    ],
  };
  const result = await waitForOriginPage(context, "https://target.example", {
    timeoutMs: 10,
    pollMs: 5,
    acceptPage: (page) => !/\/login(?:[/?#]|$)/.test(page.url()),
  });
  assert.equal(result, null);
});
