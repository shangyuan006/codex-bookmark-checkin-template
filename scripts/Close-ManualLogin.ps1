[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$signalPath = Join-Path $root 'tmp\close-manual-session.signal'
$statePath = Join-Path $root 'tmp\manual-session.json'
$verificationPath = Join-Path $root 'tmp\manual-verification.json'

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
    Write-Output '没有正在运行的手动登录会话。'
    return
}

$state = try { Get-Content -Raw -Encoding UTF8 -LiteralPath $statePath | ConvertFrom-Json } catch { $null }
if ($state -and [string]$state.mode -eq 'native') {
    . (Join-Path $PSScriptRoot 'Resolve-Runtime.ps1')
    $config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
    $targets = @(Get-CheckinAutomationBrowserProcesses $config)
    $trackedPid = 0
    $validPid = [int]::TryParse([string]$state.pid, [ref]$trackedPid) -and $trackedPid -gt 0
    $trackedProcessInfo = if ($validPid) {
        @($targets | Where-Object { [int]$_.ProcessId -eq $trackedPid } | Select-Object -First 1)[0]
    }
    else { $null }
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
    if ($identityMatches) {
        $actualStart = $trackedProcess.StartTime.ToUniversalTime()
        $expectedStart = $recordedStart.ToUniversalTime()
        $identityMatches = [Math]::Abs(($actualStart - $expectedStart).TotalSeconds) -le $startToleranceSeconds
    }

    $verificationTargets = @(Get-ManualVerificationTargets $state)
    $recordedTargetCount = 0
    $hasRecordedTargetCount = [int]::TryParse([string]$state.targetCount, [ref]$recordedTargetCount)
    $canCreateVerification = [int]$state.schemaVersion -ge 2 `
        -and $recordMatches `
        -and $verificationTargets.Count -gt 0 `
        -and $hasRecordedTargetCount `
        -and $verificationTargets.Count -eq $recordedTargetCount

    if (-not $trackedProcess -and $targets.Count -eq 0 -and $canCreateVerification) {
        Write-ManualVerification $state $verificationTargets
        Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $signalPath -Force -ErrorAction SilentlyContinue
        Write-Output "手动窗口已关闭；已记录 $($verificationTargets.Count) 个等待权威复核的站点。"
        return
    }

    if (-not $identityMatches) {
        Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $signalPath -Force -ErrorAction SilentlyContinue
        if ($targets.Count -gt 0) {
            Write-Output '手动登录记录已失效；未关闭当前占用独立配置的其他浏览器。'
        }
        else {
            Write-Output '手动登录记录已失效，已清理。'
        }
        return
    }

    $sessionProcessIds = @($targets.ProcessId)
    [void]$trackedProcess.CloseMainWindow()

    $deadline = (Get-Date).AddSeconds(20)
    do {
        Start-Sleep -Milliseconds 500
        $remaining = @(Get-CheckinAutomationBrowserProcesses $config | Where-Object {
            $sessionProcessIds -contains $_.ProcessId
        })
    } while ($remaining.Count -gt 0 -and (Get-Date) -lt $deadline)
    if ($remaining.Count -gt 0) { throw '原生手动登录窗口未能正常退出，请手动关闭后重试。' }

    if ($canCreateVerification) {
        Write-ManualVerification $state $verificationTargets
    }
    Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $signalPath -Force -ErrorAction SilentlyContinue
    if ($canCreateVerification) {
        Write-Output "机器人专用浏览器已保存会话并正常关闭；已记录 $($verificationTargets.Count) 个等待权威复核的站点。"
    }
    else {
        Write-Output '机器人专用浏览器已保存会话并正常关闭；旧版会话没有可用的定向复核元数据。'
    }
    return
}

[System.IO.File]::WriteAllText($signalPath, (Get-Date).ToString('o'), [System.Text.UTF8Encoding]::new($false))
Write-Output '已请求旧版手动登录会话保存并正常关闭。'
