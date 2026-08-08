[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$AccountId
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
. (Join-Path $PSScriptRoot 'Resolve-Runtime.ps1')
$node = Resolve-CheckinNode $config
$browser = Resolve-CheckinBrowser $config

$account = @($config.agentrouterAccounts | Where-Object {
    [string]$_.origin -eq 'https://agentrouter.org' -and [string]$_.accountId -eq $AccountId
}) | Select-Object -First 1
if ($null -eq $account) { throw "No Agent Router account configuration matches accountId '$AccountId'." }

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

$profilePreparer = Join-Path $root 'src\prepare-native-browser-profile.mjs'
& $node $profilePreparer $profile 'Default' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Unable to prepare the isolated Agent Router profile.' }

$loginUrl = 'https://agentrouter.org/login'
$arguments = @(
    "--user-data-dir=$profile",
    '--profile-directory=Default',
    '--new-window',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-component-update',
    '--window-position=60,60',
    '--window-size=1400,900',
    $loginUrl
)
$process = Start-Process -FilePath ([string]$browser.Executable) -ArgumentList $arguments -PassThru
Write-Output "Opened the isolated Agent Router login profile for accountId '$AccountId' (PID $($process.Id))."
