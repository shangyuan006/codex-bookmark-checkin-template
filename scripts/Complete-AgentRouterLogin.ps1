[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [Alias('AccountId')]
    [string]$AccountKey
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'AgentRouterAccount.ps1')
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
$requestedAccountKey = ConvertTo-AgentRouterAccountKey $AccountKey
$account = Resolve-AgentRouterAccountConfig -Accounts @($config.agentrouterAccounts) -AccountKey $requestedAccountKey
$statePath = Join-Path $root 'tmp\agentrouter-manual-state.json'
if (-not (Test-Path -LiteralPath $statePath)) { throw 'There is no Agent Router manual login state to complete.' }
$state = Get-Content -Raw -Encoding UTF8 -LiteralPath $statePath | ConvertFrom-Json
if ([string]$account.provider -eq 'LinuxDO' -and [string]$state.stage -ne 'agentrouter') {
    throw 'LinuxDO completion requires the Agent Router stage. Close the provider stage first, then open with -AgentRouterOnly.'
}

& (Join-Path $PSScriptRoot 'Close-AgentRouterLogin.ps1') -AccountKey $requestedAccountKey
$powershell = Resolve-AgentRouterPowerShellExecutable
$runScript = Join-Path $PSScriptRoot 'Run-Checkin.ps1'
& $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $runScript `
    -ReauthAccountKey $requestedAccountKey -SuppressReport
$checkinExitCode = $LASTEXITCODE
if ($checkinExitCode -eq 2) {
    Write-Warning "The account login was closed safely, but today's complete report still has unresolved results."
    exit 2
}
if ($checkinExitCode -ne 0) { exit $checkinExitCode }
if ([string]$account.provider -eq 'LinuxDO') {
    Remove-Item -LiteralPath (Join-Path $root 'tmp\agentrouter-linuxdo-provider-state.json') -Force -ErrorAction SilentlyContinue
}
Write-Output "Completed Agent Router accountKey '$requestedAccountKey' and reconciled today's authoritative result."
