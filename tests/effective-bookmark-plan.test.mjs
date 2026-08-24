import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  effectiveBookmarkPlanValidation,
  readEffectiveBookmarkPlan,
  validateEffectiveBookmarkPlan,
} from "../src/effective-bookmark-plan.mjs";

function bookmarkDocument(count) {
  return {
    roots: {
      synced: {
        id: "root",
        type: "folder",
        name: "Automation",
        children: [{
          id: "daily",
          type: "folder",
          name: "Daily",
          children: Array.from({ length: count }, (_, index) => ({
            id: `site-${index}`,
            type: "url",
            name: `Site ${index}`,
            url: `https://site-${index}.example/checkin`,
          })),
        }],
      },
    },
  };
}

const bookmarkOptions = {
  mobileFolderNames: ["Automation"],
  targetFolderNames: ["Daily"],
  minimumBookmarkTargetCount: 1,
};

test("effective bookmark threshold combines the configured minimum with the 50% drop guard", () => {
  assert.deepEqual(effectiveBookmarkPlanValidation(
    { minimumBookmarkTargetCount: 2 },
    { targetCount: 9 },
  ), {
    minimumTargets: 2,
    previousCount: 9,
    effectiveMinimumTargets: 5,
  });
  assert.equal(effectiveBookmarkPlanValidation(
    { minimumBookmarkTargetCount: 3 },
    { targetCount: 2 },
  ).effectiveMinimumTargets, 3);
});

test("effective bookmark validation rejects a sudden target drop", () => {
  const validation = effectiveBookmarkPlanValidation(
    { minimumBookmarkTargetCount: 1 },
    { targetCount: 8 },
  );
  assert.throws(
    () => validateEffectiveBookmarkPlan({ targetCount: 3 }, validation),
    /当前 3 个，上次 8 个/,
  );
});

test("effective plan consistently selects a per-source backup when the primary drops below the guard", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "effective-bookmark-plan-"));
  const bookmarksPath = path.join(directory, "Bookmarks");
  const lastValidPath = path.join(directory, "last-valid-bookmark-plan.json");
  try {
    await fs.writeFile(bookmarksPath, JSON.stringify(bookmarkDocument(2)));
    await fs.writeFile(`${bookmarksPath}.bak`, JSON.stringify(bookmarkDocument(6)));
    await fs.writeFile(lastValidPath, JSON.stringify({ targetCount: 6 }));

    const plan = await readEffectiveBookmarkPlan(bookmarksPath, bookmarkOptions, lastValidPath);
    assert.equal(plan.targetCount, 6);
    assert.equal(plan.recoveredFromBackup, true);
    assert.deepEqual(JSON.parse(await fs.readFile(lastValidPath, "utf8")), { targetCount: 6 });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("missing or malformed last-valid evidence falls back to the configured minimum", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "effective-bookmark-first-run-"));
  const bookmarksPath = path.join(directory, "Bookmarks");
  const lastValidPath = path.join(directory, "last-valid-bookmark-plan.json");
  try {
    await fs.writeFile(bookmarksPath, JSON.stringify(bookmarkDocument(2)));
    await fs.writeFile(lastValidPath, "not-json");
    const plan = await readEffectiveBookmarkPlan(bookmarksPath, {
      ...bookmarkOptions,
      minimumBookmarkTargetCount: 2,
    }, lastValidPath);
    assert.equal(plan.targetCount, 2);
    assert.equal(plan.recoveredFromBackup, false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("runner, health plan, and timeout finalizer share the effective read path", async () => {
  const [runner, currentPlan, finalizer] = await Promise.all([
    fs.readFile(new URL("../src/index.mjs", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/current-plan.mjs", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/finalize-timeout-report.mjs", import.meta.url), "utf8"),
  ]);
  for (const source of [runner, currentPlan, finalizer]) {
    assert.match(source, /readEffectiveBookmarkPlan\(/);
    assert.match(source, /last-valid-bookmark-plan\.json/);
  }
  assert.match(runner, /atomicWriteJson\(lastValidBookmarkPlanPath, publicBookmarkReport\(plan\)\)/);
  assert.doesNotMatch(currentPlan, /atomicWriteJson/);
  assert.doesNotMatch(finalizer, /atomicWriteJson/);
});
