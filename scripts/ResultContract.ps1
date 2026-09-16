$script:CheckinAvailabilityKinds = @('feature_disabled', 'task_disabled', 'temporary_unavailable')

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
    return $null -ne $Result -and (
        [string]$Result.status -in @('signed', 'already_signed') `
        -or (Test-ConfirmedNotAvailable $Result $Now)
    )
}

function Get-NormalizedCheckinResultStatus($Result, [datetime]$Now = (Get-Date)) {
    if ([string]$Result.status -ne 'not_available' -or (Test-ConfirmedNotAvailable $Result $Now)) {
        return [string]$Result.status
    }
    return 'unconfirmed'
}
