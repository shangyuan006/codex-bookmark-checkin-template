[CmdletBinding()]
param(
    [int]$LoadTimeoutSeconds = 20,
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string[]]$Origins,
    [switch]$OverrideTodayAbandonment,
    [string]$AttemptId = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
$defaultProfilePath = [System.IO.Path]::GetFullPath([string]$config.automationUserDataDir)
$allowedDataRoot = [System.IO.Path]::GetFullPath((Join-Path $root 'data'))
$allowedDataPrefix = $allowedDataRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
function Resolve-NativeProfilePath([string]$ConfiguredPath) {
    $candidate = if ([string]::IsNullOrWhiteSpace($ConfiguredPath)) {
        $defaultProfilePath
    } elseif ([System.IO.Path]::IsPathRooted($ConfiguredPath)) {
        [System.IO.Path]::GetFullPath($ConfiguredPath)
    } else {
        [System.IO.Path]::GetFullPath((Join-Path $root $ConfiguredPath))
    }
    if (-not $candidate.StartsWith($allowedDataPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "原生 WAF profile 必须位于项目 data 目录。"
    }
    return $candidate
}
. (Join-Path $PSScriptRoot 'Resolve-Runtime.ps1')
. (Join-Path $PSScriptRoot 'ManualAbandonment.ps1')
. (Join-Path $PSScriptRoot 'NativePreflightCheckpoint.ps1')
$preflightPath = Join-Path $root 'tmp\native-waf-preflight.json'
$node = Resolve-CheckinNode $config
$browser = Resolve-CheckinBrowser $config
$inspector = Join-Path $root 'src\native-browser-inspect.mjs'
$items = @($config.nativeWafPreflightUrls | ForEach-Object {
    $rawUrl = if ($_ -is [string]) { [string]$_ } else { [string]$_.url }
    $uri = [uri]$rawUrl
    $waitSeconds = if ($_ -is [string] -or $null -eq $_.waitSeconds) { 30 } else { [int]$_.waitSeconds }
    $passiveOnly = $_ -isnot [string] -and [bool]$_.passiveOnly
    $trustAsSigned = $_ -isnot [string] -and $null -ne $_.trustAsSigned -and [bool]$_.trustAsSigned
    $profileConfigured = $_ -isnot [string] -and -not [string]::IsNullOrWhiteSpace([string]$_.automationUserDataDir)
    if ($uri.Scheme -ne 'https' -or -not $uri.Host) { throw "原生 WAF 预热地址无效：$rawUrl" }
    if ($waitSeconds -lt 5 -or $waitSeconds -gt 120) { throw "原生 WAF 等待时间必须为 5 到 120 秒：$rawUrl" }
    [pscustomobject]@{
        url = $uri.AbsoluteUri
        waitSeconds = $waitSeconds
        trustAsSigned = $trustAsSigned
        passiveOnly = $passiveOnly
        action = $null
        newApiCheckin = $false
        nativeMinimal = $false
        maxAttempts = 2
        profilePath = Resolve-NativeProfilePath $(if ($profileConfigured) { [string]$_.automationUserDataDir } else { '' })
        profileConfigured = $profileConfigured
    }
})
$items += @($config.nativeChallengePreflight | ForEach-Object {
    $uri = [uri][string]$_.url
    $waitSeconds = [int]$_.waitSeconds
    $passiveOnly = [bool]$_.passiveOnly
    $action = if ($null -ne $_.action) { $_.action } else { $null }
    $newApiCheckin = [bool]$_.newApiCheckin
    $entryOrigin = $uri.GetLeftPart([System.UriPartial]::Authority)
    if ($uri.Scheme -ne 'https' -or -not $uri.Host) { throw "原生验证预热地址无效：$($_.url)" }
    if ($waitSeconds -lt 5 -or $waitSeconds -gt 120) { throw "原生验证等待时间必须为 5 到 120 秒：$($_.url)" }
    if ($passiveOnly -and $null -ne $action) { throw "被动原生验证不能同时配置签到动作：$($_.url)" }
    if ($passiveOnly -and $newApiCheckin) { throw "被动原生验证不能同时配置 New API 签到：$($_.url)" }
    if ($null -ne $action -and $newApiCheckin) { throw "原生按钮签到和 New API 签到不能同时配置：$($_.url)" }
    if ($newApiCheckin -and @($config.newApiCheckinOrigins) -notcontains $entryOrigin) {
        throw "原生 New API 签到来源未加入 newApiCheckinOrigins：$($_.url)"
    }
    if ($null -ne $action) {
        $actionTexts = @($action.actionTexts | ForEach-Object { [string]$_ } | Where-Object { $_.Trim() })
        $dismissTexts = @($action.dismissButtonTexts | ForEach-Object { [string]$_ } | Where-Object { $_.Trim() })
        $dismissSelectors = @($action.dismissSelectors | ForEach-Object { [string]$_ } | Where-Object { $_.Trim() })
        if ($actionTexts.Count -lt 1 -or $actionTexts.Count -gt 10) {
            throw "原生签到动作必须提供 1 到 10 个按钮文本：$($_.url)"
        }
        if ($dismissTexts.Count -gt 10 -or $dismissSelectors.Count -gt 10) {
            throw "原生签到公告关闭规则过多：$($_.url)"
        }
    }
    [pscustomobject]@{
        url = $uri.AbsoluteUri
        waitSeconds = $waitSeconds
        trustAsSigned = $false
        passiveOnly = $passiveOnly
        action = $action
        newApiCheckin = $newApiCheckin
        nativeMinimal = [bool]$_.nativeMinimal
        maxAttempts = if ($null -ne $_.maxAttempts) { [Math]::Max(1, [Math]::Min(2, [int]$_.maxAttempts)) } else { 2 }
        profilePath = Resolve-NativeProfilePath ([string]$_.automationUserDataDir)
        profileConfigured = -not [string]::IsNullOrWhiteSpace([string]$_.automationUserDataDir)
    }
})

$originSet = @{};
foreach ($origin in $Origins) {
    $originUri = [uri][string]$origin
    if (-not $originUri.IsAbsoluteUri -or $originUri.Scheme -notin @('http', 'https') -or -not $originUri.Host) {
        throw "预热目标 origin 无效：$origin"
    }
    $originSet[$originUri.GetLeftPart([System.UriPartial]::Authority)] = $true
}
$items = @($items | Where-Object { $originSet.ContainsKey(([uri]$_.url).GetLeftPart([System.UriPartial]::Authority)) })
$abandoned = Get-TodayAbandonedOrigins -Path (Join-Path $root 'tmp/manual-abandon.json')
$items = @($items | Where-Object {
    $origin = ([uri]$_.url).GetLeftPart([System.UriPartial]::Authority)
    ($OverrideTodayAbandonment -or -not $abandoned.ContainsKey($origin)) -and $origin -notin @($config.disabledCheckinOrigins) `
        -and $origin -notin @($config.knownNoCheckinFeatureOrigins)
})

if ($items.Count -eq 0) { return }

$reservedProfilePaths = @($config.agentrouterAccounts | ForEach-Object {
    if (-not [string]::IsNullOrWhiteSpace([string]$_.automationUserDataDir)) {
        Resolve-NativeProfilePath ([string]$_.automationUserDataDir)
    }
})
$profileOwners = @{}
foreach ($item in @($items | Where-Object { [bool]$_.profileConfigured })) {
    $profilePath = [string]$item.profilePath
    $itemOrigin = ([uri][string]$item.url).GetLeftPart([System.UriPartial]::Authority)
    if ($profilePath.Equals($defaultProfilePath, [System.StringComparison]::OrdinalIgnoreCase) `
        -or @($reservedProfilePaths | Where-Object { $_.Equals($profilePath, [System.StringComparison]::OrdinalIgnoreCase) }).Count -gt 0) {
        throw "原生 WAF 独立 profile 与全局或 Agent Router profile 冲突：$itemOrigin"
    }
    $profileKey = $profilePath.ToLowerInvariant()
    if ($profileOwners.ContainsKey($profileKey) -and [string]$profileOwners[$profileKey] -ne $itemOrigin) {
        throw "不同站点不能共享同一个原生 WAF 独立 profile：$itemOrigin"
    }
    $profileOwners[$profileKey] = $itemOrigin
}

function Get-AutomationBrowserProcesses([string]$ProfilePath) {
    @(Get-CheckinProfileBrowserProcesses -Config $config -ProfilePath $ProfilePath)
}

foreach ($configuredProfile in @($items.profilePath | Select-Object -Unique)) {
    if ((Get-AutomationBrowserProcesses ([string]$configuredProfile)).Count -gt 0) {
        throw "机器人专用 $($browser.DisplayName) 配置正被占用，无法执行原生 WAF 预热。"
    }
}

$preflightResults = @(Read-NativePreflightConfirmations -Path $preflightPath)

function Close-AutomationBrowser([string]$ProfilePath) {
    $targets = @(Get-AutomationBrowserProcesses $ProfilePath)
    $targetIds = @($targets.ProcessId)
    $roots = @($targets | Where-Object { $targetIds -notcontains $_.ParentProcessId })
    foreach ($processInfo in $roots) {
        $process = Get-Process -Id $processInfo.ProcessId -ErrorAction SilentlyContinue
        if ($process) { [void]$process.CloseMainWindow() }
    }

    $closeDeadline = (Get-Date).AddSeconds(20)
    do {
        Start-Sleep -Milliseconds 500
        $remaining = @(Get-AutomationBrowserProcesses $ProfilePath)
    } while ($remaining.Count -gt 0 -and (Get-Date) -lt $closeDeadline)
    if ($remaining.Count -gt 0) { throw '原生 WAF 预热窗口未能正常退出。' }
}

# Chromium 浏览器会节流离屏的非活动标签页，因此逐站打开并正常关闭，确保每个
# 雷池通行 Cookie 都在独立配置中完成落盘。
foreach ($item in $items) {
    $profilePath = [string]$item.profilePath
    $url = [string]$item.url
    $origin = ([uri]$url).GetLeftPart([System.UriPartial]::Authority)
    $hostName = ([uri]$url).Host

    if (@($preflightResults | Where-Object { $_.origin -eq $origin -and $_.status -in @('signed', 'already_signed') }).Count -gt 0) {
        continue
    }

    if ([bool]$item.passiveOnly) {
        $passivePrepared = $false
        try {
            # 被动模式只启动真实有头浏览器，不开放调试端口，也不连接 CDP。
            # 等待本身不是签到成功证据，因此这里只能报告 prepared/unconfirmed。
            & (Join-Path $PSScriptRoot 'Open-PlainLoginChrome.ps1') -Offscreen -NativeMinimal -UserDataDirOverride $profilePath -Urls @($url)
            Start-Sleep -Seconds 2
            if ((Get-AutomationBrowserProcesses $profilePath).Count -gt 0) {
                Start-Sleep -Seconds ([int]$item.waitSeconds)
                $passivePrepared = (Get-AutomationBrowserProcesses $profilePath).Count -gt 0
            }
        }
        catch {
            $passivePrepared = $false
        }
        finally {
            if ((Get-AutomationBrowserProcesses $profilePath).Count -gt 0) { Close-AutomationBrowser $profilePath }
        }

        if (-not $passivePrepared) {
            Write-Warning "被动原生预热未完成：$hostName"
        }
        $preflightResults += [pscustomobject]@{
            origin = $origin
            url = $url
            status = if ($passivePrepared) { 'prepared' } else { 'unconfirmed' }
            reason = if ($passivePrepared) {
                "原生 $($browser.DisplayName) 已完成被动等待，等待自动化复查"
            } else {
                "原生 $($browser.DisplayName) 被动等待未完成"
            }
            inspectionStatus = if ($passivePrepared) { 'passive_wait' } else { 'unavailable' }
        }
        Write-NativePreflightCheckpoint -Path $preflightPath -Results $preflightResults
        continue
    }

    $inspection = $null
    $lastInspection = $null
    $hasAction = $null -ne $item.action
    $hasNewApiCheckin = [bool]$item.newApiCheckin
    $inspectionMode = if ($hasAction) { 'execute-checkin' } elseif ($hasNewApiCheckin) { 'execute-new-api' } elseif ([bool]$item.trustAsSigned) { 'allow-endpoint' } else { 'require-confirmed' }
    $actionConfigBase64 = if ($hasAction) {
        $actionJson = $item.action | ConvertTo-Json -Depth 5 -Compress
        [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($actionJson))
    }
    else { '' }
    for ($inspectionAttempt = 1; $inspectionAttempt -le $item.maxAttempts -and $null -eq $inspection; $inspectionAttempt++) {
        $attemptFailure = $null
        try {
            $debugPort = Get-Random -Minimum 12000 -Maximum 32000
            & (Join-Path $PSScriptRoot 'Open-PlainLoginChrome.ps1') -Offscreen -NativeMinimal:([bool]$item.nativeMinimal) -RemoteDebuggingPort $debugPort -UserDataDirOverride $profilePath -Urls @($url)
            Start-Sleep -Seconds 2
            try {
                $inspectionText = & $node $inspector $debugPort $origin ([int]$item.waitSeconds) $inspectionMode $actionConfigBase64 2>$null
                if ($LASTEXITCODE -eq 0 -and $inspectionText) {
                    $inspection = $inspectionText | ConvertFrom-Json
                    $lastInspection = $inspection
                    $attemptExplicit = [string]$inspection.status -in @('signed', 'already_signed') `
                        -and (-not $hasNewApiCheckin -or [bool]$inspection.newApiConfirmed)
                    $attemptEndpoint = [bool]$item.trustAsSigned -and [bool]$inspection.siteBodyLoaded `
                        -and [bool]$inspection.attendanceEndpoint -and [string]$inspection.status -eq 'ready'
                    $attemptPrepared = -not $hasAction -and -not $hasNewApiCheckin -and -not [bool]$item.trustAsSigned -and [bool]$inspection.siteBodyLoaded `
                        -and [string]$inspection.status -notin @('login_required', 'interactive_challenge', 'managed_challenge')
                    if (-not $attemptExplicit -and -not $attemptEndpoint -and -not $attemptPrepared) { $inspection = $null }
                }
            }
            catch { $inspection = $null }
            if ($null -ne $inspection -and ($attemptExplicit -or $attemptEndpoint)) {
                # Persist confirmation before browser cleanup, which can itself fail.
                $confirmedResult = [pscustomobject]@{
                    origin = $origin
                    url = $url
                    status = 'signed'
                    reason = if ($attemptExplicit) { '原生页面或接口明确确认今天已签到' } else { '原生验证已确认配置的签到端点完整加载' }
                    inspectionStatus = [string]$inspection.status
                    actionAttempted = [bool]$inspection.actionAttempted
                    actionOutcome = [string]$inspection.actionOutcome
                    challengeOutcome = [string]$inspection.challengeOutcome
                    newApiConfirmed = [bool]$inspection.newApiConfirmed
                }
                Write-NativePreflightCheckpoint -Path $preflightPath -Results @($preflightResults + @($confirmedResult))
            }
        }
        catch { $attemptFailure = $_; throw }
        finally {
            Complete-NativePreflightAttempt -Cleanup { Close-AutomationBrowser $profilePath } -Failure $attemptFailure
        }
        if ([string]$lastInspection.failureCode -eq 'safeline_client_challenge') { break }
        if ($null -eq $inspection -and $inspectionAttempt -lt $item.maxAttempts) { Start-Sleep -Seconds 1 }
    }
    $explicitlyConfirmed = $null -ne $inspection -and [string]$inspection.status -in @('signed', 'already_signed') `
        -and (-not $hasNewApiCheckin -or [bool]$inspection.newApiConfirmed)
    $endpointConfirmed = [bool]$item.trustAsSigned -and $null -ne $inspection `
        -and [bool]$inspection.siteBodyLoaded -and [bool]$inspection.attendanceEndpoint `
        -and [string]$inspection.status -eq 'ready'
    $prepared = -not $hasAction -and -not $hasNewApiCheckin -and $null -ne $inspection -and [bool]$inspection.siteBodyLoaded `
        -and [string]$inspection.status -notin @('login_required', 'interactive_challenge', 'managed_challenge')
    $reportedInspection = if ($null -ne $inspection) { $inspection } else { $lastInspection }
    $requiresHandoff = -not $explicitlyConfirmed -and -not $endpointConfirmed `
        -and [string]$reportedInspection.failureCode -eq 'safeline_client_challenge'
    if (-not $explicitlyConfirmed -and -not $endpointConfirmed -and -not $prepared) {
        Write-Warning "原生验证未能确认站点正文：$hostName"
    }
    $preflightResults += [pscustomobject]@{
        origin = $origin
        url = $url
        status = if ($explicitlyConfirmed -or $endpointConfirmed) { 'signed' } elseif ($requiresHandoff) { 'interactive_challenge' } elseif ($prepared) { 'prepared' } else { 'unconfirmed' }
        failureCode = if ($requiresHandoff) { 'safeline_client_challenge' } else { $null }
        retryable = if ($requiresHandoff) { $false } else { $null }
        preflightAttemptId = $AttemptId
        reason = if ($explicitlyConfirmed -and $hasAction -and [bool]$inspection.actionAttempted) {
            "原生 $($browser.DisplayName) 已执行签到动作，并由页面明确确认今天已签到"
        } elseif ($explicitlyConfirmed -and $hasNewApiCheckin -and [bool]$inspection.newApiConfirmed) {
            "原生 $($browser.DisplayName) 已执行 New API 签到，并由状态接口确认今天已签到"
        } elseif ($explicitlyConfirmed -and $hasAction) {
            "原生 $($browser.DisplayName) 页面明确确认今天已签到"
        } elseif ($explicitlyConfirmed) {
            "原生 $($browser.DisplayName) 已通过 WAF，并由页面明确确认今天已签到"
        } elseif ($endpointConfirmed) {
            "原生 $($browser.DisplayName) 已通过 WAF，并确认签到端点完整加载"
        } elseif ($prepared) {
            "原生 $($browser.DisplayName) 已完成验证预热，等待自动化复查"
        } elseif ($requiresHandoff) {
            '雷池 WAF 要求合法用户确认，停止本轮自动重试并转人工处理'
        } elseif ($hasAction -and [string]$reportedInspection.actionOutcome -eq 'action_not_found') {
            '原生签到未找到配置的唯一动作'
        } elseif ($hasAction -and [string]$reportedInspection.actionOutcome -eq 'action_not_unique') {
            '原生签到发现多个配置动作，已拒绝点击'
        } elseif ($hasAction -and [string]$reportedInspection.challengeOutcome -eq 'challenge_not_unique') {
            '原生签到发现多个 Cloudflare 验证控件，已拒绝点击'
        } elseif ($hasAction -and [string]$reportedInspection.challengeOutcome -eq 'challenge_click_failed') {
            '原生签到未能点击唯一的 Cloudflare 验证控件'
        } elseif ($hasAction -and [string]$reportedInspection.challengeOutcome -eq 'challenge_frame_not_stable') {
            '原生签到等待 Cloudflare 验证框稳定后仍无法安全点击'
        } elseif ($hasAction -and [string]$reportedInspection.actionOutcome -eq 'confirmation_timeout') {
            '原生签到点击后在有限等待内未确认成功'
        } elseif ($hasAction -and [string]$reportedInspection.actionOutcome -eq 'not_attempted') {
            '原生签到页面尚未达到可执行状态'
        } elseif ($hasNewApiCheckin -and [string]$reportedInspection.status -eq 'login_required') {
            '原生 New API 签到接口显示登录状态无效'
        } elseif ($hasNewApiCheckin) {
            '原生 New API 签到未取得权威完成状态'
        } else {
            '原生验证页面未能确认签到结果'
        }
        inspectionStatus = if ($null -ne $reportedInspection) { [string]$reportedInspection.status } else { 'unavailable' }
        actionAttempted = $null -ne $reportedInspection -and [bool]$reportedInspection.actionAttempted
        actionOutcome = if ($null -ne $reportedInspection) { [string]$reportedInspection.actionOutcome } else { 'unavailable' }
        challengeOutcome = if ($null -ne $reportedInspection) { [string]$reportedInspection.challengeOutcome } else { 'unavailable' }
        challengeDetails = if ($null -ne $reportedInspection) { $reportedInspection.challengeDetails } else { $null }
        newApiAttempted = $null -ne $reportedInspection -and [bool]$reportedInspection.newApiAttempted
        newApiConfirmed = $null -ne $reportedInspection -and [bool]$reportedInspection.newApiConfirmed
    }
    Write-NativePreflightCheckpoint -Path $preflightPath -Results $preflightResults
}

Write-Output "已离屏预热 $($items.Count) 个原生验证会话。"
