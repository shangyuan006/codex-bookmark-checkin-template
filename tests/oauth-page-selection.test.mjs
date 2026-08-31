import assert from "node:assert/strict";
import test from "node:test";
import { selectPreferredOAuthTargetPage } from "../src/oauth-page-selection.mjs";

function page(url, closed = false) {
  return { url: () => url, isClosed: () => closed };
}

test("OAuth page selection prefers an authenticated profile over a newer login page", () => {
  const profile = page("https://target.example/profile");
  const login = page("https://target.example/sign-in");
  assert.equal(selectPreferredOAuthTargetPage([profile, login], "https://target.example"), profile);
});

test("OAuth page selection uses the newest equally ranked target page", () => {
  const older = page("https://target.example/overview");
  const newer = page("https://target.example/dashboard");
  assert.equal(selectPreferredOAuthTargetPage([older, newer], "https://target.example"), newer);
});

test("OAuth page selection ignores other origins and closed pages", () => {
  const other = page("https://other.example/profile");
  const closed = page("https://target.example/profile", true);
  const detached = { url: () => { throw new Error("detached"); } };
  assert.equal(selectPreferredOAuthTargetPage([other, closed, detached], "https://target.example"), null);
});
