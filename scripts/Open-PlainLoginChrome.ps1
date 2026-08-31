[CmdletBinding()]
param(
    [string[]]$Urls = @(),
    [string[]]$Origins = @(),
    [int[]]$Selection = @(),
    [switch]$Offscreen,
    [int]$RemoteDebuggingPort = 0,
    [switch]$NativeMinimal,
    [switch]$TrackManualSession
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
. (Join-Path $PSScriptRoot 'Resolve-Runtime.ps1')
$node = Resolve-CheckinNode $config
$browser = Resolve-CheckinBrowser $config
$statePath = Join-Path $root 'tmp\manual-session.json'
$verificationPath = Join-Path $root 'tmp\manual-verification.json'
$navigationExtensionPath = Join-Path $root 'tmp\manual-precheckin-extension'
$navigationInputPath = Join-Path $root 'tmp\manual-precheckin-extension.input.json'

if ($TrackManualSession -and (-not $NativeMinimal -or $Offscreen -or $RemoteDebuggingPort -gt 0)) {
    throw '手动登录会话必须使用可见的最小原生模式，且不得启用远程调试。'
}
if ($TrackManualSession -and $Urls.Count -gt 0) {
    throw '手动登录不接受 URL；请用 Origins 或 Selection，由当前书签解析实际地址。'
}
if ($Urls.Count -gt 0 -and ($Origins.Count -gt 0 -or $Selection.Count -gt 0)) {
    throw 'Urls 不能与 Origins 或 Selection 同时使用。'
}
if ($Origins.Count -gt 0 -and $Selection.Count -gt 0) {
    throw 'Origins 和 Selection 不能同时使用。'
}

if (Test-Path -LiteralPath $statePath) {
    & (Join-Path $PSScriptRoot 'Close-ManualLogin.ps1')
    $deadline = (Get-Date).AddSeconds(20)
    do {
        Start-Sleep -Milliseconds 500
        $manual = @(Get-CheckinAutomationBrowserProcesses $config)
    } while ($manual.Count -gt 0 -and (Get-Date) -lt $deadline)
    if ($manual.Count -gt 0) { throw '旧的手动登录会话未能正常退出。' }
}

$existing = @(Get-CheckinAutomationBrowserProcesses $config)
if ($existing.Count -gt 0) { throw "机器人专用 $($browser.DisplayName) 配置仍被其他进程占用。" }

$profilePreparer = Join-Path $root 'src\prepare-native-browser-profile.mjs'
& $node $profilePreparer ([string]$config.automationUserDataDir) 'Default' | Out-Null
if ($LASTEXITCODE -ne 0) { throw '无法清理机器人专用浏览器的旧标签恢复状态。' }

$handoff = $null
$items = if ($Urls.Count -gt 0) {
    @($Urls | ForEach-Object {
        $uri = [uri]$_
        if ($uri.Scheme -notin @('http', 'https') -or -not $uri.Host) { throw "无效网址：$_" }
        [pscustomobject]@{ url = $uri.AbsoluteUri }
    })
}
else {
    $attentionArguments = @()
    foreach ($rawOrigin in @($Origins)) {
        $uri = try { [uri]$rawOrigin } catch { $null }
        if (-not $uri -or $uri.Scheme -notin @('http', 'https') -or -not $uri.Host -or $uri.UserInfo) {
            throw "无效 origin：$rawOrigin"
        }
        $attentionArguments += @('--origin', "$($uri.Scheme)://$($uri.Authority)")
    }
    foreach ($selectedIndex in @($Selection)) {
        $attentionArguments += @('--selection', [string]$selectedIndex)
    }
    $rawHandoff = @(& $node (Join-Path $root 'src\attention-urls.mjs') @attentionArguments)
    if ($LASTEXITCODE -ne 0) { throw '无法从当前书签解析手动登录目标。' }
    $handoff = ($rawHandoff -join [Environment]::NewLine) | ConvertFrom-Json
    @($handoff.targets)
}
$agentRouterOrigins = @($config.agentrouterAccounts | ForEach-Object {
    try {
        $uri = [uri]([string]$_.origin)
        if ($uri.Scheme -eq 'https' -and $uri.Host) { $uri.GetLeftPart([System.UriPartial]::Authority).TrimEnd('/').ToLowerInvariant() }
    }
    catch { }
} | Where-Object { $_ } | Select-Object -Unique)
$selectedAgentRouterItems = @($items | ForEach-Object {
    try {
        $uri = [uri]([string]$_.url)
        if ($uri.Scheme -in @('http', 'https') -and $uri.Host) {
            $origin = $uri.GetLeftPart([System.UriPartial]::Authority).TrimEnd('/').ToLowerInvariant()
            if ($agentRouterOrigins -contains $origin) { $origin }
        }
    }
    catch { }
} | Where-Object { $_ } | Select-Object -Unique)
if ($selectedAgentRouterItems.Count -gt 0) {
    $agentRouterGuidance = 'Agent Router 必须使用专用入口：先运行 Open-AgentRouterLogin.ps1 -AccountKey <github|linuxdo>，完成后运行 Complete-AgentRouterLogin.ps1 -AccountKey <同一 accountKey>。'
    if ($Origins.Count -gt 0 -or $Selection.Count -gt 0 -or $Urls.Count -gt 0) {
        throw $agentRouterGuidance
    }
    Write-Warning "$agentRouterGuidance 普通待处理窗口将跳过该站点。"
    $items = @($items | Where-Object {
        $itemUri = try { [uri]([string]$_.url) } catch { $null }
        if (-not $itemUri -or $itemUri.Scheme -notin @('http', 'https') -or -not $itemUri.Host) { return $false }
        $itemOrigin = $itemUri.GetLeftPart([System.UriPartial]::Authority).TrimEnd('/').ToLowerInvariant()
        return $agentRouterOrigins -notcontains $itemOrigin
    })
}
if (@($items).Count -eq 0) { throw '当前没有符合选择条件的待处理站点。' }
$manualNavigationEnabled = $false
if ($TrackManualSession) {
    [System.IO.Directory]::CreateDirectory((Split-Path -Parent $navigationInputPath)) | Out-Null
    $navigationInput = [ordered]@{
        targets = @($items | Select-Object `
            @{ Name = 'origin'; Expression = { [string]$_.origin } }, `
            @{ Name = 'url'; Expression = { [string]$_.url } })
    }
    try {
        [System.IO.File]::WriteAllText(
            $navigationInputPath,
            ($navigationInput | ConvertTo-Json -Depth 6),
            [System.Text.UTF8Encoding]::new($false)
        )
        $rawNavigation = @(& $node (Join-Path $root 'src\manual-precheckin-extension.mjs') $navigationInputPath)
        if ($LASTEXITCODE -ne 0) { throw '无法准备手动接管的签到前导航。' }
        $navigation = ($rawNavigation -join [Environment]::NewLine) | ConvertFrom-Json
        $manualNavigationEnabled = [bool]$navigation.enabled
    }
    finally {
        Remove-Item -LiteralPath $navigationInputPath -Force -ErrorAction SilentlyContinue
    }
}
$windowPosition = if ($Offscreen) { '-32000,-32000' } else { '60,60' }
$launchMarker = [guid]::NewGuid().ToString('N')
$arguments = @(
    "--user-data-dir=$($config.automationUserDataDir)",
    '--profile-directory=Default',
    '--new-window',
    "--checkin-launch=$launchMarker"
)
if (-not $NativeMinimal) {
    $arguments += @(
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-sync',
        '--disable-component-update',
        '--disable-features=OptimizationGuideOnDeviceModel',
        '--force-renderer-accessibility',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding'
    )
}
if ($Offscreen -or -not $NativeMinimal) {
    $arguments += @(
        "--window-position=$windowPosition",
        '--window-size=1400,900'
    )
}
if ($RemoteDebuggingPort -gt 0) {
    $arguments += "--remote-debugging-port=$RemoteDebuggingPort"
    $arguments += "--remote-allow-origins=http://127.0.0.1:$RemoteDebuggingPort"
}
if ($manualNavigationEnabled) {
    $arguments += "--load-extension=$navigationExtensionPath"
}
$arguments += @($items | ForEach-Object { [string]$_.url })

$process = try {
    Start-Process -FilePath ([string]$browser.Executable) -ArgumentList $arguments -PassThru
}
catch {
    if ($manualNavigationEnabled) {
        Remove-Item -LiteralPath $navigationExtensionPath -Recurse -Force -ErrorAction SilentlyContinue
    }
    throw
}
if ($TrackManualSession) {
    Remove-Item -LiteralPath $verificationPath -Force -ErrorAction SilentlyContinue
    $processStartedAt = try { $process.StartTime.ToUniversalTime().ToString('o') } catch { $null }
    $state = [ordered]@{
        schemaVersion = 2
        pid = $process.Id
        mode = 'native'
        startedAt = (Get-Date).ToUniversalTime().ToString('o')
        processStartedAt = $processStartedAt
        launchMarker = $launchMarker
        profile = [string]$config.automationUserDataDir
        selectionMode = [string]$handoff.selectionMode
        sourceRunId = $handoff.sourceRunId
        sourceFinishedAt = $handoff.sourceFinishedAt
        bookmarkPlanGeneratedAt = $handoff.bookmarkPlanGeneratedAt
        bookmarkLastModifiedAt = $handoff.bookmarkLastModifiedAt
        preCheckinNavigationEnabled = $manualNavigationEnabled
        targetCount = @($items).Count
        targets = @($items | ForEach-Object {
            [ordered]@{
                origin = [string]$_.origin
                previousStatus = [string]$_.previousStatus
            }
        })
    }
    [System.IO.Directory]::CreateDirectory((Split-Path -Parent $statePath)) | Out-Null
    [System.IO.File]::WriteAllText(
        $statePath,
        ($state | ConvertTo-Json -Depth 6),
        [System.Text.UTF8Encoding]::new($false)
    )
}
Write-Output "已使用无自动化标记的原生 $($browser.DisplayName) 打开 $(@($items).Count) 个待处理站点。"
