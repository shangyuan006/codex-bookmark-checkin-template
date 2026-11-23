. (Join-Path $PSScriptRoot 'ManualVerification.ps1')

function Get-ManualInteractionStatus($Report, [object[]]$Sessions, [string[]]$AbandonedOrigins = @(),
    [string]$ExpectedRequestId = '', [datetime]$Now = (Get-Date)) {
    $today = Get-ManualVerificationShanghaiDate $Now
    $results = if ([string]$Report.runId -like "$today-*") { @($Report.results) } else { @() }
    $ready = @()
    $resolved = @()
    $waiting = @()
    $identities = @()
    foreach ($session in @($Sessions)) {
        foreach ($target in @($session.targets)) {
            $origin = ConvertTo-ManualVerificationOrigin $target.origin
            if (-not $origin) { continue }
            $key = [string]$target.accountKey
            $match = @($results | Where-Object { [string]$_.origin -eq $origin })
            $result = if ($match.Count -eq 1) { $match[0] } else { $null }
            if ($key) { $result = @($result.accountResults | Where-Object { [string]$_.accountKey -eq $key } | Select-Object -First 1)[0] }
            $item = [ordered]@{ origin = $origin; accountKey = $key }
            $confirmed = $null -ne $result -and (Test-ManualVerificationResultTerminal $result $Now)
            if ([string]$result.status -in @('signed', 'already_signed')) {
                $leaves = if ($result.accountResults) { @($result.accountResults) } else { @($result) }
                $confirmed = $confirmed -and @($leaves | Where-Object {
                    $_.evidence.authoritative -ne $true -or $null -eq $_.evidence.binding
                }).Count -eq 0
            }
            if ($confirmed -or $origin -in $AbandonedOrigins) { $resolved += [pscustomobject]$item; continue }
            if ($session.visible -eq $true -and [string]$session.identity -match '^[a-f0-9]{32}$') {
                $ready += [pscustomobject]$item
                $identities += "$($session.identity):${origin}:$key"
            } else { $waiting += [pscustomobject]$item }
        }
    }
    $requestId = $null
    if ($ready.Count -gt 0) {
        $hash = [System.Security.Cryptography.SHA256]::Create()
        try { $requestId = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes("$today|$((@($identities | Sort-Object -Unique)) -join '|')")))).Replace('-', '').ToLowerInvariant() }
        finally { $hash.Dispose() }
    }
    $expired = [bool]$ExpectedRequestId -and $ExpectedRequestId -cne $requestId
    return [pscustomobject]@{
        state = if ($ready.Count -gt 0) { 'ready' } elseif ($waiting.Count -gt 0) { 'window_unavailable' } else { 'no_action' }
        requestId = $requestId
        expired = $expired
        mayAskUser = $ready.Count -gt 0 -and -not $expired
        targets = @($ready)
        resolvedTargets = @($resolved)
        unavailableTargets = @($waiting)
        requestState = if ($expired -and $resolved.Count -gt 0 -and $waiting.Count -eq 0 -and $ready.Count -eq 0) { 'completed' }
            elseif ($ready.Count -gt 0) { 'awaiting_user' } elseif ($waiting.Count -gt 0) { 'window_closed' } else { 'no_action' }
        activeSessionCount = @($Sessions | Where-Object { $_.closed -ne $true -and $_.detached -ne $true }).Count
        closedSessions = @($Sessions | Where-Object { $_.closed -eq $true } | Select-Object identity,closeReason,closedAt,completionConfirmed,targets)
    }
}
