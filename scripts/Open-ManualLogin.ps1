[CmdletBinding()]
param(
    [string[]]$Origins = @(),
    [int[]]$Selection = @()
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Resolve-Runtime.ps1')
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
$statePath = Join-Path $root 'tmp\manual-session.json'

$agentRouterOrigins = @($config.agentrouterAccounts | ForEach-Object {
    try {
        $uri = [uri]([string]$_.origin)
        if ($uri.Scheme -eq 'https' -and $uri.Host) { $uri.GetLeftPart([System.UriPartial]::Authority).TrimEnd('/').ToLowerInvariant() }
    }
    catch { }
} | Where-Object { $_ } | Select-Object -Unique)
$requestedAgentRouterOrigins = @($Origins | ForEach-Object {
    try {
        $uri = [uri]([string]$_)
        if ($uri.Scheme -in @('http', 'https') -and $uri.Host) { $uri.GetLeftPart([System.UriPartial]::Authority).TrimEnd('/').ToLowerInvariant() }
    }
    catch { }
} | Where-Object { $agentRouterOrigins -contains $_ })
if ($requestedAgentRouterOrigins.Count -gt 0) {
    throw 'Agent Router 必须使用专用入口：先运行 Open-AgentRouterLogin.ps1 -AccountKey <github|linuxdo>，完成后运行 Complete-AgentRouterLogin.ps1 -AccountKey <同一 accountKey>。'
}

if ($Origins.Count -gt 0 -and $Selection.Count -gt 0) {
    throw 'Origins 和 Selection 不能同时使用。'
}

if (Test-Path -LiteralPath $statePath) {
    $state = try { Get-Content -Raw -Encoding UTF8 -LiteralPath $statePath | ConvertFrom-Json } catch { $null }
    $existing = @(Get-CheckinAutomationBrowserProcesses $config)
    $legacyProcess = if ($state -and [string]$state.mode -ne 'native') {
        Get-Process -Id $state.pid -ErrorAction SilentlyContinue
    }
    else { $null }
    if ($existing.Count -gt 0 -or $legacyProcess) {
        if ($Origins.Count -gt 0 -or $Selection.Count -gt 0) {
            throw '手动登录窗口已经运行；请先关闭当前会话，再按新的站点选择打开。'
        }
        Write-Output '原生手动登录窗口已经运行。'
        exit 0
    }
    & (Join-Path $PSScriptRoot 'Close-ManualLogin.ps1')
    if (Test-Path -LiteralPath $statePath) {
        throw '上一个手动登录会话没有完成安全收尾。'
    }
}

$occupied = @(Get-CheckinAutomationBrowserProcesses $config)
if ($occupied.Count -gt 0) { throw '机器人专用浏览器配置正被其他进程占用。' }

$launchOptions = @{
    NativeMinimal = $true
    TrackManualSession = $true
}
if ($Origins.Count -gt 0) { $launchOptions.Origins = @($Origins) }
if ($Selection.Count -gt 0) { $launchOptions.Selection = @($Selection) }
& (Join-Path $PSScriptRoot 'Open-PlainLoginChrome.ps1') @launchOptions
