import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  discoverInstalledBrowsers,
  getBrowserDefinitions,
  normalizeBrowserChoice,
} from "../src/browser-platform.mjs";

test("normalizes supported browser choices", () => {
  assert.equal(normalizeBrowserChoice("Auto"), "auto");
  assert.equal(normalizeBrowserChoice("Google Chrome"), "chrome");
  assert.equal(normalizeBrowserChoice("Microsoft Edge"), "edge");
  assert.throws(() => normalizeBrowserChoice("Firefox"), /Unsupported browser/);
});

test("defines separate Chrome and Edge executable and profile locations", () => {
  const environment = {
    PROGRAMFILES: "C:\\Program Files",
    "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
    LOCALAPPDATA: "C:\\FixtureUserData\\Local",
  };
  const definitions = getBrowserDefinitions(environment);
  const chrome = definitions.find((browser) => browser.id === "chrome");
  const edge = definitions.find((browser) => browser.id === "edge");

  assert.equal(chrome.processName, "chrome.exe");
  assert.equal(edge.processName, "msedge.exe");
  assert.equal(chrome.userDataDir, path.resolve(environment.LOCALAPPDATA, "Google", "Chrome", "User Data"));
  assert.equal(edge.userDataDir, path.resolve(environment.LOCALAPPDATA, "Microsoft", "Edge", "User Data"));
  assert.ok(edge.executableCandidates.some((candidate) => candidate.endsWith(path.join("Microsoft", "Edge", "Application", "msedge.exe"))));
});

test("discovers an explicitly selected Edge executable", async () => {
  const edgeExecutable = "C:\\Portable\\Edge\\msedge.exe";
  const environment = {
    PROGRAMFILES: "C:\\Program Files",
    "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
    LOCALAPPDATA: "C:\\FixtureUserData\\Local",
    EDGE_EXECUTABLE: edgeExecutable,
  };
  const access = async (candidate) => {
    if (path.resolve(candidate) === path.resolve(edgeExecutable)) return;
    const error = new Error("missing");
    error.code = "ENOENT";
    throw error;
  };
  const installed = await discoverInstalledBrowsers({ choice: "Edge", environment, access });

  assert.equal(installed.length, 1);
  assert.equal(installed[0].id, "edge");
  assert.equal(installed[0].processName, "msedge.exe");
  assert.equal(installed[0].executable, path.resolve(edgeExecutable));
});

test("browser lifecycle scripts use configured process discovery", async () => {
  const scripts = [
    "Initialize-BrowserProfile.ps1",
    "Open-PlainLoginChrome.ps1",
    "Recover-NativeLogin.ps1",
    "Prepare-NativeWafSession.ps1",
    "Clear-AutomationChromeCache.ps1",
    "Sync-ChromeSavedLogins.ps1",
  ];
  for (const script of scripts) {
    const source = await fs.readFile(new URL(`../scripts/${script}`, import.meta.url), "utf8");
    assert.match(source, /Get-CheckinAutomationBrowserProcesses/);
    assert.doesNotMatch(source, /Name='chrome\.exe'|Name -eq 'chrome\.exe'/);
  }

  const initializer = await fs.readFile(new URL("../scripts/Initialize-BrowserProfile.ps1", import.meta.url), "utf8");
  assert.match(initializer, /--no-startup-window/);
  assert.doesNotMatch(initializer, /['\"]about:blank['\"]/);

  const runtime = await fs.readFile(new URL("../scripts/Resolve-Runtime.ps1", import.meta.url), "utf8");
  assert.match(runtime, /browserExecutable/);
  assert.match(runtime, /chromeExecutable/);
  assert.match(runtime, /msedge\.exe/);
  assert.match(runtime, /ProcessName/);
});

test("preflight and setup expose browser selection", async () => {
  const preflight = await fs.readFile(new URL("../src/preflight.mjs", import.meta.url), "utf8");
  const setup = await fs.readFile(new URL("../src/setup-config.mjs", import.meta.url), "utf8");
  const environmentScript = await fs.readFile(new URL("../scripts/Test-Environment.ps1", import.meta.url), "utf8");
  const answers = JSON.parse(await fs.readFile(new URL("../setup/answers.example.json", import.meta.url), "utf8"));

  assert.match(preflight, /requestedBrowser/);
  assert.match(setup, /browserExecutable/);
  assert.match(setup, /answers\.chromeProfile/);
  assert.match(environmentScript, /ValidateSet\('Auto', 'Chrome', 'Edge'\)/);
  assert.equal(answers.browser, "Auto");
  assert.equal(answers.browserProfile, "Auto");
  assert.equal(answers.syncBrowserSavedLogins, false);
});
