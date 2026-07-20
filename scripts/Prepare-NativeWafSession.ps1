[CmdletBinding()]
param(
    [int]$LoadTimeoutSeconds = 20,
    [string[]]$Origins = @()
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
$profilePath = [string]$config.automationUserDataDir
. (Join-Path $PSScriptRoot 'Resolve-Runtime.ps1')
$node = Resolve-CheckinNode $config
$inspector = Join-Path $root 'src\native-browser-inspect.mjs'
$items = @($config.nativeWafPreflightUrls | ForEach-Object {
    $rawUrl = if ($_ -is [string]) { [string]$_ } else { [string]$_.url }
    $uri = [uri]$rawUrl
    $waitSeconds = if ($_ -is [string] -or $null -eq $_.waitSeconds) { 30 } else { [int]$_.waitSeconds }
    if ($uri.Scheme -ne 'https' -or -not $uri.Host) { throw "原生 WAF 预热地址无效：$rawUrl" }
    if ($waitSeconds -lt 5 -or $waitSeconds -gt 60) { throw "原生 WAF 等待时间必须为 5 到 60 秒：$rawUrl" }
    [pscustomobject]@{ url = $uri.AbsoluteUri; waitSeconds = $waitSeconds; trustAsSigned = $true }
})
$items += @($config.nativeChallengePreflight | ForEach-Object {
    $uri = [uri][string]$_.url
    $waitSeconds = [int]$_.waitSeconds
    if ($uri.Scheme -ne 'https' -or -not $uri.Host) { throw "原生验证预热地址无效：$($_.url)" }
    if ($waitSeconds -lt 5 -or $waitSeconds -gt 60) { throw "原生验证等待时间必须为 5 到 60 秒：$($_.url)" }
    [pscustomobject]@{ url = $uri.AbsoluteUri; waitSeconds = $waitSeconds; trustAsSigned = $false }
})

if ($Origins.Count -gt 0) {
    $originSet = @{};
    foreach ($origin in $Origins) { $originSet[([uri]$origin).GetLeftPart([System.UriPartial]::Authority)] = $true }
    $items = @($items | Where-Object { $originSet.ContainsKey(([uri]$_.url).GetLeftPart([System.UriPartial]::Authority)) })
}

if ($items.Count -eq 0) { return }

function Get-AutomationChromeProcesses {
    @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object {
        $_.CommandLine -like "*$profilePath*"
    })
}

if ((Get-AutomationChromeProcesses).Count -gt 0) {
    throw '机器人专用 Chrome 配置正被占用，无法执行原生 WAF 预热。'
}

$preflightResults = @()

function Close-AutomationChrome {
    $targets = @(Get-AutomationChromeProcesses)
    $targetIds = @($targets.ProcessId)
    $roots = @($targets | Where-Object { $targetIds -notcontains $_.ParentProcessId })
    foreach ($processInfo in $roots) {
        $process = Get-Process -Id $processInfo.ProcessId -ErrorAction SilentlyContinue
        if ($process) { [void]$process.CloseMainWindow() }
    }

    $closeDeadline = (Get-Date).AddSeconds(20)
    do {
        Start-Sleep -Milliseconds 500
        $remaining = @(Get-AutomationChromeProcesses)
    } while ($remaining.Count -gt 0 -and (Get-Date) -lt $closeDeadline)
    if ($remaining.Count -gt 0) { throw '原生 WAF 预热窗口未能正常退出。' }
}

# Chrome 会节流离屏的非活动标签页，因此逐站打开并正常关闭，确保每个
# 雷池通行 Cookie 都在独立配置中完成落盘。
foreach ($item in $items) {
    $url = [string]$item.url
    $origin = ([uri]$url).GetLeftPart([System.UriPartial]::Authority)
    $hostName = ([uri]$url).Host
    $inspection = $null
    $inspectionMode = if ([bool]$item.trustAsSigned) { 'allow-endpoint' } else { 'require-confirmed' }
    for ($inspectionAttempt = 1; $inspectionAttempt -le 2 -and $null -eq $inspection; $inspectionAttempt++) {
        $debugPort = Get-Random -Minimum 12000 -Maximum 32000
        & (Join-Path $PSScriptRoot 'Open-PlainLoginChrome.ps1') -Offscreen -RemoteDebuggingPort $debugPort -Urls @($url)
        Start-Sleep -Seconds 2
        try {
            $inspectionText = & $node $inspector $debugPort $origin ([int]$item.waitSeconds) $inspectionMode 2>$null
            if ($LASTEXITCODE -eq 0 -and $inspectionText) {
                $inspection = $inspectionText | ConvertFrom-Json
                $attemptExplicit = [string]$inspection.status -in @('signed', 'already_signed')
                $attemptEndpoint = [bool]$item.trustAsSigned -and [bool]$inspection.siteBodyLoaded `
                    -and [bool]$inspection.attendanceEndpoint -and [string]$inspection.status -eq 'ready'
                $attemptPrepared = -not [bool]$item.trustAsSigned -and [bool]$inspection.siteBodyLoaded `
                    -and [string]$inspection.status -notin @('login_required', 'interactive_challenge', 'managed_challenge')
                if (-not $attemptExplicit -and -not $attemptEndpoint -and -not $attemptPrepared) { $inspection = $null }
            }
        }
        catch { $inspection = $null }
        Close-AutomationChrome
        if ($null -eq $inspection -and $inspectionAttempt -lt 2) { Start-Sleep -Seconds 1 }
    }
    $explicitlyConfirmed = $null -ne $inspection -and [string]$inspection.status -in @('signed', 'already_signed')
    $endpointConfirmed = [bool]$item.trustAsSigned -and $null -ne $inspection `
        -and [bool]$inspection.siteBodyLoaded -and [bool]$inspection.attendanceEndpoint `
        -and [string]$inspection.status -eq 'ready'
    $prepared = $null -ne $inspection -and [bool]$inspection.siteBodyLoaded `
        -and [string]$inspection.status -notin @('login_required', 'interactive_challenge', 'managed_challenge')
    if (-not $explicitlyConfirmed -and -not $endpointConfirmed -and -not $prepared) {
        Write-Warning "原生验证未能确认站点正文：$hostName"
    }
    $preflightResults += [pscustomobject]@{
        origin = $origin
        url = $url
        status = if ($explicitlyConfirmed -or $endpointConfirmed) { 'signed' } elseif ($prepared) { 'prepared' } else { 'unconfirmed' }
        reason = if ($explicitlyConfirmed) {
            '原生 Chrome 已通过 WAF，并由页面明确确认今天已签到'
        } elseif ($endpointConfirmed) {
            '原生 Chrome 已通过 WAF，并确认签到端点完整加载'
        } elseif ($prepared) {
            '原生 Chrome 已完成验证预热，等待自动化复查'
        } else {
            '原生验证页面未能确认签到结果'
        }
        inspectionStatus = if ($null -ne $inspection) { [string]$inspection.status } else { 'unavailable' }
    }
}

$preflightPath = Join-Path $root 'tmp\native-waf-preflight.json'
$preflightReport = [pscustomobject]@{
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    results = $preflightResults
}
[System.IO.Directory]::CreateDirectory((Split-Path -Parent $preflightPath)) | Out-Null
[System.IO.File]::WriteAllText(
    $preflightPath,
    ($preflightReport | ConvertTo-Json -Depth 5),
    [System.Text.UTF8Encoding]::new($false)
)

Write-Output "已离屏预热 $($items.Count) 个原生验证会话。"
