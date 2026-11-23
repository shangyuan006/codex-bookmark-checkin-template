[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if ((Test-Path -LiteralPath (Join-Path $root 'tmp\manual-session.json'))) { return }
# One dispatch only: no schedule installation, notification flush or full run.
& (Join-Path $PSScriptRoot 'Start-UserScheduler.ps1') -Once -HandoffOnly
