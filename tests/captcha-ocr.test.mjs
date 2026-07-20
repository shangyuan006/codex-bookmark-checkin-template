import test from "node:test";
import assert from "node:assert/strict";
import { correctCaptchaConfusions } from "../src/captcha-ocr.mjs";

function glyph(width, height, leftCoverage) {
  const leftInk = Math.round(height * leftCoverage);
  return {
    width,
    height,
    columnInk: [leftInk, Math.max(0, leftInk - 1), ...Array(Math.max(0, width - 2)).fill(2)],
  };
}

test("修正 HDSky 块状字体的 B/E 与 D/0 混淆", () => {
  const glyphs = [
    glyph(8, 10, 1),
    glyph(9, 10, 1),
    glyph(8, 10, 0.8),
    glyph(8, 10, 1),
    glyph(8, 10, 1),
    glyph(8, 10, 1),
  ];
  assert.equal(correctCaptchaConfusions("ME2AGE", glyphs), "MB2AGE");
  assert.equal(correctCaptchaConfusions("DFH20E", glyphs), "DFH2DE");
  assert.equal(correctCaptchaConfusions("CMEE1H", [
    glyph(8, 10, 0.8),
    glyph(8, 10, 1),
    glyph(10, 10, 1),
    glyph(7, 10, 1),
    glyph(6, 10, 0.5),
    glyph(9, 10, 1),
  ]), "CMRE1H");
});

test("不修改普通六位验证码", () => {
  const glyphs = Array.from({ length: 6 }, () => glyph(8, 10, 0.8));
  assert.equal(correctCaptchaConfusions("PH16FG", glyphs), "PH16FG");
});
