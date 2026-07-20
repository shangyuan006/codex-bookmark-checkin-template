[CmdletBinding()]
param()

$root = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $root 'config\config.json'
$config = if (Test-Path -LiteralPath $configPath) { Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json } else { $null }
$valueName = if ($config.schedulerRunKeyName) { [string]$config.schedulerRunKeyName } else { 'CodexBookmarkDailyCheckin' }
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name $valueName -ErrorAction SilentlyContinue
Write-Output '已移除用户级后台调度器的登录启动项。'
