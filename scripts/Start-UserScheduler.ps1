[CmdletBinding()]
param([switch]$Once)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'TaskRuntimeBudget.ps1')
. (Join-Path $PSScriptRoot 'Resolve-Runtime.ps1')
. (Join-Path $PSScriptRoot 'ManualVerification.ps1')
. (Join-Path $PSScriptRoot 'ResultContract.ps1')
. (Join-Path $PSScriptRoot 'ManualAbandonment.ps1')
. (Join-Path $PSScriptRoot 'CheckinCycle.ps1')
. (Join-Path $PSScriptRoot 'AgentRouterAccount.ps1')
$configPath = Join-Path $root 'config\config.json'
$initialConfig = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
$statePath = Join-Path $root 'data\scheduler-state.json'
$heartbeatPath = Join-Path $root 'data\scheduler-heartbeat.json'
$schedulerLogPath = Join-Path $root 'logs\scheduler.log'
$manualSessionPath = Join-Path $root 'tmp\manual-session.json'
$manualLaunchPath = Join-Path $root 'tmp\manual-handoff-launch.json'
$manualVerificationPath = Join-Path $root 'tmp\manual-verification.json'
$manualHandoffPath = Join-Path $root 'tmp\manual-handoff.json'
$manualAbandonPath = Join-Path $root 'tmp\manual-abandon.json'
$agentRouterManualStatePath = Join-Path $root 'tmp\agentrouter-manual-state.json'
$agentRouterProviderStagePath = Join-Path $root 'tmp\agentrouter-linuxdo-provider-state.json'
$outboxScript = Join-Path $PSScriptRoot 'Invoke-CheckinNotificationOutbox.ps1'
$mutexCreated = $false
$mutexName = if ($initialConfig.schedulerMutexName) { [string]$initialConfig.schedulerMutexName } else { 'Local\CodexBookmarkDailyCheckinScheduler' }
$mutex = [System.Threading.Mutex]::new($true, $mutexName, [ref]$mutexCreated)
if (-not $mutexCreated) { exit 0 }

function Write-SchedulerLog([string]$message) {
    Add-Content -LiteralPath $schedulerLogPath -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $message" -Encoding UTF8
}

function Write-SchedulerJsonAtomic([string]$Path, $Value, [int]$Attempts = 5) {
    [System.IO.Directory]::CreateDirectory((Split-Path -Parent $Path)) | Out-Null
    $lastError = $null
    for ($attempt = 1; $attempt -le [Math]::Max(1, $Attempts); $attempt++) {
        $temporary = "$Path.$PID.$([guid]::NewGuid().ToString('N')).tmp"
        try {
            [System.IO.File]::WriteAllText(
                $temporary,
                ($Value | ConvertTo-Json -Depth 12),
                [System.Text.UTF8Encoding]::new($false)
            )
            Move-Item -LiteralPath $temporary -Destination $Path -Force -ErrorAction Stop
            return
        }
        catch {
            $lastError = $_.Exception
            if (Test-Path -LiteralPath $temporary) {
                Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
            }
            if ($attempt -lt [Math]::Max(1, $Attempts)) { Start-Sleep -Milliseconds (100 * $attempt) }
        }
    }
    throw $lastError
}

function Write-SchedulerHeartbeat([string]$phase) {
    $value = [ordered]@{ processId = $PID; updatedAt = (Get-Date).ToString('o'); phase = $phase }
    Write-SchedulerJsonAtomic $heartbeatPath $value
}

function Read-SchedulerState {
    if (-not (Test-Path -LiteralPath $statePath)) { return [pscustomobject]@{} }
    try { return Get-Content -Raw -Encoding UTF8 -LiteralPath $statePath | ConvertFrom-Json }
    catch { return [pscustomobject]@{} }
}

function Get-CurrentPlanFingerprint($config) {
    try {
        $node = Resolve-CheckinNode $config
        $currentPlanScript = Join-Path $root 'src\current-plan.mjs'
        $raw = @(& $node $currentPlanScript '--root' $root 2>$null)
        if ($LASTEXITCODE -ne 0 -or $raw.Count -eq 0) { return '' }
        $plan = ($raw -join [Environment]::NewLine) | ConvertFrom-Json
        $fingerprint = [string]$plan.planFingerprint
        if ($fingerprint -match '^[a-f0-9]{64}$') { return $fingerprint }
    }
    catch { }
    return ''
}

function Get-LatestReportState([datetime]$now, $config, [Nullable[datetime]]$notBefore = $null, [string]$CurrentPlanFingerprint = '') {
    $latestPath = Join-Path $root 'logs\latest.json'
    $empty = [pscustomobject]@{
        Valid = $false; Complete = $false; NextEligibleAt = $null; RunId = $null
        ProblemCount = $null; RunState = $null; PlannedTotal = 0; ProcessedTotal = 0; DueOrigins = @()
    }
    if (-not (Test-Path -LiteralPath $latestPath)) { return $empty }
    try {
        if ($null -ne $notBefore -and (Get-Item -LiteralPath $latestPath).LastWriteTime -lt ([datetime]$notBefore).AddSeconds(-2)) { return $empty }
        $latest = Get-Content -Raw -Encoding UTF8 -LiteralPath $latestPath | ConvertFrom-Json
        $latestPlanFingerprint = [string]$latest.planFingerprint
        if (-not $latestPlanFingerprint -and $latest.bookmarkSummary) {
            $latestPlanFingerprint = [string]$latest.bookmarkSummary.planFingerprint
        }
        if ($CurrentPlanFingerprint -and $latestPlanFingerprint -and $CurrentPlanFingerprint -ne $latestPlanFingerprint) {
            return $empty
        }
        $minimumTargets = [Math]::Max(1, [int]$config.minimumBookmarkTargetCount)
        $results = @($latest.results)
        $runState = [string]$latest.runState
        $plannedTotal = if ($null -ne $latest.plannedTotal) { [int]$latest.plannedTotal } else { 0 }
        $processedTotal = if ($null -ne $latest.processedTotal) { [int]$latest.processedTotal } else { $results.Count }
        $valid = [string]$latest.runId -like "$($now.ToString('yyyyMMdd'))-*" `
            -and $runState -eq 'final' `
            -and $results.Count -ge $minimumTargets `
            -and $plannedTotal -ge $minimumTargets
        if (-not $valid) { return $empty }
        $contractComplete = $latest.isComplete -eq $true `
            -and $processedTotal -ge $plannedTotal `
            -and $results.Count -ge $plannedTotal
        $abandonedOrigins = Get-TodayAbandonedOrigins -Path $manualAbandonPath -Now $now
        $problems = @($results | Where-Object {
            $resultOrigin = ConvertTo-ManualAbandonmentOrigin $_.origin
            ((-not (Test-CheckinResultTerminal $_)) -or (-not (Test-CheckinCycleCurrent $_ $config ([datetimeoffset]$now) $latest.finishedAt))) -and (-not $resultOrigin -or -not $abandonedOrigins.ContainsKey($resultOrigin))
        })
        $dueOrigins = @($problems | Where-Object {
            if ([string]$_.status -ne 'deferred' -or -not $_.nextEligibleAt) { return $true }
            try { return ([datetime]$_.nextEligibleAt -le $now) } catch { return $true }
        } | ForEach-Object { ConvertTo-ManualAbandonmentOrigin $_.origin } | Where-Object { $_ } | Sort-Object -Unique)
        $missingCount = [Math]::Max(0, $plannedTotal - $processedTotal)
        $retryTimes = @($problems | Where-Object { $_.status -eq 'deferred' -and $_.nextEligibleAt } | ForEach-Object {
            try { [datetime]$_.nextEligibleAt } catch { }
        } | Where-Object { $_ -gt $now })
        return [pscustomobject]@{
            Valid = $true
            Complete = $contractComplete -and $problems.Count -eq 0
            NextEligibleAt = if ($retryTimes.Count -gt 0) { @($retryTimes | Sort-Object)[0] } else { $null }
            RunId = [string]$latest.runId
            ProblemCount = $problems.Count + $missingCount
            RunState = $runState
            PlannedTotal = $plannedTotal
            ProcessedTotal = $processedTotal
            DueOrigins = $dueOrigins
        }
    }
    catch { return $empty }
}

function Get-ManualHandoffState([datetime]$Now) {
    $empty = [pscustomobject]@{
        Mode = 'none'
        SourceRunId = $null
        ChangedAt = $null
        Targets = @()
    }
    if ((Test-Path -LiteralPath $manualSessionPath) -or (Test-ManualHandoffLaunchActive -Path $manualLaunchPath)) {
        return [pscustomobject]@{
            Mode = 'manual_session'
            SourceRunId = $null
            ChangedAt = $null
        }
    }
    $todayPrefix = $Now.ToString('yyyyMMdd') + '-'
    if (Test-Path -LiteralPath $manualVerificationPath) {
        try {
            $verification = Get-Content -Raw -Encoding UTF8 -LiteralPath $manualVerificationPath | ConvertFrom-Json
            $pendingCount = @($verification.targets | Where-Object {
                -not (Test-ManualVerificationTargetTerminal $_)
            }).Count
            if ([string]$verification.state -eq 'pending_verification' `
                -and $verification.authoritativeEvidenceRequired -eq $true `
                -and (Test-ManualVerificationCurrentDayDocument $verification $Now) `
                -and $pendingCount -gt 0) {
                $handoffTargets = @()
                if (Test-Path -LiteralPath $manualHandoffPath) {
                    try {
                        $handoff = Get-Content -Raw -Encoding UTF8 -LiteralPath $manualHandoffPath | ConvertFrom-Json
                        if ([string]$handoff.state -eq 'awaiting_manual_handoff' `
                            -and [string]$handoff.sourceRunId -like "$todayPrefix*" `
                            -and $handoff.authoritativeEvidenceRequired -eq $true) {
                            $handoffTargets = @($handoff.targets)
                        }
                    }
                    catch { $handoffTargets = @() }
                }
                return [pscustomobject]@{
                    Mode = 'verification_ready'
                    SourceRunId = [string]$verification.sourceRunId
                    ChangedAt = (Get-Item -LiteralPath $manualVerificationPath).LastWriteTimeUtc.ToString('o')
                    Targets = $handoffTargets
                }
            }
        }
        catch { }
    }
    if (Test-Path -LiteralPath $manualHandoffPath) {
        try {
            $handoff = Get-Content -Raw -Encoding UTF8 -LiteralPath $manualHandoffPath | ConvertFrom-Json
            $targetCount = @($handoff.targets).Count
            if ([string]$handoff.state -eq 'awaiting_manual_handoff' `
                -and [string]$handoff.sourceRunId -like "$todayPrefix*" `
                -and $handoff.authoritativeEvidenceRequired -eq $true `
                -and $targetCount -gt 0) {
                return [pscustomobject]@{
                    Mode = 'awaiting_manual_handoff'
                    SourceRunId = [string]$handoff.sourceRunId
                    ChangedAt = (Get-Item -LiteralPath $manualHandoffPath).LastWriteTimeUtc.ToString('o')
                    Targets = @($handoff.targets)
                }
            }
        }
        catch { }
    }
    return $empty
}

function Get-AgentRouterOrigins($Config) {
    return @($Config.agentrouterAccounts | ForEach-Object {
        try {
            $uri = [uri]([string]$_.origin)
            if ($uri.Scheme -eq 'https' -and $uri.Host) {
                $uri.GetLeftPart([System.UriPartial]::Authority).TrimEnd('/').ToLowerInvariant()
            }
        }
        catch { }
    } | Where-Object { $_ } | Sort-Object -Unique)
}

function Test-AgentRouterHelperRunning {
    $scripts = @('Open-AgentRouterLogin.ps1', 'Close-AgentRouterLogin.ps1', 'Complete-AgentRouterLogin.ps1')
    $queryErrors = @()
    $processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue -ErrorVariable queryErrors)
    if ($queryErrors.Count -gt 0) {
        Write-SchedulerLog '无法读取进程列表，跳过 Agent Router 人工窗口启动以避免重复打开。'
        return $true
    }
    return @($processes | Where-Object {
        $commandLine = [string]$_.CommandLine
        $scripts | Where-Object { $commandLine -like "*$_*" }
    }).Count -gt 0
}

function Get-AgentRouterManualAction($ManualHandoff, $Config) {
    if ([string]$ManualHandoff.Mode -notin @('awaiting_manual_handoff', 'verification_ready')) { return $null }
    $agentOrigins = @(Get-AgentRouterOrigins $Config)
    $targets = @($ManualHandoff.Targets | Where-Object {
        $origin = ConvertTo-ManualAbandonmentOrigin $_.origin
        $origin -and $agentOrigins -contains $origin.ToLowerInvariant()
    })
    if ($targets.Count -eq 0) { return $null }

    if (Test-Path -LiteralPath $agentRouterManualStatePath) {
        try {
            $manualState = Get-Content -Raw -Encoding UTF8 -LiteralPath $agentRouterManualStatePath | ConvertFrom-Json
            $manualKey = [string]$manualState.accountKey
            $manualTarget = @($targets | Where-Object { @($_.accountKeys) -contains $manualKey }) | Select-Object -First 1
            $profileProcesses = @(Get-CheckinProfileBrowserProcesses -Config $Config -ProfilePath ([string]$manualState.profile))
            if ($manualTarget -and $profileProcesses.Count -eq 0) {
                $closedAction = if ([string]$manualState.stage -eq 'provider') { 'provider_closed' } else { 'complete' }
                return [pscustomobject]@{ Action = $closedAction; AccountKey = $manualKey; Target = $manualTarget }
            }
        }
        catch { }
        return [pscustomobject]@{ Action = 'active'; AccountKey = $null; Target = $targets[0] }
    }

    $stage = $null
    $waitingAccountKey = $null
    if (Test-Path -LiteralPath $agentRouterProviderStagePath) {
        try { $stage = Get-Content -Raw -Encoding UTF8 -LiteralPath $agentRouterProviderStagePath | ConvertFrom-Json }
        catch { return [pscustomobject]@{ Action = 'waiting'; AccountKey = $null; Target = $targets[0] } }
    }
    if ($stage) {
        $stageKey = [string]$stage.accountKey
        $stageTarget = @($targets | Where-Object { @($_.accountKeys) -contains $stageKey }) | Select-Object -First 1
        if ($stageTarget) {
            $stageAccount = Resolve-AgentRouterAccountConfig -Accounts @($Config.agentrouterAccounts) `
                -AccountKey $stageKey -Origin ([string]$stageTarget.origin)
            if ([string]$stageAccount.provider -ne 'LinuxDO') { return $null }
            if ([string]$stage.stage -eq 'provider_pending') {
                if (Test-AgentRouterProviderProbeDue $stage) {
                    return [pscustomobject]@{ Action = 'provider_recheck'; AccountKey = $stageKey; Target = $stageTarget }
                }
                $waitingAccountKey = $stageKey
            }
            elseif ([string]$stage.stage -eq 'agentrouter') {
                return [pscustomobject]@{ Action = 'complete'; AccountKey = $stageKey; Target = $stageTarget }
            }
            else {
                return [pscustomobject]@{ Action = 'agentrouter'; AccountKey = $stageKey; Target = $stageTarget }
            }
        }
    }

    # Do not guess an account when an older handoff lacks nested accountKeys;
    # opening another account could mix encrypted sessions.
    foreach ($target in $targets) {
        foreach ($accountKey in @($target.accountKeys | Where-Object { $_ })) {
            if ([string]$accountKey -eq $waitingAccountKey) { continue }
            $account = Resolve-AgentRouterAccountConfig -Accounts @($Config.agentrouterAccounts) `
                -AccountKey ([string]$accountKey) -Origin ([string]$target.origin)
            $action = switch ([string]$account.provider) {
                'LinuxDO' { 'provider' }
                'GitHub' { 'github' }
                default { return $null }
            }
            return [pscustomobject]@{ Action = $action; AccountKey = [string]$accountKey; Target = $target }
        }
    }
    if ($waitingAccountKey) {
        return [pscustomobject]@{ Action = 'waiting'; AccountKey = $waitingAccountKey; Target = $stageTarget }
    }
    return $null
}

function Start-AgentRouterManualAction($Action, $SourceRunId) {
    if ($Action.Action -in @('active', 'waiting') -or (Test-AgentRouterHelperRunning)) { return $false }
    $shell = (Get-Command pwsh,powershell -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    if (-not $shell) { throw '未找到 PowerShell 可执行文件，无法启动 Agent Router 专用交接。' }
    $script = if ($Action.Action -eq 'complete') {
        Join-Path $PSScriptRoot 'Complete-AgentRouterLogin.ps1'
    }
    elseif ($Action.Action -in @('provider_closed', 'provider_recheck')) {
        Join-Path $PSScriptRoot 'Close-AgentRouterLogin.ps1'
    }
    else {
        Join-Path $PSScriptRoot 'Open-AgentRouterLogin.ps1'
    }
    $arguments = @('-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', $script, '-AccountKey', [string]$Action.AccountKey)
    if ($Action.Action -eq 'provider') {
        # Continue immediately after a valid probe, including one-shot dispatch.
        $arguments += @('-ProviderOnly', '-ContinueToAgentRouter')
    }
    elseif ($Action.Action -in @('provider_closed', 'provider_recheck')) {
        $arguments += '-ContinueToAgentRouter'
    }
    elseif ($Action.Action -eq 'agentrouter') {
        $arguments += '-AgentRouterOnly'
    }
    Start-Process -FilePath $shell -ArgumentList $arguments -WindowStyle Hidden | Out-Null
    Write-SchedulerLog "检测到 Agent Router 专用人工交接，已启动阶段=$($Action.Action)、accountKey=$($Action.AccountKey)（来源运行=$SourceRunId）。"
    return $true
}

function Test-ManualHandoffHasNonAgentTargets($ManualHandoff, $Config) {
    if ([string]$ManualHandoff.Mode -notin @('awaiting_manual_handoff', 'verification_ready')) { return $false }
    $agentOrigins = @(Get-AgentRouterOrigins $Config)
    return @($ManualHandoff.Targets | Where-Object {
        $origin = ConvertTo-ManualAbandonmentOrigin $_.origin
        $origin -and $agentOrigins -notcontains $origin.ToLowerInvariant()
    }).Count -gt 0
}

function Start-ManualHandoffActions($ManualHandoff, $Config) {
    if ([string]$ManualHandoff.Mode -notin @('awaiting_manual_handoff', 'verification_ready')) { return }
    $runMutexName = if ($Config.runMutexName) { [string]$Config.runMutexName } else { 'Local\CodexBookmarkCheckinRun' }
    $handoffMutex = [System.Threading.Mutex]::new($false, $runMutexName)
    $handoffMutexOwned = $false
    try {
        try { $handoffMutexOwned = $handoffMutex.WaitOne(0) }
        catch [System.Threading.AbandonedMutexException] { $handoffMutexOwned = $true }
        if (-not $handoffMutexOwned) { return }
        $agentRouterAction = Get-AgentRouterManualAction $ManualHandoff $Config
        if ($null -ne $agentRouterAction -and $agentRouterAction.Action -notin @('active', 'waiting')) {
            [void](Start-AgentRouterManualAction $agentRouterAction $ManualHandoff.SourceRunId)
        }
        if ((Test-ManualHandoffHasNonAgentTargets $ManualHandoff $Config) `
            -and -not (Test-Path -LiteralPath $manualSessionPath) `
            -and -not (Test-ManualHandoffLaunchActive -Path $manualLaunchPath)) {
            $manualLoginScript = Join-Path $PSScriptRoot 'Open-ManualLogin.ps1'
            if (Test-Path -LiteralPath $manualLoginScript) {
                $manualLaunchId = [guid]::NewGuid().ToString('N')
                $manualProcess = $null
                Write-ManualHandoffLaunch -Path $manualLaunchPath -LaunchId $manualLaunchId
                try {
                    $manualProcess = Start-Process -FilePath (Get-Command pwsh,powershell | Select-Object -First 1).Source `
                        -ArgumentList @('-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', $manualLoginScript, '-HandoffLaunchId', $manualLaunchId) `
                        -WindowStyle Hidden -PassThru
                    Write-ManualHandoffLaunch -Path $manualLaunchPath -LaunchId $manualLaunchId -Process $manualProcess
                }
                catch {
                    if ($null -eq $manualProcess -or $manualProcess.HasExited) {
                        Remove-ManualHandoffLaunch -Path $manualLaunchPath -LaunchId $manualLaunchId
                    }
                    throw
                }
                Write-SchedulerLog "检测到人工交接，已自动打开原生 Edge 手动处理入口（来源运行=$($ManualHandoff.SourceRunId)）。"
            }
        }
    }
    finally {
        if ($handoffMutexOwned) { [void]$handoffMutex.ReleaseMutex() }
        $handoffMutex.Dispose()
    }
}

function Test-SchedulerWaiting($state, [datetime]$now, $config, $manualHandoff, $latestReportState = $null) {
    if ([string]$manualHandoff.Mode -in @('manual_session', 'awaiting_manual_handoff')) {
        return $true
    }
    if ([string]$manualHandoff.Mode -eq 'verification_ready' `
        -and ([string]$state.lastManualVerificationSourceRunId -ne [string]$manualHandoff.SourceRunId `
            -or [string]$state.lastManualVerificationChangedAt -ne [string]$manualHandoff.ChangedAt)) {
        return $false
    }
    $today = $now.ToString('yyyy-MM-dd')
    if ([string]$state.lastRunDate -eq $today -and $state.reportComplete -eq $true `
        -and (-not $latestReportState.Valid -or @($latestReportState.DueOrigins).Count -eq 0)) { return $true }
    $maxAttempts = if ($null -ne $config.schedulerMaxDailyAttempts) { [int]$config.schedulerMaxDailyAttempts } else { 3 }
    $maxAttempts = [Math]::Max(1, [Math]::Min(6, $maxAttempts))
    if ([string]$state.lastAttemptDate -eq $today -and [int]$state.attemptsToday -ge $maxAttempts) { return $true }
    if ($latestReportState -and $latestReportState.Valid -and @($latestReportState.DueOrigins).Count -gt 0) {
        return $false
    }
    if ([string]$state.phase -eq 'running' -and $state.lastAttemptStartedAt) {
        $claimMaxAge = Get-CheckinTaskRuntimeBudgetMinutes $config
        try {
            if ($now - [datetime]$state.lastAttemptStartedAt -lt [timespan]::FromMinutes($claimMaxAge)) { return $true }
        }
        catch { }
    }
    if ($state.nextEligibleAt) {
        try { if ([datetime]$state.nextEligibleAt -gt $now) { return $true } } catch { }
    }
    return $false
}

function Write-SchedulerClaim([datetime]$startedAt, [string]$CurrentPlanFingerprint = '') {
    $state = Read-SchedulerState
    $today = $startedAt.ToString('yyyy-MM-dd')
    $attemptsToday = if ([string]$state.lastAttemptDate -eq $today) { [int]$state.attemptsToday + 1 } else { 1 }
    $value = [ordered]@{
        phase = 'running'
        lastAttemptDate = $today
        attemptsToday = $attemptsToday
        lastAttemptStartedAt = $startedAt.ToString('o')
        lastRunDate = $state.lastRunDate
        lastFinishedAt = $state.lastFinishedAt
        lastExitCode = $state.lastExitCode
        reportValid = $state.reportValid
        reportComplete = $state.reportComplete
        lastRunId = $state.lastRunId
        nextEligibleAt = $null
        planFingerprint = if ($CurrentPlanFingerprint) { $CurrentPlanFingerprint } else { $state.planFingerprint }
    }
    Write-SchedulerJsonAtomic $statePath $value
}

function Write-SchedulerState([datetime]$finishedAt, [int]$exitCode, $reportState, $config, $manualHandoff, [string]$CurrentPlanFingerprint = '') {
    $state = Read-SchedulerState
    $failureDelay = if ($null -ne $config.schedulerFailureRetryMinutes) { [int]$config.schedulerFailureRetryMinutes } else { 60 }
    $failureDelay = [Math]::Max(5, [Math]::Min(360, $failureDelay))
    $nextEligibleAt = $null
    if (-not $reportState.Complete) {
        $nextEligibleAt = if ($null -ne $reportState.NextEligibleAt) {
            ([datetime]$reportState.NextEligibleAt).ToString('o')
        } else {
            $finishedAt.AddMinutes($failureDelay).ToString('o')
        }
    }
    $lastManualVerificationSourceRunId = [string]$state.lastManualVerificationSourceRunId
    $lastManualVerificationChangedAt = [string]$state.lastManualVerificationChangedAt
    if ([string]$manualHandoff.Mode -eq 'verification_ready') {
        $lastManualVerificationSourceRunId = [string]$manualHandoff.SourceRunId
        $lastManualVerificationChangedAt = [string]$manualHandoff.ChangedAt
    }
    elseif ([string]$manualHandoff.Mode -eq 'none') {
        $lastManualVerificationSourceRunId = $null
        $lastManualVerificationChangedAt = $null
    }
    $value = [ordered]@{
        phase = 'finished'
        lastAttemptDate = $finishedAt.ToString('yyyy-MM-dd')
        attemptsToday = [Math]::Max(1, [int]$state.attemptsToday)
        lastAttemptStartedAt = $state.lastAttemptStartedAt
        lastRunDate = if ($reportState.Complete) { $finishedAt.ToString('yyyy-MM-dd') } else { $null }
        lastFinishedAt = $finishedAt.ToString('o')
        lastExitCode = $exitCode
        reportValid = [bool]$reportState.Valid
        reportComplete = [bool]$reportState.Complete
        lastRunId = $reportState.RunId
        problemCount = $reportState.ProblemCount
        reportRunState = $reportState.RunState
        plannedTotal = $reportState.PlannedTotal
        processedTotal = $reportState.ProcessedTotal
        nextEligibleAt = $nextEligibleAt
        manualHandoffMode = [string]$manualHandoff.Mode
        manualHandoffSourceRunId = [string]$manualHandoff.SourceRunId
        manualHandoffChangedAt = [string]$manualHandoff.ChangedAt
        lastManualVerificationSourceRunId = $lastManualVerificationSourceRunId
        lastManualVerificationChangedAt = $lastManualVerificationChangedAt
        planFingerprint = if ($CurrentPlanFingerprint) { $CurrentPlanFingerprint } else { $state.planFingerprint }
    }
    Write-SchedulerJsonAtomic $statePath $value
}

try {
    Write-SchedulerLog "调度器启动（PID=$PID）。"
    while ($true) {
        try {
            Write-SchedulerHeartbeat 'idle'
            $config = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
            try {
                Write-SchedulerHeartbeat 'flushing_notifications'
                $outboxResult = (& $outboxScript | Select-Object -Last 1) | ConvertFrom-Json
                if ([int]$outboxResult.processed -gt 0 -or [int]$outboxResult.invalid -gt 0) {
                    Write-SchedulerLog "通知 outbox：处理=$($outboxResult.processed)，送达=$($outboxResult.delivered)，延后=$($outboxResult.deferred)，无效=$($outboxResult.invalid)，隔离=$($outboxResult.quarantined)。"
                }
            }
            catch {
                $outboxMessage = ([string]$_.Exception.Message) -replace '[\r\n\t]+', ' '
                Write-SchedulerLog "通知 outbox 可恢复异常：$outboxMessage"
            }
            Write-SchedulerHeartbeat 'idle'
            $schedule = [string]$config.schedule
            if ($schedule -notmatch '^([01]\d|2[0-3]):[0-5]\d$') { throw "无效签到时间：$schedule" }
            $now = Get-Date
            $scheduledToday = [datetime]::ParseExact("$($now.ToString('yyyy-MM-dd')) $schedule", 'yyyy-MM-dd HH:mm', $null)
            $state = Read-SchedulerState
            $currentPlanFingerprint = Get-CurrentPlanFingerprint $config
            if ($currentPlanFingerprint -and $state.planFingerprint -and $state.planFingerprint -ne $currentPlanFingerprint) {
                Write-SchedulerLog '检测到签到计划指纹变化，清理旧的每日调度状态。'
                $state = [pscustomobject]@{
                    phase = 'finished'
                    lastAttemptDate = $null
                    attemptsToday = 0
                    lastAttemptStartedAt = $null
                    lastRunDate = $null
                    lastFinishedAt = $null
                    lastExitCode = $null
                    reportValid = $false
                    reportComplete = $false
                    lastRunId = $null
                    nextEligibleAt = $null
                    planFingerprint = $currentPlanFingerprint
                }
                Write-SchedulerJsonAtomic $statePath $state
            }
            $manualHandoff = Get-ManualHandoffState $now
            $latestReportState = Get-LatestReportState $now $config $null $currentPlanFingerprint
            Start-ManualHandoffActions $manualHandoff $config
            $manualHandoff = Get-ManualHandoffState $now
            if ($now -ge $scheduledToday -and -not (Test-SchedulerWaiting $state $now $config $manualHandoff $latestReportState)) {
                Write-SchedulerHeartbeat 'running_checkin'
                Write-SchedulerLog "开始第 $([int]$state.attemptsToday + 1) 次签到尝试。"
                $runScript = Join-Path $PSScriptRoot 'Run-Checkin.ps1'
                $runStartedAt = Get-Date
                Write-SchedulerClaim $runStartedAt $currentPlanFingerprint
                $shell = (Get-Command pwsh,powershell -ErrorAction SilentlyContinue | Select-Object -First 1).Source
                if (-not $shell) { throw '未找到 PowerShell 可执行文件。' }
                $runArguments = @(
                    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
                    '-ExecutionPolicy', 'Bypass', '-File', $runScript
                )
                if ([string]$manualHandoff.Mode -eq 'none' -and @($latestReportState.DueOrigins).Count -gt 0) {
                    $runArguments += @('-Origins', (@($latestReportState.DueOrigins) -join ','))
                }
                $process = Start-Process -FilePath $shell -ArgumentList $runArguments -WindowStyle Hidden -PassThru
                while (-not $process.HasExited) {
                    Write-SchedulerHeartbeat 'running_checkin'
                    Start-Sleep -Seconds 15
                    $process.Refresh()
                }
                $finishedAt = Get-Date
                $reportState = Get-LatestReportState $finishedAt $config $runStartedAt $currentPlanFingerprint
                $manualHandoffAfter = Get-ManualHandoffState $finishedAt
                Write-SchedulerState $finishedAt $process.ExitCode $reportState $config $manualHandoffAfter $currentPlanFingerprint
                Write-SchedulerLog "签到结束：退出码=$($process.ExitCode)，报告有效=$($reportState.Valid)，完整=$($reportState.Complete)，进度=$($reportState.ProcessedTotal)/$($reportState.PlannedTotal)，异常=$($reportState.ProblemCount)。"
                if ([string]$manualHandoffAfter.Mode -ne 'none') {
                    Write-SchedulerLog "人工交接状态：$($manualHandoffAfter.Mode)，来源运行=$($manualHandoffAfter.SourceRunId)。"
                    # Consume the handoff in the same scheduler iteration. The
                    # next 60-second poll is only a fallback for external state
                    # changes; it must not be the first point at which the user
                    # sees the manual window.
                    Start-ManualHandoffActions $manualHandoffAfter $config
                }
            }
        }
        catch {
            $message = ([string]$_.Exception.Message) -replace '[\r\n\t]+', ' '
            Write-Warning "后台调度循环发生可恢复异常：$message"
            Write-SchedulerLog "可恢复异常：$message"
        }
        if ($Once) { break }
        Start-Sleep -Seconds 60
    }
}
finally {
    try { Write-SchedulerLog "调度器退出（PID=$PID）。" } catch { }
    $mutex.ReleaseMutex() | Out-Null
    $mutex.Dispose()
}
