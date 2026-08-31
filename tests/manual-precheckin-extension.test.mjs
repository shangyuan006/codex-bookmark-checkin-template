import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildManualPrecheckinExtension,
  manualPrecheckinContentScript,
} from "../src/manual-precheckin-extension.mjs";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "manual-precheckin-extension-"));
  const configDirectory = path.join(root, "config");
  const tmpDirectory = path.join(root, "tmp");
  const bookmarksPath = path.join(root, "Bookmarks");
  const inputPath = path.join(tmpDirectory, "handoff.json");
  await Promise.all([
    fs.mkdir(configDirectory, { recursive: true }),
    fs.mkdir(tmpDirectory, { recursive: true }),
  ]);
  await fs.writeFile(bookmarksPath, JSON.stringify({
    roots: {
      synced: {
        id: "1", type: "folder", name: "Container", children: [{
          id: "2", type: "folder", name: "Daily", children: [
            { id: "3", type: "url", name: "Profile", url: "https://alpha.example/profile" },
          ],
        }],
      },
    },
  }), "utf8");
  const config = {
    bookmarksPath,
    mobileFolderNames: ["Container"],
    targetFolderNames: ["Daily"],
    preCheckinNavigationRules: {
      "https://alpha.example": {
        steps: [
          { selector: "button[data-profile-menu]" },
          { role: "menuitem", name: "Profile" },
        ],
        expectedPath: "/profile",
      },
    },
  };
  await Promise.all([
    fs.writeFile(path.join(configDirectory, "config.json"), JSON.stringify(config), "utf8"),
    fs.writeFile(inputPath, JSON.stringify({
      targets: [{
        origin: "https://alpha.example",
        url: "https://alpha.example/profile",
      }],
    }), "utf8"),
  ]);
  return { root, config, inputPath };
}

test("manual handoff builds a temporary same-origin pre-navigation extension", async () => {
  const { root, inputPath } = await fixture();
  try {
    const result = await buildManualPrecheckinExtension({ rootDirectory: root, inputPath });
    assert.deepEqual(result, { enabled: true, ruleCount: 1 });
    const outputDirectory = path.join(root, "tmp", "manual-precheckin-extension");
    const [manifest, source] = await Promise.all([
      fs.readFile(path.join(outputDirectory, "manifest.json"), "utf8").then(JSON.parse),
      fs.readFile(path.join(outputDirectory, "navigate.js"), "utf8"),
    ]);
    assert.deepEqual(manifest.content_scripts[0].matches, ["https://alpha.example/*"]);
    assert.deepEqual(manifest.content_scripts[0].js, ["navigate.js"]);
    assert.match(source, /button\[data-profile-menu\]/);
    assert.match(source, /expectedPath/);
    assert.doesNotMatch(source, /document\.body|cookie|localStorage|sessionStorage|console\./);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("manual pre-navigation removes stale extension output when no rule applies", async () => {
  const { root, config, inputPath } = await fixture();
  try {
    const outputDirectory = path.join(root, "tmp", "manual-precheckin-extension");
    await fs.mkdir(outputDirectory, { recursive: true });
    await fs.writeFile(path.join(outputDirectory, "stale.txt"), "stale", "utf8");
    await fs.writeFile(path.join(root, "config", "config.json"), JSON.stringify({
      ...config,
      preCheckinNavigationRules: {},
    }), "utf8");
    assert.deepEqual(
      await buildManualPrecheckinExtension({ rootDirectory: root, inputPath }),
      { enabled: false, ruleCount: 0 },
    );
    await assert.rejects(fs.access(outputDirectory));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("manual pre-navigation refuses files outside tmp", async () => {
  const { root, inputPath } = await fixture();
  try {
    await assert.rejects(
      buildManualPrecheckinExtension({
        rootDirectory: root,
        inputPath,
        outputDirectory: path.join(root, "outside"),
      }),
      /inside tmp/,
    );
    assert.equal(typeof manualPrecheckinContentScript, "function");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
