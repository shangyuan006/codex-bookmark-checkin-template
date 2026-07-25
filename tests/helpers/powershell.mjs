import fs from "node:fs";
import path from "node:path";

function findOnPath(executableName) {
  const pathValue = process.env.Path ?? process.env.PATH ?? "";
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, executableName);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function resolvePowerShell() {
  if (process.env.POWERSHELL_EXECUTABLE) return process.env.POWERSHELL_EXECUTABLE;
  if (process.platform !== "win32") return findOnPath("pwsh") ?? "pwsh";
  const windowsPowerShell = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : null;
  return findOnPath("pwsh.exe")
    ?? (windowsPowerShell && fs.existsSync(windowsPowerShell) ? windowsPowerShell : null)
    ?? "powershell.exe";
}

export const powershellExecutable = resolvePowerShell();
