import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareNativeBrowserProfile } from "../src/prepare-native-browser-profile.mjs";

test("independent browser launch disables tab restoration without deleting session or login data", async () => {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "checkin-browser-profile-"));
  const profile = path.join(userDataDir, "Default");
  const sessions = path.join(profile, "Sessions");
  try {
    await fs.mkdir(sessions, { recursive: true });
    await fs.writeFile(path.join(sessions, "Session_123"), "session");
    await fs.writeFile(path.join(sessions, "Tabs_123"), "tabs");
    await fs.writeFile(path.join(sessions, "keep.txt"), "keep");
    await fs.writeFile(path.join(profile, "Cookies"), "cookie-data");
    await fs.writeFile(path.join(profile, "Preferences"), JSON.stringify({
      profile: { exit_type: "Crashed", exited_cleanly: false, keep: true },
      session: { restore_on_startup: 1, startup_urls: ["https://old.test"] },
      unrelated: { keep: true },
    }));

    const result = await prepareNativeBrowserProfile(userDataDir);
    const preferences = JSON.parse(await fs.readFile(path.join(profile, "Preferences"), "utf8"));
    assert.equal(result.preferencesUpdated, true);
    assert.equal(await fs.readFile(path.join(profile, "Cookies"), "utf8"), "cookie-data");
    assert.equal(await fs.readFile(path.join(sessions, "keep.txt"), "utf8"), "keep");
    assert.equal(await fs.readFile(path.join(sessions, "Session_123"), "utf8"), "session");
    assert.equal(await fs.readFile(path.join(sessions, "Tabs_123"), "utf8"), "tabs");
    assert.deepEqual(preferences.profile, { exit_type: "Normal", exited_cleanly: true, keep: true });
    assert.deepEqual(preferences.session, { restore_on_startup: 5, startup_urls: [] });
    assert.deepEqual(preferences.unrelated, { keep: true });
  } finally {
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

test("profile preparation rejects directory traversal", async () => {
  await assert.rejects(prepareNativeBrowserProfile(path.resolve(os.tmpdir(), "safe"), ".."), /single directory name/);
});
