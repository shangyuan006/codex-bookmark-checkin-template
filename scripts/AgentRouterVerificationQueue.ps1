. (Join-Path $PSScriptRoot 'AgentRouterAccount.ps1')
. (Join-Path $PSScriptRoot 'ManualVerification.ps1')

function Add-AgentRouterVerificationRequest([string]$Root, [string]$AccountKey, [datetime]$Now = (Get-Date), [string]$SessionMarker = '') {
    $key = ConvertTo-AgentRouterAccountKey $AccountKey
    $path = Join-Path $Root "tmp\agentrouter-verification-$key.json"
    if ($SessionMarker -and $SessionMarker -notmatch '^[a-f0-9]{32}$') { throw 'Invalid verification session marker.' }
    if ($SessionMarker -and (Test-Path -LiteralPath $path)) {
        $existing = Get-Content -Raw -LiteralPath $path | ConvertFrom-Json
        if ([string]$existing.sessionMarker -ceq $SessionMarker -and [string]$existing.date -eq (Get-ManualVerificationShanghaiDate $Now)) { return $path }
    }
    $request = [ordered]@{
        schemaVersion = 1
        state = 'pending'
        requestId = [guid]::NewGuid().ToString('N')
        accountKey = $key
        date = Get-ManualVerificationShanghaiDate $Now
        createdAt = $Now.ToUniversalTime().ToString('o')
        sessionMarker = $SessionMarker
    }
    Write-AgentRouterProviderState -Path $path -State $request
    return $path
}

function Complete-AgentRouterVerificationRequest([string]$Root, [string]$Path, $Config, [int]$ExitCode, [datetime]$Now = (Get-Date)) {
    if ($ExitCode -eq 75) { return $false }
    $request = Get-Content -Raw -Encoding UTF8 -LiteralPath $Path | ConvertFrom-Json
    $account = Resolve-AgentRouterAccountConfig -Accounts @($Config.agentrouterAccounts) -AccountKey $request.accountKey
    $reportPath = Join-Path $Root 'logs\latest.json'
    $report = if (Test-Path -LiteralPath $reportPath) { Get-Content -Raw -Encoding UTF8 -LiteralPath $reportPath | ConvertFrom-Json } else { $null }
    $selected = @($report.results | Where-Object { [string]$_.origin -eq [string]$account.origin } | ForEach-Object {
        if ($_.accountResults) { $_.accountResults } else { $_ }
    } | Where-Object { [string]$_.accountKey -eq [string]$request.accountKey })
    $confirmed = $ExitCode -in @(0, 2) -and [string]$request.date -eq (Get-ManualVerificationShanghaiDate $Now) `
        -and $report.runState -eq 'final' -and $report.isComplete -eq $true `
        -and [string]$report.runId -like "$($request.date)-*" -and $selected.Count -eq 1 `
        -and [string]$selected[0].status -in @('signed', 'already_signed') `
        -and $selected[0].evidence.authoritative -eq $true -and $null -ne $selected[0].evidence.binding `
        -and (Test-CheckinBoundSuccessEvidence $selected[0] $Now)
    $request.state = if ($confirmed) { 'complete' } else { 'needs_attention' }
    $request | Add-Member -NotePropertyName checkedAt -NotePropertyValue ((Get-Date).ToUniversalTime().ToString('o')) -Force
    Write-AgentRouterProviderState -Path $Path -State $request
    if ($confirmed -and [string]$account.provider -eq 'LinuxDO') {
        Remove-Item -LiteralPath (Join-Path $Root 'tmp\agentrouter-linuxdo-provider-state.json') -Force -ErrorAction SilentlyContinue
    }
    return $confirmed
}

function Invoke-PendingAgentRouterVerification([string]$Root, $Config, [datetime]$Now = (Get-Date)) {
    $tmp = Join-Path $Root 'tmp'
    $requests = @(Get-ChildItem -LiteralPath $tmp -Filter 'agentrouter-verification-*.json' -File -ErrorAction SilentlyContinue)
    if ($requests.Count -eq 0) { return }
    # Keep the ordinary manual-session and wrapper locks. Closing one isolated
    # account must never interfere with another browser that a human is using.
    if ((Test-Path -LiteralPath (Join-Path $tmp 'manual-session.json')) `
        -or (Test-Path -LiteralPath (Join-Path $tmp 'agentrouter-manual-state.json')) `
        -or (Test-ManualHandoffLaunchActive -Path (Join-Path $tmp 'manual-handoff-launch.json'))) { return }
    $mutexName = if ($Config.runMutexName) { [string]$Config.runMutexName } else { 'Local\CodexBookmarkCheckinRun' }
    $mutex = [System.Threading.Mutex]::new($false, "$mutexName-AccountVerificationQueue")
    $owned = $false
    try {
        try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
        if (-not $owned) { return }
        foreach ($file in $requests) {
            $request = Get-Content -Raw -Encoding UTF8 -LiteralPath $file.FullName | ConvertFrom-Json
            if ($request.schemaVersion -ne 1 -or [string]$request.state -ne 'pending' `
                -or [string]$request.requestId -notmatch '^[a-f0-9]{32}$' `
                -or [string]$request.accountKey -notmatch '^[a-z0-9][a-z0-9_-]{0,63}$') { continue }
            if ([string]$request.date -ne (Get-ManualVerificationShanghaiDate $Now)) {
                $request.state = 'expired'
                Write-AgentRouterProviderState -Path $file.FullName -State $request
                continue
            }
            $null = Resolve-AgentRouterAccountConfig -Accounts @($Config.agentrouterAccounts) -AccountKey $request.accountKey
            $shell = Resolve-AgentRouterPowerShellExecutable
            & $shell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $Root 'scripts\Run-Checkin.ps1') `
                -ReauthAccountKey ([string]$request.accountKey) -PostOAuthVerify -Attempts 1 -SuppressReport
            $code = $LASTEXITCODE
            if ($code -eq 75) { continue } # Durable request survives a busy wrapper.
            $confirmed = Complete-AgentRouterVerificationRequest -Root $Root -Path $file.FullName -Config $Config -ExitCode $code -Now (Get-Date)
            if ($confirmed) {
                Write-Output "Queued account verification completed for '$($request.accountKey)'."
            } else { Write-Warning "Queued account verification has no completion evidence for '$($request.accountKey)'; request retained for review." }
        }
    } finally {
        if ($owned) { [void]$mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}
