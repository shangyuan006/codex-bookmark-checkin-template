[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$AccountKey)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Resolve-Runtime.ps1')
. (Join-Path $PSScriptRoot 'AgentRouterAccount.ps1')
$config = Get-Content -Raw -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
$account = Resolve-AgentRouterAccountConfig -Accounts @($config.agentrouterAccounts) -AccountKey $AccountKey
$sourcePath = Join-Path $root 'tmp\agentrouter-native-state.json'
$statePath = Join-Path $root 'tmp\agentrouter-manual-state.json'
$state = Get-Content -Raw -LiteralPath $sourcePath | ConvertFrom-Json
$profile = if ([IO.Path]::IsPathRooted([string]$account.automationUserDataDir)) {
    [IO.Path]::GetFullPath([string]$account.automationUserDataDir)
} else { [IO.Path]::GetFullPath((Join-Path $root ([string]$account.automationUserDataDir))) }
$dataRoot = [IO.Path]::GetFullPath((Join-Path $root 'data')).TrimEnd('\') + '\'
if ($account.provider -ne 'LinuxDO' -or $state.stage -ne 'automatic_native' -or $state.accountKey -cne $AccountKey `
    -or -not $profile.StartsWith($dataRoot, [StringComparison]::OrdinalIgnoreCase) `
    -or -not [string]::Equals([IO.Path]::GetFullPath([string]$state.profile), $profile, [StringComparison]::OrdinalIgnoreCase) `
    -or [string]$state.launchMarker -notmatch '^[a-f0-9]{32}$' -or [int]$state.nativeDebugPort -lt 1024 -or [int]$state.nativeDebugPort -gt 65535) {
    throw 'Automatic native recovery identity is invalid.'
}
if (Test-Path -LiteralPath $statePath) {
    $tracked = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
    if ($tracked.accountKey -cne $AccountKey -or $tracked.launchMarker -cne $state.launchMarker `
        -or [int]$tracked.nativeDebugPort -ne [int]$state.nativeDebugPort `
        -or -not [string]::Equals([string]$tracked.profile, $profile, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'A different manual OAuth session is already tracked.'
    }
}
$processes = @(Get-CheckinManualSessionBrowserProcesses -Config $config -ProfilePath $profile -State $state)
if ($processes.Count -eq 0) {
    # An empty matching set must not hide another process occupying the profile.
    if (@(Get-CheckinProfileBrowserProcesses -Config $config -ProfilePath $profile).Count -gt 0) {
        throw 'The profile is occupied by a different browser; preserving the recovery record.'
    }
    Remove-Item -LiteralPath $sourcePath -Force
    return
}
$process = Get-Process -Id ([int]$state.pid) -ErrorAction Stop
if (-not (Test-CheckinProcessStartIdentity -Process $process -RecordedStart $state.processStartedAt)) {
    throw 'Automatic native process identity changed; preserving the recovery record.'
}
$rootProcess = @($processes | Where-Object { [int]$_.ProcessId -eq [int]$state.pid `
    -and $_.CommandLine -match "(?:^|\s)--checkin-launch=$($state.launchMarker)(?:\s|$)" `
    -and $_.CommandLine -match "(?:^|\s)--remote-debugging-port=$($state.nativeDebugPort)(?:\s|$)" })
if ($rootProcess.Count -ne 1) { throw 'Automatic native port/marker identity changed.' }
if (-not (Test-Path -LiteralPath $statePath)) {
    $state.stage = 'agentrouter'
    $temporaryPath = "$statePath.$PID.tmp"
    try {
        [IO.File]::WriteAllText($temporaryPath, ($state | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporaryPath -Destination $statePath -ErrorAction Stop
    } finally { if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath -Force } }
}
$node = Resolve-CheckinNode $config
$helper = Join-Path $root 'src\native-oauth-continuation.mjs'
$output = @(& $node $helper ([string]$state.nativeDebugPort) $AccountKey)
$result = try { [string]$output[-1] | ConvertFrom-Json } catch { $null }
if ($result.status -eq 'logged_in' -and $result.oauthStage -eq 'completed') {
    & (Join-Path $PSScriptRoot 'Complete-AgentRouterLogin.ps1') -AccountKey $AccountKey -ExpectedLaunchMarker ([string]$state.launchMarker)
    if ($LASTEXITCODE -notin @(0,75)) { throw 'Recovered login still requires daily reward verification.' }
    Remove-Item -LiteralPath $sourcePath -Force
    return
}
# Promote this exact retained window; never launch another OAuth attempt.
$null = @(& $node $helper ([string]$state.nativeDebugPort) $AccountKey --show-window)
$visible = Wait-CheckinVisibleBrowserWindow -Config $config -ProfilePath $profile -LaunchMarker ([string]$state.launchMarker)
if (-not $visible) { throw 'Retained native window is not confirmed visible; state is preserved.' }
$latest = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
if ($latest.launchMarker -cne $state.launchMarker) { throw 'Retained native session changed.' }
$latest | Add-Member -NotePropertyName nativeContinuationReady -NotePropertyValue $true -Force
Write-AgentRouterProviderState -Path $statePath -State $latest
$shell = Resolve-AgentRouterPowerShellExecutable
Start-Process -FilePath $shell -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
    ('"' + (Join-Path $PSScriptRoot 'Watch-AgentRouterLogin.ps1') + '"'), '-AccountKey', $AccountKey,
    '-SessionMarker', [string]$state.launchMarker) -WindowStyle Hidden | Out-Null
Remove-Item -LiteralPath $sourcePath -Force
Write-Output 'Recovered and retained the original native OAuth window; no new login was started.'
