import fs from "node:fs/promises";
import sharp from "sharp";
import { createWorker, PSM } from "tesseract.js";

function removeNoise(data, width, height) {
  const binary = new Uint8Array(width * height);
  for (let index = 0; index < binary.length; index += 1) {
    const offset = index * 3;
    const red = data[offset];
    const green = data[offset + 1];
    const blue = data[offset + 2];
    binary[index] = Math.max(red, green, blue) < 125 ? 1 : 0;
  }

  const visited = new Uint8Array(binary.length);
  const output = Buffer.alloc(binary.length, 255);
  const keptComponents = [];
  const queue = new Int32Array(binary.length);
  for (let start = 0; start < binary.length; start += 1) {
    if (!binary[start] || visited[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    const component = [];
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    while (head < tail) {
      const point = queue[head++];
      component.push(point);
      const x = point % width;
      const y = Math.floor(point / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      const neighbors = [point - 1, point + 1, point - width, point + width];
      for (const neighbor of neighbors) {
        if (neighbor < 0 || neighbor >= binary.length || visited[neighbor] || !binary[neighbor]) continue;
        const neighborX = neighbor % width;
        if (Math.abs(neighborX - x) > 1) continue;
        visited[neighbor] = 1;
        queue[tail++] = neighbor;
      }
    }
    const componentWidth = maxX - minX + 1;
    const componentHeight = maxY - minY + 1;
    const touchesBorder = minX === 0 || minY === 0 || maxX === width - 1 || maxY === height - 1;
    if (!touchesBorder && component.length >= 5 && componentHeight >= 3 && componentWidth >= 1) {
      for (const point of component) output[point] = 0;
      const rowInk = Array(componentHeight).fill(0);
      const columnInk = Array(componentWidth).fill(0);
      for (const point of component) {
        const x = point % width;
        const y = Math.floor(point / width);
        rowInk[y - minY] += 1;
        columnInk[x - minX] += 1;
      }
      keptComponents.push({
        minX, minY, maxX, maxY,
        width: componentWidth,
        height: componentHeight,
        size: component.length,
        rowInk,
        columnInk,
      });
    }
  }
  return { output, keptComponents };
}

export function correctCaptchaConfusions(rawCode, glyphs) {
  if (!/^[A-Z0-9]{6}$/.test(rawCode) || glyphs.length !== 6) return rawCode;
  const characters = [...rawCode];
  for (let index = 0; index < glyphs.length; index += 1) {
    const glyph = glyphs[index];
    const leftStemCoverage = Math.max(...glyph.columnInk.slice(0, Math.min(2, glyph.columnInk.length))) / glyph.height;

    // HDSky uses a fixed block font. Tesseract regularly reads its wide B/R
    // as E, while a real E in this font is at most eight source pixels wide.
    if (characters[index] === "E" && glyph.width >= 10) characters[index] = "R";
    else if (characters[index] === "E" && glyph.width === 9) characters[index] = "B";

    // The same font's D has a continuous left stem; zero has rounded top and
    // bottom edges, so its left-side coverage is lower.
    if (characters[index] === "0" && leftStemCoverage >= 0.95) characters[index] = "D";
  }
  return characters.join("");
}

async function prepareOpenCdCaptcha(input) {
  const source = sharp(input).removeAlpha();
  const metadata = await source.metadata();
  const left = Math.min(2, Math.max(0, (metadata.width ?? 1) - 1));
  const top = Math.min(2, Math.max(0, (metadata.height ?? 1) - 1));
  const width = Math.max(1, (metadata.width ?? 1) - left * 2);
  const height = Math.max(1, (metadata.height ?? 1) - top * 2);
  const { data, info } = await source
    .extract({ left, top, width, height })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const cleaned = removeNoise(data, info.width, info.height);
  const processed = await sharp(cleaned.output, { raw: { width: info.width, height: info.height, channels: 1 } })
    .resize({ width: info.width * 6, height: info.height * 6, kernel: "nearest" })
    .png()
    .toBuffer();
  return { processed, components: cleaned.keptComponents, width: info.width, height: info.height, scale: 6 };
}

export async function preprocessOpenCdCaptcha(input) {
  return (await prepareOpenCdCaptcha(input)).processed;
}

export async function recognizeOpenCdCaptcha(input) {
  const prepared = await prepareOpenCdCaptcha(input);
  const { processed } = prepared;
  const worker = await createWorker("eng", 1, { logger: () => {} });
  try {
    await worker.setParameters({
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      tessedit_pageseg_mode: PSM.SINGLE_LINE,
    });
    const result = await worker.recognize(processed, {}, { text: true, box: true });
    const wholeCode = String(result.data.text || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const glyphs = prepared.components
      .filter((component) => component.height >= prepared.height * 0.22 && component.width >= 2)
      .sort((left, right) => left.minX - right.minX);
    if (wholeCode.length === 6) {
      return {
        code: correctCaptchaConfusions(wholeCode, glyphs),
        rawCode: wholeCode,
        glyphs: glyphs.map((glyph) => ({
          width: glyph.width,
          height: glyph.height,
          leftStemCoverage: Math.max(...glyph.columnInk.slice(0, Math.min(2, glyph.columnInk.length))) / glyph.height,
        })),
        confidence: result.data.confidence,
        processed,
      };
    }
    if (glyphs.length === 6) {
      const recognizedBoxes = String(result.data.box || "").split(/\r?\n/).map((line) => {
        const match = line.match(/^([A-Z0-9])\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+$/i);
        return match ? { character: match[1].toUpperCase(), left: Number(match[2]), right: Number(match[4]) } : null;
      }).filter(Boolean);
      const boxMapped = glyphs.map((glyph) => {
        const left = glyph.minX * prepared.scale;
        const right = (glyph.maxX + 1) * prepared.scale;
        return recognizedBoxes
          .map((item) => ({ item, overlap: Math.max(0, Math.min(right, item.right) - Math.max(left, item.left)) }))
          .sort((a, b) => b.overlap - a.overlap)[0];
      });
      if (boxMapped.every((mapping) => mapping?.overlap >= 3)) {
        const mappedCode = boxMapped.map((mapping) => mapping.item.character).join("");
        return {
          code: correctCaptchaConfusions(mappedCode, glyphs),
          confidence: result.data.confidence,
          processed,
        };
      }
      await worker.setParameters({
        tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
        tessedit_pageseg_mode: PSM.SINGLE_CHAR,
      });
      const characters = [];
      const confidences = [];
      for (const glyph of glyphs) {
        const padding = 2;
        const left = Math.max(0, glyph.minX - padding);
        const top = Math.max(0, glyph.minY - padding);
        const right = Math.min(prepared.width - 1, glyph.maxX + padding);
        const bottom = Math.min(prepared.height - 1, glyph.maxY + padding);
        const characterImage = await sharp(processed).extract({
          left: left * prepared.scale,
          top: top * prepared.scale,
          width: (right - left + 1) * prepared.scale,
          height: (bottom - top + 1) * prepared.scale,
        }).extend({ top: 24, bottom: 24, left: 24, right: 24, background: "white" }).png().toBuffer();
        const characterResult = await worker.recognize(characterImage);
        const character = String(characterResult.data.text || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
        if (character.length !== 1) return { code: wholeCode, confidence: result.data.confidence, processed };
        characters.push(character);
        confidences.push(characterResult.data.confidence);
      }
      const characterCode = characters.join("");
      return {
        code: correctCaptchaConfusions(characterCode, glyphs),
        confidence: confidences.reduce((sum, value) => sum + value, 0) / confidences.length,
        processed,
      };
    }
    return { code: wholeCode, confidence: result.data.confidence, processed };
  } finally {
    await worker.terminate();
  }
}

if (process.argv[1] && new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (value) => value.slice(1)) === process.argv[1].replace(/\\/g, "/")) {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error("用法: node src/captcha-ocr.mjs <image>");
  const result = await recognizeOpenCdCaptcha(await fs.readFile(inputPath));
  console.log(JSON.stringify({ code: result.code, rawCode: result.rawCode, confidence: result.confidence, glyphs: result.glyphs }));
}
