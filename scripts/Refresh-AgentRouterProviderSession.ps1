[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [Alias('AccountId')]
    [string]$AccountKey,
    [ValidateRange(5, 30)]
    [int]$WaitSeconds = 8
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Resolve-Runtime.ps1')
. (Join-Path $PSScriptRoot 'AgentRouterAccount.ps1')
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
$accountKey = ConvertTo-AgentRouterAccountKey $AccountKey
$account = Resolve-AgentRouterAccountConfig -Accounts @($config.agentrouterAccounts) -AccountKey $accountKey
if ([string]$account.provider -ne 'LinuxDO') {
    throw 'Native provider session refresh is only supported for LinuxDO accounts.'
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

$browser = Resolve-CheckinBrowser $config
$node = Resolve-CheckinNode $config
function Get-ProviderProcesses {
    return @(Get-CheckinProfileBrowserProcesses -Config $config -ProfilePath $profile)
}
function Close-ProviderProcesses {
    $targets = @(Get-ProviderProcesses)
    $targetIds = @($targets.ProcessId)
    $roots = @($targets | Where-Object { $targetIds -notcontains $_.ParentProcessId })
    foreach ($processInfo in $roots) {
        $process = Get-Process -Id ([int]$processInfo.ProcessId) -ErrorAction SilentlyContinue
        if ($process) { [void]$process.CloseMainWindow() }
    }
    $deadline = (Get-Date).AddSeconds(20)
    do {
        Start-Sleep -Milliseconds 500
        $remaining = @(Get-ProviderProcesses)
    } while ($remaining.Count -gt 0 -and (Get-Date) -lt $deadline)
    if ($remaining.Count -gt 0) { throw 'The native LinuxDO session refresh window did not close normally.' }
}

if ((Get-ProviderProcesses).Count -gt 0) {
    throw 'The selected Agent Router profile is already in use.'
}
$profilePreparer = Join-Path $root 'src\prepare-native-browser-profile.mjs'
& $node $profilePreparer $profile 'Default' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Unable to prepare the isolated Agent Router profile.' }

$launchMarker = [guid]::NewGuid().ToString('N')
$arguments = @(
    "--user-data-dir=$profile",
    '--profile-directory=Default',
    '--new-window',
    "--checkin-launch=$launchMarker",
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-component-update',
    '--window-position=-32000,-32000',
    '--window-size=1200,800',
    'https://linux.do/'
)

try {
    [void](Start-Process -FilePath ([string]$browser.Executable) -ArgumentList $arguments -PassThru)
    $startupDeadline = (Get-Date).AddSeconds(10)
    do {
        Start-Sleep -Milliseconds 500
        $running = @(Get-ProviderProcesses)
    } while ($running.Count -eq 0 -and (Get-Date) -lt $startupDeadline)
    if ($running.Count -eq 0) { throw 'The native LinuxDO session refresh browser did not start.' }
    Start-Sleep -Seconds $WaitSeconds
}
finally {
    if ((Get-ProviderProcesses).Count -gt 0) { Close-ProviderProcesses }
}

[ordered]@{ status = 'prepared' } | ConvertTo-Json -Compress
