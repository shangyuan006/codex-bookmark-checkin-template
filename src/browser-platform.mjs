import fs from "node:fs/promises";
import path from "node:path";

const BROWSER_METADATA = [
  {
    id: "chrome",
    displayName: "Google Chrome",
    executableEnvironmentVariable: "CHROME_EXECUTABLE",
    executableSegments: ["Google", "Chrome", "Application", "chrome.exe"],
    userDataSegments: ["Google", "Chrome", "User Data"],
  },
  {
    id: "edge",
    displayName: "Microsoft Edge",
    executableEnvironmentVariable: "EDGE_EXECUTABLE",
    executableSegments: ["Microsoft", "Edge", "Application", "msedge.exe"],
    userDataSegments: ["Microsoft", "Edge", "User Data"],
  },
];

function unique(values) {
  return [...new Set(values.filter(Boolean).map((value) => path.resolve(value)))];
}

export function normalizeBrowserChoice(value = "auto") {
  const normalized = String(value || "auto").trim().toLowerCase();
  if (normalized === "auto") return "auto";
  if (["chrome", "google chrome"].includes(normalized)) return "chrome";
  if (["edge", "microsoft edge", "msedge"].includes(normalized)) return "edge";
  throw new Error(`Unsupported browser: ${value}. Expected Auto, Chrome, or Edge.`);
}

export function getBrowserDefinitions(environment = process.env) {
  const roots = unique([
    environment.PROGRAMFILES,
    environment["PROGRAMFILES(X86)"],
    environment.LOCALAPPDATA,
  ]);
  return BROWSER_METADATA.map((metadata) => ({
    ...metadata,
    processName: metadata.executableSegments.at(-1),
    executableCandidates: unique([
      environment[metadata.executableEnvironmentVariable],
      ...roots.map((root) => path.join(root, ...metadata.executableSegments)),
    ]),
    userDataDir: environment.LOCALAPPDATA
      ? path.resolve(environment.LOCALAPPDATA, ...metadata.userDataSegments)
      : null,
  }));
}

export async function discoverInstalledBrowsers({
  choice = "auto",
  environment = process.env,
  access = fs.access,
} = {}) {
  const normalizedChoice = normalizeBrowserChoice(choice);
  const definitions = getBrowserDefinitions(environment)
    .filter((definition) => normalizedChoice === "auto" || definition.id === normalizedChoice);
  const installed = [];
  for (const definition of definitions) {
    let executable = null;
    for (const candidate of definition.executableCandidates) {
      if (await access(candidate).then(() => true).catch(() => false)) {
        executable = candidate;
        break;
      }
    }
    if (executable) {
      installed.push({
        ...definition,
        executable,
        processName: path.basename(executable),
      });
    }
  }
  return installed;
}
