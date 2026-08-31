[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$Origin,
    [Parameter(Mandatory)]
    [string]$Provider,
    [Parameter(Mandatory)]
    [string]$LoginUrl
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
. (Join-Path $PSScriptRoot 'Resolve-Runtime.ps1')
$node = Resolve-CheckinNode $config
$browser = Resolve-CheckinBrowser $config

$originUri = try { [uri]$Origin } catch { $null }
$loginUri = try { [uri]$LoginUrl } catch { $null }
if (-not $originUri -or $originUri.Scheme -ne 'https' -or -not $originUri.Host -or $originUri.UserInfo) {
    throw '原生 OAuth 签到来源无效。'
}
$originValue = $originUri.GetLeftPart([System.UriPartial]::Authority)
if (-not $loginUri -or $loginUri.Scheme -ne 'https' -or $loginUri.UserInfo `
    -or $loginUri.GetLeftPart([System.UriPartial]::Authority) -ne $originValue) {
    throw '原生 OAuth 登录地址不属于目标站点。'
}
if (@($config.nativeOAuthCheckinOrigins) -notcontains $originValue `
    -or @($config.newApiCheckinOrigins) -notcontains $originValue) {
    throw '目标站点未显式启用原生同会话 OAuth 签到。'
}
$configuredProvider = [string]$config.automaticOAuthProviders.$originValue
if (-not $configuredProvider -or $configuredProvider -ine $Provider) {
    throw '原生 OAuth 登录提供方与本地配置不一致。'
}
if (Test-Path -LiteralPath (Join-Path $root 'tmp\manual-session.json')) {
    throw '人工接管窗口仍处于活动状态，拒绝启动原生 OAuth 签到。'
}
if (@(Get-CheckinAutomationBrowserProcesses $config).Count -gt 0) {
    throw "机器人专用 $($browser.DisplayName) 正被占用，无法执行原生 OAuth 签到。"
}

$debugPort = Get-Random -Minimum 12000 -Maximum 32000
$exitCode = 2
try {
    & (Join-Path $PSScriptRoot 'Open-PlainLoginChrome.ps1') `
        -Offscreen `
        -RemoteDebuggingPort $debugPort `
        -Urls @($loginUri.AbsoluteUri)
    Start-Sleep -Seconds 3
    & $node (Join-Path $root 'src\oauth-login.mjs') `
        $originValue `
        $Provider `
        '--login-url' `
        $loginUri.AbsoluteUri `
        '--native-cdp-port' `
        ([string]$debugPort) `
        '--checkin-after-login' `
        '--private-result'
    $exitCode = $LASTEXITCODE
}
finally {
    $targets = @(Get-CheckinAutomationBrowserProcesses $config)
    $targetIds = @($targets.ProcessId)
    $roots = @($targets | Where-Object { $targetIds -notcontains $_.ParentProcessId })
    foreach ($processInfo in $roots) {
        $process = Get-Process -Id $processInfo.ProcessId -ErrorAction SilentlyContinue
        if ($process) { [void]$process.CloseMainWindow() }
    }
    $closeDeadline = (Get-Date).AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 500
        $remaining = @(Get-CheckinAutomationBrowserProcesses $config)
    } while ($remaining.Count -gt 0 -and (Get-Date) -lt $closeDeadline)
    $remaining | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

exit $exitCode
