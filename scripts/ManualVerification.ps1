$script:ManualVerificationTerminalStatuses = @('signed', 'already_signed')
$script:ManualVerificationImmediateStatuses = @(
    'error', 'login_required', 'interactive_challenge', 'managed_challenge',
    'managed_challenge_timeout', 'needs_attention', 'unconfirmed', 'clicked', 'visited'
)
$script:ManualVerificationHandoffDeferredCauses = @('login_required', 'managed_challenge_timeout')
. (Join-Path $PSScriptRoot 'ResultContract.ps1')

function ConvertTo-ManualVerificationOrigin($Value) {
    $uri = try { [uri]([string]$Value) } catch { $null }
    if (-not $uri -or $uri.Scheme -notin @('http', 'https') -or -not $uri.Host -or $uri.UserInfo) {
        return $null
    }
    return "$($uri.Scheme)://$($uri.Authority)"
}

function Test-ManualVerificationTerminalStatus($Status, $Evidence = $null) {
    if ([string]$Status -in $script:ManualVerificationTerminalStatuses) { return $true }
    if ([string]$Status -ne 'not_available') { return $false }
    return Test-ConfirmedNotAvailable ([pscustomobject]@{
        status = $Status
        availabilityKind = $Evidence.availabilityKind
        disabledByConfig = $Evidence.disabledByConfig
        temporarilyUnavailable = $Evidence.temporarilyUnavailable
        evidence = $Evidence
    })
}

function Test-ManualVerificationResultTerminal($Result) {
    return Test-CheckinResultTerminal $Result
}

function Test-ManualVerificationTargetTerminal($Target) {
    if ($null -eq $Target) { return $false }
    if ([string]$Target.verificationStatus -in $script:ManualVerificationTerminalStatuses) { return $true }
    if ([string]$Target.verificationStatus -ne 'not_available') { return $false }
    return Test-ConfirmedNotAvailable ([pscustomobject]@{
        status = [string]$Target.verificationStatus
        availabilityKind = $Target.availabilityKind
        disabledByConfig = $Target.disabledByConfig
        temporarilyUnavailable = $Target.temporarilyUnavailable
        evidence = $Target.evidence
    })
}

function ConvertTo-ManualVerificationUtcDateTime($Value) {
    if ($Value -is [datetime]) { return ([datetime]$Value).ToUniversalTime() }
    if ($Value -is [datetimeoffset]) { return ([datetimeoffset]$Value).UtcDateTime }
    $parsed = [datetime]::MinValue
    if ([datetime]::TryParse([string]$Value, [ref]$parsed)) { return $parsed.ToUniversalTime() }
    return $null
}

function Get-ManualVerificationShanghaiDate([datetime]$Value) {
    $utc = $Value.ToUniversalTime()
    try {
        $timeZone = [TimeZoneInfo]::FindSystemTimeZoneById('China Standard Time')
        return [TimeZoneInfo]::ConvertTimeFromUtc($utc, $timeZone).ToString('yyyyMMdd')
    }
    catch {
        return $utc.AddHours(8).ToString('yyyyMMdd')
    }
}

function Test-ManualVerificationCurrentDayDocument($Document, [datetime]$Now = (Get-Date)) {
    if ($null -eq $Document) { return $false }
    $expectedDate = Get-ManualVerificationShanghaiDate $Now
    if ([string]$Document.sourceRunId -notlike "$expectedDate-*") { return $false }

    foreach ($value in @($Document.createdAt, $Document.sourceFinishedAt)) {
        $timestamp = ConvertTo-ManualVerificationUtcDateTime $value
        if ($null -eq $timestamp -or (Get-ManualVerificationShanghaiDate $timestamp) -ne $expectedDate) {
            return $false
        }
    }
    return $true
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
    if ($null -eq $Result -or (Test-ManualVerificationResultTerminal $Result)) { return $false }
    if ($Result.retryable -eq $false -or $Result.submissionAttempted -eq $true) { return $false }
    $status = [string]$Result.status
    if ($status -eq 'deferred') {
        if (-not $Result.nextEligibleAt) { return $true }
        $nextEligibleAt = ConvertTo-ManualVerificationUtcDateTime $Result.nextEligibleAt
        if ($null -eq $nextEligibleAt) { return $true }
        return $nextEligibleAt -le $RetryAt.ToUniversalTime()
    }
    return $status -in $script:ManualVerificationImmediateStatuses
}

function Test-ManualVerificationHandoffResult($Result) {
    if ($null -eq $Result -or (Test-ManualVerificationResultTerminal $Result)) { return $false }
    if ([string]$Result.status -eq 'deferred') {
        return [string]$Result.retryCause -in $script:ManualVerificationHandoffDeferredCauses
    }
    return [string]$Result.status -in $script:ManualVerificationImmediateStatuses
}

function Get-ManualHandoffTargets($Report, [datetime]$Now = (Get-Date)) {
    # A final but partial report still needs a durable handoff.  The automatic
    # runner must not silently drop sites when a timeout or browser restart
    # prevents the report from reaching plannedTotal.
    if ($null -eq $Report -or [string]$Report.runState -notin @('final', 'in_progress') -or @($Report.results).Count -eq 0) {
        return @()
    }
    $targets = @()
    $seen = @{}
    foreach ($result in @($Report.results)) {
        $origin = ConvertTo-ManualVerificationOrigin $result.origin
        if (-not $origin -or $seen.ContainsKey($origin)) { continue }
        # Automatic retry backoff must not postpone an available human login
        # or challenge handoff. The cooldown still governs unattended retries.
        if (Test-ManualVerificationHandoffResult $result) {
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
        if (-not (Test-ManualVerificationTargetTerminal $target)) {
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
            $target | Add-Member -NotePropertyName availabilityKind -NotePropertyValue ([string]$result.availabilityKind) -Force
            $target | Add-Member -NotePropertyName disabledByConfig -NotePropertyValue ($result.disabledByConfig -eq $true) -Force
            $target | Add-Member -NotePropertyName temporarilyUnavailable -NotePropertyValue ($result.temporarilyUnavailable -eq $true) -Force
            $target | Add-Member -NotePropertyName evidence -NotePropertyValue $result.evidence -Force
            $nextEligibleAt = ConvertTo-ManualVerificationUtcDateTime $result.nextEligibleAt
            $nextEligibleAtText = if ($null -ne $nextEligibleAt) { $nextEligibleAt.ToString('o') } else { [string]$result.nextEligibleAt }
            $target | Add-Member -NotePropertyName nextEligibleAt -NotePropertyValue $nextEligibleAtText -Force
        }
        if (-not (Test-ManualVerificationTargetTerminal $target)) {
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
