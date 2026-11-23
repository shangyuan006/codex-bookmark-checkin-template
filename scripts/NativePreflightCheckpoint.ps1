. (Join-Path $PSScriptRoot 'CheckinCycle.ps1')
. (Join-Path $PSScriptRoot 'ResultContract.ps1')

function Get-NativePreflightConfirmationStatus($Inspection, [bool]$ExplicitlyConfirmed, [bool]$EndpointConfirmed) {
    if (Test-ConfirmedNotAvailable $Inspection) { return 'not_available' }
    if ($ExplicitlyConfirmed) {
        if ([string]$Inspection.status -eq 'signed') { return 'signed' }
        if ([string]$Inspection.status -eq 'already_signed') {
            # A completed action followed by an authoritative signed control
            # proves this attempt completed check-in. Merely reading a prior
            # completion, including a New API no-op, must keep already_signed.
            if ($Inspection.actionAttempted -eq $true -and [string]$Inspection.actionOutcome -eq 'clicked') {
                return 'signed'
            }
            return 'already_signed'
        }
    }
    if ($EndpointConfirmed) { return 'signed' }
    return $null
}

function Read-NativePreflightConfirmations([string]$Path, [datetimeoffset]$Now = [datetimeoffset]::Now, $Config = $null, [switch]$IncludePrepared) {
    if (-not [System.IO.File]::Exists($Path)) { return }
    try { $report = [System.IO.File]::ReadAllText($Path) | ConvertFrom-Json -ErrorAction Stop }
    catch { return }
    foreach ($result in @($report.results)) {
        if ($null -ne $result.actionResults) {
            $result.actionResults = @($result.actionResults | Where-Object { $null -ne $_ })
        }
        $prepared = $IncludePrepared -and $result.status -eq 'prepared' -and $result.passiveOnly -eq $true
        $disabled = Test-ConfirmedNotAvailable $result $Now.UtcDateTime
        if (($result.status -notin @('signed', 'already_signed') -and -not $disabled -and -not $prepared) -or -not $result.origin) { continue }
        $timestamp = if ($result.observedAt) { $result.observedAt } else { $report.generatedAt }
        $observed = [datetimeoffset]::MinValue
        # PowerShell 7 may deserialize ISO strings as DateTime; string-casting those
        # drops the UTC marker and fractional seconds.
        if ($timestamp -is [datetime] -or $timestamp -is [datetimeoffset]) { $observed = [datetimeoffset]$timestamp }
        elseif (-not [datetimeoffset]::TryParse([string]$timestamp, [ref]$observed)) { continue }
        if ($prepared -and ($observed -gt $Now -or ($Now - $observed).TotalMinutes -gt 10)) { continue }
        if ($Config.siteCycleRules.([string]$result.origin)) {
            if (-not (Test-CheckinCycleCurrent $result $Config $Now $timestamp)) { continue }
        } elseif ($observed -gt $Now -or $observed.LocalDateTime.Date -ne $Now.LocalDateTime.Date) { continue }
        if ($disabled) {
            $evidenceCycle = [pscustomobject]@{ origin = $result.origin; status = 'signed'; observedAt = $result.evidence.confirmedAt }
            if (-not (Test-CheckinCycleCurrent $evidenceCycle $Config $Now)) { continue }
            $confirmed = try { [datetimeoffset]$result.evidence.confirmedAt } catch { $null }
            if ($null -eq $confirmed -or $confirmed -gt $Now -or (-not $Config.siteCycleRules.([string]$result.origin) -and $confirmed.LocalDateTime.Date -ne $Now.LocalDateTime.Date)) { continue }
        }
        # Preserve the original observation time, including legacy checkpoints.
        $result | Add-Member -NotePropertyName observedAt -NotePropertyValue $observed.ToString('o') -Force
        $result
    }
}

function Complete-NativePreflightAttempt([scriptblock]$Cleanup, $Failure) {
    try { & $Cleanup }
    catch {
        if ($null -eq $Failure) { throw }
        # Keep the original inspection/persistence error while reporting cleanup failure.
        $Failure.Exception.Data['BrowserCleanupFailed'] = $true
        Write-Warning '原生预热失败，且浏览器未能正常关闭；请检查项目浏览器进程。'
    }
}

function Commit-NativePreflightCheckpoint {
    param(
        [Parameter(Mandatory)][string]$TemporaryPath,
        [Parameter(Mandatory)][string]$Path,
        [ValidateRange(1, 5)][int]$MaxAttempts = 4,
        [scriptblock]$Commit = {
            param($Source, $Destination)
            if ([System.IO.File]::Exists($Destination)) { [System.IO.File]::Replace($Source, $Destination, [NullString]::Value) }
            else { [System.IO.File]::Move($Source, $Destination) }
        },
        [scriptblock]$Wait = { param($Milliseconds) Start-Sleep -Milliseconds $Milliseconds }
    )
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        try { & $Commit $TemporaryPath $Path; return }
        catch {
            $failure = $_.Exception
            $transient = $false
            while ($failure) {
                $win32Code = $failure.HResult -band 0xffff
                if ($failure -is [System.IO.IOException] -and $win32Code -in @(32, 33, 1175, 1176, 1177)) {
                    $transient = $true
                    break
                }
                $failure = $failure.InnerException
            }
            if (-not $transient -or $attempt -eq $MaxAttempts) { throw }
            # Keep the existing checkpoint and reuse the fully written temp file.
            & $Wait (100 * $attempt)
        }
    }
}

function Write-NativePreflightCheckpoint([string]$Path, $Results, $Config = $null) {
    $ErrorActionPreference = 'Stop'
    $now = (Get-Date).ToUniversalTime().ToString('o')
    foreach ($result in $Results) {
        if (-not $result.observedAt) { $result | Add-Member -NotePropertyName observedAt -NotePropertyValue $now -Force }
    }
    $merged = [ordered]@{}
    foreach ($result in @(Read-NativePreflightConfirmations -Path $Path -Config $Config -IncludePrepared)) { $merged[[string]$result.origin] = $result }
    foreach ($result in $Results) {
        # An inconclusive retry must never replace a confirmation from today.
        if (-not $merged.Contains([string]$result.origin) -or -not (Test-CheckinResultTerminal $merged[[string]$result.origin])) {
            $merged[[string]$result.origin] = $result
        }
    }
    $document = [ordered]@{ generatedAt = $now; results = @($merged.Values) }
    foreach ($result in $document.results) {
        if ($null -ne $result.actionResults) {
            $result.actionResults = @($result.actionResults | Where-Object { $null -ne $_ })
        }
    }
    [System.IO.Directory]::CreateDirectory((Split-Path -Parent $Path)) | Out-Null
    $temporary = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        [System.IO.File]::WriteAllText($temporary, ($document | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
        Commit-NativePreflightCheckpoint -TemporaryPath $temporary -Path $Path
    }
    finally {
        if ([System.IO.File]::Exists($temporary)) { [System.IO.File]::Delete($temporary) }
    }
}
