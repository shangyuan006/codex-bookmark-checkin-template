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
function Write-LaunchOutcomeSafe {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$LaunchId,
        [Parameter(Mandatory = $true)][int]$Attempt,
        [Parameter(Mandatory = $true)][ValidateSet('window_ready','retrying','failed')][string]$State,
        [string]$FailureCode = 'none'
    )
    if (Get-Command Write-ManualHandoffLaunchOutcome -ErrorAction SilentlyContinue) {
        Write-ManualHandoffLaunchOutcome -Root $Root -LaunchId $LaunchId -Attempt $Attempt -State $State -FailureCode $FailureCode
    }
}

try {
for ($launchAttempt = 1; $launchAttempt -le 2; $launchAttempt++) {
$retryLaunch = $false
try {
    try { $launchMutexOwned = $launchMutex.WaitOne(10000) }
    catch [System.Threading.AbandonedMutexException] { $launchMutexOwned = $true }
    if (-not $launchMutexOwned) { throw '自动签到仍在运行，暂不打开人工窗口。' }
    if ($launchAttempt -eq 1 -and $HandoffLaunchId) {
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

    # Finish bounded ordinary continuations before reserving the profile for a
    # single long-lived, same-page human verification session.
    $node = Resolve-CheckinNode $config
    $controlledArguments = @()
    foreach ($origin in @($Origins)) { $controlledArguments += @('--origin', $origin) }
    foreach ($number in @($Selection)) { $controlledArguments += @('--selection', [string]$number) }
    $controlledPlan = [pscustomobject]@{ origins = @() }
    if (($null -ne $config.nativeChallengePreflight -and @($config.nativeChallengePreflight).Count -gt 0) -or
        ($config.visitCheckinRules -and @($config.visitCheckinRules.PSObject.Properties).Count -gt 0) -or
        ($config.samePageManualCheckinRules -and @($config.samePageManualCheckinRules.PSObject.Properties |
            Where-Object { $_.Value.browserMode -eq 'native' -and $_.Value.enabled -ne $false }).Count -gt 0)) {
        $rawControlledPlan = @(& $node (Join-Path $root 'src\manual-native-continuation.mjs') --plan @controlledArguments)
        if ($LASTEXITCODE -ne 0) { throw '无法解析受控签到接续规则。' }
        $controlledPlan = ($rawControlledPlan -join [Environment]::NewLine) | ConvertFrom-Json
    }

    # An explicit local rule can retain a verification-bearing document and
    # continue its action in the same page. All other targets keep native login.
    if (@($controlledPlan.origins).Count -eq 0 -and $config.samePageManualCheckinRules -and @($config.samePageManualCheckinRules.PSObject.Properties).Count -gt 0) {
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
            $visible = @(Get-CheckinProfileBrowserProcesses -Config $config -ProfilePath ([string]$config.automationUserDataDir) |
                ForEach-Object { Get-Process -Id ([int]$_.ProcessId) -ErrorAction SilentlyContinue } |
                Where-Object { $_.MainWindowHandle -ne 0 -and $_.Responding })
            if ($visible.Count -eq 0) { throw '同页项目窗口尚未确认可见，保留会话。' }
            Write-LaunchOutcomeSafe -Root $root -LaunchId $HandoffLaunchId -Attempt $launchAttempt -State window_ready
            if ($session.stage -eq 'needs_attention') {
                Write-Warning '同页接管启动遇到异常，窗口已保留；请检查会话状态，勿重复打开。'
            }
            else {
                Write-Output '已打开同页接管窗口：请只完成验证，不刷新或关闭；程序会在当前页继续签到。等待过久会记录提示，不会自动关窗。'
            }
            return
        }
    }

    # Prefer a controllable, visible native window for reviewed check-in rules.
    # Select the eligible subset so an unrelated network failure cannot force
    # ordinary buttons into an uncontrollable login-only window.
    $launchOptions = @{
        NativeMinimal = $true
        TrackManualSession = $true
    }
    if (@($controlledPlan.origins).Count -gt 0) {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
        try {
            $listener.Start()
            $launchOptions.RemoteDebuggingPort = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
        }
        finally { $listener.Stop() }
        $launchOptions.ControlledCheckin = $true
        $launchOptions.Origins = @($controlledPlan.origins)
    }
    else {
        if ($Origins.Count -gt 0) { $launchOptions.Origins = @($Origins) }
        if ($Selection.Count -gt 0) { $launchOptions.Selection = @($Selection) }
    }
    & (Join-Path $PSScriptRoot 'Open-PlainLoginChrome.ps1') @launchOptions
    $openedState = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
    if ($openedState.mode -ne 'native' -or $openedState.windowReady -ne $true) { throw '人工项目窗口尚未确认就绪，保留会话。' }
    Write-LaunchOutcomeSafe -Root $root -LaunchId $HandoffLaunchId -Attempt $launchAttempt -State window_ready
    if ($launchOptions.ControlledCheckin) {
        $continuation = & (Join-Path $PSScriptRoot 'Resume-ManualCheckin.ps1') -Json | ConvertFrom-Json
        if ($continuation.state -in @('session_closed', 'session_changed')) {
            Write-Output $continuation.message
            return
        }
        if ($continuation.state -ne 'busy' -and $continuation.unresolvedCount -eq 0) {
            & (Join-Path $PSScriptRoot 'Close-ManualLogin.ps1') -SaveOnly
        }
        else {
            $retained = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
            $shell = (Get-Command pwsh,powershell -ErrorAction Stop | Select-Object -First 1).Source
            Start-Process -FilePath $shell -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                '-File', ('"' + (Join-Path $PSScriptRoot 'Watch-ManualCheckin.ps1') + '"'), '-SessionMarker', [string]$retained.launchMarker) `
                -WindowStyle Hidden | Out-Null
            Write-Output '可控项目窗口已保留并持续观察；验证就绪后自动接续，确认签到完成后保存关闭。'
        }
    }
}
catch {
    $failure = $_
    $failureCode = if ($_.FullyQualifiedErrorId -like 'CheckinProcessQueryFailed*') { 'process_query_failed' } else { 'startup_failed' }
    # Retry only before a session exists and after a successful inventory.
    # Unknown inventory never means that no browser is running.
    if ($launchAttempt -lt 2 -and $launchMutexOwned -and -not (Test-Path -LiteralPath $statePath)) {
        try { $retryLaunch = @(Get-CheckinAutomationBrowserProcesses $config).Count -eq 0 } catch { $retryLaunch = $false }
    }
    if ($HandoffLaunchId -and $launchMutexOwned) {
        Write-LaunchOutcomeSafe -Root $root -LaunchId $HandoffLaunchId -Attempt $launchAttempt `
            -State $(if ($retryLaunch) { 'retrying' } else { 'failed' }) -FailureCode $failureCode
    }
    if (-not $retryLaunch) { throw $failure }
}
finally {
    try {
        if ($launchMutexOwned -and $HandoffLaunchId) {
            Remove-ManualHandoffLaunch -Path $launchPath -LaunchId $HandoffLaunchId
        }
    }
    finally {
        if ($launchMutexOwned) { [void]$launchMutex.ReleaseMutex() }
        $launchMutexOwned = $false
    }
}
if (-not $retryLaunch) { break }
Start-Sleep -Milliseconds 1000
}
} finally { $launchMutex.Dispose() }
