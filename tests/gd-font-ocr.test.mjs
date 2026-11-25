import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { GD_GIANT_FONT_TEMPLATES, matchGdGiantGlyph, recognizeGdGiantText } from '../src/gd-font-ocr.mjs';
import { recognizeOpenCdCaptcha, isReliableOpenCdCaptchaRecognition } from '../src/captcha-ocr.mjs';

// Generated from the public font, never from a user's verification images.
function render(text, { replacement, color = false } = {}) {
  const width = 150, height = 40, channels = color ? 3 : 1;
  const data = Buffer.alloc(width * height * channels, 255);
  let left = 12;
  for (let i = 0; i < text.length; i++) {
    const rows = replacement?.index === i ? replacement.rows : GD_GIANT_FONT_TEMPLATES[text[i]];
    rows.forEach((row, y) => [...row].forEach((ink, x) => {
      if (ink !== '1') return;
      const offset = ((12 + y) * width + left + x) * channels;
      if (color) data.set([35, 45, 55], offset);
      else data[offset] = 0;
    }));
    left += rows[0].length + 7;
  }
  return { data, width, height, channels };
}

test('GD Giant recognizes public glyphs while rejecting the near-identical O/Q pair', () => {
  assert.equal(Object.keys(GD_GIANT_FONT_TEMPLATES).length, 36);
  for (const [code, rows] of Object.entries(GD_GIANT_FONT_TEMPLATES)) {
    const result = matchGdGiantGlyph(rows);
    if (['O', 'Q'].includes(code)) {
      assert.equal(result.code, '');
      assert.ok(result.margin < 0.06);
      continue;
    }
    assert.equal(result.code, code);
    assert.equal(result.confidence, 100);
    assert.ok(result.margin >= 0.06);
  }
});

test('GD Giant tolerates one missing or attached pixel without guessing another letter', () => {
  for (const [row, column, value] of [[4, 0, '0'], [2, 4, '1']]) {
    const rows = [...GD_GIANT_FONT_TEMPLATES.B];
    rows[row] = rows[row].slice(0, column) + value + rows[row].slice(column + 1);
    const result = matchGdGiantGlyph(rows);
    assert.equal(result.code, 'B');
    assert.ok(result.confidence >= 95);
  }
});

test('GD Giant rejects unknown, ambiguous and malformed glyphs', () => {
  const ambiguous = GD_GIANT_FONT_TEMPLATES.O.map((row, i) => [...row].map((bit, x) => (
    bit === '1' || GD_GIANT_FONT_TEMPLATES['0'][i][x] === '1' ? '1' : '0'
  )).join(''));
  for (const rows of [ambiguous, Array(10).fill('10101010'), Array(10).fill('00000000'),
    [], null, Array(10), Array(10).fill(111111), Array(10).fill(null),
    ['111', ...Array(9).fill('1111')], Array(15).fill('11111111')]) {
    assert.equal(matchGdGiantGlyph(rows).code, '');
  }
});

for (const text of ['012345', '6789AB', 'CDEFGH', 'IJKLMN', 'PRSSTT', 'UVWXYZ']) {
  test(`six-character public font layout is recognized: ${text}`, () => {
    const image = render(text), result = recognizeGdGiantText(image.data, image.width, image.height);
    assert.equal(result.code, text);
    assert.equal(result.fontDetected, true);
    assert.equal(result.confidence, 100);
  });
}

test('GD text rejects invalid dimensions, non-byte data and wrong character counts', () => {
  const image = render('ABC123');
  for (const [data, width, height] of [[image.data, 0, 40], [image.data, 150.5, 40],
    [image.data, 150, 39], [Array.from(image.data), 150, 40],
    [new Uint8Array(1000001), 1000001, 1]]) {
    assert.equal(recognizeGdGiantText(data, width, height).code, null);
  }
  for (const text of ['ABCDE', 'ABCDEFG']) {
    const generated = render(text);
    assert.equal(recognizeGdGiantText(generated.data, generated.width, generated.height).code, null);
  }
});

test('recognizable font with a damaged glyph stays rejected by the full OCR pipeline', async () => {
  const image = render('ABC123', { color: true, replacement: { index: 2, rows: Array(10).fill('11111111') } });
  const input = await sharp(image.data, { raw: image }).png().toBuffer();
  const result = await recognizeOpenCdCaptcha(input);
  assert.equal(result.method, 'gd_giant_template');
  assert.equal(result.fontDetected, true);
  assert.equal(result.code, null);
  assert.equal(isReliableOpenCdCaptchaRecognition(result.code, result.confidence), false);
});

test('full OpenCD OCR preprocesses colored natural pixels and removes isolated noise', async () => {
  const image = render('ABC123', { color: true });
  image.data.set([0, 0, 0], (6 * image.width + 6) * 3);
  const input = await sharp(image.data, { raw: image }).png().toBuffer();
  const result = await recognizeOpenCdCaptcha(input);
  assert.equal(result.code, 'ABC123');
  assert.equal(result.method, 'gd_giant_template');
  assert.equal(result.confidence, 100);
  assert.equal(isReliableOpenCdCaptchaRecognition(result.code, result.confidence), true);
});
