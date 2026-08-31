[CmdletBinding()]
param(
    [switch]$Abandon,
    [string[]]$Origins = @(),
    [int[]]$Selection = @()
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'ManualAbandonment.ps1')
$signalPath = Join-Path $root 'tmp\close-manual-session.signal'
$statePath = Join-Path $root 'tmp\manual-session.json'
$verificationPath = Join-Path $root 'tmp\manual-verification.json'
$handoffPath = Join-Path $root 'tmp\manual-handoff.json'
$abandonPath = Join-Path $root 'tmp\manual-abandon.json'
$navigationExtensionPath = Join-Path $root 'tmp\manual-precheckin-extension'

function Remove-ManualNavigationExtension {
    $tmpRoot = [System.IO.Path]::GetFullPath((Join-Path $root 'tmp'))
    $extensionRoot = [System.IO.Path]::GetFullPath($navigationExtensionPath)
    if (-not $extensionRoot.StartsWith(
        $tmpRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw '手动签到前导航目录越出 tmp 边界。'
    }
    if (Test-Path -LiteralPath $extensionRoot) {
        $item = Get-Item -LiteralPath $extensionRoot -Force
        if (-not $item.PSIsContainer `
            -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            throw '拒绝删除不安全的手动签到前导航目录。'
        }
        Remove-Item -LiteralPath $extensionRoot -Recurse -Force
    }
}

if (-not $Abandon -and ($Origins.Count -gt 0 -or $Selection.Count -gt 0)) {
    throw 'Origins 和 Selection 只能与 -Abandon 一起使用。'
}
if ($Origins.Count -gt 0 -and $Selection.Count -gt 0) {
    throw 'Origins 和 Selection 不能同时使用。'
}

function Clear-ManualContinuationState {
    Remove-Item -LiteralPath $verificationPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $handoffPath -Force -ErrorAction SilentlyContinue
}

function Write-ManualAbandonment($Targets) {
    $now = Get-Date
    $originSet = Get-TodayAbandonedOrigins -Path $abandonPath -Now $now
    foreach ($target in @($Targets)) {
        $origin = ConvertTo-ManualAbandonmentOrigin $target.origin
        if (-not $origin) { throw '今日放弃目标必须是规范的 HTTPS origin。' }
        $originSet[$origin] = $true
    }
    $document = [ordered]@{
        schemaVersion = 1
        date = $now.ToString('yyyyMMdd')
        createdAt = $now.ToUniversalTime().ToString('o')
        origins = @($originSet.Keys | Sort-Object)
    }
    [System.IO.Directory]::CreateDirectory((Split-Path -Parent $abandonPath)) | Out-Null
    $temporaryPath = "$abandonPath.$PID.tmp"
    [System.IO.File]::WriteAllText(
        $temporaryPath,
        ($document | ConvertTo-Json -Depth 4),
        [System.Text.UTF8Encoding]::new($false)
    )
    Move-Item -LiteralPath $temporaryPath -Destination $abandonPath -Force
}

function Resolve-ManualAbandonmentSelection($Targets) {
    $allTargets = @($Targets)
    if ($Origins.Count -eq 0 -and $Selection.Count -eq 0) {
        return [pscustomobject]@{ Abandoned = $allTargets; Remaining = @() }
    }
    if ($allTargets.Count -eq 0) { throw '当前手动会话没有可供选择的站点。' }

    $selectedIndexes = @{}
    foreach ($number in @($Selection)) {
        if ($number -lt 1 -or $number -gt $allTargets.Count) {
            throw "Selection 序号 $number 超出当前手动会话范围 1-$($allTargets.Count)。"
        }
        $selectedIndexes[$number - 1] = $true
    }

    $selectedOrigins = @{}
    foreach ($rawOrigin in @($Origins)) {
        $origin = ConvertTo-ManualAbandonmentOrigin $rawOrigin
        if (-not $origin) { throw "无效的放弃 origin：$rawOrigin" }
        $selectedOrigins[$origin] = $true
    }
    foreach ($origin in @($selectedOrigins.Keys)) {
        $present = @($allTargets | Where-Object {
            (ConvertTo-ManualAbandonmentOrigin $_.origin) -eq $origin
        }).Count -gt 0
        if (-not $present) { throw "放弃 origin 不在当前手动会话中：$origin" }
    }

    $abandoned = @()
    $remaining = @()
    for ($index = 0; $index -lt $allTargets.Count; $index++) {
        $target = $allTargets[$index]
        $origin = ConvertTo-ManualAbandonmentOrigin $target.origin
        $selected = $selectedIndexes.ContainsKey($index) `
            -or ($origin -and $selectedOrigins.ContainsKey($origin))
        if ($selected) { $abandoned += $target } else { $remaining += $target }
    }
    if ($abandoned.Count -eq 0) { throw '没有选中任何当前手动会话站点。' }
    return [pscustomobject]@{ Abandoned = @($abandoned); Remaining = @($remaining) }
}

function Get-ManualVerificationTargets($SessionState) {
    $resolved = @()
    foreach ($item in @($SessionState.targets)) {
        $uri = try { [uri]([string]$item.origin) } catch { $null }
        if (-not $uri -or $uri.Scheme -notin @('http', 'https') -or -not $uri.Host -or $uri.UserInfo) {
            return @()
        }
        $resolved += [ordered]@{
            origin = "$($uri.Scheme)://$($uri.Authority)"
            previousStatus = [string]$item.previousStatus
            verificationStatus = 'pending_verification'
        }
    }
    return @($resolved)
}

function Write-ManualVerification($SessionState, $VerificationTargets) {
    $closedAt = (Get-Date).ToUniversalTime().ToString('o')
    $verification = [ordered]@{
        schemaVersion = 1
        state = 'pending_verification'
        createdAt = $closedAt
        manualSessionStartedAt = [string]$SessionState.startedAt
        manualSessionClosedAt = $closedAt
        sourceRunId = $SessionState.sourceRunId
        sourceFinishedAt = $SessionState.sourceFinishedAt
        selectionMode = [string]$SessionState.selectionMode
        bookmarkPlanGeneratedAt = $SessionState.bookmarkPlanGeneratedAt
        bookmarkLastModifiedAt = $SessionState.bookmarkLastModifiedAt
        successInferredFromManualInteraction = $false
        authoritativeEvidenceRequired = $true
        targets = @($VerificationTargets)
    }
    [System.IO.Directory]::CreateDirectory((Split-Path -Parent $verificationPath)) | Out-Null
    $temporaryPath = "$verificationPath.$PID.tmp"
    [System.IO.File]::WriteAllText(
        $temporaryPath,
        ($verification | ConvertTo-Json -Depth 6),
        [System.Text.UTF8Encoding]::new($false)
    )
    Move-Item -LiteralPath $temporaryPath -Destination $verificationPath -Force
}

function Set-ManualAbandonmentContinuation($SessionState, $VerificationTargets) {
    $split = Resolve-ManualAbandonmentSelection $VerificationTargets
    Write-ManualAbandonment $split.Abandoned
    Remove-Item -LiteralPath $handoffPath -Force -ErrorAction SilentlyContinue
    if (@($split.Remaining).Count -gt 0) {
        Write-ManualVerification $SessionState $split.Remaining
    }
    else {
        Remove-Item -LiteralPath $verificationPath -Force -ErrorAction SilentlyContinue
    }
    return $split
}

if (-not (Test-Path -LiteralPath $statePath)) {
    if ($Abandon -and ($Origins.Count -gt 0 -or $Selection.Count -gt 0)) {
        throw '没有正在运行的手动登录会话，无法解析部分放弃目标。'
    }
    if ($Abandon) { Clear-ManualContinuationState }
    Remove-ManualNavigationExtension
    Write-Output '没有正在运行的手动登录会话。'
    return
}

$state = try { Get-Content -Raw -Encoding UTF8 -LiteralPath $statePath | ConvertFrom-Json } catch { $null }
if ($state -and [string]$state.mode -eq 'native') {
    . (Join-Path $PSScriptRoot 'Resolve-Runtime.ps1')
    $config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
    $targets = @(Get-CheckinManualSessionBrowserProcesses -Config $config -ProfilePath ([string]$config.automationUserDataDir) -State $state)
    $trackedPid = 0
    $validPid = [int]::TryParse([string]$state.pid, [ref]$trackedPid) -and $trackedPid -gt 0
    $trackedProcessInfo = if ($validPid) {
        @($targets | Where-Object { [int]$_.ProcessId -eq $trackedPid } | Select-Object -First 1)[0]
    }
    else { $null }
    $rebound = $false
    if (-not $trackedProcessInfo -and $targets.Count -eq 1) {
        $trackedProcessInfo = $targets[0]
        $trackedPid = [int]$trackedProcessInfo.ProcessId
        $rebound = $true
    }
    $trackedProcess = if ($trackedProcessInfo) {
        Get-Process -Id $trackedPid -ErrorAction SilentlyContinue
    }
    else { $null }

    $recordedStartText = if ($state.processStartedAt) { [string]$state.processStartedAt } else { [string]$state.startedAt }
    $startToleranceSeconds = if ($state.processStartedAt) { 2 } else { 30 }
    $recordedStart = [datetime]::MinValue
    $profileMatches = try {
        $recordedProfile = [System.IO.Path]::GetFullPath([string]$state.profile)
        $configuredProfile = [System.IO.Path]::GetFullPath([string]$config.automationUserDataDir)
        [string]::Equals($recordedProfile, $configuredProfile, [System.StringComparison]::OrdinalIgnoreCase)
    }
    catch { $false }
    $recordMatches = $profileMatches -and $recordedStartText `
        -and [datetime]::TryParse($recordedStartText, [ref]$recordedStart)
    $identityMatches = $recordMatches -and $trackedProcess
    if ($identityMatches -and -not $rebound) {
        $actualStart = $trackedProcess.StartTime.ToUniversalTime()
        $expectedStart = $recordedStart.ToUniversalTime()
        $identityMatches = [Math]::Abs(($actualStart - $expectedStart).TotalSeconds) -le $startToleranceSeconds
    }
    if ($rebound) { $identityMatches = [bool]$trackedProcess }

    $verificationTargets = @(Get-ManualVerificationTargets $state)
    $recordedTargetCount = 0
    $hasRecordedTargetCount = [int]::TryParse([string]$state.targetCount, [ref]$recordedTargetCount)
    $canCreateVerification = [int]$state.schemaVersion -ge 2 `
        -and $recordMatches `
        -and $verificationTargets.Count -gt 0 `
        -and $hasRecordedTargetCount `
        -and $verificationTargets.Count -eq $recordedTargetCount
    if ($Abandon -and ($Origins.Count -gt 0 -or $Selection.Count -gt 0) -and -not $canCreateVerification) {
        throw '当前手动会话缺少完整目标元数据，无法安全执行部分放弃。'
    }

    if (-not $trackedProcess -and $targets.Count -eq 0 -and $canCreateVerification) {
        if ($Abandon) {
            $abandonment = Set-ManualAbandonmentContinuation $state $verificationTargets
        }
        else {
            Write-ManualVerification $state $verificationTargets
        }
        Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $signalPath -Force -ErrorAction SilentlyContinue
        Remove-ManualNavigationExtension
        if ($Abandon) {
            Write-Output "手动窗口已关闭；今日放弃 $(@($abandonment.Abandoned).Count) 个，保留 $(@($abandonment.Remaining).Count) 个等待权威复核。"
        }
        else {
            Write-Output "手动窗口已关闭；已记录 $($verificationTargets.Count) 个等待权威复核的站点。"
        }
        return
    }

    if (-not $identityMatches) {
        if ($targets.Count -gt 0) {
            throw '手动登录窗口仍在运行，但无法安全识别其会话进程；为避免误关其他 Edge，保留状态记录。'
        }
        Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $signalPath -Force -ErrorAction SilentlyContinue
        Remove-ManualNavigationExtension
        Write-Output '手动登录记录已失效，已清理。'
        return
    }

    $closeTargets = @($targets | ForEach-Object {
        Get-Process -Id ([int]$_.ProcessId) -ErrorAction SilentlyContinue
    } | Where-Object { $_.MainWindowHandle -ne 0 })
    if ($closeTargets.Count -eq 0) { $closeTargets = @($trackedProcess) }
    foreach ($closeTarget in $closeTargets) { [void]$closeTarget.CloseMainWindow() }

    $deadline = (Get-Date).AddSeconds(20)
    do {
        Start-Sleep -Milliseconds 500
        $remaining = @(Get-CheckinManualSessionBrowserProcesses -Config $config -ProfilePath ([string]$config.automationUserDataDir) -State $state)
    } while ($remaining.Count -gt 0 -and (Get-Date) -lt $deadline)
    if ($remaining.Count -gt 0) { throw '原生手动登录窗口未能正常退出，请手动关闭后重试。' }

    if ($Abandon) {
        $abandonment = Set-ManualAbandonmentContinuation $state $verificationTargets
    }
    elseif ($canCreateVerification) {
        Write-ManualVerification $state $verificationTargets
    }
    Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $signalPath -Force -ErrorAction SilentlyContinue
    Remove-ManualNavigationExtension
    if ($Abandon) {
        Write-Output "机器人专用浏览器已保存会话并正常关闭；今日放弃 $(@($abandonment.Abandoned).Count) 个，保留 $(@($abandonment.Remaining).Count) 个等待权威复核。"
    }
    elseif ($canCreateVerification) {
        Write-Output "机器人专用浏览器已保存会话并正常关闭；已记录 $($verificationTargets.Count) 个等待权威复核的站点。"
    }
    else {
        Write-Output '机器人专用浏览器已保存会话并正常关闭；旧版会话没有可用的定向复核元数据。'
    }
    return
}

if ($Abandon) {
    $abandonTargets = @(Get-ManualVerificationTargets $state)
    if (($Origins.Count -gt 0 -or $Selection.Count -gt 0) -and $abandonTargets.Count -eq 0) {
        throw '旧版手动会话没有可用的目标元数据，无法安全执行部分放弃。'
    }
    $abandonment = Set-ManualAbandonmentContinuation $state $abandonTargets
}
[System.IO.File]::WriteAllText($signalPath, (Get-Date).ToString('o'), [System.Text.UTF8Encoding]::new($false))
if ($Abandon) {
    Write-Output "已请求旧版手动登录会话保存并正常关闭；今日放弃 $(@($abandonment.Abandoned).Count) 个，保留 $(@($abandonment.Remaining).Count) 个等待权威复核。"
}
else {
    Write-Output '已请求旧版手动登录会话保存并正常关闭。'
}
