import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("运行入口使用多来源备份计划并保留上次有效目标数保护", async () => {
  const [source, effectivePlan] = await Promise.all([
    fs.readFile(new URL("../src/index.mjs", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/effective-bookmark-plan.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(source, /readEffectiveBookmarkPlan\(config\.bookmarksPath, config, lastValidBookmarkPlanPath\)/);
  assert.match(effectivePlan, /readBookmarkPlanWithBackup\(bookmarksPath/);
  assert.match(effectivePlan, /effectiveMinimumTargets/);
  assert.match(effectivePlan, /Math\.ceil\(previousCount \* 0\.5\)/);
  assert.match(source, /atomicWriteJson\(lastValidBookmarkPlanPath, publicBookmarkReport\(plan\)\)/);
  assert.doesNotMatch(source, /const candidates = \[config\.bookmarksPath/);
});

test("多来源预检只读取已配置且已有目录范围的来源", async () => {
  const source = await fs.readFile(new URL("../src/preflight.mjs", import.meta.url), "utf8");
  const configuredInspection = source.match(/async function inspectConfiguredSource\(source\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  const publicSourceBase = configuredInspection.match(/const base = \{([\s\S]*?)\n\s*\};/)?.[1] ?? "";

  assert.match(source, /Array\.isArray\(config\?\.bookmarksPath\)/);
  assert.match(source, /config\?\.additionalBookmarkSources/);
  assert.match(source, /profiles: configuredMultiSource \? \[\] : await inspectProfiles\(browser\)/);
  assert.match(configuredInspection, /if \(!scopeConfigured\) return/);
  assert.ok(configuredInspection.indexOf("if (!scopeConfigured) return") < configuredInspection.indexOf("candidatePath"));
  assert.match(configuredInspection, /bookmarkFileState: index === 0 \? "primary" : "backup"/);
  assert.doesNotMatch(publicSourceBase, /\bpath\b|mobileFolderNames|targetFolderNames/);
});

test("多来源预检公开报告不包含书签文件或浏览器用户目录", async () => {
  const source = await fs.readFile(new URL("../src/preflight.mjs", import.meta.url), "utf8");
  const publicBrowser = source.match(/function publicBrowserReport\([^)]*\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  const multiSourceReturn = publicBrowser.match(/if \(configuredMultiSource\) return \{([^}]*)\}/)?.[1] ?? "";

  assert.match(source, /bookmarkSources: configuredInspection\.reports/);
  assert.match(multiSourceReturn, /installed: Boolean\(executable\)/);
  assert.doesNotMatch(multiSourceReturn, /userDataDir|executable\s*[,}]/);
  assert.doesNotMatch(source, /bookmarkSources:\s*configuredSources/);
});

test("preflight executes scalar plus additional bookmark sources without duplicating configuration", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "preflight-multi-source-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const configDirectory = path.join(root, "config");
  const primaryPath = path.join(root, "PrimaryBookmarks");
  const additionalPath = path.join(root, "AdditionalBookmarks");
  const bookmarkDocument = (container, target, url) => ({
    roots: {
      synced: {
        id: "1", type: "folder", name: container, children: [{
          id: "2", type: "folder", name: target, children: [
            { id: "3", type: "url", name: "Site", url },
          ],
        }],
      },
    },
  });
  await fs.mkdir(configDirectory, { recursive: true });
  await fs.writeFile(path.join(configDirectory, "defaults.json"), JSON.stringify({
    minimumBookmarkTargetCount: 1,
    mobileFolderNames: [],
    targetFolderNames: [],
  }), "utf8");
  await fs.writeFile(primaryPath, JSON.stringify(bookmarkDocument("Primary Root", "Primary Daily", "https://primary.test/checkin")), "utf8");
  await fs.writeFile(`${additionalPath}.bak`, JSON.stringify(bookmarkDocument("Additional Root", "Additional Daily", "https://additional.test/checkin")), "utf8");
  await fs.writeFile(path.join(configDirectory, "config.json"), JSON.stringify({
    bookmarksPath: primaryPath,
    bookmarkSourceName: "Primary",
    mobileFolderNames: ["Primary Root"],
    targetFolderNames: ["Primary Daily"],
    minimumBookmarkTargetCount: 1,
    additionalBookmarkSources: [{
      name: "Additional",
      path: additionalPath,
      mobileFolderNames: ["Additional Root"],
      targetFolderNames: ["Additional Daily"],
    }],
  }), "utf8");

  const preflightPath = fileURLToPath(new URL("../src/preflight.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [preflightPath, "--root", root, "--browser", "edge"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.checks.matchingBookmarkFolders, true);
  assert.equal(report.configuredScopeMatch.targetCount, 2);
  assert.equal(report.configuredScopeMatch.bookmarkSourceCount, 2);
  assert.equal(report.configuredScopeMatch.recoveredFromBackup, true);
  assert.equal(report.bookmarkSources.every((source) => !Object.hasOwn(source, "path")), true);

  const conflictingConfig = JSON.parse(await fs.readFile(path.join(configDirectory, "config.json"), "utf8"));
  conflictingConfig.bookmarksPath = [{
    name: "Primary",
    path: primaryPath,
    mobileFolderNames: ["Primary Root"],
    targetFolderNames: ["Primary Daily"],
  }];
  await fs.writeFile(path.join(configDirectory, "config.json"), JSON.stringify(conflictingConfig), "utf8");
  const conflicting = spawnSync(process.execPath, [preflightPath, "--root", root, "--browser", "edge"], {
    encoding: "utf8",
  });
  assert.equal(conflicting.status, 0, conflicting.stderr);
  const conflictingReport = JSON.parse(conflicting.stdout);
  assert.equal(conflictingReport.checks.matchingBookmarkFolders, false);
  assert.equal(conflictingReport.bookmarkSources[0].status, "source_invalid");
});
