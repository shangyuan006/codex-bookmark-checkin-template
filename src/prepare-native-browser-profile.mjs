import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function assertProfileDirectory(userDataDir, profileDirectory) {
  if (!path.isAbsolute(userDataDir)) throw new Error("browser user data directory must be absolute");
  if (!profileDirectory || path.basename(profileDirectory) !== profileDirectory || profileDirectory === "." || profileDirectory === "..") {
    throw new Error("browser profile directory must be a single directory name");
  }
  const root = path.resolve(userDataDir);
  const profile = path.resolve(root, profileDirectory);
  if (!profile.startsWith(`${root}${path.sep}`)) throw new Error("browser profile escaped the user data directory");
  return { root, profile };
}

async function updatePreferences(preferencesPath) {
  const stat = await fs.lstat(preferencesPath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("refusing unsafe browser Preferences file");
  const preferences = JSON.parse(await fs.readFile(preferencesPath, "utf8"));
  preferences.profile = preferences.profile && typeof preferences.profile === "object" && !Array.isArray(preferences.profile)
    ? preferences.profile
    : {};
  preferences.session = preferences.session && typeof preferences.session === "object" && !Array.isArray(preferences.session)
    ? preferences.session
    : {};
  preferences.profile.exit_type = "Normal";
  preferences.profile.exited_cleanly = true;
  preferences.session.restore_on_startup = 5;
  preferences.session.startup_urls = [];
  const temporaryPath = `${preferencesPath}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(preferences)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporaryPath, preferencesPath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
  return true;
}

export async function prepareNativeBrowserProfile(userDataDir, profileDirectory = "Default") {
  const { profile } = assertProfileDirectory(userDataDir, profileDirectory);
  const profileStat = await fs.lstat(profile).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!profileStat) return { preferencesUpdated: false };
  if (profileStat.isSymbolicLink() || !profileStat.isDirectory()) throw new Error("refusing unsafe browser profile directory");
  return {
    preferencesUpdated: await updatePreferences(path.join(profile, "Preferences")),
  };
}

const sourcePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === sourcePath) {
  const userDataDir = String(process.argv[2] ?? "");
  const profileDirectory = String(process.argv[3] ?? "Default");
  console.log(JSON.stringify(await prepareNativeBrowserProfile(userDataDir, profileDirectory)));
}
