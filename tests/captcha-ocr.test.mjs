import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseAlphanumericCaptchaRecognition,
  correctCaptchaConfusions,
  isReliableSegmentedCaptchaRecognition,
  mergeFragmentedGlyphs,
  selectSegmentedGlyphRecognition,
} from "../src/captcha-ocr.mjs";

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

test("通用验证码只选择长度合规且置信度最高的字母数字结果", () => {
  assert.deepEqual(chooseAlphanumericCaptchaRecognition([
    { text: "??", confidence: 90 },
    { text: " A8-C2 ", confidence: 72 },
    { text: "A8C2", confidence: 65 },
    { text: "A8C3", confidence: 81 },
    { text: "TOO-LONG-123", confidence: 99 },
  ], 4, 6), { code: "A8C2", confidence: 72 });
  assert.deepEqual(chooseAlphanumericCaptchaRecognition([{ text: "?", confidence: 99 }], 4, 6), {
    code: "",
    confidence: 0,
  });
});

test("低置信度多数结果不会压过高置信度候选", () => {
  assert.deepEqual(chooseAlphanumericCaptchaRecognition([
    { text: "ABCDE", confidence: 0 },
    { text: "ABCDE", confidence: 0 },
    { text: "ABCDE", confidence: 0 },
    { text: "A8C2", confidence: 74 },
  ], 4, 6), { code: "A8C2", confidence: 74 });
});

test("逐字符几何证据修正带双侧竖向笔画的 B/F 混淆", () => {
  assert.deepEqual(selectSegmentedGlyphRecognition([
    { text: "F", confidence: 70 },
    { text: "B", confidence: 0 },
  ], {
    width: 12,
    height: 18,
    rowInk: [9, 9, 4, 3, 4, 3, 4, 3, 5, 6, 3, 4, 4, 4, 4, 4, 9, 10],
    columnInk: [4, 3, 16, 16, 6, 4, 4, 5, 5, 5, 11, 11],
  }), { code: "B", confidence: 60, shapeConfirmed: true });
});

test("强左竖干、上下横笔不闭合时修正 R/B 混淆", () => {
  assert.deepEqual(selectSegmentedGlyphRecognition([
    { text: "B", confidence: 89 },
  ], {
    width: 12,
    height: 18,
    rowInk: [10, 10, 4, 4, 4, 4, 4, 4, 10, 10, 4, 4, 2, 4, 4, 1, 4, 4],
    columnInk: [17, 17, 4, 4, 6, 6, 5, 5, 6, 5, 8, 8],
  }), { code: "R", confidence: 60, shapeConfirmed: true });
});

test("底部闭合横笔存在时保留 B", () => {
  assert.deepEqual(selectSegmentedGlyphRecognition([
    { text: "B", confidence: 89 },
  ], {
    width: 12,
    height: 18,
    rowInk: [10, 10, 4, 4, 4, 4, 4, 4, 10, 10, 4, 4, 4, 4, 4, 4, 10, 10],
    columnInk: [17, 17, 4, 4, 6, 6, 5, 5, 6, 5, 12, 12],
  }), { code: "B", confidence: 60, shapeConfirmed: true });
});

test("没有 B 候选时也可用非对称双竖干和三横确认 B", () => {
  assert.deepEqual(selectSegmentedGlyphRecognition([
    { text: "E", confidence: 78 },
  ], {
    width: 12,
    height: 18,
    rowInk: [10, 10, 4, 4, 4, 4, 4, 4, 8, 8, 4, 4, 4, 4, 0, 4, 10, 9],
    columnInk: [4, 4, 17, 17, 6, 6, 5, 6, 6, 6, 11, 11],
  }), { code: "B", confidence: 60, shapeConfirmed: true });
});

test("OCR 零候选时只允许强几何字形恢复 B", () => {
  assert.deepEqual(selectSegmentedGlyphRecognition([], {
    width: 12,
    height: 18,
    rowInk: [10, 10, 4, 4, 4, 4, 4, 4, 8, 8, 4, 4, 4, 4, 0, 4, 10, 9],
    columnInk: [4, 4, 17, 17, 6, 6, 5, 6, 6, 6, 11, 11],
  }), { code: "B", confidence: 60, shapeConfirmed: true });
  assert.deepEqual(selectSegmentedGlyphRecognition([], {
    width: 12,
    height: 18,
    rowInk: Array(18).fill(4),
    columnInk: Array(12).fill(6),
  }), { code: "", confidence: 0, shapeConfirmed: false });
});

test("左右对称的 8 不按非对称 B 修正", () => {
  assert.deepEqual(selectSegmentedGlyphRecognition([
    { text: "8", confidence: 59 },
  ], {
    width: 12,
    height: 18,
    rowInk: [8, 8, 4, 2, 4, 4, 4, 4, 8, 8, 4, 4, 4, 4, 4, 4, 8, 8],
    columnInk: [11, 11, 6, 6, 6, 6, 6, 6, 6, 6, 12, 12],
  }), { code: "8", confidence: 60, shapeConfirmed: true });
});

test("OCR 没有 8 候选时可用对称双竖弧和三横确认 8", () => {
  assert.deepEqual(selectSegmentedGlyphRecognition([
    { text: "H", confidence: 20 },
  ], {
    width: 12,
    height: 18,
    rowInk: [8, 8, 4, 2, 4, 4, 4, 4, 8, 8, 4, 4, 4, 4, 4, 4, 8, 8],
    columnInk: [11, 11, 6, 6, 6, 6, 6, 6, 6, 6, 12, 12],
  }), { code: "8", confidence: 60, shapeConfirmed: true });
});

test("缺少中横的对称闭环不按 8 修正", () => {
  assert.deepEqual(selectSegmentedGlyphRecognition([
    { text: "0", confidence: 70 },
  ], {
    width: 12,
    height: 18,
    rowInk: [8, 8, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 8, 8],
    columnInk: [11, 11, 6, 6, 6, 6, 6, 6, 6, 6, 12, 12],
  }), { code: "0", confidence: 70, shapeConfirmed: false });
});

test("a near-exact template hint recovers an eight with one damaged side pixel", () => {
  assert.deepEqual(selectSegmentedGlyphRecognition([
    { text: "E", confidence: 0 },
  ], {
    width: 12,
    height: 18,
    rowInk: [8, 8, 4, 3, 3, 1, 1, 2, 8, 8, 4, 4, 3, 0, 4, 4, 8, 8],
    columnInk: [8, 7, 6, 6, 6, 6, 6, 6, 6, 6, 9, 9],
  }, { templateHints: ["8"] }), { code: "8", confidence: 60, shapeConfirmed: true });
});

test("a damaged loop is not promoted to eight without a matching template hint", () => {
  assert.deepEqual(selectSegmentedGlyphRecognition([
    { text: "E", confidence: 40 },
  ], {
    width: 12,
    height: 18,
    rowInk: [8, 8, 4, 3, 3, 1, 1, 2, 8, 8, 4, 4, 3, 0, 4, 4, 8, 8],
    columnInk: [8, 7, 6, 6, 6, 6, 6, 6, 6, 6, 9, 9],
  }), { code: "E", confidence: 40, shapeConfirmed: false });
});

test("two stable template hints distinguish compact Q and O loops", () => {
  const glyph = {
    width: 12,
    height: 18,
    rowInk: [8, 8, 4, 4, 4, 4, 3, 3, 4, 4, 4, 4, 6, 4, 6, 6, 8, 8],
    columnInk: [13, 13, 4, 4, 6, 6, 6, 6, 4, 4, 13, 13],
  };
  assert.deepEqual(selectSegmentedGlyphRecognition([], glyph, {
    templateHints: ["Q", "Q"],
  }), { code: "Q", confidence: 60, shapeConfirmed: true });
  assert.deepEqual(selectSegmentedGlyphRecognition([], glyph, {
    templateHints: ["O", "O"],
  }), { code: "O", confidence: 60, shapeConfirmed: true });
  assert.deepEqual(selectSegmentedGlyphRecognition([], glyph, {
    templateHints: ["Q"],
  }), { code: "", confidence: 0, shapeConfirmed: false });
});

test("an OCR eight candidate is not geometry-confirmed without a template hint", () => {
  assert.deepEqual(selectSegmentedGlyphRecognition([
    { text: "8", confidence: 40 },
  ], {
    width: 12,
    height: 18,
    rowInk: [8, 8, 4, 3, 3, 1, 1, 2, 8, 8, 4, 4, 3, 0, 4, 4, 8, 8],
    columnInk: [8, 7, 6, 6, 6, 6, 6, 6, 6, 6, 9, 9],
  }), { code: "8", confidence: 40, shapeConfirmed: false });
});

test("a trusted G template is not overridden by symmetric-eight geometry", () => {
  assert.deepEqual(selectSegmentedGlyphRecognition([
    { text: "G", confidence: 100, source: "template" },
    { text: "8", confidence: 36, source: "tesseract" },
  ], {
    width: 12,
    height: 18,
    rowInk: [8, 8, 4, 4, 2, 2, 2, 2, 2, 2, 7, 6, 3, 4, 4, 5, 8, 8],
    columnInk: [12, 12, 4, 4, 4, 4, 5, 5, 6, 6, 9, 10],
  }), { code: "G", confidence: 100, shapeConfirmed: false });
});

test("shape confirmations elsewhere do not rescue a low-confidence glyph", () => {
  assert.equal(isReliableSegmentedCaptchaRecognition({
    code: "98T8B",
    confidence: 36,
    shapeConfirmedCount: 3,
  }, 5, 5), false);
  assert.equal(isReliableSegmentedCaptchaRecognition({
    code: "98TGB",
    confidence: 60,
    shapeConfirmedCount: 2,
  }, 5, 5), true);
});

test("双侧竖干只有上下横时确认 D 而不是 B", () => {
  assert.deepEqual(selectSegmentedGlyphRecognition([
    { text: "B", confidence: 90 },
    { text: "0", confidence: 16 },
  ], {
    width: 12,
    height: 18,
    rowInk: [10, 10, 4, 4, 4, 4, 4, 4, 4, 3, 4, 0, 1, 2, 4, 4, 10, 10],
    columnInk: [4, 4, 15, 14, 4, 4, 4, 4, 4, 4, 12, 13],
  }), { code: "D", confidence: 60, shapeConfirmed: true });
});

test("a complete left stem still confirms D when the middle crossbar is absent", () => {
  assert.deepEqual(selectSegmentedGlyphRecognition([
    { text: "B", confidence: 18 },
  ], {
    width: 12,
    height: 18,
    rowInk: [9, 10, 3, 3, 3, 3, 3, 4, 4, 4, 2, 2, 4, 4, 4, 4, 10, 10],
    columnInk: [4, 4, 16, 17, 4, 4, 4, 4, 4, 4, 8, 13],
  }), { code: "D", confidence: 60, shapeConfirmed: true });
});

test("a centered crossbar and intact right stem recover a damaged H", () => {
  assert.deepEqual(selectSegmentedGlyphRecognition([
    { text: "4", confidence: 93 },
    { text: "H", confidence: 72 },
  ], {
    width: 8,
    height: 18,
    rowInk: [2, 2, 0, 2, 2, 2, 2, 0, 3, 8, 2, 2, 2, 2, 2, 2, 2, 2],
    columnInk: [1, 1, 1, 1, 1, 2, 16, 16],
  }), { code: "H", confidence: 60, shapeConfirmed: true });
});

test("a centered H crossbar is not geometry-confirmed as four", () => {
  assert.deepEqual(selectSegmentedGlyphRecognition([
    { text: "4", confidence: 93 },
  ], {
    width: 8,
    height: 18,
    rowInk: [2, 2, 0, 2, 2, 2, 2, 0, 3, 8, 2, 2, 2, 2, 2, 2, 2, 2],
    columnInk: [1, 1, 1, 1, 1, 2, 16, 16],
  }), { code: "4", confidence: 93, shapeConfirmed: false });
});

test("逐字符几何证据修正中右竖线和中部横线的 4/F 混淆", () => {
  assert.deepEqual(selectSegmentedGlyphRecognition([
    { text: "F", confidence: 36 },
    { text: "4", confidence: 22 },
  ], {
    width: 12,
    height: 17,
    rowInk: [2, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 12, 12, 2, 2, 2, 2],
    columnInk: [6, 6, 4, 4, 4, 4, 4, 4, 17, 17, 2, 2],
  }), { code: "4", confidence: 60, shapeConfirmed: true });
});

test("中央下竖干和上部分叉确认 Y", () => {
  assert.deepEqual(selectSegmentedGlyphRecognition([
    { text: "V", confidence: 44 },
    { text: "Y", confidence: 16 },
  ], {
    width: 10,
    height: 18,
    rowInk: [4, 4, 4, 4, 4, 4, 4, 4, 2, 0, 2, 2, 2, 2, 2, 2, 2, 2],
    columnInk: [4, 4, 4, 4, 9, 9, 4, 4, 4, 4],
  }), { code: "Y", confidence: 60, shapeConfirmed: true });
});

test("没有中央下竖干时不把 V 修正成 Y", () => {
  assert.deepEqual(selectSegmentedGlyphRecognition([
    { text: "V", confidence: 44 },
    { text: "Y", confidence: 16 },
  ], {
    width: 10,
    height: 18,
    rowInk: [4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 3, 2],
    columnInk: [8, 8, 6, 6, 6, 6, 6, 6, 8, 8],
  }), { code: "V", confidence: 44, shapeConfirmed: false });
});

test("没有明确几何证据时保留最高置信度的逐字符结果", () => {
  assert.deepEqual(selectSegmentedGlyphRecognition([
    { text: "X", confidence: 31 },
    { text: "K", confidence: 68 },
  ], {
    width: 12,
    height: 18,
    rowInk: Array(18).fill(4),
    columnInk: [8, 8, 2, 2, 4, 4, 4, 4, 4, 4, 3, 3],
  }), { code: "K", confidence: 68, shapeConfirmed: false });
});

test("逐字符多变体共识可以压过单个略高置信度候选", () => {
  assert.deepEqual(selectSegmentedGlyphRecognition([
    { text: "2", confidence: 60 },
    { text: "2", confidence: 58 },
    { text: "2", confidence: 57 },
    { text: "2", confidence: 55 },
    { text: "2", confidence: 52 },
    { text: "7", confidence: 80 },
  ], {
    width: 12,
    height: 18,
    rowInk: Array(18).fill(4),
    columnInk: Array(12).fill(6),
  }), { code: "2", confidence: 60, shapeConfirmed: false });
});

test("圆弧三横且没有满宽横线或强竖干时修正 S/5 混淆", () => {
  assert.deepEqual(selectSegmentedGlyphRecognition([
    { text: "5", confidence: 81 },
    { text: "5", confidence: 70 },
  ], {
    width: 12,
    height: 18,
    rowInk: [8, 8, 3, 3, 2, 2, 2, 2, 8, 7, 2, 2, 2, 1, 3, 4, 7, 8],
    columnInk: [8, 8, 5, 5, 6, 6, 6, 6, 6, 6, 7, 5],
  }), { code: "S", confidence: 60, shapeConfirmed: true });
});

test("存在满宽横线的 5 不按圆弧 S 修正", () => {
  assert.deepEqual(selectSegmentedGlyphRecognition([
    { text: "5", confidence: 81 },
  ], {
    width: 12,
    height: 18,
    rowInk: [12, 12, 3, 3, 2, 2, 2, 2, 10, 9, 2, 2, 2, 1, 3, 4, 10, 12],
    columnInk: [10, 10, 6, 6, 6, 6, 6, 6, 6, 6, 7, 5],
  }), { code: "5", confidence: 81, shapeConfirmed: false });
});

test("上部起笔、底部满横且中间断裂时确认数字 2", () => {
  assert.deepEqual(selectSegmentedGlyphRecognition([
    { text: "7", confidence: 93 },
    { text: "2", confidence: 90 },
  ], {
    width: 12,
    height: 18,
    rowInk: [7, 8, 4, 4, 4, 4, 2, 1, 0, 0, 4, 4, 2, 2, 2, 2, 12, 11],
    columnInk: [8, 8, 6, 6, 6, 6, 6, 5, 4, 4, 6, 8],
  }), { code: "2", confidence: 60, shapeConfirmed: true });
});

test("没有中部断口时不把相似候选强制修正成数字 2", () => {
  assert.deepEqual(selectSegmentedGlyphRecognition([
    { text: "Z", confidence: 93 },
    { text: "2", confidence: 90 },
  ], {
    width: 12,
    height: 18,
    rowInk: [12, 12, 4, 4, 4, 4, 3, 3, 2, 2, 3, 3, 4, 4, 4, 4, 12, 12],
    columnInk: Array(12).fill(7),
  }), { code: "Z", confidence: 93, shapeConfirmed: false });
});

test("强左竖干、弱横线和右侧斜笔确认 K", () => {
  assert.deepEqual(selectSegmentedGlyphRecognition([
    { text: "X", confidence: 62 },
    { text: "K", confidence: 0 },
  ], {
    width: 12,
    height: 18,
    rowInk: [2, 3, 3, 4, 4, 2, 4, 4, 4, 4, 3, 2, 4, 4, 4, 4, 3, 4],
    columnInk: [15, 15, 2, 2, 3, 4, 4, 4, 4, 4, 3, 2],
  }), { code: "K", confidence: 60, shapeConfirmed: true });
});

function fragment(minX, minY, width, height, size = width * height) {
  return {
    minX,
    minY,
    maxX: minX + width - 1,
    maxY: minY + height - 1,
    width,
    height,
    size,
    rowInk: Array(height).fill(Math.max(1, Math.round(size / height))),
    columnInk: Array(width).fill(Math.max(1, Math.round(size / width))),
  };
}

test("合并水平高度重叠且垂直间隔很小的断裂字形", () => {
  const merged = mergeFragmentedGlyphs([
    fragment(20, 10, 12, 8, 34),
    fragment(20, 20, 12, 8, 39),
  ], 160, 58);
  assert.equal(merged.length, 1);
  assert.deepEqual({
    minX: merged[0].minX,
    minY: merged[0].minY,
    maxX: merged[0].maxX,
    maxY: merged[0].maxY,
    width: merged[0].width,
    height: merged[0].height,
    size: merged[0].size,
  }, { minX: 20, minY: 10, maxX: 31, maxY: 27, width: 12, height: 18, size: 73 });
});

test("不合并垂直距离过远或水平重叠不足的碎片", () => {
  const merged = mergeFragmentedGlyphs([
    fragment(20, 2, 12, 6),
    fragment(20, 20, 12, 6),
    fragment(40, 10, 12, 6),
    fragment(49, 18, 12, 6),
  ], 160, 58);
  assert.equal(merged.length, 4);
});

test("合并细竖干和底横组成的 L 字形", () => {
  const merged = mergeFragmentedGlyphs([
    fragment(16, 26, 2, 15, 30),
    fragment(16, 42, 12, 2, 16),
  ], 160, 58);
  assert.equal(merged.length, 1);
  assert.deepEqual({ width: merged[0].width, height: merged[0].height, size: merged[0].size }, {
    width: 12,
    height: 18,
    size: 46,
  });
});

test("合并相邻斜笔片段但不跨字符间距", () => {
  const merged = mergeFragmentedGlyphs([
    fragment(70, 27, 12, 10, 28),
    fragment(74, 36, 8, 8, 14),
    fragment(70, 38, 2, 6, 12),
    fragment(70, 26, 2, 5, 8),
    fragment(96, 30, 12, 18, 88),
  ], 160, 58);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((item) => ({ x: item.minX, width: item.width, height: item.height })), [
    { x: 70, width: 12, height: 18 },
    { x: 96, width: 12, height: 18 },
  ]);
});

test("merge side-by-side fragments only when they form one glyph", () => {
  const merged = mergeFragmentedGlyphs([
    fragment(18, 20, 4, 18, 44),
    fragment(22, 20, 8, 18, 59),
    fragment(46, 20, 12, 18, 81),
  ], 160, 58);
  assert.deepEqual(merged.map((item) => ({ x: item.minX, width: item.width, height: item.height })), [
    { x: 18, width: 12, height: 18 },
    { x: 46, width: 12, height: 18 },
  ]);
});

test("do not merge full-height fragments across a character gap", () => {
  const merged = mergeFragmentedGlyphs([
    fragment(18, 20, 4, 18, 44),
    fragment(24, 20, 8, 18, 59),
  ], 160, 58);
  assert.equal(merged.length, 2);
});
