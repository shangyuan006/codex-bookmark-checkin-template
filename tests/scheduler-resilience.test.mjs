import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("Windows 计划任务回退前停用遗留任务", async () => {
  const installer = await fs.readFile(path.join(root, "scripts", "Install-ScheduledTask.ps1"), "utf8");
  assert.match(installer, /Disable-ScheduledTask\s+-TaskName\s+\$taskName/);
  assert.match(installer, /运行锁阻止重复签到/);
});

test("计划任务安装器只清理确属本项目的启动入口", async () => {
  const installer = await fs.readFile(path.join(root, "scripts", "Install-ScheduledTask.ps1"), "utf8");
  assert.match(installer, /legacyRunValue\.IndexOf\(\$_, \[System\.StringComparison\]::OrdinalIgnoreCase\)/);
  assert.match(installer, /shortcutCommand\.IndexOf\(\$_, \[System\.StringComparison\]::OrdinalIgnoreCase\)/);
  assert.match(installer, /if \(\$ownsRunValue\)/);
  assert.match(installer, /if \(\$ownsShortcut\)/);
});

test("健康检查核对计划任务动作、触发频率且不要求空闲 heartbeat", async () => {
  const health = await fs.readFile(path.join(root, "scripts", "Test-CheckinHealth.ps1"), "utf8");
  assert.match(health, /expectedTriggerMinutes/);
  assert.match(health, /actualTriggerMinutes/);
  assert.match(health, /scheduledTaskActionValid/);
  assert.match(health, /scheduledTaskTriggerFrequencyValid/);
  assert.match(health, /Compare-Object\s+-ReferenceObject\s+\$expectedTriggerMinutes/);
  assert.match(health, /schedulerHeartbeatFresh\s*=\s*if \(\$useUserScheduler\)[\s\S]*?elseif \(\$scheduledTaskReady\) \{ \$true \}/);
});
