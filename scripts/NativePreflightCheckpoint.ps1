function Read-NativePreflightConfirmations([string]$Path, [datetimeoffset]$Now = [datetimeoffset]::Now) {
    if (-not [System.IO.File]::Exists($Path)) { return }
    try { $report = [System.IO.File]::ReadAllText($Path) | ConvertFrom-Json -ErrorAction Stop }
    catch { return }
    foreach ($result in @($report.results)) {
        if ($result.status -notin @('signed', 'already_signed') -or -not $result.origin) { continue }
        $timestamp = if ($result.observedAt) { $result.observedAt } else { $report.generatedAt }
        $observed = [datetimeoffset]::MinValue
        # PowerShell 7 may deserialize ISO strings as DateTime; string-casting those
        # drops the UTC marker and fractional seconds.
        if ($timestamp -is [datetime] -or $timestamp -is [datetimeoffset]) { $observed = [datetimeoffset]$timestamp }
        elseif (-not [datetimeoffset]::TryParse([string]$timestamp, [ref]$observed)) { continue }
        if ($observed -gt $Now -or $observed.LocalDateTime.Date -ne $Now.LocalDateTime.Date) { continue }
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

function Write-NativePreflightCheckpoint([string]$Path, $Results) {
    $ErrorActionPreference = 'Stop'
    $now = (Get-Date).ToUniversalTime().ToString('o')
    foreach ($result in $Results) {
        if (-not $result.observedAt) { $result | Add-Member -NotePropertyName observedAt -NotePropertyValue $now -Force }
    }
    $merged = [ordered]@{}
    foreach ($result in @(Read-NativePreflightConfirmations -Path $Path)) { $merged[[string]$result.origin] = $result }
    foreach ($result in $Results) {
        # An inconclusive retry must never replace a confirmation from today.
        if (-not $merged.Contains([string]$result.origin)) { $merged[[string]$result.origin] = $result }
    }
    $document = [ordered]@{ generatedAt = $now; results = @($merged.Values) }
    [System.IO.Directory]::CreateDirectory((Split-Path -Parent $Path)) | Out-Null
    $temporary = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        [System.IO.File]::WriteAllText($temporary, ($document | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
        if ([System.IO.File]::Exists($Path)) { [System.IO.File]::Replace($temporary, $Path, [NullString]::Value) }
        else { [System.IO.File]::Move($temporary, $Path) }
    }
    finally {
        if ([System.IO.File]::Exists($temporary)) { [System.IO.File]::Delete($temporary) }
    }
}
