[CmdletBinding()]
param([Parameter(Mandatory = $true)][ValidatePattern('^[a-f0-9]{32}$')][string]$SessionMarker)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Resolve-Runtime.ps1')
$root = Split-Path -Parent $PSScriptRoot
$statePath = Join-Path $root 'tmp\manual-session.json'
$watchMutex = [System.Threading.Mutex]::new($false, "Local\CheckinManualWatch_$SessionMarker")
$owned = $false
try {
    try { $owned = $watchMutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
    if (-not $owned) { return }
    while (Test-Path -LiteralPath $statePath) {
        $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
        if ([string]$state.launchMarker -cne $SessionMarker -or $state.controlledCheckin -ne $true) { break }
        $owner = Get-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue
        if (-not $owner) {
            & (Join-Path $PSScriptRoot 'Close-ManualLogin.ps1')
            break
        }
        if (-not (Test-CheckinProcessStartIdentity -Process $owner -RecordedStart $state.processStartedAt)) { break }
        try {
            # Observe delayed verification and continue ready controls. This
            # mode never reopens/reloads a form or starts more CF click rounds.
            $result = & (Join-Path $PSScriptRoot 'Resume-ManualCheckin.ps1') -ReadyOnly -Json | ConvertFrom-Json
            if ($result.state -eq 'session_closed' -or $result.state -eq 'session_changed') { break }
            if ($result.state -ne 'busy' -and $result.unresolvedCount -eq 0) {
                & (Join-Path $PSScriptRoot 'Close-ManualLogin.ps1')
                break
            }
        }
        catch {
            if (-not (Test-Path -LiteralPath $statePath)) { break }
            # Keep the page and identity. A concurrent close or temporary run
            # lock cannot authorize a replacement browser or another click.
        }
        Start-Sleep -Seconds 5
    }
}
finally {
    if ($owned) { [void]$watchMutex.ReleaseMutex() }
    $watchMutex.Dispose()
}
