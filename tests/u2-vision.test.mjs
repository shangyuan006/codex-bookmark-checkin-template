import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { parseMyAnimeListSearchImages } from "../src/u2-vision.mjs";

test("U2 备用作品源只接受标题匹配的 MyAnimeList CDN 图片", () => {
  const html = `
    <img alt="School Rumble" data-src="https://cdn.myanimelist.net/r/50x70/images/anime/4/75488.jpg?s=abc">
    <img data-src='https://cdn.myanimelist.net/r/50x70/images/anime/1/2.jpg?s=def' alt='Unrelated School'>
    <img data-src="https://cdn.myanimelist.net/r/100x140/images/anime/3/4.jpg?s=ghi" alt="School Rumble: Extra Class">
    <img alt="School Rumble" data-src="https://attacker.invalid/image.jpg">
  `;
  assert.deepEqual(parseMyAnimeListSearchImages(html, ["School Rumble"]), [
    "https://cdn.myanimelist.net/images/anime/4/75488.jpg?s=abc",
    "https://cdn.myanimelist.net/images/anime/3/4.jpg?s=ghi",
  ]);
});

test("U2 只有 AniList 候选不足时才查询备用源", async () => {
  const source = await fs.readFile(new URL("../src/u2-vision.mjs", import.meta.url), "utf8");
  assert.match(source, /referenceGroups\[optionIndex\]\?\.length > 0\s*\? \[\]/);
  assert.match(source, /AniList 与 MyAnimeList 均未返回足够/);
});
