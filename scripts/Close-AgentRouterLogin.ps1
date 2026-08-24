[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [Alias('AccountId')]
    [string]$AccountKey
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

$statePath = Join-Path $root 'tmp\agentrouter-manual-state.json'
if (-not (Test-Path -LiteralPath $statePath)) {
    Write-Output 'No Agent Router manual login state is active.'
    return
}
$state = Get-Content -Raw -Encoding UTF8 -LiteralPath $statePath | ConvertFrom-Json
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
    Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
    Write-Output 'The Agent Router process has exited; the stale state record was removed.'
    return
}

$process = Get-Process -Id $trackedPid -ErrorAction SilentlyContinue
$recordedStart = [datetime]::MinValue
$recordedStartValid = [datetime]::TryParse([string]$state.processStartedAt, [ref]$recordedStart)
$processIdentityMatches = $process -and $recordedStartValid
if ($processIdentityMatches -and -not $rebound) {
    $processIdentityMatches = [Math]::Abs(
        ($process.StartTime.ToUniversalTime() - $recordedStart.ToUniversalTime()).TotalSeconds
    ) -le 2
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

$stage = [string]$state.stage
if ($stage -eq 'provider') {
    $providerStagePath = Join-Path $root 'tmp\agentrouter-linuxdo-provider-state.json'
    $providerStage = [ordered]@{
        schemaVersion = 1
        accountKey = $requestedAccountKey
        profile = $profile
        closedAt = (Get-Date).ToUniversalTime().ToString('o')
    }
    [System.IO.File]::WriteAllText(
        $providerStagePath,
        ($providerStage | ConvertTo-Json -Depth 4),
        [System.Text.UTF8Encoding]::new($false)
    )
}
Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
if ($stage -eq 'provider') {
    Write-Output "Closed the LinuxDO provider login window for accountKey '$requestedAccountKey' and recorded the provider stage."
}
else {
    Write-Output "Closed the Agent Router manual login window for accountKey '$requestedAccountKey'."
}
