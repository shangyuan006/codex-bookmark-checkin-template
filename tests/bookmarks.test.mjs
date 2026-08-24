import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findBookmarkTarget, listBookmarkFolderCandidates, listBookmarkFolderCandidatesWithBackup, normalizeHttpUrl, publicBookmarkReport, readBookmarkPlan, readBookmarkPlanWithBackup } from "../src/bookmarks.mjs";

test("普通签到书签只接受无凭据 HTTPS", () => {
  assert.equal(normalizeHttpUrl("https://example.test/checkin/"), "https://example.test/checkin");
  assert.equal(normalizeHttpUrl("http://example.test/checkin"), null);
  assert.equal(normalizeHttpUrl(`https://user:secret${"@"}example.test/checkin`), null);
});

test("不预设名称时列出候选书签目录供用户选择", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "checkin-candidates-"));
  const file = path.join(directory, "Bookmarks");
  await fs.writeFile(file, JSON.stringify({
    roots: {
      custom: {
        id: "1", type: "folder", name: "我的自动任务", children: [{
          id: "2", type: "folder", name: "每日领取", children: [
            { id: "3", type: "url", name: "示例", url: "https://example.test/daily" },
          ],
        }],
      },
    },
  }));
  const candidates = await listBookmarkFolderCandidates(file);
  const container = candidates.find((value) => value.name === "我的自动任务");
  assert.ok(container);
  assert.equal(container.descendantUrlCount, 1);
  assert.deepEqual(container.childFolders, [{ name: "每日领取", urlCount: 1 }]);
});

test("合并两个移动设备书签并按来源与站点去重", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "checkin-bookmarks-"));
  const file = path.join(directory, "Bookmarks");
  const fixture = {
    roots: {
      bookmark_bar: {
        id: "1", type: "folder", name: "书签栏", children: [{
          id: "10", type: "folder", name: "移动设备书签", children: [{
            id: "11", type: "folder", name: "签到", children: [
              { id: "12", type: "url", name: "A", url: "https://a.example/attendance.php" },
              { id: "13", type: "url", name: "B 控制台", url: "https://b.example/console" },
            ],
          }],
        }],
      },
      synced: {
        id: "3", type: "folder", name: "移动设备书签", children: [{
          id: "20", type: "folder", name: "公益站", children: [
            { id: "21", type: "url", name: "B 首页", url: "https://b.example/dashboard/overview" },
            { id: "22", type: "url", name: "C", url: "https://c.example/checkin" },
          ],
        }],
      },
    },
  };
  await fs.writeFile(file, JSON.stringify(fixture));
  const plan = await readBookmarkPlan(file, {
    mobileFolderNames: ["移动设备书签"],
    targetFolderNames: ["签到", "公益站"],
  });

  assert.equal(plan.sources.length, 2);
  assert.equal(plan.exactUrlCount, 4);
  assert.equal(plan.targetCount, 3);
  assert.equal(plan.comparison["签到"].unionUrlCount, 2);
  assert.equal(plan.comparison["公益站"].unionUrlCount, 2);
  const bTarget = plan.targets.find((target) => target.origin === "https://b.example");
  assert.deepEqual(bTarget.candidates, ["https://b.example/dashboard/overview", "https://b.example/console"]);
  assert.deepEqual(bTarget.allowedOrigins, ["https://b.example"]);
});

test("合并 Chrome 与 Edge 书签并跨浏览器精确 URL 和 origin 去重", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "checkin-browser-sources-"));
  const chromeFile = path.join(directory, "ChromeBookmarks");
  const edgeFile = path.join(directory, "EdgeBookmarks");
  try {
    await fs.writeFile(chromeFile, JSON.stringify({
      roots: { synced: { id: "1", type: "folder", name: "Chrome 自动任务", children: [{
        id: "2", type: "folder", name: "每日领取", children: [
          { id: "3", type: "url", name: "共同入口", url: "https://shared.example/checkin" },
          { id: "4", type: "url", name: "共同控制台", url: "https://shared.example/console" },
        ],
      }] } },
    }));
    await fs.writeFile(edgeFile, JSON.stringify({
      roots: { synced: { id: "10", type: "folder", name: "Edge 收藏", children: [{
        id: "11", type: "folder", name: "公益站", children: [
          { id: "12", type: "url", name: "重复入口", url: "https://shared.example/checkin" },
          { id: "13", type: "url", name: "Edge 新站", url: "https://edge-only.example/console" },
        ],
      }] } },
    }));

    const plan = await readBookmarkPlan(chromeFile, {
      bookmarkSourceName: "Chrome",
      mobileFolderNames: ["Chrome 自动任务"],
      targetFolderNames: ["每日领取"],
      additionalBookmarkSources: [{
        name: "Edge",
        path: edgeFile,
        mobileFolderNames: ["Edge 收藏"],
        targetFolderNames: ["公益站"],
        optional: true,
      }],
    });

    assert.equal(plan.bookmarkFiles.length, 2);
    assert.equal(plan.exactUrlCount, 3);
    assert.equal(plan.targetCount, 2);
    const shared = plan.targets.find((target) => target.origin === "https://shared.example");
    assert.deepEqual(shared.candidates, ["https://shared.example/checkin", "https://shared.example/console"]);
    assert.deepEqual(shared.sourcePaths, ["Chrome: Chrome 自动任务", "Edge: Edge 收藏"]);
    const report = publicBookmarkReport(plan);
    assert.equal(report.bookmarkSourceCount, 2);
    assert.deepEqual(report.bookmarkSources.map((source) => source.name), ["Chrome", "Edge"]);
    assert.equal(report.sourceCount, 2);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("来源数组可以完全使用各自的目录范围", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "checkin-source-array-"));
  const firstFile = path.join(directory, "FirstBookmarks");
  const secondFile = path.join(directory, "SecondBookmarks");
  try {
    await fs.writeFile(firstFile, JSON.stringify({
      roots: { synced: { id: "1", type: "folder", name: "First Root", children: [{
        id: "2", type: "folder", name: "First Daily", children: [
          { id: "3", type: "url", name: "First", url: "https://first.example/checkin" },
        ],
      }] } },
    }));
    await fs.writeFile(secondFile, JSON.stringify({
      roots: { synced: { id: "10", type: "folder", name: "Second Root", children: [{
        id: "11", type: "folder", name: "Second Daily", children: [
          { id: "12", type: "url", name: "Second", url: "https://second.example/checkin" },
        ],
      }] } },
    }));

    const plan = await readBookmarkPlan([
      { name: "First", path: firstFile, mobileFolderNames: ["First Root"], targetFolderNames: ["First Daily"] },
      { name: "Second", path: secondFile, mobileFolderNames: ["Second Root"], targetFolderNames: ["Second Daily"] },
    ]);
    assert.deepEqual(plan.targets.map((target) => target.origin), ["https://first.example", "https://second.example"]);
    assert.deepEqual(Object.keys(plan.comparison), ["First Daily", "Second Daily"]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("来源数组不能再叠加 additionalBookmarkSources", async () => {
  await assert.rejects(() => readBookmarkPlan([{
    name: "Primary",
    path: "unused-primary",
    mobileFolderNames: ["Root"],
    targetFolderNames: ["Daily"],
  }], {
    additionalBookmarkSources: [{ name: "Extra", path: "unused-extra" }],
  }), /不能与 additionalBookmarkSources 同时配置/);
});

test("缺失的可选书签来源只生成公开警告", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "checkin-optional-source-"));
  const file = path.join(directory, "Bookmarks");
  try {
    await fs.writeFile(file, JSON.stringify({
      roots: { synced: { id: "1", type: "folder", name: "自动任务", children: [{
        id: "2", type: "folder", name: "签到", children: [
          { id: "3", type: "url", name: "Site", url: "https://site.example/checkin" },
        ],
      }] } },
    }));
    const plan = await readBookmarkPlan(file, {
      mobileFolderNames: ["自动任务"],
      targetFolderNames: ["签到"],
      additionalBookmarkSources: [{ name: "Edge", path: path.join(directory, "Missing"), optional: true }],
    });
    assert.equal(plan.targetCount, 1);
    assert.equal(plan.sourceWarnings.length, 1);
    assert.match(plan.sourceWarnings[0], /^Edge：/);
    assert.doesNotMatch(plan.sourceWarnings[0], new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.deepEqual(publicBookmarkReport(plan).sourceWarnings, plan.sourceWarnings);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("仅从显式配置加入关联签到入口", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "checkin-related-"));
  const file = path.join(directory, "Bookmarks");
  await fs.writeFile(file, JSON.stringify({
    roots: {
      synced: {
        id: "1", type: "folder", name: "移动设备书签", children: [{
          id: "2", type: "folder", name: "公益站", children: [
            { id: "3", type: "url", name: "旧入口", url: "https://old.example/console" },
          ],
        }],
      },
    },
  }));
  const plan = await readBookmarkPlan(file, {
    mobileFolderNames: ["移动设备书签"],
    targetFolderNames: ["公益站"],
    relatedCandidateUrls: { "https://old.example": ["https://new.example/"] },
  });
  assert.deepEqual(plan.targets[0].candidates, ["https://old.example/console", "https://new.example/"]);
  assert.deepEqual(plan.targets[0].allowedOrigins, ["https://old.example", "https://new.example"]);
});

test("显式站点必须位于目标目录范围并使用无凭据 HTTPS", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "checkin-configured-security-"));
  const file = path.join(directory, "Bookmarks");
  try {
    await fs.writeFile(file, JSON.stringify({
      roots: { synced: { id: "1", type: "folder", name: "自动任务", children: [] } },
    }));
    const plan = await readBookmarkPlan(file, {
      mobileFolderNames: ["自动任务"],
      targetFolderNames: ["签到"],
      configuredTargets: [{ title: "Configured", url: "https://configured.example/console", folderName: "签到" }],
    });
    assert.equal(plan.targetCount, 1);
    assert.equal(plan.targets[0].origin, "https://configured.example");

    await assert.rejects(readBookmarkPlan(file, {
      mobileFolderNames: ["自动任务"],
      targetFolderNames: ["签到"],
      configuredTargets: [{ url: "https://configured.example/", folderName: "其他" }],
    }), /显式站点目录无效/);
    for (const url of ["http://configured.example/", `https://user:secret${"@"}configured.example/`]) {
      await assert.rejects(readBookmarkPlan(file, {
        mobileFolderNames: ["自动任务"],
        targetFolderNames: ["签到"],
        configuredTargets: [{ url, folderName: "签到" }],
      }), (error) => {
        assert.match(error.message, /无凭据 HTTPS/);
        assert.doesNotMatch(error.message, /secret/);
        return true;
      });
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("普通书签过滤 HTTP 与内嵌凭据但保留 HTTPS", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "checkin-bookmark-security-"));
  const file = path.join(directory, "Bookmarks");
  try {
    await fs.writeFile(file, JSON.stringify({
      roots: { synced: { id: "1", type: "folder", name: "自动任务", children: [{
        id: "2", type: "folder", name: "签到", children: [
          { id: "3", type: "url", name: "HTTP", url: "http://http.example/checkin" },
          { id: "4", type: "url", name: "Credential", url: `https://user:secret${"@"}credential.example/checkin` },
          { id: "5", type: "url", name: "HTTPS", url: "https://secure.example/checkin" },
        ],
      }] } },
    }));
    const plan = await readBookmarkPlan(file, {
      mobileFolderNames: ["自动任务"],
      targetFolderNames: ["签到"],
    });
    assert.deepEqual(plan.targets.map((target) => target.origin), ["https://secure.example"]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("登录恢复可从 Bookmarks.bak 找到主文件缺失的目标", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "checkin-login-bookmarks-"));
  const file = path.join(directory, "Bookmarks");
  await fs.writeFile(file, JSON.stringify({
    roots: { synced: { id: "1", type: "folder", name: "我的自动任务", children: [] } },
  }));
  await fs.writeFile(`${file}.bak`, JSON.stringify({
    roots: {
      synced: {
        id: "1", type: "folder", name: "我的自动任务", children: [{
          id: "2", type: "folder", name: "每日领取", children: [
            { id: "3", type: "url", name: "Vibe Code", url: "https://service.example/dashboard" },
          ],
        }],
      },
    },
  }));

  const found = await findBookmarkTarget(file, "https://service.example", {
    mobileFolderNames: ["我的自动任务"],
    targetFolderNames: ["每日领取"],
  });
  assert.equal(found.target.origin, "https://service.example");
  assert.equal(found.recoveredFromBackup, true);
  assert.equal(found.plan.recoveredFromBackup, true);
  const fallbackPlan = await readBookmarkPlanWithBackup(file, {
    mobileFolderNames: ["我的自动任务"],
    targetFolderNames: ["每日领取"],
  });
  assert.equal(fallbackPlan.targetCount, 1);
  assert.equal(fallbackPlan.recoveredFromBackup, true);
  assert.equal(fallbackPlan.bookmarkPath, `${file}.bak`);
  const fallbackCandidates = await listBookmarkFolderCandidatesWithBackup(file);
  assert.equal(fallbackCandidates.recoveredFromBackup, true);
  assert.ok(fallbackCandidates.candidates.some((value) => value.name === "我的自动任务"));
});

test("每个书签来源可以独立回退到自己的备份", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "checkin-source-backup-"));
  const chromeFile = path.join(directory, "ChromeBookmarks");
  const edgeFile = path.join(directory, "EdgeBookmarks");
  try {
    await fs.writeFile(chromeFile, JSON.stringify({
      roots: { synced: { id: "1", type: "folder", name: "Chrome Root", children: [{
        id: "2", type: "folder", name: "Daily", children: [
          { id: "3", type: "url", name: "Chrome", url: "https://chrome.example/checkin" },
        ],
      }] } },
    }));
    await fs.writeFile(edgeFile, "not-json");
    await fs.writeFile(`${edgeFile}.bak`, JSON.stringify({
      roots: { synced: { id: "10", type: "folder", name: "Edge Root", children: [{
        id: "11", type: "folder", name: "Daily", children: [
          { id: "12", type: "url", name: "Edge", url: "https://edge.example/checkin" },
        ],
      }] } },
    }));

    const options = {
      bookmarkSourceName: "Chrome",
      mobileFolderNames: ["Chrome Root"],
      targetFolderNames: ["Daily"],
      minimumBookmarkTargetCount: 2,
      additionalBookmarkSources: [{
        name: "Edge",
        path: edgeFile,
        mobileFolderNames: ["Edge Root"],
        targetFolderNames: ["Daily"],
        optional: true,
      }],
    };
    const plan = await readBookmarkPlanWithBackup(chromeFile, options);
    assert.equal(plan.targetCount, 2);
    assert.equal(plan.recoveredFromBackup, true);
    assert.deepEqual(plan.recoveredSources, ["Edge"]);
    assert.deepEqual(plan.bookmarkPaths, [chromeFile, `${edgeFile}.bak`]);
    const found = await findBookmarkTarget(chromeFile, "https://edge.example", options);
    assert.equal(found.target.origin, "https://edge.example");
    assert.equal(found.recoveredFromBackup, true);
    assert.deepEqual(found.bookmarkPaths, [chromeFile, `${edgeFile}.bak`]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("多来源回退搜索有固定组合上限", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "checkin-bounded-backup-"));
  try {
    const sources = [];
    for (let index = 0; index < 9; index += 1) {
      const file = path.join(directory, `Bookmarks-${index}`);
      const fixture = JSON.stringify({
        roots: { synced: { id: String(index), type: "folder", name: "Root", children: [] } },
      });
      await fs.writeFile(file, fixture);
      await fs.writeFile(`${file}.bak`, fixture);
      sources.push({ name: `Source ${index}`, path: file, mobileFolderNames: ["Root"], targetFolderNames: ["Daily"] });
    }
    await assert.rejects(readBookmarkPlanWithBackup(sources, { minimumBookmarkTargetCount: 1 }), /回退组合已达到 256 个上限/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
