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

if ($provider -eq 'LinuxDO' -and $AgentRouterOnly) {
    $providerStagePath = Join-Path $root 'tmp\agentrouter-linuxdo-provider-state.json'
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
    $probeScript = Join-Path $root 'src\oauth-provider-session.mjs'
    $probeOutput = @(& $node $probeScript 'https://agentrouter.org' $provider `
        '--automation-user-data-dir' $profile 2>$null)
    $providerSessionStatus = 'unknown'
    for ($index = $probeOutput.Count - 1; $index -ge 0; $index--) {
        try {
            $probe = [string]$probeOutput[$index] | ConvertFrom-Json
            if ([string]$probe.status -in @('valid', 'invalid', 'unknown', 'not_supported')) {
                $providerSessionStatus = [string]$probe.status
                break
            }
        }
        catch { }
    }
    if ($providerSessionStatus -ne 'valid') {
        throw "The LinuxDO provider session is not confirmed ($providerSessionStatus). Run -ProviderOnly again and complete LinuxDO login first."
    }
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
elseif ($provider -eq 'LinuxDO') {
    Write-Output "Opened only the Agent Router OAuth login for accountKey '$requestedAccountKey' (PID $($process.Id)); the saved LinuxDO session will be reused."
}
else {
    Write-Output "Opened the isolated Agent Router login profile for accountKey '$requestedAccountKey' (PID $($process.Id))."
}
