[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$SuppressReport,
    [int]$Attempts = 0,
    [string[]]$Origins = @(),
    [string]$ReauthAccountKey,
    [switch]$ForceReauth,
    [switch]$PostOAuthVerify
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Resolve-Runtime.ps1')
. (Join-Path $PSScriptRoot 'RunLock.ps1')
. (Join-Path $PSScriptRoot 'ManualVerification.ps1')
. (Join-Path $PSScriptRoot 'ManualAbandonment.ps1')
. (Join-Path $PSScriptRoot 'NativeFallbackPolicy.ps1')
. (Join-Path $PSScriptRoot 'TaskRetryPolicy.ps1')
. (Join-Path $PSScriptRoot 'TaskRuntimeBudget.ps1')
$reporterScript = Join-Path $PSScriptRoot 'Submit-UnifiedCheckinReport.ps1'
$outboxScript = Join-Path $PSScriptRoot 'Invoke-CheckinNotificationOutbox.ps1'
$timeoutFinalizerScript = Join-Path $root 'src\finalize-timeout-report.mjs'
$runLockPath = Join-Path $root 'tmp\run.lock'
$manualVerificationPath = Join-Path $root 'tmp\manual-verification.json'
$manualSessionPath = Join-Path $root 'tmp\manual-session.json'
$manualHandoffPath = Join-Path $root 'tmp\manual-handoff.json'
$manualAbandonPath = Join-Path $root 'tmp\manual-abandon.json'
$startedAt = Get-Date
$runnerStatus = 'failed'
$runnerMessage = '签到任务尚未开始。'
$nodeExitCode = 1
$locationPushed = $false
$resumeCandidate = $null
$wrapperMutex = $null
$wrapperMutexOwned = $false
$manualVerification = $null

function Get-FreshResumeReport([datetime]$NotBefore) {
    $logsRoot = Join-Path $root 'logs'
    if (-not (Test-Path -LiteralPath $logsRoot)) { return $null }
    $candidates = @()
    $latestPath = Join-Path $logsRoot 'latest.json'
    if (Test-Path -LiteralPath $latestPath) { $candidates += Get-Item -LiteralPath $latestPath }
    $candidates += @(Get-ChildItem -LiteralPath $logsRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        foreach ($name in @('result.json', 'progress.json')) {
            $path = Join-Path $_.FullName $name
            if (Test-Path -LiteralPath $path) { Get-Item -LiteralPath $path }
        }
    })
    $todayPrefix = (Get-Date).ToString('yyyyMMdd') + '-'
    $validCandidates = @()
    foreach ($file in @($candidates | Where-Object { $_.LastWriteTime -ge $NotBefore.AddSeconds(-2) } | Sort-Object LastWriteTime -Descending)) {
        try {
            $value = Get-Content -Raw -Encoding UTF8 -LiteralPath $file.FullName | ConvertFrom-Json
            if ([string]$value.runId -like "$todayPrefix*" -and $null -ne $value.results) {
                $plannedTotal = if ($null -ne $value.plannedTotal) { [int]$value.plannedTotal } else { 0 }
                $processedTotal = if ($null -ne $value.processedTotal) { [int]$value.processedTotal } else { @($value.results).Count }
                $completeFinal = [string]$value.runState -eq 'final' `
                    -and $value.isComplete -eq $true `
                    -and $plannedTotal -gt 0 `
                    -and $processedTotal -ge $plannedTotal `
                    -and @($value.results).Count -ge $plannedTotal
                $validCandidates += [pscustomobject]@{
                    Path = $file.FullName
                    Report = $value
                    LastWriteTime = $file.LastWriteTime
                    CompleteFinal = $completeFinal
                }
            }
        }
        catch { }
    }
    return @($validCandidates | Sort-Object `
        @{ Expression = { [int]$_.CompleteFinal }; Descending = $true }, `
        @{ Expression = { $_.LastWriteTime }; Descending = $true } | Select-Object -First 1)[0]
}

function Get-TodayResumeReport {
    $latestPath = Join-Path $root 'logs\latest.json'
    if (-not (Test-Path -LiteralPath $latestPath)) { return $null }
    try {
        $value = Get-Content -Raw -Encoding UTF8 -LiteralPath $latestPath | ConvertFrom-Json
        $todayPrefix = (Get-Date).ToString('yyyyMMdd') + '-'
        $minimumTargets = [Math]::Max(1, [int]$config.minimumBookmarkTargetCount)
        if ([string]$value.runId -like "$todayPrefix*" `
            -and [string]$value.runState -eq 'final' `
            -and $value.isComplete -eq $true `
            -and @($value.results).Count -ge $minimumTargets) {
            return [pscustomobject]@{ Path = $latestPath; Report = $value; LastWriteTime = (Get-Item -LiteralPath $latestPath).LastWriteTime }
        }
    }
    catch { }
    return $null
}

function Test-IsCompleteFinalReport($Report) {
    if ($null -eq $Report) { return $false }
    if ([string]$Report.runState -ne 'final' -or $Report.isComplete -ne $true) { return $false }
    $plannedTotal = if ($null -ne $Report.plannedTotal) { [int]$Report.plannedTotal } else { 0 }
    $processedTotal = if ($null -ne $Report.processedTotal) { [int]$Report.processedTotal } else { @($Report.results).Count }
    return $plannedTotal -gt 0 -and $processedTotal -ge $plannedTotal -and @($Report.results).Count -ge $plannedTotal
}

function Test-HasImmediateRetry($Report, [datetime]$RetryAt) {
    $results = @($Report.results)
    if (-not (Test-IsCompleteFinalReport $Report)) { return $true }
    $unresolved = @($results | Where-Object { $_.status -notin @('signed', 'already_signed', 'not_available') })
    if ($unresolved.Count -eq 0) { return $false }
    $immediateRetryStatuses = @('error', 'login_required', 'managed_challenge', 'managed_challenge_timeout', 'unconfirmed', 'clicked', 'visited')
    foreach ($result in $unresolved) {
        $status = [string]$result.status
        if ($status -eq 'deferred') {
            try {
                if (-not $result.nextEligibleAt -or [datetime]$result.nextEligibleAt -le $RetryAt) { return $true }
            }
            catch { return $true }
            continue
        }
        if ($status -in $immediateRetryStatuses) { return $true }
    }
    return $false
}

function Resolve-RequestedCheckinOrigins([string[]]$Values) {
    $resolved = @()
    $seen = @{}
    foreach ($raw in @($Values)) {
        foreach ($item in @([string]$raw -split ',')) {
            $value = $item.Trim()
            $uri = try { [uri]$value } catch { $null }
            if (-not $value -or -not $uri -or $uri.Scheme -ne 'https' -or -not $uri.Host `
                -or $uri.UserInfo -or $uri.AbsolutePath -ne '/' -or $uri.Query -or $uri.Fragment) {
                throw "定向签到只接受无路径、查询参数或凭据的规范 HTTPS origin：$value"
            }
            $origin = $uri.GetLeftPart([System.UriPartial]::Authority).TrimEnd('/')
            $key = $origin.ToLowerInvariant()
            if (-not $seen.ContainsKey($key)) {
                $seen[$key] = $true
                $resolved += $origin
            }
        }
    }
    return @($resolved)
}

function Test-RequestedOriginsAuthoritativelyComplete($Report, [string[]]$RequestedOrigins) {
    if (-not (Test-IsCompleteFinalReport $Report) -or @($RequestedOrigins).Count -eq 0) { return $false }
    $expected = @{}
    foreach ($origin in @($RequestedOrigins)) { $expected[$origin.ToLowerInvariant()] = $true }
    $selected = @{}
    foreach ($value in @($Report.selectedOrigins)) {
        $origin = ConvertTo-ManualVerificationOrigin $value
        if (-not $origin) { return $false }
        $selected[$origin.ToLowerInvariant()] = $true
    }
    if ($selected.Count -ne $expected.Count) { return $false }
    foreach ($origin in @($expected.Keys)) {
        if (-not $selected.ContainsKey($origin)) { return $false }
    }

    $results = @{}
    foreach ($result in @($Report.results)) {
        $origin = ConvertTo-ManualVerificationOrigin $result.origin
        if (-not $origin) { continue }
        $key = $origin.ToLowerInvariant()
        if ($results.ContainsKey($key)) { return $false }
        $results[$key] = $result
    }
    foreach ($origin in @($expected.Keys)) {
        if (-not $results.ContainsKey($origin) `
            -or [string]$results[$origin].status -notin @('signed', 'already_signed')) {
            return $false
        }
    }
    return $true
}

function Test-NeedsSavedLoginSync($ResumeCandidate, [datetime]$Now) {
    if ($null -eq $ResumeCandidate) { return $true }
    foreach ($result in @($ResumeCandidate.Report.results)) {
        $isLoginProblem = [string]$result.status -eq 'login_required' `
            -or ([string]$result.status -eq 'deferred' -and [string]$result.retryCause -eq 'login_required')
        if (-not $isLoginProblem) { continue }
        try { if (-not $result.nextEligibleAt -or [datetime]$result.nextEligibleAt -le $Now) { return $true } }
        catch { return $true }
    }
    return $false
}

function Write-ManualHandoff($Report, [datetime]$Now = (Get-Date)) {
    # Keep the automatic-to-manual boundary durable without opening a visible
    # browser from a hidden scheduled task. The next manual close can then be
    # consumed immediately by the scheduler.
    if (Test-Path -LiteralPath $manualSessionPath) {
        return $false
    }
    $abandonedOrigins = Get-TodayAbandonedOrigins -Path $manualAbandonPath -Now $Now
    $targets = @(Get-ManualHandoffTargets $Report $Now | Where-Object {
        $origin = ConvertTo-ManualAbandonmentOrigin $_.origin
        -not $origin -or -not $abandonedOrigins.ContainsKey($origin)
    })
    if ($targets.Count -eq 0) {
        Remove-Item -LiteralPath $manualHandoffPath -Force -ErrorAction SilentlyContinue
        return $false
    }
    $handoff = [ordered]@{
        schemaVersion = 1
        state = 'awaiting_manual_handoff'
        createdAt = $Now.ToUniversalTime().ToString('o')
        sourceRunId = [string]$Report.runId
        sourceFinishedAt = [string]$Report.finishedAt
        authoritativeEvidenceRequired = $true
        targets = $targets
    }
    [System.IO.Directory]::CreateDirectory((Split-Path -Parent $manualHandoffPath)) | Out-Null
    $temporaryPath = "$manualHandoffPath.$PID.tmp"
    try {
        [System.IO.File]::WriteAllText(
            $temporaryPath,
            ($handoff | ConvertTo-Json -Depth 6),
            [System.Text.UTF8Encoding]::new($false)
        )
        Move-Item -LiteralPath $temporaryPath -Destination $manualHandoffPath -Force
    }
    finally {
        if (Test-Path -LiteralPath $temporaryPath) {
            Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
        }
    }
    Write-Warning "自动签到已结束，$($targets.Count) 个站点等待人工接管；关闭手动窗口后将立即进行定向权威复核。"
    return $true
}

try {
    Push-Location $root
    $locationPushed = $true
    $configPath = Join-Path $root 'config\config.json'
    if (-not (Test-Path -LiteralPath $configPath)) { throw '尚未初始化，请先运行 scripts\Initialize-Checkin.ps1。' }
    $config = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
    $node = Resolve-CheckinNode $config
    $requestedOrigins = @(Resolve-RequestedCheckinOrigins $Origins)
    if ($ReauthAccountKey -and $requestedOrigins.Count -gt 0) {
        throw 'Origins 不能与 Agent Router 的 ReauthAccountKey 同时使用。'
    }
    if ($ForceReauth -and -not $ReauthAccountKey) {
        throw 'ForceReauth 只能与明确的 ReauthAccountKey 同时使用。'
    }
    if ($PostOAuthVerify -and -not $ReauthAccountKey) {
        throw 'PostOAuthVerify 只能与明确的 ReauthAccountKey 同时使用。'
    }
    $nativeFallbackOnlyOrigins = @(Get-NativeFallbackOnlyOrigins $config | Where-Object {
        $requestedOrigins.Count -eq 0 -or $requestedOrigins -contains [string]$_
    })

    $wrapperMutexName = if ($config.runMutexName) { [string]$config.runMutexName } else { 'Local\CodexBookmarkCheckinRun' }
    $wrapperMutex = [System.Threading.Mutex]::new($false, $wrapperMutexName)
    try { $wrapperMutexOwned = $wrapperMutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $wrapperMutexOwned = $true }
    if (-not $wrapperMutexOwned) {
        $runnerStatus = 'busy'
        $runnerMessage = '已有一个签到 wrapper 正在运行，本次不重复启动。'
        $nodeExitCode = 0
        $SuppressReport = $true
        return
    }

    $timeoutMinutes = Get-CheckinTaskTimeoutMinutes $config
    $runAttempts = Get-CheckinTaskRunAttempts $config $Attempts
    if ($DryRun) { $runAttempts = 1 }
    $retryDelayMinutes = Get-CheckinTaskRetryDelayMinutes $config

    $indexScript = Join-Path $root 'src\index.mjs'
    $arguments = @($indexScript)
    if ($DryRun) { $arguments += '--dry-run' }
    if ($ReauthAccountKey) {
        $arguments += @('--origins', 'https://agentrouter.org', '--reauth-account-key', $ReauthAccountKey)
        if ($ForceReauth) { $arguments += '--force-reauth' }
        if ($PostOAuthVerify) { $arguments += '--post-oauth-verify' }
    }
    elseif ($requestedOrigins.Count -gt 0) {
        $arguments += @('--origins', ($requestedOrigins -join ','))
    }

    if (-not $DryRun) { $resumeCandidate = Get-TodayResumeReport }
    if (-not $DryRun -and -not $ReauthAccountKey) {
        $pendingManualVerification = Get-PendingManualVerification -Path $manualVerificationPath
        $todayPrefix = (Get-Date).ToString('yyyyMMdd') + '-'
        if ($null -ne $pendingManualVerification `
            -and $null -ne $resumeCandidate `
            -and [string]$pendingManualVerification.Document.sourceRunId -like "$todayPrefix*") {
            if ($requestedOrigins.Count -eq 0) {
                $manualVerification = $pendingManualVerification
            }
            else {
                $pendingOriginSet = @{}
                foreach ($origin in @($pendingManualVerification.Origins)) {
                    $pendingOriginSet[[string]$origin] = $true
                }
                $requestedOriginsArePending = $true
                foreach ($origin in @($requestedOrigins)) {
                    if (-not $pendingOriginSet.ContainsKey([string]$origin)) {
                        $requestedOriginsArePending = $false
                        break
                    }
                }
                if ($requestedOriginsArePending) {
                    $manualVerification = [pscustomobject]@{
                        Document = $pendingManualVerification.Document
                        Origins = @($requestedOrigins)
                    }
                }
            }
        }
        elseif ($null -ne $pendingManualVerification) {
            Write-Warning '手动复核记录不是今天的有效运行，未强制续跑；请重新打开待处理站点。'
        }
    }

    $preflightConfigured = @($config.nativeWafPreflightUrls).Count -gt 0 -or @($config.nativeChallengePreflight).Count -gt 0
    $currentPreflightTargets = @()
    if (-not $DryRun -and $preflightConfigured) {
        $targetOutput = @(& $node $indexScript '--list-preflight-targets')
        if ($LASTEXITCODE -ne 0) { throw '无法读取当前书签预热目标。' }
        try {
            $parsedPreflightTargets = ($targetOutput -join [Environment]::NewLine) | ConvertFrom-Json
            $currentPreflightTargets = @($parsedPreflightTargets)
        }
        catch { throw "当前书签预热目标格式无效：$($_.Exception.Message)" }
        if ($currentPreflightTargets.Count -eq 0) { throw '当前书签没有可用的预热目标。' }
    }

    $shouldSyncSavedLogins = -not $DryRun `
        -and (Test-NeedsSavedLoginSync $resumeCandidate (Get-Date)) `
        -and $config.syncBookmarkSavedLogins -eq $true
    if ($shouldSyncSavedLogins) {
        & (Join-Path $PSScriptRoot 'Sync-ChromeSavedLogins.ps1')
    }

    if ($DryRun) {
        & $node @arguments
        $nodeExitCode = $LASTEXITCODE
        $runnerStatus = 'skipped'
        $runnerMessage = '仅执行书签读取与对比，未签到。'
    }
    else {
        for ($attempt = 1; $attempt -le $runAttempts; $attempt++) {
            $manualAttemptUpdate = $null
            $needsNativeFallbackRetry = $false
            $runArguments = @($arguments)
            if ($null -ne $resumeCandidate) {
                $runArguments += @('--resume-report', [string]$resumeCandidate.Path)
            }
            if ($null -ne $manualVerification) {
                if ($requestedOrigins.Count -eq 0) {
                    $runArguments += @('--origins', (@($manualVerification.Origins) -join ','))
                }
                $runArguments += @(
                    '--consume-manual-verification',
                    '--consume-manual-verification-subset'
                )
            }
            elseif ($attempt -gt 1 -and $requestedOrigins.Count -eq 0 -and $null -ne $resumeCandidate) {
                $fallbackRetryOrigins = @(Get-NativeFallbackRetryOrigins `
                    -Report $resumeCandidate.Report `
                    -Origins $nativeFallbackOnlyOrigins)
                if ($fallbackRetryOrigins.Count -gt 0) {
                    $runArguments += @('--origins', ($fallbackRetryOrigins -join ','))
                }
            }
            if ($preflightConfigured) {
                $preflightTargets = @($currentPreflightTargets)
                if ($null -ne $resumeCandidate) {
                    $previousOriginSet = @{}
                    $pendingOriginSet = @{}
                    foreach ($result in @($resumeCandidate.Report.results)) {
                        $resultOrigin = [string]$result.origin
                        $previousOriginSet[$resultOrigin] = $true
                        if ([string]$result.status -notin @('signed', 'already_signed', 'not_available')) {
                            $pendingOriginSet[$resultOrigin] = $true
                        }
                    }
                    $preflightTargets = @($currentPreflightTargets | Where-Object {
                        $targetOrigin = [string]$_.origin
                        -not $previousOriginSet.ContainsKey($targetOrigin) -or $pendingOriginSet.ContainsKey($targetOrigin)
                    })
                }
                if ($null -ne $manualVerification) {
                    $manualOriginSet = @{}
                    foreach ($origin in @($manualVerification.Origins)) {
                        $manualOriginSet[[string]$origin] = $true
                    }
                    $preflightTargets = @($preflightTargets | Where-Object {
                        $manualOriginSet.ContainsKey([string]$_.origin)
                    })
                }
                elseif ($requestedOrigins.Count -gt 0) {
                    $requestedOriginSet = @{}
                    foreach ($origin in @($requestedOrigins)) { $requestedOriginSet[$origin] = $true }
                    $preflightTargets = @($preflightTargets | Where-Object {
                        $requestedOriginSet.ContainsKey([string]$_.origin)
                    })
                }
                if ($attempt -eq 1 -and $nativeFallbackOnlyOrigins.Count -gt 0) {
                    $preflightTargets = @($preflightTargets | Where-Object {
                        -not ($nativeFallbackOnlyOrigins -contains [string]$_.origin)
                    })
                }
                $preflightOrigins = @($preflightTargets | ForEach-Object {
                    if (@($_.allowedOrigins).Count -gt 0) { @($_.allowedOrigins) } else { [string]$_.origin }
                } | Sort-Object -Unique)
                if ($preflightOrigins.Count -gt 0) {
                    & (Join-Path $PSScriptRoot 'Prepare-NativeWafSession.ps1') -Origins $preflightOrigins
                }
            }

            Write-Output "开始签到任务级尝试 $attempt/$runAttempts。"
            $attemptStartedAt = Get-Date
            $process = Start-Process -FilePath $node -ArgumentList $runArguments -NoNewWindow -PassThru
            $processStartedAt = $process.StartTime
            $finishedInTime = $process.WaitForExit($timeoutMinutes * 60 * 1000)
            if (-not $finishedInTime) {
                try { $process.Kill($true) } catch { try { $process.Kill() } catch { } }
                $nodeExitCode = 124
                $runnerStatus = 'timeout'
                $runnerMessage = "第 $attempt 次尝试超过 $timeoutMinutes 分钟。"
                $processExited = $false
                try { $processExited = $process.WaitForExit(10000) } catch { }
                try { $process.Refresh(); $processExited = $processExited -or $process.HasExited } catch { }
                if (-not $processExited) {
                    $runnerStatus = 'timeout_process_alive'
                    $runnerMessage = "第 $attempt 次尝试超时且子进程仍存活；保留运行锁，拒绝并发重试。"
                    $SuppressReport = $true
                    Write-Warning $runnerMessage
                    break
                }
                [void](Remove-RunLockOwnedByProcess -LockPath $runLockPath -ProcessId $process.Id -ProcessStartedAt $processStartedAt)
                $timeoutProgress = Get-FreshResumeReport $attemptStartedAt
                if ($null -ne $timeoutProgress -and [string]$timeoutProgress.Report.runState -eq 'in_progress') {
                    try {
                        & $node $timeoutFinalizerScript --progress-report ([string]$timeoutProgress.Path) | Out-Null
                        if ($LASTEXITCODE -ne 0) { throw '超时进度报告补全失败。' }
                    }
                    catch {
                        Write-Warning "超时进度报告未能补全：$($_.Exception.Message)"
                    }
                }
            }
            else {
                $nodeExitCode = $process.ExitCode
                $runnerStatus = 'completed'
                $runnerMessage = "任务级尝试 $attempt/$runAttempts 已结束，退出码 $nodeExitCode。"
            }
            $freshCandidate = Get-FreshResumeReport $attemptStartedAt
            if ($null -ne $freshCandidate) { $resumeCandidate = $freshCandidate }
            if ($requestedOrigins.Count -gt 0 `
                -and $null -ne $freshCandidate `
                -and (Test-RequestedOriginsAuthoritativelyComplete $freshCandidate.Report $requestedOrigins)) {
                $nodeExitCode = 0
                $runnerStatus = 'completed'
                $runnerMessage = "$($requestedOrigins.Count) 个定向站点已取得权威签到结果。"
                $needsNativeFallbackRetry = $false
            }
            if ($ReauthAccountKey `
                -and $null -ne $freshCandidate `
                -and (Test-IsCompleteFinalReport $freshCandidate.Report)) {
                $needsNativeFallbackRetry = $false
                if (Test-ReauthAccountAuthoritativelyComplete $freshCandidate.Report $ReauthAccountKey) {
                    $nodeExitCode = 0
                    $runnerStatus = 'completed'
                    $runnerMessage = "Agent Router accountKey '$ReauthAccountKey' 已取得权威签到结果。"
                }
                else {
                    $nodeExitCode = 2
                    $runnerStatus = 'needs_attention'
                    $runnerMessage = "Agent Router accountKey '$ReauthAccountKey' 未取得 signed 或 already_signed 权威结果。"
                }
            }
            if (-not $ReauthAccountKey `
                -and $attempt -eq 1 `
                -and $attempt -lt $runAttempts `
                -and $null -ne $freshCandidate) {
                $needsNativeFallbackRetry = Test-NeedsNativeFallbackRetry `
                    -Report $freshCandidate.Report `
                    -Origins $nativeFallbackOnlyOrigins
                if ($needsNativeFallbackRetry) {
                    Write-Warning '首轮仍有原生 fallback 站点未确认；继续第二轮原生签到复核。'
                }
            }
            if ($null -ne $manualVerification -and $null -ne $freshCandidate) {
                $manualAttemptUpdate = Update-ManualVerificationState `
                    -Pending $manualVerification `
                    -Report $freshCandidate.Report `
                    -Path $manualVerificationPath `
                    -RetryAt ((Get-Date).AddMinutes($retryDelayMinutes))
                if ($manualAttemptUpdate.Updated) {
                    if ($manualAttemptUpdate.Complete) {
                        Write-Output '手动操作后的定向权威复核已全部确认。'
                    }
                    else {
                        Write-Output "手动操作后的定向权威复核仍有 $(@($manualAttemptUpdate.PendingOrigins).Count) 个待处理站点。"
                    }
                }
            }
            if ($null -ne $freshCandidate -and (Test-IsCompleteFinalReport $freshCandidate.Report)) {
                [void](Write-ManualHandoff $freshCandidate.Report (Get-Date))
            }
            if ($nodeExitCode -eq 0 -and ($null -eq $freshCandidate -or -not (Test-IsCompleteFinalReport $freshCandidate.Report))) {
                $nodeExitCode = 2
                $runnerMessage = "签到程序已结束，但第 $attempt 次尝试未生成完整的 final 报告。"
            }
            if ($null -ne $manualVerification `
                -and $null -ne $freshCandidate `
                -and (Test-IsCompleteFinalReport $freshCandidate.Report) `
                -and ($null -eq $manualAttemptUpdate -or -not $manualAttemptUpdate.Updated)) {
                if ($nodeExitCode -eq 0) { $nodeExitCode = 2 }
                $runnerStatus = 'failed'
                $runnerMessage = '签到程序已结束，但人工复核记录未被当前书签结果更新；可能有复核目标已移出书签范围。'
            }
            if (-not $needsNativeFallbackRetry) {
                if ($nodeExitCode -eq 0) { break }
            }
            if ($attempt -lt $runAttempts) {
                if ($null -ne $manualVerification) {
                    if ($null -ne $manualAttemptUpdate -and $manualAttemptUpdate.Updated -and $manualAttemptUpdate.Complete) {
                        Write-Warning '人工复核目标已全部确认；未选中的其他异常不会触发重复访问。'
                        break
                    }
                    if ($null -eq $manualAttemptUpdate -or -not $manualAttemptUpdate.Updated) {
                        Write-Warning '本轮没有生成可用于更新人工复核记录的完整报告，记录保持待处理。'
                        break
                    }
                    if (@($manualAttemptUpdate.RetryOrigins).Count -eq 0) {
                        Write-Warning '人工复核目标当前没有适合立即重试的站点，本次不重复访问；未确认记录留待后续任务消费。'
                        break
                    }
                    $manualVerification.Origins = @($manualAttemptUpdate.RetryOrigins)
                }
                elseif ($null -ne $resumeCandidate) {
                    if (-not $needsNativeFallbackRetry `
                        -and -not (Test-HasImmediateRetry $resumeCandidate.Report ((Get-Date).AddMinutes($retryDelayMinutes)))) {
                        Write-Warning '剩余站点当前不适合立即重试，本次不空转；仅在后续任务触发且达到 nextEligibleAt 后定向补跑。'
                        break
                    }
                }
                if ($retryDelayMinutes -gt 0 -and -not $needsNativeFallbackRetry) {
                    Start-Sleep -Seconds ($retryDelayMinutes * 60)
                }
            }
        }
    }
}
catch {
    if ($nodeExitCode -eq 0) { $nodeExitCode = 1 }
    $runnerStatus = 'failed'
    $runnerMessage = ([string]$_.Exception.Message -replace '[\r\n\t]+', ' ')
    if ($runnerMessage.Length -gt 300) { $runnerMessage = $runnerMessage.Substring(0, 300) }
    Write-Warning $runnerMessage
}
finally {
    if (-not $DryRun -and -not $SuppressReport) {
        try {
            $notificationCandidate = Get-FreshResumeReport $startedAt
            if ($null -ne $notificationCandidate) { & $reporterScript -RunnerStatus $runnerStatus -RunnerMessage $runnerMessage -ReportPath ([string]$notificationCandidate.Path) }
            else { & $reporterScript -RunnerStatus $runnerStatus -RunnerMessage $runnerMessage }
        }
        catch {
            Write-Warning "结果通知失败：$($_.Exception.Message)"
        }
        try { & $outboxScript | Out-Null }
        catch { Write-Warning "通知 outbox 暂未送达，将由后台调度器重试：$($_.Exception.Message)" }
    }
    if ($locationPushed) { Pop-Location }
    if ($wrapperMutexOwned -and $null -ne $wrapperMutex) {
        try { $wrapperMutex.ReleaseMutex() | Out-Null } catch { }
    }
    if ($null -ne $wrapperMutex) { $wrapperMutex.Dispose() }
}

exit $nodeExitCode
