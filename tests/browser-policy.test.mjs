import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CHALLENGE_SELECTOR,
  candidateHistoryEntry,
  preferCandidateResult,
  shouldPersistSiteStorage,
  writeSiteStorageSnapshot,
} from "../src/browser.mjs";

test("候选弱结果不会覆盖登录、挑战或延迟状态", () => {
  for (const status of ["login_required", "interactive_challenge", "managed_challenge_timeout", "deferred"]) {
    const valuable = { status, reason: "actionable" };
    assert.equal(preferCandidateResult(valuable, { status: "no_action" }), valuable);
    assert.equal(preferCandidateResult(valuable, { status: "error" }), valuable);
  }
});

test("候选完成状态会覆盖此前异常状态", () => {
  const completed = { status: "signed", reason: "done" };
  assert.equal(preferCandidateResult({ status: "login_required" }, completed), completed);
});

test("候选历史会脱敏网址和错误原因", () => {
  const entry = candidateHistoryEntry(
    "https://example.test/checkin?token=secret-value&day=2026-07-23",
    {
      status: "error",
      reason: "authorization=private-value https://example.test/error?code=secret-code",
    },
    2,
  );
  const serialized = JSON.stringify(entry);
  assert.equal(entry.attempt, 2);
  assert.equal(entry.status, "error");
  assert.doesNotMatch(serialized, /secret-value|private-value|secret-code|2026-07-23/);
  assert.match(decodeURIComponent(entry.candidateUrl), /token=\[REDACTED\]/);
  assert.match(decodeURIComponent(entry.candidateUrl), /day=\[VALUE\]/);
});

test("通用安全验证选择器覆盖 Cap.js", () => {
  assert.match(CHALLENGE_SELECTOR, /cap-widget/);
  assert.match(CHALLENGE_SELECTOR, /data-cap-api-endpoint/);
});

test("只有已确认签到结果允许保存站点会话", () => {
  assert.equal(shouldPersistSiteStorage({ status: "signed" }), true);
  assert.equal(shouldPersistSiteStorage({ status: "already_signed" }), true);
  for (const status of ["login_required", "error", "no_action", "unconfirmed", "not_available"]) {
    assert.equal(shouldPersistSiteStorage({ status }), false);
  }
});

test("站点会话更新前会把旧内容保留为 bak", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "checkin-storage-"));
  const storagePath = path.join(directory, "session.json");
  try {
    const previous = { version: 1, origin: "https://example.test", local: [["auth", "old"]], session: [] };
    const current = { version: 1, origin: "https://example.test", local: [["auth", "new"]], session: [] };
    await fs.writeFile(storagePath, `${JSON.stringify(previous)}\n`, "utf8");

    await writeSiteStorageSnapshot(storagePath, current);

    assert.deepEqual(JSON.parse(await fs.readFile(storagePath, "utf8")), current);
    assert.deepEqual(JSON.parse(await fs.readFile(`${storagePath}.bak`, "utf8")), previous);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
