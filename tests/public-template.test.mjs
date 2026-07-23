import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("公开默认配置不启用外部通知", async () => {
  const defaults = JSON.parse(await fs.readFile(new URL("../config/defaults.json", import.meta.url), "utf8"));
  assert.equal(defaults.notification.mode, "none");
  assert.equal(defaults.notification.executable, "");
  assert.equal(defaults.syncBookmarkSavedLogins, false);
  assert.deepEqual(defaults.syncSavedLoginOrigins, []);
  assert.equal(defaults.qaWebSearchEnabled, false);
  assert.equal(defaults.disableOptimizationGuideOnDeviceModel, true);
});

test("保存密码同步必须经过显式总开关授权", async () => {
  const runner = await fs.readFile(new URL("../scripts/Run-Checkin.ps1", import.meta.url), "utf8");
  assert.match(runner, /syncBookmarkSavedLogins -eq \$true/);
  assert.doesNotMatch(runner, /syncSavedLoginOrigins\)\.Count -gt 0 -or/);
});

test("机器人 Chrome 缓存清理有目录边界和会话数据保护", async () => {
  const cleaner = await fs.readFile(new URL("../scripts/Clear-AutomationChromeCache.ps1", import.meta.url), "utf8");
  assert.match(cleaner, /Join-Path \$root 'data'/);
  assert.match(cleaner, /机器人 Chrome 正在运行/);
  assert.match(cleaner, /\[switch\]\$Apply/);
  assert.match(cleaner, /FileAttributes\]::ReparsePoint/);
  assert.match(cleaner, /Assert-NoReparsePointInPath \$profileRoot \$allowedParent/);
  assert.match(cleaner, /Assert-NoReparsePointTree \$target/);
  for (const protectedName of ["Cookies", "Local Storage", "Session Storage", "IndexedDB", "Service Worker", "Login Data"]) {
    assert.match(cleaner, new RegExp(protectedName.replace(" ", "\\s")));
  }
  assert.doesNotMatch(cleaner, /Remove-Item\s+-LiteralPath\s+\$profileRoot\b/);
});

test("wrapper 覆盖前置步骤并且只在子进程退出后清理运行锁", async () => {
  const defaults = JSON.parse(await fs.readFile(new URL("../config/defaults.json", import.meta.url), "utf8"));
  const runner = await fs.readFile(new URL("../scripts/Run-Checkin.ps1", import.meta.url), "utf8");
  assert.match(defaults.runMutexName, /^Local\\/);
  assert.match(runner, /WaitOne\(0\)/);
  assert.match(runner, /AbandonedMutexException/);
  assert.match(runner, /\$processExited\s*=\s*\$process\.WaitForExit\(10000\)/);
  assert.match(runner, /if \(-not \$processExited\)[\s\S]*?保留运行锁/);
  assert.match(runner, /Remove-RunLockOwnedByProcess/);
});

test("安装配置优先使用 PowerShell 7，5.1 仅作为可用回退", async () => {
  const setup = await fs.readFile(new URL("../src/setup-config.mjs", import.meta.url), "utf8");
  const preflight = await fs.readFile(new URL("../scripts/Test-Environment.ps1", import.meta.url), "utf8");
  assert.match(setup, /findOnPath\("pwsh\.exe"\)/);
  assert.match(setup, /answers\.powershellExecutable \|\| preferredPowerShell/);
  assert.match(preflight, /--scope-json-base64/);
});

test("公开模板不预设任何用户的书签文件夹名称", async () => {
  const defaults = JSON.parse(await fs.readFile(new URL("../config/defaults.json", import.meta.url), "utf8"));
  const answers = JSON.parse(await fs.readFile(new URL("../setup/answers.example.json", import.meta.url), "utf8"));
  const questions = JSON.parse(await fs.readFile(new URL("../setup/questions.json", import.meta.url), "utf8"));
  assert.deepEqual(defaults.mobileFolderNames, []);
  assert.deepEqual(defaults.targetFolderNames, []);
  assert.deepEqual(answers.mobileFolderNames, []);
  assert.deepEqual(answers.targetFolderNames, []);
  const scope = questions.groups.find((group) => group.id === "bookmark_scope");
  assert.deepEqual(scope.askBefore, ["automation_policy", "notification"]);

  const bookmarksSource = await fs.readFile(new URL("../src/bookmarks.mjs", import.meta.url), "utf8");
  const browserSource = await fs.readFile(new URL("../src/browser.mjs", import.meta.url), "utf8");
  const runnerSource = await fs.readFile(new URL("../src/index.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(bookmarksSource, /options\.mobileFolderNames\s*\?\?\s*\[\s*["']移动设备书签/);
  assert.doesNotMatch(bookmarksSource, /options\.targetFolderNames\s*\?\?\s*\[\s*["']签到/);
  assert.doesNotMatch(browserSource, /folderNames\.includes\(["']公益站["']\)/);
  assert.doesNotMatch(runnerSource, /folderNames\.includes\(["']公益站["']\)/);
});

test("公开站点规则只包含无凭据 HTTPS URL", async () => {
  const rules = JSON.parse(await fs.readFile(new URL("../config/site-rules.public.json", import.meta.url), "utf8"));
  const serialized = JSON.stringify(rules);
  assert.doesNotMatch(serialized, /(?:password|passwd|cookie|access_token|authorization)[=:]/i);
  const collectStrings = (value) => typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(collectStrings)
      : value && typeof value === "object"
        ? Object.entries(value).flatMap(([key, nested]) => [key, ...collectStrings(nested)])
        : [];
  for (const value of collectStrings(rules).filter((item) => item.startsWith("http"))) {
    const url = new URL(value);
    assert.equal(url.protocol, "https:");
    assert.equal(url.username, "");
    assert.equal(url.password, "");
  }
});

test("本机配置、结果和凭据目录被 Git 忽略", async () => {
  const ignore = await fs.readFile(new URL("../.gitignore", import.meta.url), "utf8");
  for (const pattern of ["config/config.json", "config/config.local.json", "setup/answers.json", "data/", "logs/*", "tmp/*"]) {
    assert.match(ignore, new RegExp(pattern.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")));
  }
});

test("DPAPI 凭据恢复默认关闭且强制同源验证", async () => {
  const defaults = JSON.parse(await fs.readFile(new URL("../config/defaults.json", import.meta.url), "utf8"));
  const loginSource = await fs.readFile(new URL("../src/credential-login.mjs", import.meta.url), "utf8");
  const setter = await fs.readFile(new URL("../scripts/Set-ProtectedSiteCredential.ps1", import.meta.url), "utf8");
  const recovery = await fs.readFile(new URL("../scripts/Recover-ProtectedLogin.ps1", import.meta.url), "utf8");

  assert.deepEqual(defaults.protectedCredentialOrigins, []);
  assert.deepEqual(defaults.protectedLoginVerificationPaths, {});
  assert.match(loginSource, /new URL\(loginUrl\)\.origin !== origin/);
  assert.match(loginSource, /verificationUrl\.origin !== origin/);
  assert.match(setter, /ConvertFrom-SecureString/);
  assert.match(recovery, /RedirectStandardInput = \$true/);
  assert.doesNotMatch(recovery, /ArgumentList\.Add\(\$passwordPlain\)/);
});
