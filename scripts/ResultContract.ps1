. (Join-Path $PSScriptRoot 'CheckinContract.generated.ps1')

function Test-CheckinEvidenceTimestamp($Value, [datetime]$Now = (Get-Date)) {
    $parsed = [datetime]::MinValue
    if ($Value -is [datetime]) { $parsed = ([datetime]$Value).ToUniversalTime() }
    elseif ($Value -is [datetimeoffset]) { $parsed = ([datetimeoffset]$Value).UtcDateTime }
    elseif (-not [datetime]::TryParse([string]$Value, [ref]$parsed)) { return $false }
    return $parsed.ToUniversalTime() -le $Now.ToUniversalTime().AddMinutes(5)
}

function Test-CheckinFeatureDisabledEvidence($Evidence) {
    $source = [string]$Evidence.source
    $originalSource = if ($source -eq 'cached_confirmation') { [string]$Evidence.originalSource } else { $source }
    $outcome = [string]$Evidence.outcome
    if ($originalSource -eq 'bmapi_checkin_status' -and $outcome -eq 'enabled_false') { return $true }
    if ($originalSource -in @('new_api_checkin_status', 'new_api_checkin_action') -and $outcome -eq 'message_not_enabled') { return $true }
    return $originalSource -eq 'configuration' -and $outcome -eq 'known_no_checkin_feature'
}

function Test-ConfirmedNotAvailable($Result, [datetime]$Now = (Get-Date)) {
    if ($null -eq $Result -or [string]$Result.status -ne 'not_available') { return $false }
    $evidence = $Result.evidence
    if ([string]$Result.availabilityKind -notin $script:CheckinAvailabilityKinds `
        -or $evidence.authoritative -ne $true `
        -or -not (Test-CheckinEvidenceTimestamp $evidence.confirmedAt $Now)) { return $false }
    if ([string]$Result.availabilityKind -eq 'task_disabled') {
        return $Result.disabledByConfig -eq $true -and [string]$evidence.source -eq 'configuration'
    }
    if ([string]$Result.availabilityKind -eq 'temporary_unavailable') {
        return $Result.temporarilyUnavailable -eq $true -and [string]$evidence.source -eq 'operator_confirmation'
    }
    return $Result.disabledByConfig -ne $true `
        -and $Result.temporarilyUnavailable -ne $true `
        -and (Test-CheckinFeatureDisabledEvidence $evidence)
}

function Test-CheckinResultTerminal($Result, [datetime]$Now = (Get-Date)) {
    if ([string]$Result.status -in $script:CheckinSuccessStatuses -and -not (Test-CheckinBoundSuccessEvidence $Result $Now)) { return $false }
    return $null -ne $Result -and (
        [string]$Result.status -in $script:CheckinSuccessStatuses `
        -or (Test-ConfirmedNotAvailable $Result $Now)
    )
}

function Test-CheckinBoundSuccessEvidence($Result, [datetime]$Now = (Get-Date)) {
    if ($null -ne $Result.accountResults -and @($Result.accountResults).Count -gt 0) {
        foreach ($account in @($Result.accountResults)) {
            if ([string]$account.status -notin $script:CheckinSuccessStatuses -or -not (Test-CheckinBoundSuccessEvidence $account $Now)) { return $false }
        }
        return $true
    }
    $binding = $Result.evidence.binding
    if ($null -eq $binding) { return $true } # legacy compatibility, never restamped
    $key = if ($Result.accountKey) { [string]$Result.accountKey } else { 'default' }
    $action = if ($Result.actionType) { [string]$Result.actionType } else { 'checkin' }
    $allowed = if ($Result.allowedOrigins) { @($Result.allowedOrigins) } else { @([string]$Result.origin) }
    if ($binding.version -ne 2 -or [string]$binding.siteOrigin -cne [string]$Result.origin `
        -or [string]$binding.accountKey -cne $key -or [string]$binding.actionType -cne $action `
        -or [string]$binding.observedOrigin -cnotin $allowed -or [string]$binding.cycleId -cne [string]$Result.cycle.id `
        -or [string]$Result.evidence.source -notin @('page_text','status_endpoint','reward_log','user_rule','reauth_state') `
        -or -not (Test-CheckinEvidenceTimestamp $Result.evidence.confirmedAt $Now)) { return $false }
    if ($Result.evidence.authoritative -ne $true -and [string]$Result.evidence.source -ne 'user_rule') { return $false }
    try {
        $start = [datetimeoffset]$Result.cycle.startAt
        $end = [datetimeoffset]$Result.cycle.endAt
        $confirmed = [datetimeoffset]$Result.evidence.confirmedAt
        $current = [datetimeoffset]$Now
        return $confirmed -le $current -and $start -le $current -and $current -lt $end
    } catch { return $false }
}

function Get-NormalizedCheckinResultStatus($Result, [datetime]$Now = (Get-Date)) {
    if ([string]$Result.status -in $script:CheckinSuccessStatuses -and -not (Test-CheckinBoundSuccessEvidence $Result $Now)) { return 'unconfirmed' }
    if ([string]$Result.status -ne 'not_available' -or (Test-ConfirmedNotAvailable $Result $Now)) {
        return [string]$Result.status
    }
    return 'unconfirmed'
}
