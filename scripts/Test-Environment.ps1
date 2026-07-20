[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$npmCommand = Get-Command npm -ErrorAction SilentlyContinue
$pwshCommand = Get-Command pwsh -ErrorAction SilentlyContinue
$pythonCommand = Get-Command python,python3 -ErrorAction SilentlyContinue | Where-Object { $_.Source -notmatch 'WindowsApps\\python(?:3)?\.exe$' } | Select-Object -First 1

if (-not $nodeCommand) {
    [ordered]@{
        generatedAt = (Get-Date).ToString('o')
        ready = $false
        checks = [ordered]@{
            supportedWindows = $IsWindows -or $env:OS -eq 'Windows_NT'
            powershellSupported = $PSVersionTable.PSVersion.Major -ge 5
            nodePresent = $false
            npmPresent = [bool]$npmCommand
            pythonPresent = [bool]$pythonCommand
            scheduledTaskCmdletPresent = [bool](Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)
        }
        guidance = [ordered]@{ blocking = @('nodePresent'); needsUserInput = @('installNode') }
    } | ConvertTo-Json -Depth 8
    return
}

$raw = & $nodeCommand.Source (Join-Path $root 'src\preflight.mjs')
if ($LASTEXITCODE -ne 0) { throw '环境预检程序运行失败。' }
$report = ($raw -join [Environment]::NewLine) | ConvertFrom-Json
$report.checks | Add-Member -NotePropertyName powershellSupported -NotePropertyValue ($PSVersionTable.PSVersion.Major -ge 5) -Force
$report.checks | Add-Member -NotePropertyName npmPresent -NotePropertyValue ([bool]$npmCommand) -Force
$report.checks | Add-Member -NotePropertyName pwshPresent -NotePropertyValue ([bool]$pwshCommand) -Force
$report.checks | Add-Member -NotePropertyName pythonPresent -NotePropertyValue ([bool]$pythonCommand) -Force
$report | Add-Member -NotePropertyName optionalCapabilities -NotePropertyValue ([ordered]@{
    pythonForSavedLoginSync = [bool]$pythonCommand
    windowsTaskScheduler = [bool](Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)
    externalNotification = $false
}) -Force
$report.checks | Add-Member -NotePropertyName scheduledTaskCmdletPresent -NotePropertyValue ([bool](Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)) -Force
if (-not $npmCommand) {
    $report.ready = $false
    $report.guidance.blocking = @($report.guidance.blocking) + 'npmPresent'
}
$report | ConvertTo-Json -Depth 10
