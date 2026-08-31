[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [Alias('AccountId')]
    [string]$AccountKey,
    [switch]$ProviderOnly,
    [switch]$AgentRouterOnly
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
    throw 'An Agent Router manual login state is already tracked. Close or complete it first.'
}
$existingProfileProcesses = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -ieq $browser.ProcessName -and $_.CommandLine -like "*$profile*"
})
if ($existingProfileProcesses.Count -gt 0) { throw 'The selected Agent Router profile is already in use.' }

$profilePreparer = Join-Path $root 'src\prepare-native-browser-profile.mjs'
& $node $profilePreparer $profile 'Default' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Unable to prepare the isolated Agent Router profile.' }

function Get-LinuxDoProviderSessionProbe {
    $probeScript = Join-Path $root 'src\oauth-provider-session.mjs'
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        # The probe intentionally exits nonzero for an indeterminate session;
        # its final JSON status must still be parsed before deciding the UI path.
        $ErrorActionPreference = 'Continue'
        $probeOutput = @(& $node $probeScript 'https://agentrouter.org' $provider `
            '--automation-user-data-dir' $profile 2>$null)
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    for ($index = $probeOutput.Count - 1; $index -ge 0; $index--) {
        try {
            $probe = [string]$probeOutput[$index] | ConvertFrom-Json
            if ([string]$probe.status -in @('valid', 'invalid', 'unknown', 'not_supported')) {
                $attempts = 0
                if (-not [int]::TryParse([string]$probe.attempts, [ref]$attempts) -or $attempts -lt 1) {
                    $attempts = 1
                }
                return [pscustomobject]@{
                    Status = [string]$probe.status
                    Attempts = $attempts
                }
            }
        }
        catch { }
    }
    return [pscustomobject]@{ Status = 'unknown'; Attempts = 0 }
}

function Write-LinuxDoProviderProbeLog($Probe, [string]$Stage) {
    $probeLog = [ordered]@{
        schemaVersion = 1
        stage = $Stage
        status = [string]$Probe.Status
        attempts = [int]$Probe.Attempts
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
        accountKey = $requestedAccountKey
        profile = $profile
        probeStatus = [string]$Probe.Status
        probeAttempts = [int]$Probe.Attempts
        closedAt = (Get-Date).ToUniversalTime().ToString('o')
    }
    [System.IO.Directory]::CreateDirectory((Split-Path -Parent $providerStagePath)) | Out-Null
    [System.IO.File]::WriteAllText(
        $providerStagePath,
        ($providerStage | ConvertTo-Json -Depth 4),
        [System.Text.UTF8Encoding]::new($false)
    )
}

if ($provider -eq 'LinuxDO' -and $ProviderOnly) {
    $existingProviderProbe = Get-LinuxDoProviderSessionProbe
    Write-LinuxDoProviderProbeLog $existingProviderProbe 'provider'
    if ([string]$existingProviderProbe.Status -eq 'valid') {
        Write-LinuxDoProviderStage $existingProviderProbe
        Write-Output "The LinuxDO provider session is already valid after $($existingProviderProbe.Attempts) bounded probe attempt(s); no visible provider page was opened. Continue with -AgentRouterOnly."
        return
    }
    if ([string]$existingProviderProbe.Status -ne 'invalid') {
        throw "The LinuxDO provider session is indeterminate after $($existingProviderProbe.Attempts) bounded probe attempt(s). No visible provider page was opened; retry later instead of logging in again."
    }
}

if ($provider -eq 'LinuxDO' -and $AgentRouterOnly) {
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
    $providerSessionProbe = Get-LinuxDoProviderSessionProbe
    Write-LinuxDoProviderProbeLog $providerSessionProbe 'agentrouter'
    if ([string]$providerSessionProbe.Status -eq 'unknown' -or [string]$providerSessionProbe.Status -eq 'not_supported') {
        throw "The LinuxDO provider session is indeterminate after $($providerSessionProbe.Attempts) bounded probe attempt(s). No Agent Router page was opened; retry later."
    }
    if ([string]$providerSessionProbe.Status -ne 'valid') {
        throw "The LinuxDO provider session is invalid after $($providerSessionProbe.Attempts) bounded probe attempt(s). Run -ProviderOnly again and complete LinuxDO login first."
    }

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
        '--private-result'
    )
    if ($null -ne $account.oauthWaitMs) {
        $oauthArguments += @('--wait-ms', [string]$account.oauthWaitMs)
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
    $automaticResult = $null
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
    if ([string]$automaticResult.status -eq 'logged_in') {
        if (@(Get-CimInstance Win32_Process | Where-Object {
            $_.Name -ieq $browser.ProcessName -and $_.CommandLine -like "*$profile*"
        }).Count -gt 0) {
            throw 'Automatic Agent Router OAuth completed but its isolated browser did not close.'
        }
        $powershell = Resolve-AgentRouterPowerShellExecutable
        & $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass `
            -File (Join-Path $PSScriptRoot 'Run-Checkin.ps1') `
            -ReauthAccountKey $requestedAccountKey `
            -PostOAuthVerify `
            -Attempts 1 `
            -SuppressReport
        $checkinExitCode = $LASTEXITCODE
        if ($checkinExitCode -ne 0) { exit $checkinExitCode }
        Remove-Item -LiteralPath $providerStagePath -Force -ErrorAction SilentlyContinue
        Write-Output "Executed one Agent Router OAuth for accountKey '$requestedAccountKey' and confirmed the authoritative account result without a second OAuth attempt."
        return
    }
    $safeOAuthStages = @(
        'target_login', 'provider_button', 'login_challenge', 'provider_transition',
        'linuxdo_session', 'provider_authorization', 'target_callback',
        'session_verification', 'checkin_verification', 'completed'
    )
    $safeAuthorizationOutcomes = @(
        'not_applicable', 'authorization_not_found', 'authorization_not_unique',
        'authorization_click_failed', 'authorization_clicked', 'authorization_completed'
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
    Write-Warning "Agent Router OAuth ended without a confirmed target session (stage=$failedStage, authorization=$failedAuthorization). Opening one native no-CDP Edge window for manual completion."
}

$launchMarker = [guid]::NewGuid().ToString('N')
$loginUrls = @('https://agentrouter.org/login')
if ($provider -eq 'LinuxDO' -and $ProviderOnly) {
    $loginUrls = @('https://linux.do/login')
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
$processStartedAt = try { $process.StartTime.ToUniversalTime().ToString('o') } catch { $null }
if (-not $processStartedAt) {
    [void]$process.CloseMainWindow()
    throw 'Unable to record the Agent Router browser process identity.'
}

[System.IO.Directory]::CreateDirectory((Split-Path -Parent $statePath)) | Out-Null
$state = [ordered]@{
    schemaVersion = 1
    accountKey = $requestedAccountKey
    profile = $profile
    pid = $process.Id
    startedAt = (Get-Date).ToUniversalTime().ToString('o')
    processStartedAt = $processStartedAt
    launchMarker = $launchMarker
    stage = if ($ProviderOnly) { 'provider' } else { 'agentrouter' }
}
[System.IO.File]::WriteAllText(
    $statePath,
    ($state | ConvertTo-Json -Depth 4),
    [System.Text.UTF8Encoding]::new($false)
)
if ($provider -eq 'LinuxDO' -and $ProviderOnly) {
    Write-Output "Opened only the LinuxDO provider login for accountKey '$requestedAccountKey' (PID $($process.Id)). Close this window after LinuxDO login, then run with -AgentRouterOnly."
}
else {
    Write-Output "Opened the isolated Agent Router login profile for accountKey '$requestedAccountKey' (PID $($process.Id))."
}
