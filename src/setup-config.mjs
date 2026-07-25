import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readBookmarkPlanWithBackup } from "./bookmarks.mjs";
import { discoverInstalledBrowsers, normalizeBrowserChoice } from "./browser-platform.mjs";
import { atomicWriteJson, ensurePrivateDirectory } from "./security.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function deepMerge(base, override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) return override === undefined ? base : override;
  const output = { ...(base && typeof base === "object" && !Array.isArray(base) ? base : {}) };
  for (const [key, value] of Object.entries(override)) output[key] = deepMerge(output[key], value);
  return output;
}

async function readJson(filePath, fallback = null) {
  return fs.readFile(filePath, "utf8").then(JSON.parse).catch((error) => {
    if (error.code === "ENOENT") return fallback;
    throw error;
  });
}

async function exists(filePath) {
  return fs.access(filePath).then(() => true).catch(() => false);
}

async function findOnPath(executableName) {
  const pathValue = process.env.Path ?? process.env.PATH ?? "";
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, executableName);
    if (await exists(candidate)) return path.resolve(candidate);
  }
  return null;
}

async function discoverProfiles(browser, options) {
  const entries = await fs.readdir(browser.userDataDir, { withFileTypes: true }).catch(() => []);
  const profiles = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const bookmarksPath = path.join(browser.userDataDir, entry.name, "Bookmarks");
    if (!(await exists(bookmarksPath))) continue;
    const plan = await readBookmarkPlanWithBackup(bookmarksPath, options).catch(() => null);
    if (plan) profiles.push({
      browser,
      name: entry.name,
      bookmarksPath,
      targetCount: plan.targetCount,
      sourceCount: plan.sources.length,
    });
  }
  return profiles.sort((a, b) => b.targetCount - a.targetCount);
}

const answersIndex = process.argv.indexOf("--answers");
const answersPath = answersIndex >= 0 ? path.resolve(process.argv[answersIndex + 1]) : path.join(root, "setup", "answers.json");
const defaults = await readJson(path.join(root, "config", "defaults.json"));
const answers = await readJson(answersPath);
if (!answers) throw new Error(`Missing questionnaire answers: ${answersPath}`);
if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(answers.schedule ?? defaults.schedule))) throw new Error("schedule must use HH:mm");
for (const [field, value] of [["mobileFolderNames", answers.mobileFolderNames], ["targetFolderNames", answers.targetFolderNames]]) {
  if (!Array.isArray(value) || value.length === 0 || value.some((name) => !String(name).trim())) {
    throw new Error(`${field} must contain at least one user-confirmed folder name`);
  }
}

const publicRules = answers.useBuiltInSiteRules === false
  ? {}
  : await readJson(path.join(root, "config", "site-rules.public.json"), {});
const localRules = await readJson(path.join(root, "config", "config.local.json"), {});
let config = deepMerge(deepMerge(deepMerge(defaults, publicRules), {
  mobileFolderNames: answers.mobileFolderNames,
  targetFolderNames: answers.targetFolderNames,
  schedule: answers.schedule,
  autoDetectLinuxDoOAuth: answers.autoDetectLinuxDoOAuth,
  syncBookmarkSavedLogins: answers.syncBrowserSavedLogins ?? answers.syncChromeSavedLogins,
  qaWebSearchEnabled: answers.qaWebSearchEnabled,
  checkinMessage: answers.checkinMessage,
  u2Message: answers.checkinMessage,
  notification: answers.notification,
}), localRules);

const legacyChromeAnswers = answers.browser === undefined && answers.chromeProfile !== undefined;
const browserChoice = normalizeBrowserChoice(answers.browser ?? (legacyChromeAnswers ? "chrome" : "auto"));
const installedBrowsers = await discoverInstalledBrowsers({ choice: browserChoice });
if (installedBrowsers.length === 0) {
  throw new Error(`No supported ${browserChoice === "auto" ? "Chrome or Edge" : browserChoice} installation was found`);
}
const profiles = (await Promise.all(installedBrowsers.map((browser) => discoverProfiles(browser, config))))
  .flat()
  .sort((a, b) => b.targetCount - a.targetCount);
if (profiles.length === 0) throw new Error("No readable Chrome or Edge bookmark profile was found");

const requestedProfile = answers.browserProfile ?? answers.chromeProfile ?? "Auto";
let selected;
if (requestedProfile !== "Auto") {
  const matches = profiles.filter((profile) => profile.name.toLowerCase() === String(requestedProfile).toLowerCase());
  if (matches.length === 0) throw new Error(`Browser profile does not exist: ${requestedProfile}`);
  if (matches.length > 1) throw new Error(`Profile ${requestedProfile} exists in multiple browsers; select Chrome or Edge explicitly`);
  [selected] = matches;
} else {
  const bestCount = profiles[0].targetCount;
  const tied = profiles.filter((profile) => profile.targetCount === bestCount);
  if (tied.length > 1) {
    throw new Error(`Auto found multiple equally ranked browser profiles: ${tied.map((value) => `${value.browser.displayName}/${value.name}`).join(", ")}`);
  }
  [selected] = profiles;
}
if (selected.targetCount === 0) throw new Error("The selected browser profile does not contain the confirmed bookmark folders");

const windowsPowerShell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const preferredPowerShell = await findOnPath("pwsh.exe")
  ?? (await exists(windowsPowerShell) ? windowsPowerShell : "pwsh.exe");
config = deepMerge(config, {
  browser: selected.browser.id,
  browserDisplayName: selected.browser.displayName,
  browserExecutable: selected.browser.executable,
  browserProcessName: selected.browser.processName,
  bookmarksPath: selected.bookmarksPath,
  sourceUserDataDir: selected.browser.userDataDir,
  sourceProfileDirectory: selected.name,
  automationUserDataDir: path.join(root, "data", `${selected.browser.id}-user-data`),
  nodeExecutable: process.execPath,
  pythonExecutable: answers.pythonExecutable ?? "",
  powershellExecutable: answers.powershellExecutable || preferredPowerShell,
  schedulerTaskName: "CodexBookmarkDailyCheckin",
  schedulerRunKeyName: "CodexBookmarkDailyCheckin",
});

for (const directory of ["data", "logs", "tmp", "outputs"]) await ensurePrivateDirectory(path.join(root, directory));
await atomicWriteJson(path.join(root, "config", "config.json"), config);
console.log(JSON.stringify({
  configured: true,
  browser: selected.browser.id,
  browserDisplayName: selected.browser.displayName,
  profile: selected.name,
  bookmarkSources: selected.sourceCount,
  targets: selected.targetCount,
  schedule: config.schedule,
  builtInRules: answers.useBuiltInSiteRules !== false,
  notificationMode: config.notification?.mode ?? "none",
}, null, 2));
