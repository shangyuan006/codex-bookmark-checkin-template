import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildAttentionHandoff,
  canExplicitlyRequestManualAttention,
  loadAttentionHandoff,
  mergeAttentionEvidence,
  parseAttentionArguments,
  requiresManualAttention,
} from "../src/attention-urls.mjs";

const plan = {
  generatedAt: "2026-07-28T04:00:00.000Z",
  targets: [
    {
      origin: "https://alpha.example",
      candidates: ["https://alpha.example/user/attendance"],
    },
    {
      origin: "https://beta.example",
      candidates: ["https://beta.example/checkin"],
    },
    {
      origin: "https://done.example",
      candidates: ["https://done.example/daily"],
    },
  ],
};

const latest = {
  runId: "20260728-120000",
  finishedAt: "2026-07-28T04:10:00.000Z",
  results: [
    {
      origin: "https://alpha.example",
      url: "https://alpha.example/old-home",
      status: "login_required",
    },
    { origin: "https://beta.example", status: "interactive_challenge" },
    { origin: "https://done.example", status: "signed" },
  ],
};

test("手动交接忽略旧报告 URL，并从当前书签计划解析地址", () => {
  const handoff = buildAttentionHandoff({ plan, latest });

  assert.deepEqual(handoff.targets.map((item) => item.url), [
    "https://alpha.example/user/attendance",
    "https://beta.example/checkin",
  ]);
  assert.equal(handoff.sourceRunId, latest.runId);
});

test("显式传入旧路径时只把它当作 origin 选择，不把旧 URL 用于导航", () => {
  const handoff = buildAttentionHandoff({
    plan,
    latest,
    requestedOrigins: ["https://alpha.example/old-home?from=manual"],
  });

  assert.equal(handoff.selectionMode, "origins");
  assert.deepEqual(handoff.targets, [{
    origin: "https://alpha.example",
    url: "https://alpha.example/user/attendance",
    previousStatus: "login_required",
  }]);
});

test("显式选择当前书签中的新增站点时允许进入手动处理", () => {
  const currentPlan = {
    ...plan,
    targets: [
      ...plan.targets,
      { origin: "https://new.example", candidates: ["https://new.example/checkin"] },
    ],
  };
  const handoff = buildAttentionHandoff({
    plan: currentPlan,
    latest,
    requestedOrigins: ["https://new.example/home"],
  });

  assert.deepEqual(handoff.targets, [{
    origin: "https://new.example",
    url: "https://new.example/checkin",
    previousStatus: "new_target",
  }]);
});

test("no-action sites require an explicit origin before manual handoff", () => {
  const unresolved = {
    ...latest,
    results: [
      ...latest.results.filter((result) => result.origin !== "https://beta.example"),
      { origin: "https://beta.example", status: "no_action" },
    ],
  };

  assert.equal(canExplicitlyRequestManualAttention({ status: "no_action" }), true);
  assert.deepEqual(buildAttentionHandoff({ plan, latest: unresolved }).targets.map((item) => item.origin), [
    "https://alpha.example",
  ]);
  assert.deepEqual(buildAttentionHandoff({
    plan,
    latest: unresolved,
    requestedOrigins: ["https://beta.example"],
  }).targets, [{
    origin: "https://beta.example",
    url: "https://beta.example/checkin",
    previousStatus: "no_action",
  }]);
});

test("序号选择基于稳定排序后的当前待处理列表", () => {
  const handoff = buildAttentionHandoff({
    plan,
    latest,
    preferredOrigins: ["https://beta.example"],
    selection: [1],
  });

  assert.equal(handoff.selectionMode, "selection");
  assert.equal(handoff.targets[0].origin, "https://beta.example");
  assert.equal(handoff.targets[0].url, "https://beta.example/checkin");
});

test("已完成、未知或越界的站点不能进入手动待处理交接", () => {
  assert.throws(
    () => buildAttentionHandoff({ plan, latest, requestedOrigins: ["https://done.example/"] }),
    /不在当前待处理列表/,
  );
  assert.throws(
    () => buildAttentionHandoff({ plan, latest, selection: [3] }),
    /Selection 必须是/,
  );
});

test("命令行 origin 和序号参数保持为选择条件", () => {
  assert.deepEqual(parseAttentionArguments([
    "--origin", "https://alpha.example/old",
    "--origin", "https://beta.example/",
  ]), {
    requestedOrigins: ["https://alpha.example/old", "https://beta.example/"],
    selection: [],
  });
  assert.deepEqual(parseAttentionArguments(["--selection", "2"]), {
    requestedOrigins: [],
    selection: ["2"],
  });
});

test("人工交接只接收登录或验证原因的 deferred", () => {
  assert.equal(requiresManualAttention({ status: "deferred", retryCause: "login_required" }), true);
  assert.equal(requiresManualAttention({ status: "deferred", retryCause: "managed_challenge_timeout" }), true);
  assert.equal(requiresManualAttention({ status: "deferred", retryCause: "rate_limit" }), false);
  assert.equal(requiresManualAttention({ status: "deferred" }), false);

  const deferredLatest = {
    results: [
      { origin: "https://alpha.example", status: "deferred", retryCause: "rate_limit" },
      { origin: "https://beta.example", status: "deferred", retryCause: "login_required" },
    ],
  };
  const handoff = buildAttentionHandoff({ plan, latest: deferredLatest });
  assert.deepEqual(handoff.targets.map((target) => target.origin), ["https://beta.example"]);
});

test("可人工接管明确的站点错误", () => {
  assert.equal(requiresManualAttention({ status: "error", reason: "modal_intercepts_action" }), true);
});

test("当天定向验证结果可为未终态完整日报补充人工交接证据", () => {
  const baseline = {
    runId: "20260728-120000",
    results: [
      { origin: "https://alpha.example", status: "error" },
      { origin: "https://done.example", status: "signed" },
    ],
  };
  const merged = mergeAttentionEvidence(baseline, [{
    runId: "20260728-121500",
    selectedOrigins: ["https://alpha.example", "https://done.example"],
    results: [
      { origin: "https://alpha.example", status: "deferred", retryCause: "managed_challenge_timeout" },
      { origin: "https://done.example", status: "deferred", retryCause: "login_required" },
    ],
  }]);

  assert.equal(merged.results.find((result) => result.origin === "https://alpha.example").status, "deferred");
  assert.equal(merged.results.find((result) => result.origin === "https://done.example").status, "signed");
  assert.deepEqual(
    buildAttentionHandoff({ plan, latest: merged, requestedOrigins: ["https://alpha.example"] }).targets,
    [{
      origin: "https://alpha.example",
      url: "https://alpha.example/user/attendance",
      previousStatus: "deferred",
    }],
  );
});

test("跨日定向结果不能改变当天人工交接状态", () => {
  const baseline = {
    runId: "20260728-120000",
    results: [{ origin: "https://alpha.example", status: "error" }],
  };
  const merged = mergeAttentionEvidence(baseline, [{
    runId: "20260727-235900",
    selectedOrigins: ["https://alpha.example"],
    results: [{ origin: "https://alpha.example", status: "deferred", retryCause: "login_required" }],
  }]);
  assert.equal(merged.results[0].status, "error");
});

test("加载人工交接时使用当天最新定向结果但仍从当前书签导航", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "manual-handoff-targeted-result-"));
  const configDirectory = path.join(root, "config");
  const logsDirectory = path.join(root, "logs");
  const runDirectory = path.join(logsDirectory, "20260728-121500");
  const bookmarksPath = path.join(root, "Bookmarks");
  try {
    await fs.mkdir(configDirectory, { recursive: true });
    await fs.mkdir(runDirectory, { recursive: true });
    await fs.writeFile(bookmarksPath, JSON.stringify({
      roots: {
        synced: {
          id: "1", type: "folder", name: "Container", children: [{
            id: "2", type: "folder", name: "Daily", children: [{
              id: "3", type: "url", name: "Site", url: "https://alpha.example/current-checkin",
            }],
          }],
        },
      },
    }));
    await fs.writeFile(path.join(configDirectory, "config.json"), JSON.stringify({
      bookmarksPath,
      mobileFolderNames: ["Container"],
      targetFolderNames: ["Daily"],
    }));
    await fs.writeFile(path.join(logsDirectory, "latest.json"), JSON.stringify({
      runId: "20260728-120000",
      results: [{ origin: "https://alpha.example", status: "error" }],
    }));
    await fs.writeFile(path.join(runDirectory, "result.json"), JSON.stringify({
      runId: "20260728-121500",
      selectedOrigins: ["https://alpha.example"],
      results: [{
        origin: "https://alpha.example",
        url: "https://alpha.example/stale-diagnostic-url",
        status: "deferred",
        retryCause: "managed_challenge_timeout",
      }],
    }));

    const handoff = await loadAttentionHandoff(root, ["--origin", "https://alpha.example"]);
    assert.equal(handoff.sourceRunId, "20260728-120000");
    assert.deepEqual(handoff.targets, [{
      origin: "https://alpha.example",
      url: "https://alpha.example/current-checkin",
      previousStatus: "deferred",
    }]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("加载手动交接时只读取当前 Bookmarks，不复用带旧地址的备份", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "manual-handoff-live-bookmarks-"));
  const configDirectory = path.join(root, "config");
  const logsDirectory = path.join(root, "logs");
  const bookmarksPath = path.join(root, "Bookmarks");
  const bookmarkDocument = (url) => ({
    roots: {
      synced: {
        id: "1", type: "folder", name: "容器", children: [{
          id: "2", type: "folder", name: "每日", children: [
            { id: "3", type: "url", name: "站点", url },
          ],
        }],
      },
    },
  });

  try {
    await fs.mkdir(configDirectory, { recursive: true });
    await fs.mkdir(logsDirectory, { recursive: true });
    await fs.writeFile(bookmarksPath, JSON.stringify(bookmarkDocument("https://alpha.example/user/attendance")));
    await fs.writeFile(`${bookmarksPath}.bak`, JSON.stringify(bookmarkDocument("https://alpha.example/old-home")));
    await fs.writeFile(path.join(configDirectory, "config.json"), JSON.stringify({
      bookmarksPath,
      mobileFolderNames: ["容器"],
      targetFolderNames: ["每日"],
    }));
    await fs.writeFile(path.join(logsDirectory, "latest.json"), JSON.stringify({
      runId: "20260728-120000",
      results: [{ origin: "https://alpha.example", status: "login_required" }],
    }));

    const handoff = await loadAttentionHandoff(root, ["--origin", "https://alpha.example/old-home"]);
    assert.equal(handoff.targets[0].url, "https://alpha.example/user/attendance");

    await fs.writeFile(bookmarksPath, "{not-json");
    await assert.rejects(() => loadAttentionHandoff(root));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("multi-source handoff reads every live primary file and uses the newest mtime", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "manual-handoff-multi-source-"));
  const configDirectory = path.join(root, "config");
  const logsDirectory = path.join(root, "logs");
  const primaryPath = path.join(root, "PrimaryBookmarks");
  const additionalPath = path.join(root, "AdditionalBookmarks");
  const bookmarkDocument = (folder, url) => ({
    roots: {
      synced: {
        id: "1", type: "folder", name: folder, children: [{
          id: "2", type: "folder", name: "Daily", children: [
            { id: "3", type: "url", name: "Site", url },
          ],
        }],
      },
    },
  });

  try {
    await fs.mkdir(configDirectory, { recursive: true });
    await fs.mkdir(logsDirectory, { recursive: true });
    await fs.writeFile(primaryPath, JSON.stringify(bookmarkDocument("Primary", "https://primary.example/checkin")));
    await fs.writeFile(additionalPath, JSON.stringify(bookmarkDocument("Additional", "https://additional.example/checkin")));
    await fs.writeFile(`${additionalPath}.bak`, JSON.stringify(bookmarkDocument("Additional", "https://stale.example/checkin")));
    const older = new Date("2026-01-01T00:00:00.000Z");
    const newer = new Date("2026-01-02T00:00:00.000Z");
    await fs.utimes(primaryPath, older, older);
    await fs.utimes(additionalPath, newer, newer);
    await fs.writeFile(path.join(configDirectory, "config.json"), JSON.stringify({
      bookmarksPath: primaryPath,
      mobileFolderNames: ["Primary"],
      targetFolderNames: ["Daily"],
      additionalBookmarkSources: [{
        name: "Additional",
        path: additionalPath,
        mobileFolderNames: ["Additional"],
        targetFolderNames: ["Daily"],
      }],
    }));
    await fs.writeFile(path.join(logsDirectory, "latest.json"), JSON.stringify({
      runId: "20260728-120000",
      results: [
        { origin: "https://primary.example", status: "login_required" },
        { origin: "https://additional.example", status: "login_required" },
      ],
    }));

    const handoff = await loadAttentionHandoff(root);
    assert.deepEqual(handoff.targets.map((target) => target.origin), [
      "https://additional.example",
      "https://primary.example",
    ]);
    assert.equal(handoff.bookmarkLastModifiedAt, newer.toISOString());

    await fs.unlink(additionalPath);
    await assert.rejects(() => loadAttentionHandoff(root));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
