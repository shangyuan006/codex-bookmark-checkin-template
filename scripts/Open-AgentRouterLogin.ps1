[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [Alias('AccountId')]
    [string]$AccountKey,
    [switch]$ProviderOnly,
    [switch]$AgentRouterOnly,
    [switch]$ContinueToAgentRouter,
    [switch]$OpenProviderWhenIndeterminate,
    [switch]$ExperimentalTurnstileFrameClick
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
. (Join-Path $PSScriptRoot 'Resolve-Runtime.ps1')
. (Join-Path $PSScriptRoot 'AgentRouterAccount.ps1')
$node = Resolve-CheckinNode $config
$browser = Resolve-CheckinBrowser $config

$requestedAccountKey = ConvertTo-AgentRouterAccountKey $AccountKey
$account = Resolve-AgentRouterAccountConfig -Accounts @($config.agentrouterAccounts) -AccountKey $requestedAccountKey
$provider = [string]$account.provider
if ($ProviderOnly -and $AgentRouterOnly) {
    throw 'ProviderOnly and AgentRouterOnly cannot be used together.'
}
if ($provider -eq 'LinuxDO' -and -not $ProviderOnly -and -not $AgentRouterOnly) {
    throw 'LinuxDO recovery is two-stage: run with -ProviderOnly first, close that window, then run with -AgentRouterOnly.'
}
if ($provider -ne 'LinuxDO' -and ($ProviderOnly -or $AgentRouterOnly)) {
    throw 'ProviderOnly and AgentRouterOnly are only valid for LinuxDO Agent Router accounts.'
}
if ($OpenProviderWhenIndeterminate -and ($provider -ne 'LinuxDO' -or -not $ProviderOnly)) {
    throw 'OpenProviderWhenIndeterminate is only valid with LinuxDO ProviderOnly recovery.'
}
if ($ContinueToAgentRouter -and ($provider -ne 'LinuxDO' -or -not $ProviderOnly)) {
    throw 'ContinueToAgentRouter is only valid with LinuxDO ProviderOnly recovery.'
}
if ($ExperimentalTurnstileFrameClick -and ($provider -ne 'LinuxDO' -or -not $AgentRouterOnly)) {
    throw 'ExperimentalTurnstileFrameClick is only valid with LinuxDO AgentRouterOnly recovery.'
}
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
$providerProbeLogPath = Join-Path $root 'tmp\agentrouter-linuxdo-provider-probe.json'
if (Test-Path -LiteralPath $statePath) {
    $trackedState = try {
        Get-Content -Raw -Encoding UTF8 -LiteralPath $statePath | ConvertFrom-Json
    }
    catch {
        throw 'The tracked Agent Router manual login state is unreadable; refusing to replace it.'
    }
    $trackedProfile = try { [System.IO.Path]::GetFullPath([string]$trackedState.profile) } catch { $null }
    $trackedStateMatches = [string]$trackedState.accountKey -eq $requestedAccountKey `
        -and $trackedProfile `
        -and [string]::Equals($trackedProfile, $profile, [System.StringComparison]::OrdinalIgnoreCase)
    if (-not $trackedStateMatches) {
        throw 'The tracked Agent Router manual login state belongs to a different account or profile.'
    }
    $trackedProcesses = @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -ieq $browser.ProcessName -and $_.CommandLine -like "*$profile*"
    })
    if ($trackedProcesses.Count -gt 0) {
        throw 'An Agent Router manual login state is already tracked. Close or complete it first.'
    }
    # A crashed or externally closed dedicated window can leave only this
    # transient marker behind. Reconcile that marker before starting a new
    # stage; the encrypted browser profile remains untouched.
    Remove-Item -LiteralPath $statePath -Force -ErrorAction Stop
}
$existingProfileProcesses = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -ieq $browser.ProcessName -and $_.CommandLine -like "*$profile*"
})
if ($existingProfileProcesses.Count -gt 0) { throw 'The selected Agent Router profile is already in use.' }

if ($provider -eq 'LinuxDO' -and (Test-Path -LiteralPath $providerStagePath)) {
    $pendingProviderStage = Get-Content -Raw -Encoding UTF8 -LiteralPath $providerStagePath | ConvertFrom-Json
    if ([string]$pendingProviderStage.stage -eq 'provider_pending') {
        # A closed native window is pending verification, not another login.
        & (Join-Path $PSScriptRoot 'Close-AgentRouterLogin.ps1') -AccountKey $requestedAccountKey `
            -ContinueToAgentRouter:($ContinueToAgentRouter -or $AgentRouterOnly)
        return
    }
}

$profilePreparer = Join-Path $root 'src\prepare-native-browser-profile.mjs'
& $node $profilePreparer $profile 'Default' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Unable to prepare the isolated Agent Router profile.' }

function Get-LinuxDoProviderSessionProbe {
    $diagnosticStage = if ($ProviderOnly) { 'manual_provider' } else { 'manual_target' }
    return Invoke-LinuxDoProviderSessionProbe -Root $root -Node $node -Profile $profile -DiagnosticStage $diagnosticStage
}

function Write-LinuxDoProviderProbeLog($Probe, [string]$Stage) {
    $probeLog = [ordered]@{
        schemaVersion = 1
        stage = $Stage
        status = [string]$Probe.Status
        attempts = [int]$Probe.Attempts
        challengeObserved = $Probe.ChallengeObserved -eq $true
        rateLimited = $Probe.RateLimited -eq $true
        checkedAt = (Get-Date).ToUniversalTime().ToString('o')
    }
    [System.IO.Directory]::CreateDirectory((Split-Path -Parent $providerProbeLogPath)) | Out-Null
    [System.IO.File]::WriteAllText(
        $providerProbeLogPath,
        ($probeLog | ConvertTo-Json -Depth 4),
        [System.Text.UTF8Encoding]::new($false)
    )
}

function Write-LinuxDoProviderStage($Probe) {
    $providerStage = [ordered]@{
        schemaVersion = 2
        stage = 'provider'
        accountKey = $requestedAccountKey
        profile = $profile
        probeStatus = [string]$Probe.Status
        probeAttempts = [int]$Probe.Attempts
        closedAt = (Get-Date).ToUniversalTime().ToString('o')
    }
    Write-AgentRouterProviderState -Path $providerStagePath -State $providerStage
}

function Mark-LinuxDoProviderStageForAgentRouter {
    if (-not (Test-Path -LiteralPath $providerStagePath)) { return }
    $providerStage = try { Get-Content -Raw -Encoding UTF8 -LiteralPath $providerStagePath | ConvertFrom-Json } catch { $null }
    if (-not $providerStage -or [string]$providerStage.accountKey -ne $requestedAccountKey) {
        throw 'The recorded LinuxDO provider stage does not match this accountKey.'
    }
    # ConvertFrom-Json returns a PSCustomObject whose shape may come from an
    # older provider-stage file without a stage property. Add/replace the
    # bounded marker explicitly so old state can be upgraded in place.
    $providerStage | Add-Member -MemberType NoteProperty -Name stage -Value 'agentrouter' -Force
    [System.IO.File]::WriteAllText(
        $providerStagePath,
        ($providerStage | ConvertTo-Json -Depth 4),
        [System.Text.UTF8Encoding]::new($false)
    )
}

function Get-AgentRouterTargetCompletionProbe {
    $probeScript = Join-Path $root 'src\probe-agentrouter-session.mjs'
    if (-not (Test-Path -LiteralPath $probeScript)) { return $null }
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $probeOutput = @(& $node $probeScript 'https://agentrouter.org' $requestedAccountKey 2>$null)
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    for ($index = $probeOutput.Count - 1; $index -ge 0; $index--) {
        try {
            $probe = [string]$probeOutput[$index] | ConvertFrom-Json
            if ([string]$probe.status -in @('already_signed', 'needs_attention')) {
                return [string]$probe.status
            }
        }
        catch { }
    }
    return $null
}

function Get-AgentRouterRecoveryAction {
    $probeScript = Join-Path $root 'src\probe-agentrouter-session.mjs'
    $probeOutput = @(& $node $probeScript 'https://agentrouter.org' $requestedAccountKey '--recovery-state' 2>$null)
    for ($index = $probeOutput.Count - 1; $index -ge 0; $index--) {
        try {
            $probe = [string]$probeOutput[$index] | ConvertFrom-Json
            if ([string]$probe.action -in @('restart', 'resume', 'complete')) { return [string]$probe.action }
        }
        catch { }
    }
    throw 'Unable to read the account recovery stage; no OAuth or manual window was started.'
}

function Invoke-AgentRouterAccountCheckin([switch]$VerifyOnly) {
    $powershell = Resolve-AgentRouterPowerShellExecutable
    $runArguments = @(
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', (Join-Path $PSScriptRoot 'Run-Checkin.ps1'),
        '-ReauthAccountKey', $requestedAccountKey, '-Attempts', '1', '-SuppressReport'
    )
    if ($VerifyOnly) { $runArguments += '-PostOAuthVerify' }
    & $powershell @runArguments | Out-Host
    return $LASTEXITCODE
}

if ($provider -eq 'LinuxDO' -and $ProviderOnly) {
    $existingProviderProbe = Get-LinuxDoProviderSessionProbe
    Write-LinuxDoProviderProbeLog $existingProviderProbe 'provider'
    if ([string]$existingProviderProbe.Status -eq 'valid') {
        Write-LinuxDoProviderStage $existingProviderProbe
        Write-Output "The LinuxDO provider session is already valid after $($existingProviderProbe.Attempts) bounded probe attempt(s); no visible provider page was opened. Continue with -AgentRouterOnly."
        if ($ContinueToAgentRouter) {
            & $PSCommandPath -AccountKey $requestedAccountKey -AgentRouterOnly
        }
        return
    }
    $providerChallengeHandoff = [string]$existingProviderProbe.Status -eq 'unknown' `
        -and $existingProviderProbe.ChallengeObserved -eq $true
    if ([string]$existingProviderProbe.Status -ne 'invalid' `
        -and -not $providerChallengeHandoff -and -not $OpenProviderWhenIndeterminate) {
        throw "The LinuxDO provider session is indeterminate after $($existingProviderProbe.Attempts) bounded probe attempt(s). No visible provider page was opened; retry later instead of logging in again."
    }
    if ($providerChallengeHandoff) {
        Write-Warning 'Cloudflare blocked the LinuxDO session probe; login expiry is not confirmed. Opening one native no-CDP provider window for verification, not an assumed re-login.'
    }
    elseif ([string]$existingProviderProbe.Status -ne 'invalid') {
        Write-Warning "The LinuxDO provider session is indeterminate after $($existingProviderProbe.Attempts) bounded probe attempt(s). Opening one native no-CDP provider window because OpenProviderWhenIndeterminate was explicitly requested."
    }
}

if ($provider -eq 'LinuxDO' -and $AgentRouterOnly) {
    $recoveryAction = Get-AgentRouterRecoveryAction
    if ($recoveryAction -eq 'complete') {
        # Reconcile the daily report even when only the per-account checkpoint
        # survived. No browser or provider probe is needed for a completed day.
        $checkinExitCode = Invoke-AgentRouterAccountCheckin
        if ($checkinExitCode -ne 0) { exit $checkinExitCode }
        Remove-Item -LiteralPath $providerStagePath -Force -ErrorAction SilentlyContinue
        Write-Output "Today's completed account result was reconciled without another OAuth or manual window."
        return
    }
    if (-not (Test-Path -LiteralPath $providerStagePath)) {
        throw 'No completed LinuxDO provider stage is recorded. Run with -ProviderOnly, finish login, and close that window first.'
    }
    $providerStage = try { Get-Content -Raw -Encoding UTF8 -LiteralPath $providerStagePath | ConvertFrom-Json } catch { $null }
    if (-not $providerStage -or [string]$providerStage.accountKey -ne $requestedAccountKey) {
        throw 'The recorded LinuxDO provider stage does not match this accountKey.'
    }
    $recordedProviderProfile = try { [System.IO.Path]::GetFullPath([string]$providerStage.profile) } catch { $null }
    if (-not $recordedProviderProfile -or -not [string]::Equals(
        $recordedProviderProfile,
        $profile,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw 'The recorded LinuxDO provider stage does not match the account profile.'
    }
    $recordedProviderClosedAt = [datetimeoffset]::MinValue
    $recordedProviderClosedAtParsed = $false
    if ($providerStage.closedAt -is [datetime]) {
        $recordedProviderClosedAt = [datetimeoffset]([datetime]$providerStage.closedAt).ToUniversalTime()
        $recordedProviderClosedAtParsed = $true
    }
    elseif ($providerStage.closedAt -is [datetimeoffset]) {
        $recordedProviderClosedAt = ([datetimeoffset]$providerStage.closedAt).ToUniversalTime()
        $recordedProviderClosedAtParsed = $true
    }
    else {
        $recordedProviderClosedAtParsed = [datetimeoffset]::TryParse(
            [string]$providerStage.closedAt,
            [ref]$recordedProviderClosedAt
        )
    }
    $recordedProviderStageIsFresh = [string]$providerStage.probeStatus -eq 'valid' `
        -and $recordedProviderClosedAtParsed `
        -and ([datetimeoffset]::UtcNow - $recordedProviderClosedAt.ToUniversalTime()).TotalSeconds -ge -60 `
        -and ([datetimeoffset]::UtcNow - $recordedProviderClosedAt.ToUniversalTime()).TotalMinutes -le 5
    $providerSessionProbe = Get-LinuxDoProviderSessionProbe
    Write-LinuxDoProviderProbeLog $providerSessionProbe 'agentrouter'
    if ([string]$providerSessionProbe.Status -eq 'unknown' -or [string]$providerSessionProbe.Status -eq 'not_supported') {
        if (-not $recordedProviderStageIsFresh) {
            throw "The LinuxDO provider session is indeterminate after $($providerSessionProbe.Attempts) bounded probe attempt(s). No Agent Router page was opened; retry later."
        }
        Write-Warning "The immediate LinuxDO provider recheck is indeterminate after $($providerSessionProbe.Attempts) bounded probe attempt(s); continuing from the fresh explicit valid provider stage."
    }
    elseif ([string]$providerSessionProbe.Status -ne 'valid') {
        throw "The LinuxDO provider session is invalid after $($providerSessionProbe.Attempts) bounded probe attempt(s). Run -ProviderOnly again and complete LinuxDO login first."
    }

    if ($recoveryAction -eq 'restart') {
        # The automatic run may have stopped BEFORE target logout. Let the
        # daily state machine establish that boundary before any login-only helper.
        $checkinExitCode = Invoke-AgentRouterAccountCheckin
        if ($checkinExitCode -eq 0) {
            Remove-Item -LiteralPath $providerStagePath -Force -ErrorAction SilentlyContinue
            Write-Output "Resumed the full daily account flow and reconciled its authoritative result."
            return
        }
        $recoveryAction = Get-AgentRouterRecoveryAction
        if ($recoveryAction -ne 'resume') {
            throw 'The daily account flow stopped before a verified logout; its pending result was retained. No login-only OAuth or misleading target window was opened.'
        }
    }

    $automaticResult = $null
    $oauthArguments = @(
        (Join-Path $root 'src\oauth-login.mjs'),
        'https://agentrouter.org',
        $provider,
        '--login-url',
        'https://agentrouter.org/login',
        '--automation-user-data-dir',
        $profile,
        '--account-id',
        $requestedAccountKey,
        '--agent-router-only',
        '--provider-session-confirmed',
        '--diagnostic-stage',
        'manual_target_oauth',
        '--private-result'
    )
    if ($null -ne $account.oauthWaitMs) {
        $oauthArguments += @('--wait-ms', [string]$account.oauthWaitMs)
    }
    if ($ExperimentalTurnstileFrameClick) {
        $oauthArguments += '--experimental-sso-frame-click'
    }
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        # oauth-login emits private stage markers on stderr; they are progress,
        # not PowerShell failures. The final JSON status remains authoritative.
        $ErrorActionPreference = 'Continue'
        $automaticOutput = @(& $node @oauthArguments 2>$null)
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    for ($index = $automaticOutput.Count - 1; $index -ge 0; $index--) {
        try {
            $candidate = [string]$automaticOutput[$index] | ConvertFrom-Json
            if ([string]$candidate.status -in @('logged_in', 'needs_attention')) {
                $automaticResult = $candidate
                break
            }
        }
        catch { }
    }
    if ($ExperimentalTurnstileFrameClick) {
        $safeExperimentalOutcomes = @(
            'not_exercised', 'not_observed', 'observed_auto_resolved',
            'semantic_clicked', 'frame_clicked', 'observed_not_clickable', 'click_failed'
        )
        $experimentalOutcome = if ([string]$automaticResult.experimentalSsoChallengeOutcome -in $safeExperimentalOutcomes) {
            [string]$automaticResult.experimentalSsoChallengeOutcome
        }
        else { 'not_exercised' }
        Write-Output "Experimental LinuxDO SSO Turnstile outcome: $experimentalOutcome."
    }
    if ($provider -eq 'LinuxDO') {
        $safeProviderAuthorizationChallengeOutcomes = @(
            'not_observed', 'observed_not_clickable', 'observed_auto_resolved',
            'clicked_once', 'clicked_twice', 'resolved_after_click', 'unresolved_after_click'
        )
        $providerAuthorizationChallengeOutcome = if (
            [string]$automaticResult.providerAuthorizationChallengeOutcome -in $safeProviderAuthorizationChallengeOutcomes
        ) {
            [string]$automaticResult.providerAuthorizationChallengeOutcome
        }
        else { 'not_exercised' }
        $providerAuthorizationChallengeClicks = 0
        if ($null -ne $automaticResult.providerAuthorizationChallengeClicks) {
            $candidateClicks = [int]$automaticResult.providerAuthorizationChallengeClicks
            if ($candidateClicks -ge 0 -and $candidateClicks -le 10) {
                $providerAuthorizationChallengeClicks = $candidateClicks
            }
        }
        Write-Output "LinuxDO authorization Turnstile outcome: $providerAuthorizationChallengeOutcome (clicks=$providerAuthorizationChallengeClicks)."
    }
    if ([string]$automaticResult.status -eq 'logged_in') {
        if (@(Get-CimInstance Win32_Process | Where-Object {
            $_.Name -ieq $browser.ProcessName -and $_.CommandLine -like "*$profile*"
        }).Count -gt 0) {
            throw 'Automatic Agent Router OAuth completed but its isolated browser did not close.'
        }
        $checkinExitCode = Invoke-AgentRouterAccountCheckin -VerifyOnly
        if ($checkinExitCode -ne 0) { exit $checkinExitCode }
        Remove-Item -LiteralPath $providerStagePath -Force -ErrorAction SilentlyContinue
        Write-Output "Executed one Agent Router OAuth for accountKey '$requestedAccountKey' and confirmed the authoritative account result without a second OAuth attempt."
        return
    }
    $safeOAuthStages = @(
        'target_login', 'provider_button', 'login_challenge', 'provider_transition',
        'linuxdo_session', 'linuxdo_login_challenge', 'provider_session',
        'provider_authorization', 'target_callback',
        'session_verification', 'checkin_verification', 'completed'
    )
    $safeAuthorizationOutcomes = @(
        'not_applicable', 'authorization_not_found', 'authorization_not_unique',
        'authorization_click_failed', 'authorization_clicked', 'authorization_completed',
        'provider_challenge_not_clickable', 'provider_challenge_unresolved'
    )
    $failedStage = if ([string]$automaticResult.oauthStage -in $safeOAuthStages) {
        [string]$automaticResult.oauthStage
    }
    else { 'unknown' }
    $failedAuthorization = if ([string]$automaticResult.authorizationOutcome -in $safeAuthorizationOutcomes) {
        [string]$automaticResult.authorizationOutcome
    }
    else { 'not_observed' }
    Write-Warning "Automatic Agent Router OAuth did not complete (stage=$failedStage, authorization=$failedAuthorization)."
    if (@(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -ieq $browser.ProcessName -and $_.CommandLine -like "*$profile*"
    }).Count -gt 0) {
        throw 'Automatic Agent Router OAuth failed while its isolated browser remained open; refusing to open a second window.'
    }
    $targetCompletionProbe = Get-AgentRouterTargetCompletionProbe
    if ($targetCompletionProbe -eq 'already_signed') {
        # A probe is read-only. Persist the account checkpoint and merged daily
        # result through the same verifier used after successful OAuth.
        $checkinExitCode = Invoke-AgentRouterAccountCheckin -VerifyOnly
        if ($checkinExitCode -ne 0) { exit $checkinExitCode }
        if ($AgentRouterOnly) {
            Remove-Item -LiteralPath $providerStagePath -Force -ErrorAction SilentlyContinue
        }
        Write-Output "Automatic Agent Router OAuth did not complete, but the isolated target session authoritatively confirms today's check-in; no visible manual window was opened."
        return
    }
    Write-Warning "Agent Router OAuth ended without a confirmed target session (stage=$failedStage, authorization=$failedAuthorization). Opening one native no-CDP Edge window for manual completion."
}

$launchMarker = [guid]::NewGuid().ToString('N')
$loginUrls = @('https://agentrouter.org/login')
if ($provider -eq 'LinuxDO' -and $ProviderOnly) {
    $loginUrls = if ($providerChallengeHandoff) { @('https://linux.do/') } else { @('https://linux.do/login') }
}
$arguments = @(
    "--user-data-dir=$profile",
    '--profile-directory=Default',
    '--new-window',
    "--checkin-launch=$launchMarker",
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-component-update',
    '--window-position=60,60',
    '--window-size=1400,900'
)
$arguments += $loginUrls
$process = Start-Process -FilePath ([string]$browser.Executable) -ArgumentList $arguments -PassThru
$stableWindow = Wait-CheckinVisibleBrowserWindow `
    -Config $config `
    -ProfilePath $profile `
    -LaunchMarker $launchMarker
if (-not $stableWindow) {
    $markedProcesses = @(Get-CheckinProfileBrowserProcesses -Config $config -ProfilePath $profile | Where-Object {
        $_.CommandLine -like "*--checkin-launch=$launchMarker*"
    })
    foreach ($markedProcess in $markedProcesses) {
        $candidate = Get-Process -Id ([int]$markedProcess.ProcessId) -ErrorAction SilentlyContinue
        if ($candidate -and $candidate.MainWindowHandle -ne 0) { [void]$candidate.CloseMainWindow() }
    }
    throw 'The Agent Router browser did not expose one stable visible window; no manual login state was recorded.'
}
$processId = [int]$stableWindow.ProcessId
$processStartedAt = [string]$stableWindow.ProcessStartedAt

[System.IO.Directory]::CreateDirectory((Split-Path -Parent $statePath)) | Out-Null
$state = [ordered]@{
    schemaVersion = 1
    accountKey = $requestedAccountKey
    profile = $profile
    pid = $processId
    startedAt = (Get-Date).ToUniversalTime().ToString('o')
    processStartedAt = $processStartedAt
    launchMarker = $launchMarker
    stage = if ($ProviderOnly) { 'provider' } else { 'agentrouter' }
    continueToAgentRouter = $ContinueToAgentRouter.IsPresent
}
[System.IO.File]::WriteAllText(
    $statePath,
    ($state | ConvertTo-Json -Depth 4),
    [System.Text.UTF8Encoding]::new($false)
)
if ($provider -eq 'LinuxDO' -and $AgentRouterOnly) {
    Mark-LinuxDoProviderStageForAgentRouter
}
if ($provider -eq 'LinuxDO' -and $ProviderOnly) {
    $providerPurpose = if ($providerChallengeHandoff) { 'verification (session probe blocked by Cloudflare)' } else { 'login' }
    Write-Output "Opened only the LinuxDO provider $providerPurpose for accountKey '$requestedAccountKey' (PID $processId) after confirming and foregrounding one stable window. Close this window after provider verification, then run with -AgentRouterOnly."
    if ($ContinueToAgentRouter) {
        $closureDeadline = (Get-Date).AddMinutes(10)
        do {
            $running = @(Get-CheckinManualSessionBrowserProcesses -Config $config -ProfilePath $profile -State $state)
            if ($running.Count -eq 0) { break }
            Start-Sleep -Seconds 1
        } while ((Get-Date) -lt $closureDeadline)
        if ($running.Count -eq 0 -and (Test-Path -LiteralPath $statePath)) {
            & (Join-Path $PSScriptRoot 'Close-AgentRouterLogin.ps1') -AccountKey $requestedAccountKey -ContinueToAgentRouter
        }
        elseif ($running.Count -gt 0) {
            Write-Warning 'The native LinuxDO window is still open; its pending stage was retained without assuming login success.'
        }
    }
}
else {
    Write-Output "Opened the isolated Agent Router login profile for accountKey '$requestedAccountKey' (PID $processId) after confirming and foregrounding one stable window."
}
