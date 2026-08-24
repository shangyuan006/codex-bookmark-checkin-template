$script:ManualVerificationTerminalStatuses = @('signed', 'already_signed', 'not_available')
$script:ManualVerificationImmediateStatuses = @(
    'error', 'login_required', 'interactive_challenge', 'managed_challenge',
    'managed_challenge_timeout', 'needs_attention', 'unconfirmed', 'clicked', 'visited'
)

function ConvertTo-ManualVerificationOrigin($Value) {
    $uri = try { [uri]([string]$Value) } catch { $null }
    if (-not $uri -or $uri.Scheme -notin @('http', 'https') -or -not $uri.Host -or $uri.UserInfo) {
        return $null
    }
    return "$($uri.Scheme)://$($uri.Authority)"
}

function Test-ManualVerificationTerminalStatus($Status) {
    return [string]$Status -in $script:ManualVerificationTerminalStatuses
}

function ConvertTo-ManualVerificationUtcDateTime($Value) {
    if ($Value -is [datetime]) { return ([datetime]$Value).ToUniversalTime() }
    if ($Value -is [datetimeoffset]) { return ([datetimeoffset]$Value).UtcDateTime }
    $parsed = [datetime]::MinValue
    if ([datetime]::TryParse([string]$Value, [ref]$parsed)) { return $parsed.ToUniversalTime() }
    return $null
}

function Test-ManualVerificationFinalReport($Report) {
    if ($null -eq $Report -or [string]$Report.runState -ne 'final' -or $Report.isComplete -ne $true) {
        return $false
    }
    $plannedTotal = if ($null -ne $Report.plannedTotal) { [int]$Report.plannedTotal } else { 0 }
    $processedTotal = if ($null -ne $Report.processedTotal) { [int]$Report.processedTotal } else { @($Report.results).Count }
    return $plannedTotal -gt 0 `
        -and $processedTotal -ge $plannedTotal `
        -and @($Report.results).Count -ge $plannedTotal
}

function Test-ManualVerificationImmediateResult($Result, [datetime]$RetryAt) {
    if ($null -eq $Result -or (Test-ManualVerificationTerminalStatus $Result.status)) { return $false }
    $status = [string]$Result.status
    if ($status -eq 'deferred') {
        if (-not $Result.nextEligibleAt) { return $true }
        $nextEligibleAt = ConvertTo-ManualVerificationUtcDateTime $Result.nextEligibleAt
        if ($null -eq $nextEligibleAt) { return $true }
        return $nextEligibleAt -le $RetryAt.ToUniversalTime()
    }
    return $status -in $script:ManualVerificationImmediateStatuses
}

function Get-ManualHandoffTargets($Report, [datetime]$Now = (Get-Date)) {
    if ($null -eq $Report -or [string]$Report.runState -ne 'final' -or $Report.isComplete -ne $true) {
        return @()
    }
    $targets = @()
    $seen = @{}
    foreach ($result in @($Report.results)) {
        $origin = ConvertTo-ManualVerificationOrigin $result.origin
        if (-not $origin -or $seen.ContainsKey($origin)) { continue }
        if (Test-ManualVerificationImmediateResult $result $Now) {
            $seen[$origin] = $true
            $targets += [ordered]@{
                origin = $origin
                previousStatus = [string]$result.status
            }
        }
    }
    return @($targets)
}

function Get-PendingManualVerification([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try { $document = Get-Content -Raw -Encoding UTF8 -LiteralPath $Path | ConvertFrom-Json }
    catch { return $null }
    if ([string]$document.state -ne 'pending_verification' -or $document.authoritativeEvidenceRequired -ne $true) {
        return $null
    }

    $origins = @()
    foreach ($target in @($document.targets)) {
        $origin = ConvertTo-ManualVerificationOrigin $target.origin
        if (-not $origin) { return $null }
        if (-not (Test-ManualVerificationTerminalStatus $target.verificationStatus)) {
            $origins += $origin
        }
    }
    $origins = @($origins | Sort-Object -Unique)
    if ($origins.Count -eq 0) { return $null }
    return [pscustomobject]@{ Document = $document; Origins = $origins }
}

function Get-ManualVerificationRetryOrigins($Pending, $Report, [datetime]$RetryAt) {
    if ($null -eq $Pending -or -not (Test-ManualVerificationFinalReport $Report)) { return @() }
    $resultByOrigin = @{}
    foreach ($result in @($Report.results)) {
        $origin = ConvertTo-ManualVerificationOrigin $result.origin
        if ($origin) { $resultByOrigin[$origin] = $result }
    }

    $retryOrigins = @()
    foreach ($origin in @($Pending.Origins)) {
        $normalizedOrigin = ConvertTo-ManualVerificationOrigin $origin
        if ($normalizedOrigin -and $resultByOrigin.ContainsKey($normalizedOrigin) `
            -and (Test-ManualVerificationImmediateResult $resultByOrigin[$normalizedOrigin] $RetryAt)) {
            $retryOrigins += $normalizedOrigin
        }
    }
    return @($retryOrigins | Sort-Object -Unique)
}

function Update-ManualVerificationState($Pending, $Report, [string]$Path, [datetime]$RetryAt) {
    $notUpdated = [pscustomobject]@{
        Updated = $false
        Complete = $false
        PendingOrigins = @()
        RetryOrigins = @()
    }
    if ($null -eq $Pending -or -not (Test-ManualVerificationFinalReport $Report)) { return $notUpdated }

    $resultByOrigin = @{}
    foreach ($result in @($Report.results)) {
        $origin = ConvertTo-ManualVerificationOrigin $result.origin
        if ($origin) { $resultByOrigin[$origin] = $result }
    }
    $pendingOriginSet = @{}
    foreach ($origin in @($Pending.Origins)) {
        $normalizedOrigin = ConvertTo-ManualVerificationOrigin $origin
        if (-not $normalizedOrigin -or -not $resultByOrigin.ContainsKey($normalizedOrigin)) {
            return $notUpdated
        }
        $pendingOriginSet[$normalizedOrigin] = $true
    }

    $allConfirmed = $true
    $pendingOrigins = @()
    foreach ($target in @($Pending.Document.targets)) {
        $origin = ConvertTo-ManualVerificationOrigin $target.origin
        if (-not $origin) { return $notUpdated }
        if ($pendingOriginSet.ContainsKey($origin)) {
            $result = $resultByOrigin[$origin]
            $target.verificationStatus = [string]$result.status
            $target | Add-Member -NotePropertyName verificationReason -NotePropertyValue ([string]$result.reason) -Force
            $target | Add-Member -NotePropertyName retryCause -NotePropertyValue ([string]$result.retryCause) -Force
            $nextEligibleAt = ConvertTo-ManualVerificationUtcDateTime $result.nextEligibleAt
            $nextEligibleAtText = if ($null -ne $nextEligibleAt) { $nextEligibleAt.ToString('o') } else { [string]$result.nextEligibleAt }
            $target | Add-Member -NotePropertyName nextEligibleAt -NotePropertyValue $nextEligibleAtText -Force
        }
        if (-not (Test-ManualVerificationTerminalStatus $target.verificationStatus)) {
            $allConfirmed = $false
            $pendingOrigins += $origin
        }
    }

    $Pending.Document.state = if ($allConfirmed) { 'verification_complete' } else { 'pending_verification' }
    $Pending.Document.authoritativeEvidenceRequired = -not $allConfirmed
    $Pending.Document | Add-Member -NotePropertyName verificationRunId -NotePropertyValue ([string]$Report.runId) -Force
    $Pending.Document | Add-Member -NotePropertyName verifiedAt -NotePropertyValue ((Get-Date).ToUniversalTime().ToString('o')) -Force
    $temporaryPath = "$Path.$PID.tmp"
    try {
        [System.IO.File]::WriteAllText(
            $temporaryPath,
            ($Pending.Document | ConvertTo-Json -Depth 8),
            [System.Text.UTF8Encoding]::new($false)
        )
        Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
    }
    finally {
        if (Test-Path -LiteralPath $temporaryPath) {
            Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
        }
    }

    return [pscustomobject]@{
        Updated = $true
        Complete = $allConfirmed
        PendingOrigins = @($pendingOrigins | Sort-Object -Unique)
        RetryOrigins = @(Get-ManualVerificationRetryOrigins $Pending $Report $RetryAt)
    }
}
