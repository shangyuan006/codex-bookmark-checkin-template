import test from "node:test";
import assert from "node:assert/strict";
import {
  matchPixelFontGlyph,
  PIXEL_FONT_TEMPLATE_VARIANTS,
  PIXEL_FONT_TEMPLATES,
  scorePixelFontTemplate,
} from "../src/pixel-font-ocr.mjs";

test("固定像素字体模板可以识别全部非歧义字形", () => {
  for (const [code, rows] of Object.entries(PIXEL_FONT_TEMPLATES)) {
    const result = matchPixelFontGlyph(rows);
    assert.equal(result.code, code, `${code} should match its own template`);
    assert.equal(result.confidence, 100);
  }
});

test("模板匹配允许单个像素缺失", () => {
  const rows = [...PIXEL_FONT_TEMPLATES.M];
  rows[3] = `${rows[3].slice(0, 2)}0${rows[3].slice(3)}`;
  const result = matchPixelFontGlyph(rows);
  assert.equal(result.code, "M");
  assert.ok(result.confidence >= 95);
});

test("未知图形和候选差距不足时拒绝猜测", () => {
  assert.equal(matchPixelFontGlyph(Array(9).fill("000000")).code, "");
  const ambiguous = Array(9).fill("100001");
  assert.equal(matchPixelFontGlyph(ambiguous).code, "");
});

test("a near-exact ambiguous glyph exposes a hint without returning an answer", () => {
  const rows = [...PIXEL_FONT_TEMPLATES["8"]];
  rows[6] = `0${rows[6].slice(1)}`;
  const result = matchPixelFontGlyph(rows);
  assert.equal(result.code, "");
  assert.equal(result.bestCode, "8");
  assert.ok(result.score >= 0.95);
});

test("confirmed font variants remain associated with the same character", () => {
  assert.equal(matchPixelFontGlyph(PIXEL_FONT_TEMPLATE_VARIANTS.V[0]).code, "V");
  const compactQ = matchPixelFontGlyph(PIXEL_FONT_TEMPLATE_VARIANTS.Q[0]);
  assert.equal(compactQ.code, "");
  assert.equal(compactQ.bestCode, "Q");
  assert.equal(compactQ.score, 1);
});

test("平移一格仍可计算出高相似度", () => {
  const shifted = PIXEL_FONT_TEMPLATES.E.map((row) => `0${row}`);
  assert.ok(scorePixelFontTemplate(shifted, PIXEL_FONT_TEMPLATES.E) >= 0.95);
});
