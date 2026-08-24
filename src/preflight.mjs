import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { listBookmarkFolderCandidatesWithBackup, readBookmarkPlan, readBookmarkPlanWithBackup } from "./bookmarks.mjs";
import { discoverInstalledBrowsers, getBrowserDefinitions, normalizeBrowserChoice } from "./browser-platform.mjs";

const defaultRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const rootIndex = process.argv.indexOf("--root");
const root = rootIndex >= 0
  ? path.resolve(String(process.argv[rootIndex + 1] ?? ""))
  : defaultRoot;
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
const requestedScopeProvided = Array.isArray(requestedScope?.mobileFolderNames)
  && requestedScope.mobileFolderNames.length > 0
  && Array.isArray(requestedScope?.targetFolderNames)
  && requestedScope.targetFolderNames.length > 0;
const runtimeConfig = await fs.readFile(path.join(root, "config", "config.json"), "utf8")
  .then(JSON.parse)
  .catch(() => null);

async function exists(value) {
  return Boolean(value) && fs.access(value).then(() => true).catch(() => false);
}

function folderNames(value) {
  return Array.isArray(value) ? value.map((name) => String(name).trim()).filter(Boolean) : [];
}

function configuredSourceName(source, index) {
  const value = String(source?.name ?? "").toLowerCase();
  if (value.includes("chrome")) return "Chrome";
  if (value.includes("edge")) return "Edge";
  return `来源 ${index + 1}`;
}

function resolveConfiguredBookmarkSources(config) {
  const configuredAsArray = Array.isArray(config?.bookmarksPath);
  const additionalSources = Array.isArray(config?.additionalBookmarkSources)
    ? config.additionalBookmarkSources
    : [];
  const multiSource = configuredAsArray || additionalSources.length > 0;
  if (!multiSource) return null;
  if (configuredAsArray && additionalSources.length > 0) {
    return [{
      id: "source_config_conflict",
      name: "书签来源配置",
      path: "",
      optional: false,
      mobileFolderNames: ["__invalid__"],
      targetFolderNames: ["__invalid__"],
    }];
  }

  const configured = configuredAsArray
    ? config.bookmarksPath
    : [{ name: config.bookmarkSourceName, path: config.bookmarksPath, optional: false }, ...additionalSources];
  const globalMobileFolderNames = requestedScopeProvided
    ? folderNames(requestedScope.mobileFolderNames)
    : folderNames(config.mobileFolderNames);
  const globalTargetFolderNames = requestedScopeProvided
    ? folderNames(requestedScope.targetFolderNames)
    : folderNames(config.targetFolderNames);
  const seen = new Set();
  const sources = [];

  for (let index = 0; index < configured.length; index += 1) {
    const value = configured[index];
    const source = typeof value === "string" ? { path: value } : value;
    const sourcePath = String(source?.path ?? "").trim();
    const pathKey = sourcePath.toLowerCase();
    if (pathKey && seen.has(pathKey)) continue;
    if (pathKey) seen.add(pathKey);
    sources.push({
      id: `source_${index + 1}`,
      name: configuredSourceName(source, index),
      path: sourcePath,
      optional: source?.optional === true,
      mobileFolderNames: folderNames(source?.mobileFolderNames).length > 0
        ? folderNames(source.mobileFolderNames)
        : globalMobileFolderNames,
      targetFolderNames: folderNames(source?.targetFolderNames).length > 0
        ? folderNames(source.targetFolderNames)
        : globalTargetFolderNames,
    });
  }
  return sources;
}

async function inspectConfiguredSource(source) {
  const scopeConfigured = source.mobileFolderNames.length > 0 && source.targetFolderNames.length > 0;
  const base = {
    id: source.id,
    name: source.name,
    optional: source.optional,
    scopeConfigured,
  };
  if (!source.path) return { ...base, status: "source_invalid", readable: false, scopeMatched: false };
  if (!scopeConfigured) return { ...base, status: "scope_unconfirmed", readable: false, scopeMatched: false };

  let firstReadable = null;
  for (let index = 0; index < 2; index += 1) {
    const candidatePath = index === 0 ? source.path : `${source.path}.bak`;
    try {
      const plan = await readBookmarkPlan(candidatePath, {
        ...defaults,
        bookmarkSourceName: source.name,
        mobileFolderNames: source.mobileFolderNames,
        targetFolderNames: source.targetFolderNames,
      });
      const report = {
        ...base,
        status: plan.targetCount > 0 ? "ready" : "scope_mismatch",
        readable: true,
        scopeMatched: plan.targetCount > 0,
        bookmarkFileState: index === 0 ? "primary" : "backup",
        recoveredFromBackup: index > 0,
        sourceCount: plan.sources.length,
        exactUrlCount: plan.exactUrlCount,
        targetCount: plan.targetCount,
      };
      firstReadable ??= report;
      if (report.scopeMatched) return report;
    } catch {
      // Only the classified source state is included in public preflight output.
    }
  }
  return firstReadable ?? {
    ...base,
    status: "source_unreadable",
    readable: false,
    scopeMatched: false,
  };
}

async function inspectConfiguredSources(sources, config) {
  const reports = await Promise.all(sources.map(inspectConfiguredSource));
  const requiredSources = reports.filter((source) => !source.optional);
  const requiredScopesConfigured = requiredSources.length > 0
    && requiredSources.every((source) => source.scopeConfigured);
  const requiredSourcesReadable = requiredSources.length > 0
    && requiredSources.every((source) => source.readable);
  const requiredScopesMatched = requiredSources.length > 0
    && requiredSources.every((source) => source.scopeMatched);
  const readableSources = sources.filter((source, index) => reports[index].scopeConfigured && source.path);
  let plan = null;

  if (requiredScopesConfigured && readableSources.length > 0) {
    plan = await readBookmarkPlanWithBackup(readableSources, {
      ...defaults,
      ...config,
      additionalBookmarkSources: [],
      minimumBookmarkTargetCount: Math.max(1, Number(config?.minimumBookmarkTargetCount) || 1),
    }).catch(() => null);
  }

  return {
    reports,
    plan,
    requiredScopesConfigured,
    requiredSourcesReadable,
    requiredScopesMatched,
  };
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
      const plan = requestedScopeProvided
        ? await readBookmarkPlanWithBackup(bookmarksPath, {
          ...defaults,
          mobileFolderNames: requestedScope.mobileFolderNames,
          targetFolderNames: requestedScope.targetFolderNames,
        })
        : null;
      if (plan) {
        profiles.push({
          browser: browser.id,
          browserDisplayName: browser.displayName,
          name: entry.name,
          recoveredFromBackup: Boolean(plan.recoveredFromBackup),
          scopeMatch: {
          sourceCount: plan.sources.length,
          exactUrlCount: plan.exactUrlCount,
          targetCount: plan.targetCount,
            sources: plan.sources.map((source) => ({
              path: source.path,
              counts: Object.fromEntries(Object.entries(source.sections)
                .map(([name, entries]) => [name, entries.length])),
            })),
          },
        });
      } else {
        const folderReport = await listBookmarkFolderCandidatesWithBackup(bookmarksPath);
        profiles.push({
          browser: browser.id,
          browserDisplayName: browser.displayName,
          name: entry.name,
          bookmarksPath,
          recoveredFromBackup: Boolean(folderReport.recoveredFromBackup),
          folderCandidates: folderReport.candidates,
          scopeMatch: null,
        });
      }
    } catch (error) {
      profiles.push({
        browser: browser.id,
        browserDisplayName: browser.displayName,
        name: entry.name,
        ...(requestedScopeProvided
          ? { error: "bookmark_scope_unreadable" }
          : { bookmarksPath, error: String(error?.message ?? error) }),
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
const configuredSources = resolveConfiguredBookmarkSources(runtimeConfig);
const configuredMultiSource = Array.isArray(configuredSources);
const configuredInspection = configuredMultiSource
  ? await inspectConfiguredSources(configuredSources, runtimeConfig)
  : null;
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
    profiles: configuredMultiSource ? [] : await inspectProfiles(browser),
  };
}));
const profiles = browserReports.flatMap((browser) => browser.profiles);
const matchingProfiles = requestedScopeProvided
  ? profiles.filter((value) => (value.scopeMatch?.targetCount ?? 0) > 0)
  : [];
const bookmarkScopeProvided = configuredMultiSource
  ? configuredInspection.requiredScopesConfigured
  : requestedScopeProvided;
const configuredScopeMatched = configuredMultiSource
  ? configuredInspection.requiredScopesMatched && (configuredInspection.plan?.targetCount ?? 0) > 0
  : null;
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
  readableBookmarkProfile: configuredMultiSource
    ? configuredInspection.requiredSourcesReadable
    : profiles.some((value) => !value.error),
  browserSelectionResolved,
  bookmarkScopeProvided,
  matchingBookmarkFolders: bookmarkScopeProvided
    ? configuredMultiSource ? configuredScopeMatched : matchingProfiles.length > 0
    : null,
};
const blockingKeys = ["supportedWindows", "nodeSupported", "writableProject", "supportedBrowserPresent", "readableBookmarkProfile"];
const environmentReady = blockingKeys.every((key) => checks[key]);
const ready = environmentReady && browserSelectionResolved && bookmarkScopeProvided && checks.matchingBookmarkFolders;
const needsUserInput = [];
if (!browserSelectionResolved) needsUserInput.push("browserSelection");
if (!bookmarkScopeProvided) needsUserInput.push("bookmarkScope");
else if (!checks.matchingBookmarkFolders) needsUserInput.push("bookmarkScopeMismatch");

function publicBrowserReport({ profiles: ignored, userDataDir, executable, ...browser }) {
  if (configuredMultiSource) return { ...browser, installed: Boolean(executable) };
  return requestedScopeProvided ? { ...browser, executable } : { ...browser, executable, userDataDir };
}

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  environmentReady,
  ready,
  platform: { os: os.release(), platform: process.platform, arch: process.arch, node: process.versions.node },
  requestedBrowser: browserChoice === "auto" ? null : browserChoice,
  requestedScope: requestedScopeProvided ? requestedScope : null,
  browsers: browserReports.map(publicBrowserReport),
  checks,
  profiles,
  ...(configuredMultiSource ? {
    bookmarkSources: configuredInspection.reports,
    configuredScopeMatch: configuredInspection.plan ? {
      bookmarkSourceCount: configuredInspection.plan.bookmarkFiles?.length ?? 0,
      exactUrlCount: configuredInspection.plan.exactUrlCount,
      targetCount: configuredInspection.plan.targetCount,
      recoveredFromBackup: Boolean(configuredInspection.plan.recoveredFromBackup),
    } : null,
  } : {}),
  guidance: {
    blocking: blockingKeys.filter((key) => !checks[key]),
    needsUserInput,
  },
}, null, 2));
