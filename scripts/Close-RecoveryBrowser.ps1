[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Resolve-Runtime.ps1')
if (Test-Path -LiteralPath (Join-Path $root 'tmp/manual-session.json')) {
    throw '人工窗口处于活动状态，拒绝清理其浏览器。'
}
$config = Get-Content -Raw -LiteralPath (Join-Path $root 'config/config.json') | ConvertFrom-Json
$targets = @(Get-CheckinAutomationBrowserProcesses $config)
$ids = @($targets.ProcessId)
foreach ($target in @($targets | Where-Object { $ids -notcontains $_.ParentProcessId })) {
    $process = Get-Process -Id $target.ProcessId -ErrorAction SilentlyContinue
    if ($process) { [void]$process.CloseMainWindow() }
}
$deadline = (Get-Date).AddSeconds(15)
while (@(Get-CheckinAutomationBrowserProcesses $config).Count -gt 0 -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
}
if (@(Get-CheckinAutomationBrowserProcesses $config).Count -gt 0) {
    throw '登录恢复浏览器未能正常保存并退出，停止后续自动恢复。'
}
