[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [Alias('AccountId')]
    [string]$AccountKey
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
. (Join-Path $PSScriptRoot 'AgentRouterAccount.ps1')

$requestedAccountKey = ConvertTo-AgentRouterAccountKey $AccountKey
$account = Resolve-AgentRouterAccountConfig -Accounts @($config.agentrouterAccounts) -AccountKey $requestedAccountKey
if ([string]$account.provider -ne 'LinuxDO') {
    throw 'The experimental Turnstile script only supports a LinuxDO Agent Router account.'
}

$opener = Join-Path $PSScriptRoot 'Open-AgentRouterLogin.ps1'
& $opener -AccountKey $requestedAccountKey -ProviderOnly

$manualStatePath = Join-Path $root 'tmp\agentrouter-manual-state.json'
if (Test-Path -LiteralPath $manualStatePath) {
    Write-Warning 'LinuxDO requires manual provider login. Finish it, close the window, then run this script again.'
    exit 2
}

& $opener `
    -AccountKey $requestedAccountKey `
    -AgentRouterOnly `
    -ExperimentalTurnstileFrameClick
