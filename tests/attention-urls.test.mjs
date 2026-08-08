import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildAttentionHandoff,
  loadAttentionHandoff,
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
