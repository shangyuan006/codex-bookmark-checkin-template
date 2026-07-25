import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { listBookmarkFolderCandidates, listBookmarkFolderCandidatesWithBackup, readBookmarkPlanWithBackup } from "./bookmarks.mjs";
import { discoverInstalledBrowsers, getBrowserDefinitions, normalizeBrowserChoice } from "./browser-platform.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const defaults = JSON.parse(await fs.readFile(path.join(root, "config", "defaults.json"), "utf8"));
const scopeIndex = process.argv.indexOf("--scope-json");
const scopeBase64Index = process.argv.indexOf("--scope-json-base64");
const browserIndex = process.argv.indexOf("--browser");
const browserChoice = normalizeBrowserChoice(browserIndex >= 0 ? process.argv[browserIndex + 1] : "auto");
const requestedScope = scopeBase64Index >= 0
  ? JSON.parse(Buffer.from(String(process.argv[scopeBase64Index + 1] ?? ""), "base64").toString("utf8"))
  : scopeIndex >= 0
    ? JSON.parse(String(process.argv[scopeIndex + 1] ?? "{}"))
    : null;
const scopeProvided = Array.isArray(requestedScope?.mobileFolderNames)
  && requestedScope.mobileFolderNames.length > 0
  && Array.isArray(requestedScope?.targetFolderNames)
  && requestedScope.targetFolderNames.length > 0;

async function exists(value) {
  return Boolean(value) && fs.access(value).then(() => true).catch(() => false);
}

async function inspectProfiles(browser) {
  if (!(await exists(browser.userDataDir))) return [];
  const entries = await fs.readdir(browser.userDataDir, { withFileTypes: true }).catch(() => []);
  const profiles = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const bookmarksPath = path.join(browser.userDataDir, entry.name, "Bookmarks");
    if (!(await exists(bookmarksPath))) continue;
    try {
      const plan = scopeProvided
        ? await readBookmarkPlanWithBackup(bookmarksPath, {
          ...defaults,
          mobileFolderNames: requestedScope.mobileFolderNames,
          targetFolderNames: requestedScope.targetFolderNames,
        })
        : null;
      const folderReport = plan
        ? {
          candidates: await listBookmarkFolderCandidates(plan.bookmarkPath),
          recoveredFromBackup: plan.recoveredFromBackup,
        }
        : await listBookmarkFolderCandidatesWithBackup(bookmarksPath);
      profiles.push({
        browser: browser.id,
        browserDisplayName: browser.displayName,
        name: entry.name,
        bookmarksPath,
        recoveredFromBackup: Boolean(folderReport.recoveredFromBackup || plan?.recoveredFromBackup),
        folderCandidates: folderReport.candidates,
        scopeMatch: plan ? {
          sourceCount: plan.sources.length,
          exactUrlCount: plan.exactUrlCount,
          targetCount: plan.targetCount,
        } : null,
      });
    } catch (error) {
      profiles.push({
        browser: browser.id,
        browserDisplayName: browser.displayName,
        name: entry.name,
        bookmarksPath,
        error: String(error?.message ?? error),
      });
    }
  }
  return profiles.sort((left, right) => {
    const targetDifference = (right.scopeMatch?.targetCount ?? -1) - (left.scopeMatch?.targetCount ?? -1);
    if (targetDifference !== 0) return targetDifference;
    return (right.folderCandidates?.length ?? 0) - (left.folderCandidates?.length ?? 0);
  });
}

const consideredDefinitions = getBrowserDefinitions()
  .filter((definition) => browserChoice === "auto" || definition.id === browserChoice);
const installedBrowsers = await discoverInstalledBrowsers({ choice: browserChoice });
const installedById = new Map(installedBrowsers.map((browser) => [browser.id, browser]));
const browserReports = await Promise.all(consideredDefinitions.map(async (definition) => {
  const installed = installedById.get(definition.id);
  const browser = installed ?? definition;
  return {
    id: browser.id,
    displayName: browser.displayName,
    executable: installed?.executable ?? null,
    processName: installed?.processName ?? browser.processName,
    userDataDir: browser.userDataDir,
    profiles: await inspectProfiles(browser),
  };
}));
const profiles = browserReports.flatMap((browser) => browser.profiles);
const matchingProfiles = scopeProvided
  ? profiles.filter((value) => (value.scopeMatch?.targetCount ?? 0) > 0)
  : [];
const installedCount = browserReports.filter((browser) => browser.executable).length;
const browserSelectionResolved = browserChoice !== "auto" || installedCount === 1;
const majorNodeVersion = Number(process.versions.node.split(".")[0]);
const checks = {
  supportedWindows: process.platform === "win32",
  supportedArchitecture: process.arch === "x64" || process.arch === "arm64",
  nodeSupported: majorNodeVersion >= 20,
  writableProject: await fs.access(root, fs.constants.W_OK).then(() => true).catch(() => false),
  supportedBrowserPresent: installedCount > 0,
  browserUserDataPresent: await Promise.all(browserReports.map((browser) => exists(browser.userDataDir))).then((values) => values.some(Boolean)),
  readableBookmarkProfile: profiles.some((value) => !value.error),
  browserSelectionResolved,
  bookmarkScopeProvided: scopeProvided,
  matchingBookmarkFolders: scopeProvided ? matchingProfiles.length > 0 : null,
};
const blockingKeys = ["supportedWindows", "nodeSupported", "writableProject", "supportedBrowserPresent", "readableBookmarkProfile"];
const environmentReady = blockingKeys.every((key) => checks[key]);
const ready = environmentReady && browserSelectionResolved && scopeProvided && checks.matchingBookmarkFolders;
const needsUserInput = [];
if (!browserSelectionResolved) needsUserInput.push("browserSelection");
if (!scopeProvided) needsUserInput.push("bookmarkScope");
else if (!checks.matchingBookmarkFolders) needsUserInput.push("bookmarkScopeMismatch");

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  environmentReady,
  ready,
  platform: { os: os.release(), platform: process.platform, arch: process.arch, node: process.versions.node },
  requestedBrowser: browserChoice === "auto" ? null : browserChoice,
  requestedScope: scopeProvided ? requestedScope : null,
  browsers: browserReports.map(({ profiles: ignored, ...browser }) => browser),
  checks,
  profiles,
  guidance: {
    blocking: blockingKeys.filter((key) => !checks[key]),
    needsUserInput,
  },
}, null, 2));
