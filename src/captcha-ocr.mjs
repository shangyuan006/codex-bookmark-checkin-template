import fs from "node:fs/promises";
import sharp from "sharp";
import { createWorker, PSM } from "tesseract.js";
import { matchPixelFontGlyph } from "./pixel-font-ocr.mjs";

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

export function chooseAlphanumericCaptchaRecognition(results, minLength = 4, maxLength = 8) {
  const candidates = (results ?? []).map((result) => ({
    code: String(result?.text || "").toUpperCase().replace(/[^A-Z0-9]/g, ""),
    confidence: Number(result?.confidence) || 0,
  })).filter((result) => result.code.length >= minLength && result.code.length <= maxLength);
  const grouped = new Map();
  for (const candidate of candidates) {
    const group = grouped.get(candidate.code) ?? { code: candidate.code, count: 0, confidence: 0 };
    group.count += 1;
    group.confidence = Math.max(group.confidence, candidate.confidence);
    grouped.set(candidate.code, group);
  }
  const score = (candidate) => candidate.confidence + Math.min(30, Math.max(0, candidate.count - 1) * 10);
  const selected = [...grouped.values()].sort((left, right) => (
    score(right) - score(left) || right.confidence - left.confidence || right.count - left.count
  ))[0];
  return selected ? { code: selected.code, confidence: selected.confidence } : { code: "", confidence: 0 };
}

function collectDarkComponents(data, width, height, threshold) {
  const foreground = new Uint8Array(width * height);
  for (let index = 0; index < foreground.length; index += 1) {
    foreground[index] = data[index] < threshold ? 1 : 0;
  }
  const visited = new Uint8Array(foreground.length);
  const queue = new Int32Array(foreground.length);
  const components = [];
  for (let start = 0; start < foreground.length; start += 1) {
    if (!foreground[start] || visited[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    let size = 0;
    const points = [];
    while (head < tail) {
      const point = queue[head++];
      points.push(point);
      size += 1;
      const x = point % width;
      const y = Math.floor(point / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      for (let deltaY = -1; deltaY <= 1; deltaY += 1) {
        for (let deltaX = -1; deltaX <= 1; deltaX += 1) {
          if (deltaX === 0 && deltaY === 0) continue;
          const neighborX = x + deltaX;
          const neighborY = y + deltaY;
          if (neighborX < 0 || neighborX >= width || neighborY < 0 || neighborY >= height) continue;
          const neighbor = neighborY * width + neighborX;
          if (!foreground[neighbor] || visited[neighbor]) continue;
          visited[neighbor] = 1;
          queue[tail++] = neighbor;
        }
      }
    }
    const componentWidth = maxX - minX + 1;
    const componentHeight = maxY - minY + 1;
    const rowInk = Array(componentHeight).fill(0);
    const columnInk = Array(componentWidth).fill(0);
    for (const point of points) {
      const x = point % width;
      const y = Math.floor(point / width);
      rowInk[y - minY] += 1;
      columnInk[x - minX] += 1;
    }
    components.push({
      minX, minY, maxX, maxY,
      width: componentWidth,
      height: componentHeight,
      size,
      rowInk,
      columnInk,
    });
  }
  return components;
}

function mergeCaptchaComponents(left, right) {
  const minX = Math.min(left.minX, right.minX);
  const minY = Math.min(left.minY, right.minY);
  const maxX = Math.max(left.maxX, right.maxX);
  const maxY = Math.max(left.maxY, right.maxY);
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const rowInk = Array(height).fill(0);
  const columnInk = Array(width).fill(0);
  for (const component of [left, right]) {
    for (let index = 0; index < component.rowInk.length; index += 1) {
      rowInk[component.minY - minY + index] += component.rowInk[index];
    }
    for (let index = 0; index < component.columnInk.length; index += 1) {
      columnInk[component.minX - minX + index] += component.columnInk[index];
    }
  }
  return {
    minX, minY, maxX, maxY, width, height,
    size: left.size + right.size,
    rowInk,
    columnInk,
  };
}

export function mergeFragmentedGlyphs(components, imageWidth, imageHeight) {
  const merged = (components ?? []).map((component) => ({
    ...component,
    rowInk: [...component.rowInk],
    columnInk: [...component.columnInk],
  }));
  const maximumGap = Math.max(2, Math.round(imageHeight * 0.07));
  const maximumWidth = imageWidth * 0.2;
  const maximumHeight = imageHeight * 0.8;
  while (true) {
    let best = null;
    for (let leftIndex = 0; leftIndex < merged.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < merged.length; rightIndex += 1) {
        const left = merged[leftIndex];
        const right = merged[rightIndex];
        const verticalGap = left.maxY < right.minY
          ? right.minY - left.maxY - 1
          : right.maxY < left.minY
            ? left.minY - right.maxY - 1
            : 0;
        const horizontalGap = left.maxX < right.minX
          ? right.minX - left.maxX - 1
          : right.maxX < left.minX
            ? left.minX - right.maxX - 1
            : 0;
        const horizontalOverlap = Math.max(0, Math.min(left.maxX, right.maxX) - Math.max(left.minX, right.minX) + 1);
        const overlapRatio = horizontalOverlap / Math.max(1, Math.min(left.width, right.width));
        const verticalOverlap = Math.max(0, Math.min(left.maxY, right.maxY) - Math.max(left.minY, right.minY) + 1);
        const verticalOverlapRatio = verticalOverlap / Math.max(1, Math.min(left.height, right.height));
        const verticallyStacked = verticalGap <= maximumGap && overlapRatio >= 0.7;
        const adjacentFragments = horizontalGap <= 2 && verticalGap <= 2 && overlapRatio >= 0.5;
        const combinedWidth = Math.max(left.maxX, right.maxX) - Math.min(left.minX, right.minX) + 1;
        const combinedHeight = Math.max(left.maxY, right.maxY) - Math.min(left.minY, right.minY) + 1;
        const sideBySideFragments = horizontalGap === 0
          && verticalOverlapRatio >= 0.85
          && combinedWidth <= Math.max(12, imageWidth * 0.1);
        if (!verticallyStacked && !adjacentFragments && !sideBySideFragments) continue;
        if (combinedWidth > maximumWidth || combinedHeight > maximumHeight) continue;
        const distance = horizontalGap + verticalGap;
        const affinity = Math.max(overlapRatio, sideBySideFragments ? verticalOverlapRatio : 0);
        if (!best || distance < best.distance
          || (distance === best.distance && affinity > best.affinity)) {
          best = { leftIndex, rightIndex, distance, affinity };
        }
      }
    }
    if (!best) break;
    const combined = mergeCaptchaComponents(merged[best.leftIndex], merged[best.rightIndex]);
    merged.splice(best.rightIndex, 1);
    merged.splice(best.leftIndex, 1, combined);
  }
  return merged.sort((left, right) => left.minX - right.minX || left.minY - right.minY);
}

function findSegmentedCaptchaLayout(data, width, height, minLength, maxLength) {
  const minimumSize = Math.max(5, Math.round(width * height * 0.001));
  const minimumWidth = Math.max(2, Math.round(width * 0.025));
  const minimumHeight = Math.max(3, Math.round(height * 0.2));
  const layouts = [];
  for (const threshold of [100, 110, 120, 130, 140, 150, 160, 170]) {
    const fragments = collectDarkComponents(data, width, height, threshold)
      .filter((component) => component.size >= Math.max(4, Math.floor(minimumSize / 2))
        && component.width >= 1
        && component.height >= 2
        && component.width <= width * 0.2
        && component.height <= height * 0.8);
    const glyphs = mergeFragmentedGlyphs(fragments, width, height)
      .filter((component) => component.size >= minimumSize
        && component.width >= minimumWidth
        && component.height >= minimumHeight)
      .sort((left, right) => left.minX - right.minX);
    if (glyphs.length >= minLength && glyphs.length <= maxLength) layouts.push({ threshold, glyphs });
  }
  if (layouts.length === 0) return null;
  const frequency = new Map();
  for (const layout of layouts) frequency.set(layout.glyphs.length, (frequency.get(layout.glyphs.length) ?? 0) + 1);
  const preferredLength = [...frequency.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0])[0][0];
  return layouts.find((layout) => layout.glyphs.length === preferredLength) ?? null;
}

function renderPixelFontGrid(data, imageWidth, glyph, threshold) {
  return Array.from({ length: Math.ceil(glyph.height / 2) }, (_, gridY) => (
    Array.from({ length: Math.ceil(glyph.width / 2) }, (_, gridX) => {
      let ink = 0;
      let pixels = 0;
      for (let deltaY = 0; deltaY < 2; deltaY += 1) {
        for (let deltaX = 0; deltaX < 2; deltaX += 1) {
          const x = glyph.minX + gridX * 2 + deltaX;
          const y = glyph.minY + gridY * 2 + deltaY;
          if (x > glyph.maxX || y > glyph.maxY) continue;
          pixels += 1;
          if (data[y * imageWidth + x] < threshold) ink += 1;
        }
      }
      return ink >= Math.max(1, Math.ceil(pixels / 2)) ? "1" : "0";
    }).join("")
  ));
}

function separatedVerticalStemGroups(glyph, minimumCoverage = 0.55) {
  const groups = [];
  for (let index = 0; index < glyph.columnInk.length; index += 1) {
    if (glyph.columnInk[index] / glyph.height < minimumCoverage) continue;
    const previous = groups.at(-1);
    if (previous && previous.end === index - 1) previous.end = index;
    else groups.push({ start: index, end: index });
  }
  return groups;
}

export function selectSegmentedGlyphRecognition(results, glyph, { templateHints = [] } = {}) {
  const candidates = (results ?? []).map((result) => ({
    code: String(result?.text || "").toUpperCase().replace(/[^A-Z0-9]/g, ""),
    confidence: Number(result?.confidence) || 0,
    source: String(result?.source || ""),
  })).filter((result) => result.code.length === 1);
  const trustedTemplateCandidates = candidates.filter((candidate) => (
    candidate.source === "template" && candidate.confidence >= 90
  ));
  const trustedTemplateCodes = new Set(trustedTemplateCandidates.map((candidate) => candidate.code));
  if (trustedTemplateCodes.size === 1) {
    const selectedTemplate = trustedTemplateCandidates
      .sort((left, right) => right.confidence - left.confidence)[0];
    return { code: selectedTemplate.code, confidence: selectedTemplate.confidence, shapeConfirmed: false };
  }
  const templateHintCodes = new Set(templateHints);
  const templateHintCounts = new Map();
  for (const code of templateHints) {
    templateHintCounts.set(code, (templateHintCounts.get(code) ?? 0) + 1);
  }
  const candidateCodes = new Set([
    ...candidates.map((candidate) => candidate.code),
    ...templateHintCodes,
  ]);
  const stemGroups = separatedVerticalStemGroups(glyph);
  const topCoverage = Math.max(...glyph.rowInk.slice(0, 2), 0) / glyph.width;
  const bottomCoverage = Math.max(...glyph.rowInk.slice(-2), 0) / glyph.width;
  const middleStart = Math.floor(glyph.rowInk.length * 0.3);
  const middleEnd = Math.max(middleStart + 1, Math.ceil(glyph.rowInk.length * 0.65));
  const middleCoverage = Math.max(...glyph.rowInk.slice(middleStart, middleEnd), 0) / glyph.width;
  const leftStemCoverage = Math.max(...glyph.columnInk.slice(0, 2), 0) / glyph.height;
  const hasSeparatedStems = stemGroups.length >= 2
    && stemGroups.at(-1).start - stemGroups[0].end >= glyph.width * 0.4;
  const firstStemGroup = stemGroups[0];
  const lastStemGroup = stemGroups.at(-1);
  const groupedLeftStemCoverage = firstStemGroup && firstStemGroup.start <= glyph.width * 0.35
    ? Math.max(...glyph.columnInk.slice(firstStemGroup.start, firstStemGroup.end + 1), 0) / glyph.height
    : 0;
  const groupedRightStemCoverage = lastStemGroup && lastStemGroup.end >= glyph.width * 0.65
    ? Math.max(...glyph.columnInk.slice(lastStemGroup.start, lastStemGroup.end + 1), 0) / glyph.height
    : 0;
  const strongBlockBShape = hasSeparatedStems
    && groupedLeftStemCoverage >= 0.85
    && groupedRightStemCoverage >= 0.5 && groupedRightStemCoverage <= 0.72
    && topCoverage >= 0.65 && middleCoverage >= 0.6 && bottomCoverage >= 0.65;
  if (strongBlockBShape) {
    return { code: "B", confidence: 60, shapeConfirmed: true };
  }
  const strongBlockDShape = hasSeparatedStems
    && groupedLeftStemCoverage >= 0.75
    && groupedRightStemCoverage >= 0.6 && groupedRightStemCoverage <= 0.85
    && topCoverage >= 0.75 && middleCoverage < 0.5 && bottomCoverage >= 0.75;
  if (strongBlockDShape) {
    return { code: "D", confidence: 60, shapeConfirmed: true };
  }
  const symmetricEightShape = hasSeparatedStems
    && groupedLeftStemCoverage >= 0.55 && groupedLeftStemCoverage <= 0.75
    && groupedRightStemCoverage >= 0.55 && groupedRightStemCoverage <= 0.75
    && Math.abs(groupedLeftStemCoverage - groupedRightStemCoverage) <= 0.15
    && topCoverage >= 0.55 && middleCoverage >= 0.55 && bottomCoverage >= 0.55;
  if (symmetricEightShape) {
    return { code: "8", confidence: 60, shapeConfirmed: true };
  }
  const leftLoopCoverage = Math.max(
    ...glyph.columnInk.slice(0, Math.max(1, Math.ceil(glyph.width * 0.35))),
    0,
  ) / glyph.height;
  const rightLoopCoverage = Math.max(
    ...glyph.columnInk.slice(Math.floor(glyph.width * 0.65)),
    0,
  ) / glyph.height;
  const damagedEightShape = templateHintCodes.has("8")
    && topCoverage >= 0.55 && middleCoverage >= 0.55 && bottomCoverage >= 0.55
    && leftLoopCoverage >= 0.35 && rightLoopCoverage >= 0.35
    && Math.abs(leftLoopCoverage - rightLoopCoverage) <= 0.18;
  if (damagedEightShape) {
    return { code: "8", confidence: 60, shapeConfirmed: true };
  }
  const stableClosedLoopHint = ["O", "Q"].find((code) => (
    (templateHintCounts.get(code) ?? 0) >= 2
    && hasSeparatedStems
    && topCoverage >= 0.55 && bottomCoverage >= 0.55
    && middleCoverage <= 0.55
  ));
  if (stableClosedLoopHint) {
    return { code: stableClosedLoopHint, confidence: 60, shapeConfirmed: true };
  }
  if (candidates.length === 0) return { code: "", confidence: 0, shapeConfirmed: false };
  if (candidateCodes.has("B") && hasSeparatedStems
    && topCoverage >= 0.6 && middleCoverage >= 0.5 && bottomCoverage >= 0.6) {
    return { code: "B", confidence: 60, shapeConfirmed: true };
  }
  if (candidateCodes.has("B") && leftStemCoverage >= 0.8
    && topCoverage >= 0.7 && middleCoverage >= 0.7 && bottomCoverage < 0.6) {
    return { code: "R", confidence: 60, shapeConfirmed: true };
  }

  const strongestColumn = glyph.columnInk.reduce((best, value, index) => (
    value > best.value ? { value, index } : best
  ), { value: -1, index: -1 });
  const strongestRow = glyph.rowInk.reduce((best, value, index) => (
    value > best.value ? { value, index } : best
  ), { value: -1, index: -1 });
  const strongestRowPosition = strongestRow.index / Math.max(1, glyph.height - 1);
  const rightEdgeStemCoverage = Math.max(...glyph.columnInk.slice(-2), 0) / glyph.height;
  const leftEdgeStemCoverage = Math.max(...glyph.columnInk.slice(0, 2), 0) / glyph.height;
  const damagedHShape = candidateCodes.has("H")
    && strongestRowPosition >= 0.4 && strongestRowPosition <= 0.55
    && strongestRow.value / glyph.width >= 0.9
    && rightEdgeStemCoverage >= 0.8 && leftEdgeStemCoverage <= 0.2
    && topCoverage >= 0.15 && topCoverage <= 0.35
    && bottomCoverage >= 0.15 && bottomCoverage <= 0.35;
  if (damagedHShape) {
    return { code: "H", confidence: 60, shapeConfirmed: true };
  }
  const centralRightStem = strongestColumn.index / Math.max(1, glyph.width - 1) >= 0.55
    && strongestColumn.value / glyph.height >= 0.85;
  const middleCrossbar = strongestRowPosition >= 0.55
    && strongestRowPosition <= 0.8
    && strongestRow.value / glyph.width >= 0.8;
  if (candidateCodes.has("4") && centralRightStem && middleCrossbar && topCoverage < 0.6 && bottomCoverage < 0.6) {
    return { code: "4", confidence: 60, shapeConfirmed: true };
  }
  const strongestColumnPosition = strongestColumn.index / Math.max(1, glyph.width - 1);
  const edgeCoverage = Math.max(
    ...glyph.columnInk.slice(0, 2),
    ...glyph.columnInk.slice(-2),
    0,
  ) / glyph.height;
  const forkCenterRows = glyph.rowInk.slice(
    Math.floor(glyph.rowInk.length * 0.4),
    Math.max(1, Math.ceil(glyph.rowInk.length * 0.6)),
  );
  const yForkShape = strongestColumnPosition >= 0.35 && strongestColumnPosition <= 0.65
    && strongestColumn.value / glyph.height >= 0.45
    && strongestColumn.value / glyph.height <= 0.7
    && edgeCoverage <= 0.35
    && topCoverage >= 0.35 && topCoverage <= 0.65
    && bottomCoverage >= 0.15 && bottomCoverage <= 0.4
    && Math.min(...forkCenterRows, glyph.width) / glyph.width <= 0.1;
  if (candidateCodes.has("Y") && yForkShape) {
    return { code: "Y", confidence: 60, shapeConfirmed: true };
  }

  const strongestRowCoverage = Math.max(...glyph.rowInk, 0) / glyph.width;
  const strongestColumnCoverage = Math.max(...glyph.columnInk, 0) / glyph.height;
  const rightSideCoverage = Math.max(...glyph.columnInk.slice(Math.floor(glyph.width * 0.35)), 0) / glyph.height;
  const roundedThreeStrokeShape = topCoverage >= 0.55
    && middleCoverage >= 0.5
    && bottomCoverage >= 0.55
    && strongestRowCoverage <= 0.8
    && strongestColumnCoverage <= 0.55;
  if (candidateCodes.has("5") && roundedThreeStrokeShape) {
    return { code: "S", confidence: 60, shapeConfirmed: true };
  }
  if (candidateCodes.has("K") && leftStemCoverage >= 0.75
    && strongestRowCoverage <= 0.5 && rightSideCoverage >= 0.15 && rightSideCoverage < 0.55) {
    return { code: "K", confidence: 60, shapeConfirmed: true };
  }

  const centralRows = glyph.rowInk.slice(
    Math.floor(glyph.rowInk.length * 0.35),
    Math.max(1, Math.ceil(glyph.rowInk.length * 0.65)),
  );
  const hasCentralBreak = centralRows.some((value, index) => (
    value / glyph.width <= 0.08 && (centralRows[index + 1] ?? glyph.width) / glyph.width <= 0.08
  ));
  if (candidateCodes.has("2") && topCoverage >= 0.5 && bottomCoverage >= 0.8 && hasCentralBreak) {
    return { code: "2", confidence: 60, shapeConfirmed: true };
  }

  const grouped = new Map();
  for (const candidate of candidates) {
    const group = grouped.get(candidate.code) ?? { code: candidate.code, count: 0, confidence: 0 };
    group.count += 1;
    group.confidence = Math.max(group.confidence, candidate.confidence);
    grouped.set(candidate.code, group);
  }
  const score = (candidate) => candidate.confidence + Math.min(24, Math.max(0, candidate.count - 1) * 6);
  const selected = [...grouped.values()].sort((left, right) => (
    score(right) - score(left) || right.confidence - left.confidence || right.count - left.count
  ))[0];
  return { code: selected.code, confidence: selected.confidence, shapeConfirmed: false };
}

export function isReliableSegmentedCaptchaRecognition(result, minLength, maxLength) {
  const code = String(result?.code || "");
  return code.length >= minLength
    && code.length <= maxLength
    && Number(result?.confidence) >= 60;
}

async function recognizeSegmentedCaptcha(input, worker, minLength, maxLength) {
  const { data, info } = await sharp(input).grayscale().raw().toBuffer({ resolveWithObject: true });
  const layout = findSegmentedCaptchaLayout(data, info.width, info.height, minLength, maxLength);
  if (!layout) return { code: "", confidence: 0, shapeConfirmedCount: 0 };
  const largePadding = Math.max(1, Math.round(info.height * 0.07));
  const smallPadding = Math.max(1, Math.round(info.height * 0.035));
  const renderOptions = [
    { mode: "binary-before", threshold: layout.threshold, padding: largePadding, scale: 6 },
    { mode: "binary-before", threshold: Math.min(240, layout.threshold + 40), padding: largePadding, scale: 6 },
    { mode: "binary-before", threshold: layout.threshold, padding: smallPadding, scale: 4 },
    { mode: "color-lanczos", padding: largePadding, scale: 6 },
    { mode: "gray-lanczos", padding: largePadding, scale: 6 },
    { mode: "gray-lanczos", padding: largePadding, scale: 4 },
    { mode: "binary-after", threshold: 150, padding: largePadding, scale: 6 },
    { mode: "blur-binary-after", threshold: 150, padding: largePadding, scale: 6 },
  ];
  await worker.setParameters({
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    tessedit_pageseg_mode: PSM.SINGLE_CHAR,
    user_defined_dpi: "300",
  });
  const selected = [];
  for (const glyph of layout.glyphs) {
    const candidates = [];
    const templateHints = [];
    for (const threshold of [layout.threshold, Math.min(170, layout.threshold + 40)]) {
      const template = matchPixelFontGlyph(renderPixelFontGrid(data, info.width, glyph, threshold));
      if (template.code) candidates.push({ text: template.code, confidence: template.confidence, source: "template" });
      else if (template.score >= 0.95 && template.bestCode) templateHints.push(template.bestCode);
    }
    for (const option of renderOptions) {
      const left = Math.max(0, glyph.minX - option.padding);
      const top = Math.max(0, glyph.minY - option.padding);
      const right = Math.min(info.width - 1, glyph.maxX + option.padding);
      const bottom = Math.min(info.height - 1, glyph.maxY + option.padding);
      const cropWidth = right - left + 1;
      const cropHeight = bottom - top + 1;
      let pipeline = sharp(input).extract({ left, top, width: cropWidth, height: cropHeight });
      if (option.mode === "binary-before") {
        pipeline = pipeline.grayscale().normalize().threshold(option.threshold)
          .resize({ width: cropWidth * option.scale, height: cropHeight * option.scale, kernel: "nearest" });
      } else if (["color-lanczos", "gray-lanczos"].includes(option.mode)) {
        pipeline = option.mode === "color-lanczos" ? pipeline.removeAlpha() : pipeline.grayscale();
        pipeline = pipeline.normalize()
          .resize({ width: cropWidth * option.scale, height: cropHeight * option.scale, kernel: "lanczos3" });
      } else {
        pipeline = pipeline.grayscale()
          .resize({ width: cropWidth * option.scale, height: cropHeight * option.scale, kernel: "lanczos3" });
        if (option.mode === "blur-binary-after") pipeline = pipeline.blur(0.5);
        pipeline = pipeline.normalize().threshold(option.threshold);
      }
      const rendered = await pipeline
        .extend({ top: 30, bottom: 30, left: 30, right: 30, background: "white" })
        .png()
        .toBuffer();
      const recognized = await worker.recognize(rendered);
      candidates.push({ text: recognized.data.text, confidence: recognized.data.confidence, source: "tesseract" });
    }
    selected.push(selectSegmentedGlyphRecognition(candidates, glyph, { templateHints }));
  }
  if (selected.some((result) => !result.code)) return { code: "", confidence: 0, shapeConfirmedCount: 0 };
  return {
    code: selected.map((result) => result.code).join(""),
    confidence: Math.min(...selected.map((result) => result.confidence)),
    shapeConfirmedCount: selected.filter((result) => result.shapeConfirmed).length,
  };
}

export async function recognizeAlphanumericCaptcha(input, { minLength = 4, maxLength = 8 } = {}) {
  const worker = await createWorker("eng", 1, { logger: () => {} });
  try {
    const segmentedRecognition = await recognizeSegmentedCaptcha(input, worker, minLength, maxLength);
    if (isReliableSegmentedCaptchaRecognition(segmentedRecognition, minLength, maxLength)) {
      return segmentedRecognition;
    }

    const metadata = await sharp(input).metadata();
    const width = Math.max(1, metadata.width ?? 1) * 6;
    const height = Math.max(1, metadata.height ?? 1) * 6;
    const pipeline = () => sharp(input)
      .removeAlpha()
      .resize({ width, height, kernel: "lanczos3" })
      .grayscale()
      .normalize()
      .sharpen();
    const channel = (name, threshold) => sharp(input)
      .removeAlpha()
      .resize({ width, height, kernel: "lanczos3" })
      .extractChannel(name)
      .normalize()
      .sharpen()
      .threshold(threshold)
      .png()
      .toBuffer();
    const variants = await Promise.all([
      sharp(input).removeAlpha().resize({ width, height, kernel: "lanczos3" }).sharpen().png().toBuffer(),
      pipeline().png().toBuffer(),
      pipeline().threshold(100).png().toBuffer(),
      pipeline().threshold(150).png().toBuffer(),
      pipeline().threshold(200).png().toBuffer(),
      pipeline().negate().png().toBuffer(),
      channel("red", 120),
      channel("red", 180),
      channel("green", 120),
      channel("green", 180),
      channel("blue", 120),
      channel("blue", 180),
    ]);
    const results = [];
    for (const pageSegMode of [PSM.SINGLE_LINE, PSM.SINGLE_WORD, PSM.RAW_LINE]) {
      await worker.setParameters({
        tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
        tessedit_pageseg_mode: pageSegMode,
        user_defined_dpi: "300",
      });
      for (const variant of variants) {
        const recognized = await worker.recognize(variant);
        results.push({ text: recognized.data.text, confidence: recognized.data.confidence });
      }
    }
    const lineRecognition = chooseAlphanumericCaptchaRecognition(results, minLength, maxLength);
    return lineRecognition;
  } finally {
    await worker.terminate();
  }
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
