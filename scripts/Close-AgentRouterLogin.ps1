[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [Alias('AccountId')]
    [string]$AccountKey,
    [switch]$ContinueToAgentRouter
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Resolve-Runtime.ps1')
. (Join-Path $PSScriptRoot 'AgentRouterAccount.ps1')
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
$requestedAccountKey = ConvertTo-AgentRouterAccountKey $AccountKey
$account = Resolve-AgentRouterAccountConfig -Accounts @($config.agentrouterAccounts) -AccountKey $requestedAccountKey
$profileValue = [string]$account.automationUserDataDir
if (-not $profileValue) { throw 'The Agent Router account has no automationUserDataDir.' }
$profile = if ([System.IO.Path]::IsPathRooted($profileValue)) {
    [System.IO.Path]::GetFullPath($profileValue)
}
else {
    [System.IO.Path]::GetFullPath((Join-Path $root $profileValue))
}
$dataRoot = [System.IO.Path]::GetFullPath((Join-Path $root 'data')).TrimEnd('\') + '\'
if (-not $profile.StartsWith($dataRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'The Agent Router profile must stay inside the project data directory.'
}

$statePath = Join-Path $root 'tmp\agentrouter-manual-state.json'
$providerStagePath = Join-Path $root 'tmp\agentrouter-linuxdo-provider-state.json'
$pendingRecheck = $false
if (Test-Path -LiteralPath $statePath) {
    $state = Get-Content -Raw -Encoding UTF8 -LiteralPath $statePath | ConvertFrom-Json
}
else {
    $state = if (Test-Path -LiteralPath $providerStagePath) {
        Get-Content -Raw -Encoding UTF8 -LiteralPath $providerStagePath | ConvertFrom-Json
    } else { $null }
    if (-not $state -or [string]$state.stage -ne 'provider_pending') {
        Write-Output 'No Agent Router manual login state is active.'
        return
    }
    $pendingRecheck = $true
}
if ([string]$state.accountKey -ne $requestedAccountKey) {
    throw 'The tracked manual login state belongs to a different accountKey.'
}
$recordedProfile = try { [System.IO.Path]::GetFullPath([string]$state.profile) } catch { $null }
if (-not $recordedProfile -or -not [string]::Equals(
    $recordedProfile,
    $profile,
    [System.StringComparison]::OrdinalIgnoreCase
)) {
    throw 'The tracked manual login profile does not match the account configuration.'
}

if ($pendingRecheck -and -not (Test-AgentRouterProviderProbeDue $state)) {
    Write-Output 'The closed LinuxDO provider stage is waiting for its next bounded probe; no browser was opened.'
    return
}
if (-not $pendingRecheck) {
    $processes = @(Get-CheckinManualSessionBrowserProcesses -Config $config -ProfilePath $profile -State $state)
    $trackedPid = 0
    if (-not [int]::TryParse([string]$state.pid, [ref]$trackedPid) -or $trackedPid -le 0) {
        throw 'The tracked Agent Router PID is invalid.'
    }
    $tracked = @($processes | Where-Object { [int]$_.ProcessId -eq $trackedPid } | Select-Object -First 1)[0]
    $rebound = $false
    if (-not $tracked -and $processes.Count -eq 1) {
        $tracked = $processes[0]
        $trackedPid = [int]$tracked.ProcessId
        $rebound = $true
    }
    if (-not $tracked) {
        if ($processes.Count -gt 0) {
            throw 'The tracked PID is stale while the dedicated profile is still in use; refusing to close unknown processes.'
        }
        Write-Output 'The Agent Router process has exited; reconciling its recorded stage.'
    }

    if ($tracked) {
        $process = Get-Process -Id $trackedPid -ErrorAction SilentlyContinue
        $processIdentityMatches = $false
        if (-not $rebound) {
            $processIdentityMatches = Test-CheckinProcessStartIdentity `
                -Process $process `
                -RecordedStart $state.processStartedAt `
                -ToleranceSeconds 2
        }
        if ($rebound) { $processIdentityMatches = [bool]$process }
        if (-not $processIdentityMatches) {
            throw 'The Agent Router process identity check failed; refusing to close a potentially reused PID.'
        }

        $closeTargets = @($processes | ForEach-Object {
            Get-Process -Id ([int]$_.ProcessId) -ErrorAction SilentlyContinue
        } | Where-Object { $_.MainWindowHandle -ne 0 })
        if ($closeTargets.Count -eq 0) { $closeTargets = @($process) }
        foreach ($closeTarget in $closeTargets) { [void]$closeTarget.CloseMainWindow() }
        $deadline = (Get-Date).AddSeconds(20)
        do {
            Start-Sleep -Milliseconds 500
            $remaining = @(Get-CheckinManualSessionBrowserProcesses -Config $config -ProfilePath $profile -State $state)
        } while ($remaining.Count -gt 0 -and (Get-Date) -lt $deadline)
        if ($remaining.Count -gt 0) { throw 'The Agent Router manual login window did not close normally.' }
    }
}

$stage = if ($pendingRecheck) { 'provider' } else { [string]$state.stage }
if (@(Get-CheckinProfileBrowserProcesses -Config $config -ProfilePath $profile).Count -gt 0) {
    throw 'The dedicated profile is still in use; no provider probe or next login stage was started.'
}
if ($stage -eq 'provider') {
    if ([string]$account.provider -ne 'LinuxDO') {
        throw 'Only LinuxDO accounts can have a closed provider verification stage.'
    }
    $failureCount = 0
    if ($pendingRecheck) { [void][int]::TryParse([string]$state.verificationFailures, [ref]$failureCount) }
    $failureCount = [Math]::Max(0, [Math]::Min(20, $failureCount)) + 1
    $checkedAt = [datetimeoffset]::UtcNow
    $pendingStage = [ordered]@{
        schemaVersion = 3
        stage = 'provider_pending'
        accountKey = $requestedAccountKey
        profile = $profile
        continueToAgentRouter = $ContinueToAgentRouter -or $state.continueToAgentRouter -eq $true
        closedAt = if ($pendingRecheck) { $state.closedAt } else { $checkedAt.ToString('o') }
        probeStatus = 'unknown'
        verificationFailures = $failureCount
        checkedAt = $checkedAt.ToString('o')
        nextProbeAt = $checkedAt.AddMinutes((Get-AgentRouterProviderProbeBackoffMinutes $failureCount)).ToString('o')
    }
    # Save recovery before probing or deleting the window marker. A failed or
    # interrupted probe must not send the scheduler back to opening LinuxDO.
    Write-AgentRouterProviderState -Path $providerStagePath -State $pendingStage
    if (Test-Path -LiteralPath $statePath) {
        Remove-Item -LiteralPath $statePath -Force -ErrorAction Stop
    }
    $node = Resolve-CheckinNode $config
    $probe = Invoke-LinuxDoProviderSessionProbe -Root $root -Node $node -Profile $profile `
        -DiagnosticStage 'manual_provider_after_close'
    $probeLog = [ordered]@{
        schemaVersion = 1
        stage = 'provider_after_close'
        status = [string]$probe.Status
        attempts = [int]$probe.Attempts
        challengeObserved = $probe.ChallengeObserved -eq $true
        rateLimited = $probe.RateLimited -eq $true
        checkedAt = (Get-Date).ToUniversalTime().ToString('o')
    }
    [System.IO.File]::WriteAllText(
        (Join-Path $root 'tmp\agentrouter-linuxdo-provider-probe.json'),
        ($probeLog | ConvertTo-Json -Depth 4),
        [System.Text.UTF8Encoding]::new($false)
    )
    if ([string]$probe.Status -ne 'valid') {
        if ([string]$probe.Status -eq 'invalid') {
            Remove-Item -LiteralPath $providerStagePath -Force -ErrorAction Stop
            throw 'The LinuxDO provider session is confirmed invalid. No valid stage or Agent Router login was assumed; provider login may now be retried.'
        }
        $pendingStage.probeStatus = [string]$probe.Status
        $pendingStage.probeAttempts = [int]$probe.Attempts
        $pendingStage.challengeObserved = $probe.ChallengeObserved -eq $true
        $pendingStage.rateLimited = $probe.RateLimited -eq $true
        $pendingStage.nextProbeAt = ([datetimeoffset]::UtcNow).AddMinutes(
            (Get-AgentRouterProviderProbeBackoffMinutes $failureCount ($probe.RateLimited -eq $true))
        ).ToString('o')
        Write-AgentRouterProviderState -Path $providerStagePath -State $pendingStage
        throw "The LinuxDO window closed, but its provider session is $($probe.Status). No valid stage or Agent Router login was assumed. The closed stage is retained for a later bounded probe, without reopening LinuxDO."
    }
    $providerStage = [ordered]@{
        schemaVersion = 2
        stage = 'provider'
        accountKey = $requestedAccountKey
        profile = $profile
        probeStatus = [string]$probe.Status
        probeAttempts = [int]$probe.Attempts
        closedAt = (Get-Date).ToUniversalTime().ToString('o')
    }
    Write-AgentRouterProviderState -Path $providerStagePath -State $providerStage
}
if ($stage -eq 'provider') {
    Write-Output "Closed the LinuxDO provider window for accountKey '$requestedAccountKey' and recorded its verified session."
    if ($ContinueToAgentRouter -or $state.continueToAgentRouter -eq $true) {
        & (Join-Path $PSScriptRoot 'Open-AgentRouterLogin.ps1') -AccountKey $requestedAccountKey -AgentRouterOnly
    }
}
else {
    Remove-Item -LiteralPath $statePath -Force -ErrorAction Stop
    Write-Output "Closed the Agent Router manual login window for accountKey '$requestedAccountKey'."
}
