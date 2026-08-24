[CmdletBinding()]
param([switch]$Abandon)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$signalPath = Join-Path $root 'tmp\close-manual-session.signal'
$statePath = Join-Path $root 'tmp\manual-session.json'
$verificationPath = Join-Path $root 'tmp\manual-verification.json'
$handoffPath = Join-Path $root 'tmp\manual-handoff.json'
$abandonPath = Join-Path $root 'tmp\manual-abandon.json'

function Clear-ManualContinuationState {
    Remove-Item -LiteralPath $verificationPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $handoffPath -Force -ErrorAction SilentlyContinue
}

function Write-ManualAbandonment($Targets) {
    $today = (Get-Date).ToString('yyyyMMdd')
    $existingOrigins = @()
    if (Test-Path -LiteralPath $abandonPath) {
        try {
            $existing = Get-Content -Raw -Encoding UTF8 -LiteralPath $abandonPath | ConvertFrom-Json
            if ([string]$existing.date -eq $today) { $existingOrigins = @($existing.origins) }
        }
        catch { $existingOrigins = @() }
    }
    $origins = @($existingOrigins + @($Targets | ForEach-Object { [string]$_.origin }) `
        | Where-Object { $_ } | Sort-Object -Unique)
    $document = [ordered]@{
        schemaVersion = 1
        date = $today
        createdAt = (Get-Date).ToUniversalTime().ToString('o')
        origins = $origins
    }
    $temporaryPath = "$abandonPath.$PID.tmp"
    [System.IO.File]::WriteAllText(
        $temporaryPath,
        ($document | ConvertTo-Json -Depth 4),
        [System.Text.UTF8Encoding]::new($false)
    )
    Move-Item -LiteralPath $temporaryPath -Destination $abandonPath -Force
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

if (-not (Test-Path -LiteralPath $statePath)) {
    if ($Abandon) { Clear-ManualContinuationState }
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

    if (-not $trackedProcess -and $targets.Count -eq 0 -and $canCreateVerification) {
        if ($Abandon) {
            Write-ManualAbandonment $verificationTargets
            Clear-ManualContinuationState
        }
        else {
            Write-ManualVerification $state $verificationTargets
        }
        Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $signalPath -Force -ErrorAction SilentlyContinue
        if ($Abandon) {
            Write-Output "手动窗口已关闭；已将 $($verificationTargets.Count) 个站点标记为今日放弃。"
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
        Write-ManualAbandonment $verificationTargets
        Clear-ManualContinuationState
    }
    elseif ($canCreateVerification) {
        Write-ManualVerification $state $verificationTargets
    }
    Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $signalPath -Force -ErrorAction SilentlyContinue
    if ($Abandon) {
        Write-Output "机器人专用浏览器已保存会话并正常关闭；已将 $($verificationTargets.Count) 个站点标记为今日放弃。"
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
    if ($abandonTargets.Count -gt 0) { Write-ManualAbandonment $abandonTargets }
    Clear-ManualContinuationState
}
[System.IO.File]::WriteAllText($signalPath, (Get-Date).ToString('o'), [System.Text.UTF8Encoding]::new($false))
Write-Output '已请求旧版手动登录会话保存并正常关闭。'
