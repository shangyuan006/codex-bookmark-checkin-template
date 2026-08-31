import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readBookmarkPlan } from "./bookmarks.mjs";
import { getConfiguredPreCheckinNavigationRule } from "./pre-checkin-navigation.mjs";

function isWithin(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function removeOwnedDirectory(rootDirectory, outputDirectory) {
  const tmpDirectory = path.join(rootDirectory, "tmp");
  if (!isWithin(tmpDirectory, outputDirectory)) {
    throw new Error("manual pre-check-in extension path escaped tmp");
  }
  const stat = await fs.lstat(outputDirectory).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("refusing unsafe manual pre-check-in extension path");
  }
  await fs.rm(outputDirectory, { recursive: true, force: true });
}

function normalizeHandoffItems(document) {
  if (!document || !Array.isArray(document.targets)) {
    throw new Error("manual pre-check-in input is invalid");
  }
  return document.targets.map((item) => {
    const origin = new URL(String(item?.origin ?? "")).origin;
    const url = new URL(String(item?.url ?? ""));
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
      throw new Error("manual pre-check-in target is invalid");
    }
    return { origin, url: url.href };
  });
}

export function manualPrecheckinContentScript(rules) {
  const rule = rules[location.origin];
  if (!rule || location.pathname === rule.expectedPath) return;

  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden"
      && rect.width > 0 && rect.height > 0;
  };
  const roleCandidates = (role) => {
    if (role === "button") {
      return [...document.querySelectorAll('button, input[type="button"], input[type="submit"], input[type="reset"], [role="button"]')];
    }
    if (role === "link") return [...document.querySelectorAll('a[href], [role="link"]')];
    return [...document.querySelectorAll('[role="menuitem"]')];
  };
  const accessibleName = (element) => normalize(
    element.getAttribute("aria-label") || element.innerText || element.value || element.textContent,
  );
  const locate = (step) => {
    const candidates = step.selector
      ? [...document.querySelectorAll(step.selector)]
      : roleCandidates(step.role).filter((element) => accessibleName(element) === step.name);
    if (candidates.length > 20) throw new Error("candidate set too large");
    const matches = candidates.filter((element) => visible(element)
      && !element.disabled && element.getAttribute("aria-disabled") !== "true");
    if (matches.length > 1) throw new Error("candidate is not unique");
    return matches[0] ?? null;
  };
  const waitForCandidate = async (step) => {
    const deadline = Date.now() + rule.waitMs;
    do {
      const candidate = locate(step);
      if (candidate) return candidate;
      if (Date.now() >= deadline) break;
      await delay(100);
    } while (true);
    throw new Error("candidate was not found");
  };

  void (async () => {
    const initialOrigin = location.origin;
    for (const step of rule.steps) {
      const candidate = await waitForCandidate(step);
      candidate.click();
      await delay(rule.afterClickWaitMs);
      if (location.origin !== initialOrigin) throw new Error("navigation left the allowed origin");
    }
    const deadline = Date.now() + rule.waitMs;
    while (location.pathname !== rule.expectedPath) {
      if (location.origin !== initialOrigin || Date.now() >= deadline) {
        throw new Error("expected path was not reached");
      }
      await delay(100);
    }
  })().catch(() => {});
}

function extensionSource(rules) {
  return `const RULES = ${JSON.stringify(rules)};\n(${manualPrecheckinContentScript.toString()})(RULES);\n`;
}

export async function buildManualPrecheckinExtension({
  rootDirectory,
  inputPath,
  outputDirectory = path.join(rootDirectory, "tmp", "manual-precheckin-extension"),
}) {
  const tmpDirectory = path.join(rootDirectory, "tmp");
  if (!isWithin(tmpDirectory, inputPath) || !isWithin(tmpDirectory, outputDirectory)) {
    throw new Error("manual pre-check-in files must stay inside tmp");
  }
  const inputStat = await fs.lstat(inputPath);
  if (inputStat.isSymbolicLink() || !inputStat.isFile()) {
    throw new Error("refusing unsafe manual pre-check-in input");
  }
  const [config, input] = await Promise.all([
    fs.readFile(path.join(rootDirectory, "config", "config.json"), "utf8").then(JSON.parse),
    fs.readFile(inputPath, "utf8").then(JSON.parse),
  ]);
  const plan = await readBookmarkPlan(config.bookmarksPath, config);
  const targetByOrigin = new Map(plan.targets.map((target) => [target.origin, target]));
  const rules = {};
  for (const item of normalizeHandoffItems(input)) {
    const target = targetByOrigin.get(item.origin);
    if (!target) throw new Error("manual pre-check-in target is not in the bookmark plan");
    if (!target.candidates.some((candidate) => new URL(candidate).href === item.url)) {
      throw new Error("manual pre-check-in URL is not a current bookmark candidate");
    }
    const activeOrigin = new URL(item.url).origin;
    const rule = getConfiguredPreCheckinNavigationRule(target, activeOrigin, config);
    if (rule) rules[activeOrigin] = rule;
  }

  await removeOwnedDirectory(rootDirectory, outputDirectory);
  const origins = Object.keys(rules).sort();
  if (origins.length === 0) return { enabled: false, ruleCount: 0 };

  await fs.mkdir(outputDirectory, { recursive: true });
  const manifest = {
    manifest_version: 3,
    name: "Check-in manual pre-navigation",
    version: "1.0.0",
    content_scripts: [{
      matches: origins.map((origin) => `${origin}/*`),
      js: ["navigate.js"],
      run_at: "document_idle",
    }],
  };
  try {
    await Promise.all([
      fs.writeFile(path.join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      }),
      fs.writeFile(path.join(outputDirectory, "navigate.js"), extensionSource(rules), {
        encoding: "utf8",
        mode: 0o600,
      }),
    ]);
  } catch (error) {
    await removeOwnedDirectory(rootDirectory, outputDirectory).catch(() => {});
    throw error;
  }
  return { enabled: true, ruleCount: origins.length };
}

const sourcePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === sourcePath) {
  const rootDirectory = path.dirname(path.dirname(sourcePath));
  const inputPath = path.resolve(String(process.argv[2] ?? ""));
  process.stdout.write(JSON.stringify(await buildManualPrecheckinExtension({ rootDirectory, inputPath })));
}
