import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("原生 WAF 独立 profile 受 data 目录和冲突检查约束", async () => {
  const preflight = await fs.readFile(new URL("../scripts/Prepare-NativeWafSession.ps1", import.meta.url), "utf8");
  assert.match(preflight, /Resolve-NativeProfilePath/);
  assert.match(preflight, /必须位于项目 data 目录/);
  assert.match(preflight, /与全局或 Agent Router profile 冲突/);
  assert.match(preflight, /不同站点不能共享同一个原生 WAF 独立 profile/);
  assert.match(preflight, /-UserDataDirOverride \$profilePath/);
});

test("原生浏览器覆盖 profile 时重新绑定全部进程和启动参数", async () => {
  const launcher = await fs.readFile(new URL("../scripts/Open-PlainLoginChrome.ps1", import.meta.url), "utf8");
  assert.match(launcher, /\[string\]\$UserDataDirOverride/);
  assert.match(launcher, /\$config\.automationUserDataDir = \$profilePath/);
  assert.match(launcher, /--user-data-dir=\$\(\$config\.automationUserDataDir\)/);
});

test("健康检查覆盖独立 WAF profile 的存在性和唯一性", async () => {
  const health = await fs.readFile(new URL("../scripts/Test-CheckinHealth.ps1", import.meta.url), "utf8");
  assert.match(health, /nativeWafProfilesValid/);
  assert.match(health, /nativeWafProfilesPresent/);
  assert.match(health, /automationProfilesUnique/);
});
