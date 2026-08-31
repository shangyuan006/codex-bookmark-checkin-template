[CmdletBinding()]
param(
    [string]$Root
)

$ErrorActionPreference = 'Stop'
trap {
    [ordered]@{
        schemaVersion = 1
        healthy = $false
        reason = 'health_check_error'
        checkedAt = (Get-Date).ToString('o')
        failedChecks = @('healthCheckExecution')
        checks = [ordered]@{ healthCheckExecution = $false }
    } | ConvertTo-Json -Depth 6
    exit 3
}

$root = if ($Root) { [System.IO.Path]::GetFullPath($Root) } else { Split-Path -Parent $PSScriptRoot }
. (Join-Path $PSScriptRoot 'TaskRuntimeBudget.ps1')
. (Join-Path $PSScriptRoot 'Resolve-Runtime.ps1')
. (Join-Path $PSScriptRoot 'ManualAbandonment.ps1')

function Test-HealthPath([string]$Path) {
    return [bool]$Path -and (Test-Path -LiteralPath $Path)
}

function Test-HealthBookmarkSources([object]$Config) {
    $bookmarksPathIsArray = $Config.bookmarksPath -is [System.Array]
    $additionalSources = @($Config.additionalBookmarkSources | Where-Object { $null -ne $_ })
    if ($bookmarksPathIsArray -and $additionalSources.Count -gt 0) { return $false }

    $sources = if ($bookmarksPathIsArray) {
        @($Config.bookmarksPath)
    }
    else {
        @([pscustomobject]@{ path = [string]$Config.bookmarksPath; optional = $false }) + $additionalSources
    }
    if ($sources.Count -eq 0) { return $false }

    foreach ($source in $sources) {
        $sourcePath = if ($source -is [string]) { [string]$source } else { [string]$source.path }
        $optional = if ($source -is [string]) { $false } else { $source.optional -eq $true }
        if (-not $sourcePath) { return $false }
        if (-not $optional -and -not ((Test-HealthPath $sourcePath) -or (Test-HealthPath "$sourcePath.bak"))) {
            return $false
        }
    }
    return $true
}

function ConvertTo-HealthOrigin([object]$Value) {
    $raw = [string]$Value
    $uri = try { [uri]$raw } catch { $null }
    if (-not $raw -or $raw -ne $raw.Trim() `
        -or -not $uri -or $uri.Scheme -notin @('http', 'https') -or -not $uri.Host -or $uri.UserInfo `
        -or $uri.AbsolutePath -ne '/' -or $uri.Query -or $uri.Fragment) { return $null }
    return $uri.GetLeftPart([System.UriPartial]::Authority).TrimEnd('/').ToLowerInvariant()
}

function ConvertTo-HealthProvider([object]$Value) {
    $normalized = (([string]$Value).Trim().ToLowerInvariant() -replace '[\s._/-]+', '')
    switch ($normalized) {
        'github' { return 'GitHub' }
        'gitlab' { return 'GitLab' }
        'linuxdo' { return 'LinuxDO' }
        'google' { return 'Google' }
        'gitee' { return 'Gitee' }
        'discord' { return 'Discord' }
        'oauth' { return 'OAuth' }
        default { return $null }
    }
}

function ConvertTo-HealthAccountKey([string]$Value) {
    # Match JavaScript encodeURIComponent, which leaves these five characters unescaped.
    return [uri]::EscapeDataString($Value).Replace('%21', '!').Replace('%27', "'").Replace('%28', '(').Replace('%29', ')').Replace('%2A', '*')
}

function Get-HealthResultIdentity([object]$Target) {
    $origin = ConvertTo-HealthOrigin $Target.origin
    if (-not $origin) { return $null }
    $accountKey = [string]$Target.accountKey
    if ($accountKey) {
        $encodedAccountKey = ConvertTo-HealthAccountKey ($accountKey.Trim())
        return "$origin#account=$encodedAccountKey"
    }
    return $origin
}

function Get-HealthNestedAccountIdentity([string]$Origin, [object]$AccountResult) {
    $accountKey = if ($AccountResult.accountKey) { [string]$AccountResult.accountKey } else { [string]$AccountResult.accountId }
    if (-not $accountKey) { return $null }
    return Get-HealthResultIdentity ([pscustomobject]@{ origin = $Origin; accountKey = $accountKey })
}

function Get-HealthNestedAccountPlanIdentity([string]$Origin, [object]$AccountResult) {
    $identity = Get-HealthNestedAccountIdentity $Origin $AccountResult
    $provider = ConvertTo-HealthProvider $AccountResult.provider
    if (-not $identity -or -not $provider) { return $null }
    return "$identity`n$provider"
}

$configPath = Join-Path $root 'config\config.json'
if (-not (Test-Path -LiteralPath $configPath)) {
    [ordered]@{
        schemaVersion = 1
        healthy = $false
        reason = 'not_initialized'
        checkedAt = (Get-Date).ToString('o')
        failedChecks = @('configPresent')
        checks = [ordered]@{ configPresent = $false }
    } | ConvertTo-Json -Depth 6
    exit 2
}

$config = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
$browserExecutable = if ($config.browserExecutable) { [string]$config.browserExecutable } else { [string]$config.chromeExecutable }
$latestPath = Join-Path $root 'logs\latest.json'
$manualAbandonPath = Join-Path $root 'tmp\manual-abandon.json'
$statePath = Join-Path $root 'data\site-state.json'
$notificationQuarantinePath = Join-Path $root 'data\notification-outbox\quarantine'
$notificationQuarantinedCount = @(Get-ChildItem -LiteralPath $notificationQuarantinePath -Filter '*.invalid.json' -File -ErrorAction SilentlyContinue).Count
$taskName = if ($config.schedulerTaskName) { [string]$config.schedulerTaskName } else { 'CodexBookmarkDailyCheckin' }
$runKeyName = if ($config.schedulerRunKeyName) { [string]$config.schedulerRunKeyName } else { 'CodexBookmarkDailyCheckin' }
$scheduledTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$scheduledTaskEnabled = $scheduledTask -and [string]$scheduledTask.State -ne 'Disabled'
$runValue = try {
    $runProperties = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction Stop
    [string]$runProperties.$runKeyName
} catch { $null }
$schedulerScript = Join-Path $PSScriptRoot 'Start-UserScheduler.ps1'
$watchdogScript = Join-Path $PSScriptRoot 'Ensure-UserScheduler.ps1'
$schedulerCount = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -in @('pwsh.exe', 'powershell.exe') -and $_.CommandLine -like "*-File*$schedulerScript*"
}).Count
$watchdogCount = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -in @('pwsh.exe', 'powershell.exe') -and $_.CommandLine -like "*-File*$watchdogScript*"
}).Count
$latest = if (Test-Path -LiteralPath $latestPath) { Get-Content -Raw -Encoding UTF8 -LiteralPath $latestPath | ConvertFrom-Json } else { $null }
$schedulerStatePath = Join-Path $root 'data\scheduler-state.json'
$schedulerState = if (Test-Path -LiteralPath $schedulerStatePath) { try { Get-Content -Raw -Encoding UTF8 -LiteralPath $schedulerStatePath | ConvertFrom-Json } catch { $null } } else { $null }
$heartbeatPath = Join-Path $root 'data\scheduler-heartbeat.json'
$heartbeat = if (Test-Path -LiteralPath $heartbeatPath) { try { Get-Content -Raw -Encoding UTF8 -LiteralPath $heartbeatPath | ConvertFrom-Json } catch { $null } } else { $null }
$heartbeatMaxAgeMinutes = if ($heartbeat -and [string]$heartbeat.phase -eq 'running_checkin') { Get-CheckinTaskRuntimeBudgetMinutes $config } else { 5 }
$heartbeatUpdatedAt = [datetime]::MinValue
$heartbeatTimestampValid = $false
if ($heartbeat) {
    if ($heartbeat.updatedAt -is [datetime]) {
        $heartbeatUpdatedAt = ([datetime]$heartbeat.updatedAt).ToUniversalTime()
        $heartbeatTimestampValid = $true
    }
    elseif ($heartbeat.updatedAt -is [datetimeoffset]) {
        $heartbeatUpdatedAt = ([datetimeoffset]$heartbeat.updatedAt).UtcDateTime
        $heartbeatTimestampValid = $true
    }
    else {
        $heartbeatTimestampValid = [datetime]::TryParse([string]$heartbeat.updatedAt, [ref]$heartbeatUpdatedAt)
        if ($heartbeatTimestampValid) { $heartbeatUpdatedAt = $heartbeatUpdatedAt.ToUniversalTime() }
    }
}
$heartbeatAge = if ($heartbeatTimestampValid) {
    (Get-Date).ToUniversalTime() - $heartbeatUpdatedAt
}
else {
    [timespan]::MaxValue
}
$heartbeatFresh = $heartbeatTimestampValid -and $heartbeatAge -lt [timespan]::FromMinutes($heartbeatMaxAgeMinutes)

$currentPlan = $null
$currentPlanReadable = $false
try {
    $node = Resolve-CheckinNode $config
    $currentPlanScript = Join-Path (Split-Path -Parent $PSScriptRoot) 'src\current-plan.mjs'
    $currentPlanOutput = @(& $node $currentPlanScript '--root' $root 2>$null)
    if ($LASTEXITCODE -eq 0 -and $currentPlanOutput.Count -gt 0) {
        $currentPlan = ($currentPlanOutput -join [Environment]::NewLine) | ConvertFrom-Json
        $currentPlanReadable = $null -ne $currentPlan.targetCount `
            -and $null -ne $currentPlan.identities `
            -and $null -ne $currentPlan.accountGroups
    }
} catch {
    $currentPlan = $null
    $currentPlanReadable = $false
}

$minimumTargets = [Math]::Max(1, [int]$config.minimumBookmarkTargetCount)
$latestPlannedTotal = if ($latest -and $null -ne $latest.plannedTotal) { [int]$latest.plannedTotal } else { 0 }
$latestProcessedTotal = if ($latest -and $null -ne $latest.processedTotal) { [int]$latest.processedTotal } elseif ($latest) { @($latest.results).Count } else { 0 }
$latestRunToday = $latest -and [string]$latest.runId -like "$(Get-Date -Format 'yyyyMMdd')-*"
$abandonedOrigins = Get-TodayAbandonedOrigins -Path $manualAbandonPath -Now (Get-Date)
$latestAbandonedCount = if ($latestRunToday) { @($latest.results | Where-Object {
    $origin = ConvertTo-ManualAbandonmentOrigin $_.origin
    $origin -and $abandonedOrigins.ContainsKey($origin)
}).Count } else { 0 }
$problemCount = if ($latest) { @($latest.results | Where-Object {
    $origin = ConvertTo-ManualAbandonmentOrigin $_.origin
    $isAbandoned = $latestRunToday -and $origin -and $abandonedOrigins.ContainsKey($origin)
    $_.status -notin @('signed', 'already_signed', 'not_available') -and -not $isAbandoned
}).Count } else { $null }
$latestResultComplete = $latest `
    -and $latestRunToday `
    -and [string]$latest.runState -eq 'final' `
    -and $latest.isComplete -eq $true `
    -and $latestPlannedTotal -ge $minimumTargets `
    -and $latestProcessedTotal -eq $latestPlannedTotal `
    -and @($latest.results).Count -eq $latestPlannedTotal

$currentPlanIdentities = if ($currentPlanReadable) { @($currentPlan.identities | ForEach-Object { [string]$_ } | Sort-Object -Unique) } else { @() }
$latestPlanIdentities = if ($latest) { @(
    @($latest.results) | ForEach-Object { Get-HealthResultIdentity $_ } | Where-Object { $_ } | Sort-Object -Unique
) } else { @() }
$currentPlannedTotal = if ($currentPlanReadable) { [int]$currentPlan.targetCount } else { $null }
$currentPlanIdentityReady = $currentPlanReadable -and $currentPlanIdentities.Count -eq $currentPlannedTotal
$latestPlanIdentityReady = $latest `
    -and @($latest.results).Count -eq $latestPlannedTotal `
    -and $latestPlanIdentities.Count -eq $latestPlannedTotal
$latestTopLevelMatchesCurrentPlan = $currentPlanIdentityReady `
    -and $latestPlanIdentityReady `
    -and $currentPlannedTotal -eq $latestPlannedTotal `
    -and @(Compare-Object -ReferenceObject $currentPlanIdentities -DifferenceObject $latestPlanIdentities).Count -eq 0

$currentAccountGroups = @(if ($currentPlanReadable) { @($currentPlan.accountGroups) } else { @() })
$currentAccountIdentityCount = @($currentAccountGroups | ForEach-Object { @($_.identities) }).Count
$expectedAccountGroupOrigins = @($currentAccountGroups | ForEach-Object {
    ConvertTo-HealthOrigin $_.origin
} | Where-Object { $_ } | Sort-Object -Unique)
$latestNestedAccountParents = @()
$latestNestedAccountInvalidOriginCount = 0
if ($latest) {
    foreach ($result in @($latest.results)) {
        $accountResultsProperty = $result.PSObject.Properties['accountResults']
        if ($null -eq $accountResultsProperty) { continue }
        $parentOrigin = ConvertTo-HealthOrigin $result.origin
        if (-not $parentOrigin) {
            $latestNestedAccountInvalidOriginCount++
            continue
        }
        $latestNestedAccountParents += [pscustomobject]@{
            Origin = $parentOrigin
            Result = $result
            AccountResults = @($accountResultsProperty.Value)
            Abandoned = [bool]($latestRunToday -and $abandonedOrigins.ContainsKey($parentOrigin))
        }
    }
}
$latestNestedAccountOrigins = @($latestNestedAccountParents | ForEach-Object {
    [string]$_.Origin
} | Sort-Object -Unique)
$nestedAccountParentOriginDifferenceCount = if ($expectedAccountGroupOrigins.Count -gt 0 -and $latestNestedAccountOrigins.Count -gt 0) {
    @(Compare-Object -ReferenceObject $expectedAccountGroupOrigins -DifferenceObject $latestNestedAccountOrigins).Count
}
else {
    $expectedAccountGroupOrigins.Count + $latestNestedAccountOrigins.Count
}
$nestedAccountParentOriginsMatch = $currentPlanReadable `
    -and $expectedAccountGroupOrigins.Count -eq @($currentAccountGroups).Count `
    -and $latestNestedAccountInvalidOriginCount -eq 0 `
    -and $latestNestedAccountOrigins.Count -eq $expectedAccountGroupOrigins.Count `
    -and $nestedAccountParentOriginDifferenceCount -eq 0
$latestAccountIdentityCount = 0
$latestAccountProblemCount = @($latestNestedAccountParents | ForEach-Object {
    if (-not $_.Abandoned) {
        @($_.AccountResults) | Where-Object { $_.status -notin @('signed', 'already_signed') }
    }
}).Count
$latestAccountAggregateMismatchCount = 0
$latestAccountPlanMismatchCount = 0
$latestAccountsMatchCurrentPlan = [bool]$nestedAccountParentOriginsMatch
foreach ($parent in $latestNestedAccountParents) {
    $latestAccountIdentityCount += @($parent.AccountResults | ForEach-Object {
        Get-HealthNestedAccountIdentity $parent.Origin $_
    } | Where-Object { $_ } | Sort-Object -Unique).Count
}
foreach ($group in $currentAccountGroups) {
    $groupOrigin = ConvertTo-HealthOrigin $group.origin
    $expectedIdentities = @($group.identities | ForEach-Object { [string]$_ } | Sort-Object -Unique)
    $expectedAccounts = @($group.accounts)
    $expectedAccountPlans = @($expectedAccounts | ForEach-Object {
        $identity = [string]$_.identity
        $provider = ConvertTo-HealthProvider $_.provider
        if ($identity -and $provider) { "$identity`n$provider" }
    } | Sort-Object -Unique)
    $expectedAccountPlanIdentities = @($expectedAccounts | ForEach-Object { [string]$_.identity } | Where-Object { $_ } | Sort-Object -Unique)
    $parentEntries = @($latestNestedAccountParents | Where-Object { $_.Origin -eq $groupOrigin })
    if (-not $groupOrigin `
        -or $expectedIdentities.Count -eq 0 `
        -or $expectedAccounts.Count -ne $expectedIdentities.Count `
        -or $expectedAccountPlans.Count -ne $expectedIdentities.Count `
        -or $expectedAccountPlanIdentities.Count -ne $expectedIdentities.Count `
        -or @(Compare-Object -ReferenceObject $expectedIdentities -DifferenceObject $expectedAccountPlanIdentities).Count -ne 0 `
        -or $parentEntries.Count -ne 1) {
        $latestAccountsMatchCurrentPlan = $false
        $latestAccountPlanMismatchCount += 1
        continue
    }
    $parentResult = $parentEntries[0].Result
    $accountResults = @($parentEntries[0].AccountResults)
    $actualIdentities = @($accountResults | ForEach-Object {
        Get-HealthNestedAccountIdentity $groupOrigin $_
    } | Where-Object { $_ } | Sort-Object -Unique)
    $actualAccountPlans = @($accountResults | ForEach-Object {
        Get-HealthNestedAccountPlanIdentity $groupOrigin $_
    } | Where-Object { $_ } | Sort-Object -Unique)
    $completedStatuses = @($accountResults | ForEach-Object { [string]$_.status } | Where-Object { $_ -in @('signed', 'already_signed') })
    if ($accountResults.Count -gt 0 -and $completedStatuses.Count -eq $accountResults.Count) {
        $expectedAggregateStatus = if ($completedStatuses -contains 'signed') { 'signed' } else { 'already_signed' }
        if ([string]$parentResult.status -ne $expectedAggregateStatus) {
            $latestAccountAggregateMismatchCount += 1
            $latestAccountsMatchCurrentPlan = $false
        }
    }
    if ($actualIdentities.Count -ne $expectedIdentities.Count `
        -or $accountResults.Count -ne $expectedIdentities.Count `
        -or @(Compare-Object -ReferenceObject $expectedIdentities -DifferenceObject $actualIdentities).Count -ne 0) {
        $latestAccountsMatchCurrentPlan = $false
    }
    if ($actualAccountPlans.Count -ne $expectedAccountPlans.Count `
        -or @(Compare-Object -ReferenceObject $expectedAccountPlans -DifferenceObject $actualAccountPlans).Count -ne 0) {
        $latestAccountPlanMismatchCount += 1
        $latestAccountsMatchCurrentPlan = $false
    }
}
$latestMatchesCurrentPlan = $latestTopLevelMatchesCurrentPlan -and $latestAccountsMatchCurrentPlan

$userSchedulerReady = [bool]$runValue -and $schedulerCount -eq 1 -and $watchdogCount -eq 1 -and [bool]$heartbeatFresh
$notificationMode = [string]$config.notification.mode
$notificationReady = $notificationMode -in @('', 'none') -or (
    $notificationMode -eq 'command' -and
    ((Test-HealthPath ([string]$config.notification.executable)) -or (Get-Command ([string]$config.notification.executable) -ErrorAction SilentlyContinue))
)
$automationUserDataDir = [string]$config.automationUserDataDir
$checks = [ordered]@{
    configPresent = $true
    bookmarksReadable = Test-HealthBookmarkSources $config
    currentPlanReadable = [bool]$currentPlanReadable
    browserExecutablePresent = Test-HealthPath $browserExecutable
    automationProfilePresent = [bool]$automationUserDataDir -and (Test-HealthPath (Join-Path $automationUserDataDir 'Local State'))
    notificationReady = [bool]$notificationReady
    notificationOutboxClean = $notificationQuarantinedCount -eq 0
    schedulerReady = [bool]$scheduledTaskEnabled -or [bool]$userSchedulerReady
    schedulerUnique = if ($scheduledTaskEnabled) { $true } elseif ($runValue) { $schedulerCount -eq 1 -and $watchdogCount -eq 1 } else { $false }
    schedulerHeartbeatFresh = [bool]$heartbeatFresh
    latestResultPresent = [bool]$latest
    latestRunToday = [bool]$latestRunToday
    latestResultComplete = [bool]$latestResultComplete
    latestMatchesCurrentPlan = [bool]$latestMatchesCurrentPlan
    latestAccountResultsConfirmed = [bool]$latestAccountsMatchCurrentPlan -and $latestAccountProblemCount -eq 0
    latestResultConfirmed = [bool]$latestResultComplete -and [bool]$latestMatchesCurrentPlan -and $null -ne $problemCount -and $problemCount -eq 0 -and $latestAccountProblemCount -eq 0
    siteStatePresent = Test-Path -LiteralPath $statePath
}
$failedChecks = @($checks.GetEnumerator() | Where-Object { -not [bool]$_.Value } | ForEach-Object { [string]$_.Key })
$healthy = $failedChecks.Count -eq 0
[ordered]@{
    schemaVersion = 1
    healthy = $healthy
    reason = if ($healthy) { 'ok' } else { 'checks_failed' }
    checkedAt = (Get-Date).ToString('o')
    failedChecks = $failedChecks
    schedule = [string]$config.schedule
    browser = [string]$config.browser
    browserProcessName = [string]$config.browserProcessName
    schedulerMode = if ($scheduledTaskEnabled) { 'windows_task' } elseif ($runValue) { 'user_scheduler' } elseif ($scheduledTask) { 'windows_task_disabled' } else { 'none' }
    scheduledTaskEnabled = [bool]$scheduledTaskEnabled
    schedulerStatus = if ($scheduledTaskEnabled -or $userSchedulerReady) { 'active' } elseif ($scheduledTask -or $runValue) { 'paused' } else { 'not_installed' }
    schedulerProcessCount = $schedulerCount
    watchdogProcessCount = $watchdogCount
    latestRunId = if ($latest) { [string]$latest.runId } else { $null }
    latestSiteCount = if ($latest) { @($latest.results).Count } else { $null }
    currentPlannedTotal = $currentPlannedTotal
    latestPlannedTotal = if ($latest -and $null -ne $latest.plannedTotal) { [int]$latest.plannedTotal } else { $null }
    currentPlanMatchesLatest = [bool]$latestMatchesCurrentPlan
    currentPlanIdentityCount = $currentPlanIdentities.Count
    latestPlanIdentityCount = $latestPlanIdentities.Count
    currentAccountIdentityCount = $currentAccountIdentityCount
    latestAccountIdentityCount = $latestAccountIdentityCount
    latestProblemCount = $problemCount
    latestAbandonedCount = $latestAbandonedCount
    latestAccountProblemCount = $latestAccountProblemCount
    latestAccountAggregateMismatchCount = $latestAccountAggregateMismatchCount
    latestAccountPlanMismatchCount = $latestAccountPlanMismatchCount
    schedulerAttemptsToday = if ($schedulerState) { [int]$schedulerState.attemptsToday } else { 0 }
    schedulerNextEligibleAt = if ($schedulerState -and $schedulerState.nextEligibleAt) { try { ([datetime]$schedulerState.nextEligibleAt).ToString('o') } catch { [string]$schedulerState.nextEligibleAt } } else { $null }
    schedulerReportComplete = if ($schedulerState) { [bool]$schedulerState.reportComplete } else { $false }
    notificationQuarantinedCount = $notificationQuarantinedCount
    checks = $checks
} | ConvertTo-Json -Depth 6
if (-not $healthy) { exit 2 }
