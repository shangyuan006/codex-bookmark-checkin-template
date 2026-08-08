import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("手动会话状态只记录复核所需字段，不持久化书签 URL", async () => {
  const scriptUrl = new URL("../scripts/Open-PlainLoginChrome.ps1", import.meta.url);
  const bytes = await fs.readFile(scriptUrl);
  const source = bytes.toString("utf8");
  const targetProjection = source.match(
    /targets = @\(\$items \| ForEach-Object \{\s*\[ordered\]@\{([\s\S]*?)\r?\n\s*\}\r?\n\s*\}\)/,
  )?.[1] ?? "";

  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.ok(targetProjection, "manual-session target projection must be present");
  assert.deepEqual(
    [...targetProjection.matchAll(/^\s+(\w+)\s*=/gm)].map((match) => match[1]),
    ["origin", "previousStatus"],
  );
  assert.doesNotMatch(targetProjection, /\burl\s*=/i);
  assert.match(source, /\$arguments \+= @\(\$items \| ForEach-Object \{ \[string\]\$_\.url \}\)/);
});
