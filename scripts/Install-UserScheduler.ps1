[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
$schedulerScript = Join-Path $PSScriptRoot 'Start-UserScheduler.ps1'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$valueName = if ($config.schedulerRunKeyName) { [string]$config.schedulerRunKeyName } else { 'CodexBookmarkDailyCheckin' }
$shell = (Get-Command pwsh,powershell -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $shell) { throw '未找到 PowerShell 可执行文件。' }
$command = "`"$shell`" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$schedulerScript`""

New-Item -Path $runKey -Force | Out-Null
New-ItemProperty -Path $runKey -Name $valueName -Value $command -PropertyType String -Force | Out-Null

$statePath = Join-Path $root 'data\scheduler-state.json'
if (-not (Test-Path -LiteralPath $statePath)) {
    $state = [ordered]@{
        lastRunDate = (Get-Date).ToString('yyyy-MM-dd')
        lastFinishedAt = (Get-Date).ToString('o')
        lastExitCode = 0
        initializedFromCompletedCalibration = $true
    }
    [System.IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))
}

Start-Process -FilePath $shell -ArgumentList @(
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
    '-ExecutionPolicy', 'Bypass', '-File', $schedulerScript
) -WindowStyle Hidden

Write-Output '用户级后台调度器已安装并启动；登录后自动恢复，并按本机配置时间运行。'
