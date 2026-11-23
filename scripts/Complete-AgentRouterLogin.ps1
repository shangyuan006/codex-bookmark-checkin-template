[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [Alias('AccountId')]
    [string]$AccountKey,
    [ValidatePattern('^[a-f0-9]{32}$')][string]$ExpectedLaunchMarker
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'AgentRouterAccount.ps1')
. (Join-Path $PSScriptRoot 'AgentRouterVerificationQueue.ps1')
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
$requestedAccountKey = ConvertTo-AgentRouterAccountKey $AccountKey
$account = Resolve-AgentRouterAccountConfig -Accounts @($config.agentrouterAccounts) -AccountKey $requestedAccountKey
$statePath = Join-Path $root 'tmp\agentrouter-manual-state.json'
$completionMutex = [System.Threading.Mutex]::new($false, "Local\CheckinOAuthComplete_$requestedAccountKey")
$completionOwned = $false
try {
try { $completionOwned = $completionMutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $completionOwned = $true }
if (-not $completionOwned) { exit 75 }
if (-not (Test-Path -LiteralPath $statePath)) {
    $requestPath = Join-Path $root "tmp\agentrouter-verification-$requestedAccountKey.json"
    if ($ExpectedLaunchMarker -and (Test-Path -LiteralPath $requestPath)) {
        $previous = Get-Content -Raw -LiteralPath $requestPath | ConvertFrom-Json
        if ([string]$previous.sessionMarker -ceq $ExpectedLaunchMarker -and [string]$previous.date -eq (Get-ManualVerificationShanghaiDate (Get-Date))) {
            if ([string]$previous.state -eq 'complete') { exit 0 }
            exit 75
        }
    }
    throw 'There is no Agent Router manual login state to complete.'
}
$state = Get-Content -Raw -Encoding UTF8 -LiteralPath $statePath | ConvertFrom-Json
if ([string]$state.accountKey -ne $requestedAccountKey -or ($ExpectedLaunchMarker -and [string]$state.launchMarker -cne $ExpectedLaunchMarker)) {
    throw 'The OAuth completion belongs to a different tracked session.'
}
$expectedProfile = if ([System.IO.Path]::IsPathRooted([string]$account.automationUserDataDir)) {
    [System.IO.Path]::GetFullPath([string]$account.automationUserDataDir)
} else { [System.IO.Path]::GetFullPath((Join-Path $root ([string]$account.automationUserDataDir))) }
if (-not [string]::Equals([System.IO.Path]::GetFullPath([string]$state.profile), $expectedProfile, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'The OAuth completion profile does not match the configured account.'
}
if ([string]$account.provider -eq 'LinuxDO' -and [string]$state.stage -ne 'agentrouter') {
    throw 'LinuxDO completion requires the Agent Router stage. Close the provider stage first, then open with -AgentRouterOnly.'
}

# Persist before closing too: a crash between window closure and the wrapper
# must leave the account queued, even while another manual profile is occupied.
$verificationRequestPath = Add-AgentRouterVerificationRequest -Root $root -AccountKey $requestedAccountKey -SessionMarker ([string]$state.launchMarker)
& (Join-Path $PSScriptRoot 'Close-AgentRouterLogin.ps1') -AccountKey $requestedAccountKey
$powershell = Resolve-AgentRouterPowerShellExecutable
$runScript = Join-Path $PSScriptRoot 'Run-Checkin.ps1'
& $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $runScript `
    -ReauthAccountKey $requestedAccountKey `
    -PostOAuthVerify `
    -Attempts 1 `
    -SuppressReport
$checkinExitCode = $LASTEXITCODE
if ($checkinExitCode -eq 75) {
    Write-Warning "Account '$requestedAccountKey' is closed and queued for verification after the active manual session ends."
    exit 75
}
$verified = Complete-AgentRouterVerificationRequest -Root $root -Path $verificationRequestPath -Config $config -ExitCode $checkinExitCode
if (-not $verified) {
    Write-Warning 'The account login was closed safely, but its daily reward has no authoritative completion evidence.'
    if ($checkinExitCode -eq 0) { exit 2 }
    exit $checkinExitCode
}
Write-Output "Completed Agent Router accountKey '$requestedAccountKey' and reconciled today's authoritative result."
exit 0
}
finally {
    if ($completionOwned) { [void]$completionMutex.ReleaseMutex() }
    $completionMutex.Dispose()
}
