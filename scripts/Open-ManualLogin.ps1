[CmdletBinding()]
param(
    [string[]]$Origins = @(),
    [int[]]$Selection = @(),
    [ValidatePattern('^[a-f0-9]{32}$')]
    [string]$HandoffLaunchId
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Resolve-Runtime.ps1')
. (Join-Path $PSScriptRoot 'ManualVerification.ps1')
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
$statePath = Join-Path $root 'tmp\manual-session.json'
$launchPath = Join-Path $root 'tmp\manual-handoff-launch.json'
$runMutexName = if ($config.runMutexName) { [string]$config.runMutexName } else { 'Local\CodexBookmarkCheckinRun' }
$launchMutex = [System.Threading.Mutex]::new($false, $runMutexName)
$launchMutexOwned = $false

try {
    try { $launchMutexOwned = $launchMutex.WaitOne(10000) }
    catch [System.Threading.AbandonedMutexException] { $launchMutexOwned = $true }
    if (-not $launchMutexOwned) { throw '自动签到仍在运行，暂不打开人工窗口。' }
    if ($HandoffLaunchId) {
        $launch = Get-Content -Raw -Encoding UTF8 -LiteralPath $launchPath | ConvertFrom-Json
        if ([string]$launch.launchId -ne $HandoffLaunchId) { throw '人工启动占用已改变，取消过期窗口启动。' }
    }
    else {
        if (Test-ManualHandoffLaunchActive -Path $launchPath) { throw '已有一个人工窗口正在启动。' }
        $HandoffLaunchId = [guid]::NewGuid().ToString('N')
    }
    Write-ManualHandoffLaunch -Path $launchPath -LaunchId $HandoffLaunchId

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

    # An explicit local rule can retain a verification-bearing document and
    # continue its action in the same page. All other targets keep native login.
    if ($config.samePageManualCheckinRules -and @($config.samePageManualCheckinRules.PSObject.Properties).Count -gt 0) {
        $node = Resolve-CheckinNode $config
        $samePageHelper = Join-Path $root 'src\live-checkin-session.mjs'
        $attentionArguments = @()
        foreach ($origin in @($Origins)) { $attentionArguments += @('--origin', $origin) }
        foreach ($number in @($Selection)) { $attentionArguments += @('--selection', [string]$number) }
        $rawPlan = @(& $node $samePageHelper --plan @attentionArguments)
        if ($LASTEXITCODE -ne 0) { throw '无法解析同页接管规则。' }
        $samePagePlan = ($rawPlan -join [Environment]::NewLine) | ConvertFrom-Json
        if ($samePagePlan.origin) {
            $sessionId = [guid]::NewGuid().ToString('N')
            $helper = Start-Process -FilePath $node -ArgumentList @(
                "`"$samePageHelper`"", '--origin', [string]$samePagePlan.origin, '--session-id', $sessionId
            ) -WindowStyle Hidden -PassThru
            $readyDeadline = (Get-Date).AddSeconds(30)
            do {
                Start-Sleep -Milliseconds 250
                $session = try { Get-Content -Raw -Encoding UTF8 -LiteralPath $statePath | ConvertFrom-Json } catch { $null }
                if ($session.sessionId -eq $sessionId -and $session.windowRetained -eq $true) { break }
                $helper.Refresh()
            } while (-not $helper.HasExited -and (Get-Date) -lt $readyDeadline)
            if ($session.sessionId -ne $sessionId -or $session.windowRetained -ne $true) {
                throw '同页接管窗口尚未就绪；保留启动状态，请检查会话，勿重复打开。'
            }
            if ($session.stage -eq 'needs_attention') {
                Write-Warning '同页接管启动遇到异常，窗口已保留；请检查会话状态，勿重复打开。'
            }
            else {
                Write-Output '已打开同页接管窗口：请只完成验证，不刷新或关闭；程序会在当前页继续签到。等待过久会记录提示，不会自动关窗。'
            }
            return
        }
    }

    $launchOptions = @{
        NativeMinimal = $true
        TrackManualSession = $true
    }
    if ($Origins.Count -gt 0) { $launchOptions.Origins = @($Origins) }
    if ($Selection.Count -gt 0) { $launchOptions.Selection = @($Selection) }
    & (Join-Path $PSScriptRoot 'Open-PlainLoginChrome.ps1') @launchOptions
}
finally {
    try {
        if ($launchMutexOwned -and $HandoffLaunchId) {
            Remove-ManualHandoffLaunch -Path $launchPath -LaunchId $HandoffLaunchId
        }
    }
    finally {
        if ($launchMutexOwned) { [void]$launchMutex.ReleaseMutex() }
        $launchMutex.Dispose()
    }
}
