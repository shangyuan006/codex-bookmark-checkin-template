[CmdletBinding()]
param(
    [ValidateSet('completed', 'failed', 'timeout', 'skipped')]
    [string]$RunnerStatus = 'completed',
    [string]$RunnerMessage = '',
    [string]$ReportPath,
    [string]$OutboxPath,
    [string]$ConfigPath,
    [switch]$Preview
)

$ErrorActionPreference = 'Stop'

function Get-Sha256Hex([byte[]]$Bytes) {
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha256.ComputeHash($Bytes)
        return -join @($hash | ForEach-Object { $_.ToString('x2') })
    }
    finally {
        $sha256.Dispose()
    }
}
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'ManualAbandonment.ps1')
$localConfigPath = Join-Path $root 'config\config.json'
$defaultsPath = Join-Path $root 'config\defaults.json'
$effectiveConfigPath = if ($ConfigPath) { $ConfigPath } elseif (Test-Path -LiteralPath $localConfigPath) { $localConfigPath } else { $defaultsPath }
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath $effectiveConfigPath | ConvertFrom-Json
$manualAbandonPath = Join-Path $root 'tmp\manual-abandon.json'
$abandonedOrigins = Get-TodayAbandonedOrigins -Path $manualAbandonPath -Now (Get-Date)
$report = $null
$results = @()

function Remove-SensitiveText([object]$Value) {
    $text = [string]$Value
    $text = $text -replace '(?i)\b(authorization)\s*:\s*(?:bearer|basic)\s+[^\s,;，；]+', '$1: [REDACTED]'
    $text = $text -replace '(?i)\b(password|passwd|pwd|access[-_]?token|refresh[-_]?token|id[-_]?token|token|cookie|client[-_]?secret|secret|api[-_ ]?key)\b\s*[:=]\s*(?:"[^"]*"|''[^'']*''|[^\s,;，；]+)', '$1=[REDACTED]'
    $text = $text -replace '(密码|口令|令牌|密钥)\s*[:=：]\s*(?:"[^"]*"|''[^'']*''|[^\s,;，；]+)', '$1=[REDACTED]'
    return $text
}

function Compress-Text([object]$Value, [int]$MaximumLength = 120) {
    $text = ((Remove-SensitiveText $Value) -replace "`e\[[0-?]*[ -/]*[@-~]", '' -replace '[\r\n\t]+', ' ' -replace '\s{2,}', ' ').Trim()
    $text = ($text -replace '\s*Call log:.*$', '').Trim()
    if ($text.Length -gt $MaximumLength) { return $text.Substring(0, $MaximumLength) + '…' }
    return $text
}

function Protect-AccountIdentityText([object]$Value, [int]$MaximumLength = 48) {
    $text = (Remove-SensitiveText $Value).Trim()
    if (-not $text) { return '' }
    $text = [regex]::Replace($text, '(?i)\bhttps?://[^\s,;，；]+', {
        param($match)
        try { return ([uri]$match.Value).GetLeftPart([System.UriPartial]::Authority) }
        catch { return '[REDACTED]' }
    })
    $text = $text -replace '(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b', '[REDACTED]'
    $text = ($text -replace '[\r\n\t]+', ' ' -replace '\s{2,}', ' ').Trim()
    if (-not $text -or $text.Contains('[REDACTED]')) { return '' }
    if ($text.Length -gt $MaximumLength) { return $text.Substring(0, $MaximumLength) + '…' }
    return $text
}

function Get-AccountStatus([object]$AccountResult) {
    $status = [string]$AccountResult.status
    if ($status -in @(
        'signed', 'already_signed', 'deferred', 'login_required', 'interactive_challenge',
        'managed_challenge_timeout', 'needs_attention', 'not_available', 'no_action',
        'visited', 'clicked', 'error', 'failed'
    )) { return $status }
    return 'unknown'
}

function Get-AccountReasonLabel([object]$AccountResult) {
    $status = Get-AccountStatus $AccountResult
    switch ($status) {
        'signed' { return '签到成功' }
        'already_signed' { return '今日已签到' }
        'deferred' {
            switch ([string]$AccountResult.retryCause) {
                'login_required' { return '登录恢复未成功，等待重试' }
                'managed_challenge_timeout' { return '验证未自动通过，等待重试' }
                default { return '等待计划重试' }
            }
        }
        'login_required' { return '需要重新登录' }
        'interactive_challenge' { return '需要人工验证' }
        'managed_challenge_timeout' { return '验证超时' }
        'needs_attention' { return '需要人工处理' }
        'not_available' { return '未开放签到' }
        'no_action' { return '未找到签到入口' }
        'visited' { return '结果未确认' }
        'clicked' { return '结果未确认' }
        'error' { return '执行失败' }
        'failed' { return '执行失败' }
        default { return '结果未确认' }
    }
}

function Get-AccountReasonFingerprint([object]$AccountResult) {
    $text = Remove-SensitiveText $AccountResult.reason
    $text = [regex]::Replace($text, '(?i)\bhttps?://[^\s,;，；]+', {
        param($match)
        try { return ([uri]$match.Value).GetLeftPart([System.UriPartial]::Authority) }
        catch { return '[REDACTED]' }
    })
    $text = $text -replace '(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b', '[REDACTED]'
    $text = $text -replace '(?i)\b(balance|quota|credit|amount)\b[^,;，；。.!?]{0,80}', '$1=[REDACTED]'
    $text = $text -replace '(余额|额度|积分)[^,;，；。.!?]{0,80}', '$1=[REDACTED]'
    foreach ($propertyName in @('accountId', 'authoritativeAccountId', 'siteAccountId')) {
        $accountId = [string]$AccountResult.$propertyName
        if ($accountId) { $text = [regex]::Replace($text, [regex]::Escape($accountId), '[REDACTED]', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase) }
    }
    $text = ($text -replace '[\r\n\t]+', ' ' -replace '\s{2,}', ' ').Trim()
    return (Get-Sha256Hex ([System.Text.Encoding]::UTF8.GetBytes($text))).Substring(0, 16)
}

function Get-AccountDisplayLabel([object]$AccountResult, [int]$Index) {
    $provider = (Protect-AccountIdentityText $AccountResult.provider).ToLowerInvariant() -replace '[\s._-]+', ''
    switch -Regex ($provider) {
        '^github$' { return 'GitHub' }
        '^linuxdo$' { return 'LinuxDO' }
        '^gitlab$' { return 'GitLab' }
        '^gitee$' { return 'Gitee' }
        '^google$' { return 'Google' }
        '^discord$' { return 'Discord' }
    }
    return "账号 $Index"
}

function Get-AccountStateParts([object]$Result) {
    $parts = @()
    $accountResultsProperty = $Result.PSObject.Properties['accountResults']
    if ($null -eq $accountResultsProperty) { return @() }
    if ($null -eq $accountResultsProperty.Value) { return @('||=unknown:结果未确认:malformed') }
    $index = 0
    foreach ($accountResult in @($accountResultsProperty.Value)) {
        $index++
        if ($null -eq $accountResult) {
            $parts += '||=unknown:结果未确认:malformed'
            continue
        }
        $label = Protect-AccountIdentityText $accountResult.accountLabel
        $provider = Protect-AccountIdentityText $accountResult.provider
        $accountKey = Protect-AccountIdentityText $accountResult.accountKey
        $status = Get-AccountStatus $accountResult
        $reason = Get-AccountReasonLabel $accountResult
        $reasonFingerprint = Get-AccountReasonFingerprint $accountResult
        $parts += "$label|$provider|$accountKey=$status`:$reason`:$reasonFingerprint"
    }
    return @($parts | Sort-Object)
}

function Get-NestedAccountConflictCount([object]$Result) {
    $accountResultsProperty = $Result.PSObject.Properties['accountResults']
    if ($null -eq $accountResultsProperty) { return 0 }
    if ($null -eq $accountResultsProperty.Value) { return 1 }
    $accountResults = @($accountResultsProperty.Value)
    if ($accountResults.Count -eq 0) { return 1 }
    $count = 0
    foreach ($accountResult in $accountResults) {
        if ($null -eq $accountResult -or (Get-AccountStatus $accountResult) -notin @('signed', 'already_signed')) { $count++ }
    }
    return $count
}

function Test-ResultHasNestedAccountConflict([object]$Result) {
    if ([string]$Result.status -notin @('signed', 'already_signed')) { return $false }
    return (Get-NestedAccountConflictCount $Result) -gt 0
}

function Test-ResultIsAbandoned([object]$Result) {
    $origin = ConvertTo-ManualAbandonmentOrigin $Result.origin
    return [bool]$origin -and $abandonedOrigins.ContainsKey($origin)
}

function Get-ProjectedResultStatus([object]$Result) {
    if (Test-ResultIsAbandoned $Result) { return 'abandoned' }
    return [string]$Result.status
}

if ($ReportPath) {
    $resolvedReport = (Resolve-Path -LiteralPath $ReportPath).Path
    $logsRoot = [System.IO.Path]::GetFullPath((Join-Path $root 'logs'))
    $logsPrefix = $logsRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $resolvedReport.StartsWith($logsPrefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw '报告必须位于本项目 logs 目录。' }
    $report = Get-Content -Raw -Encoding UTF8 -LiteralPath $resolvedReport | ConvertFrom-Json
    $results = @($report.results)
}

$statuses = @($results | ForEach-Object { Get-ProjectedResultStatus $_ })
$reportRunState = if ($null -ne $report) { [string]$report.runState } else { '' }
$plannedTotal = if ($null -ne $report -and $null -ne $report.plannedTotal) { [int]$report.plannedTotal } else { $results.Count }
$processedTotal = if ($null -ne $report -and $null -ne $report.processedTotal) { [int]$report.processedTotal } else { $results.Count }
$selectedOriginList = @()
if ($null -ne $report -and $null -ne $report.selectedOrigins) {
    $selectedOriginList = @($report.selectedOrigins | ForEach-Object { [string]$_ } | Where-Object { $_ })
}
$hasSelectedScope = $selectedOriginList.Count -gt 0
$selectedResults = @(if ($hasSelectedScope) {
    @($results | Where-Object { $selectedOriginList -contains ([string]$_.origin) })
}
else { @($results) })
$selectedTotal = if ($null -ne $report -and $null -ne $report.selectedTotal) { [int]$report.selectedTotal } elseif ($hasSelectedScope) { $selectedOriginList.Count } else { $results.Count }
$selectedProcessedTotal = if ($null -ne $report -and $null -ne $report.selectedProcessedTotal) { [int]$report.selectedProcessedTotal } else { $selectedResults.Count }
$selectedStatuses = @($selectedResults | ForEach-Object {
    if (Test-ResultIsAbandoned $_) { 'abandoned' }
    elseif (Test-ResultHasNestedAccountConflict $_) { 'needs_attention' }
    else { [string]$_.status }
})
$selectedSummary = [ordered]@{}
foreach ($selectedStatus in @($selectedStatuses | Sort-Object -Unique)) {
    $selectedSummary[$selectedStatus] = @($selectedStatuses | Where-Object { $_ -eq $selectedStatus }).Count
}
$selectedDone = @($selectedStatuses | Where-Object { $_ -in @('signed', 'already_signed') }).Count
$selectedNotAvailable = @($selectedStatuses | Where-Object { $_ -eq 'not_available' }).Count
$selectedAbandonedCount = @($selectedStatuses | Where-Object { $_ -eq 'abandoned' }).Count
$selectedProblems = @($selectedResults | Where-Object {
    -not (Test-ResultIsAbandoned $_) `
        -and ($_.status -notin @('signed', 'already_signed', 'not_available') -or (Test-ResultHasNestedAccountConflict $_))
})
$isTargetedReport = $hasSelectedScope -and $plannedTotal -gt 0 -and $selectedTotal -lt $plannedTotal
$isCompleteFinalReport = $null -ne $report `
    -and $reportRunState -eq 'final' `
    -and $report.isComplete -eq $true `
    -and $plannedTotal -gt 0 `
    -and $processedTotal -ge $plannedTotal `
    -and $results.Count -ge $plannedTotal
$isPartialReport = $null -ne $report -and -not $isCompleteFinalReport
$nestedConflictResults = @($results | Where-Object {
    -not (Test-ResultIsAbandoned $_) -and (Test-ResultHasNestedAccountConflict $_)
})
$done = @($results | Where-Object {
    -not (Test-ResultIsAbandoned $_) `
        -and $_.status -in @('signed', 'already_signed') `
        -and -not (Test-ResultHasNestedAccountConflict $_)
}).Count
$notAvailable = @($statuses | Where-Object { $_ -eq 'not_available' }).Count
$abandonedCount = @($statuses | Where-Object { $_ -eq 'abandoned' }).Count
$parentProblems = @($results | Where-Object {
    -not (Test-ResultIsAbandoned $_) -and $_.status -notin @('signed', 'already_signed', 'not_available')
})
$problems = @($results | Where-Object {
    -not (Test-ResultIsAbandoned $_) `
        -and ($_.status -notin @('signed', 'already_signed', 'not_available') -or (Test-ResultHasNestedAccountConflict $_))
})
$attentionCount = @($parentProblems | Where-Object { $_.status -in @('interactive_challenge', 'login_required', 'needs_attention') }).Count + $nestedConflictResults.Count
$timeoutCount = @($parentProblems | Where-Object { $_.status -eq 'managed_challenge_timeout' }).Count
$hardFailureCount = @($parentProblems | Where-Object { $_.status -in @('error', 'failed') }).Count

if ($RunnerStatus -eq 'timeout') { $status = 'timeout' }
elseif ($isPartialReport) { $status = 'unconfirmed' }
elseif ($results.Count -gt 0 -and $problems.Count -eq 0 -and $statuses -contains 'signed') { $status = 'success' }
elseif ($results.Count -gt 0 -and $problems.Count -eq 0 -and $statuses -contains 'already_signed') { $status = 'already_done' }
elseif ($results.Count -gt 0 -and $problems.Count -eq 0) { $status = 'skipped' }
elseif ($results.Count -gt 0 -and $attentionCount -gt 0) { $status = 'needs_attention' }
elseif ($results.Count -gt 0 -and ($done -gt 0 -or $notAvailable -gt 0)) { $status = 'unconfirmed' }
elseif ($results.Count -gt 0 -and $timeoutCount -eq $results.Count) { $status = 'timeout' }
elseif ($results.Count -gt 0 -and $hardFailureCount -eq $results.Count) { $status = 'failed' }
elseif ($results.Count -gt 0 -and $statuses -contains 'deferred') { $status = 'skipped' }
elseif ($results.Count -gt 0) { $status = 'unconfirmed' }
elseif ($RunnerStatus -eq 'failed') { $status = 'failed' }
elseif ($RunnerStatus -eq 'skipped') { $status = 'skipped' }
else { $status = 'unconfirmed' }

$summary = if ($results.Count -gt 0 -or ($null -ne $report -and $plannedTotal -gt 0)) {
    if ($isTargetedReport) {
        $dailyHeading = if ($isCompleteFinalReport) { "今日累计：共 $plannedTotal 站" } else { "今日累计：已处理 $processedTotal/$plannedTotal 站（任务未完成）" }
        "本轮 $selectedProcessedTotal/$selectedTotal 站：`n$selectedDone 个签到正常`n$selectedNotAvailable 个未开放签到`n$selectedAbandonedCount 个今日放弃`n$dailyHeading`n$done 个签到正常`n$notAvailable 个未开放签到`n$abandonedCount 个今日放弃"
    }
    else {
        $heading = if ($isCompleteFinalReport) { "共 $plannedTotal 站：" } else { "已处理 $processedTotal/$plannedTotal 站（任务未完成）：" }
        "$heading`n$done 个签到正常`n$notAvailable 个未开放签到`n$abandonedCount 个今日放弃"
    }
}
else { Compress-Text $RunnerMessage 160 }
if ($parentProblems.Count -gt 0) {
    $summary += "`n需关注 $($parentProblems.Count) 个："
    $brief = @($parentProblems | ForEach-Object {
        $problem = $_
        $hostName = try { ([uri]$problem.origin).DnsSafeHost } catch { Compress-Text $problem.origin 30 }
        $reason = switch ([string]$problem.status) {
            'login_required' { '登录失效' }
            'interactive_challenge' { '需要验证' }
            'managed_challenge_timeout' { '验证超时' }
            'deferred' {
                $retryLabel = switch ([string]$problem.retryCause) {
                    'login_required' { '登录恢复未成功'; break }
                    'managed_challenge_timeout' { '验证未自动通过'; break }
                    default { '限频' }
                }
                if ($problem.nextEligibleAt) { try { "$retryLabel，计划 $(([datetime]$problem.nextEligibleAt).ToLocalTime().ToString('HH:mm')) 重试" } catch { "$retryLabel，已安排重试" } }
                else { "$retryLabel，已安排重试" }
            }
            'no_action' { '未找到入口' }
            'visited' { '结果未确认' }
            'clicked' { '结果未确认' }
            default { Compress-Text $problem.reason 40 }
        }
        "- $hostName：$reason"
    }) -join "`n"
    $summary += "`n$brief"
}
if ($nestedConflictResults.Count -gt 0) {
    $nestedConflictAccountCount = 0
    foreach ($nestedConflictResult in $nestedConflictResults) {
        $nestedConflictAccountCount += Get-NestedAccountConflictCount $nestedConflictResult
    }
    $summary += "`n需关注 $($nestedConflictResults.Count) 个站点的账号明细：$nestedConflictAccountCount 个账号未确认"
}
$accountDetailLines = @($results | Where-Object { -not (Test-ResultIsAbandoned $_) } | Sort-Object origin | ForEach-Object {
    $result = $_
    $hostName = try { ([uri]$result.origin).DnsSafeHost } catch { '站点' }
    $accountResultsProperty = $result.PSObject.Properties['accountResults']
    if ($null -ne $accountResultsProperty) {
        if ($null -eq $accountResultsProperty.Value) {
            "- $hostName / 账号 1：unknown（结果未确认）"
        }
        else {
            $accountIndex = 0
            foreach ($accountResult in @($accountResultsProperty.Value)) {
                $accountIndex++
                if ($null -eq $accountResult) {
                    "- $hostName / 账号 $accountIndex：unknown（结果未确认）"
                    continue
                }
                $accountLabel = Get-AccountDisplayLabel $accountResult $accountIndex
                $accountStatus = Get-AccountStatus $accountResult
                $accountReason = Get-AccountReasonLabel $accountResult
                "- $hostName / $accountLabel：$accountStatus（$accountReason）"
            }
        }
    }
})
if ($accountDetailLines.Count -gt 0) {
    $summary += "`n账号明细：`n$($accountDetailLines -join "`n")"
}
if ($summary.Length -gt 950) { $summary = $summary.Substring(0, 947) + "…`n（其余站点请查看本地日志）" }
$summary = Remove-SensitiveText $summary

$notification = $config.notification
$mode = if ($notification.mode) { [string]$notification.mode } else { 'none' }
$taskId = if ($notification.taskId) { [string]$notification.taskId } else { 'bookmark_daily' }
$name = if ($notification.name) { [string]$notification.name } else { '浏览器书签签到' }
$source = if ($notification.source) { [string]$notification.source } else { 'browser-codex' }

$stateParts = @($results | Sort-Object origin | ForEach-Object {
    $result = $_
    $projectedStatus = Get-ProjectedResultStatus $result
    "$([string]$result.origin)=$projectedStatus`:$([string]$result.retryCause)"
    if ($projectedStatus -ne 'abandoned') {
        Get-AccountStateParts $result | ForEach-Object { "account:$([string]$result.origin):$_" }
    }
})
$selectedStateParts = @($selectedResults | Sort-Object origin | ForEach-Object {
    $result = $_
    $projectedStatus = Get-ProjectedResultStatus $result
    "$([string]$result.origin)=$projectedStatus`:$([string]$result.retryCause)"
    if ($projectedStatus -ne 'abandoned') {
        Get-AccountStateParts $result | ForEach-Object { "account:$([string]$result.origin):$_" }
    }
})
$scopeMaterial = if ($hasSelectedScope) { "|selected=$selectedTotal/$selectedProcessedTotal|$($selectedOriginList -join ',')|$($selectedStateParts -join '|')" } else { '' }
$stateMaterial = if ($stateParts.Count -gt 0) { "$status|$reportRunState|$($stateParts -join '|')$scopeMaterial" } else { "$status|$RunnerStatus$scopeMaterial" }
$stateBytes = [System.Text.Encoding]::UTF8.GetBytes($stateMaterial)
$stateHash = (Get-Sha256Hex $stateBytes).Substring(0, 16)
$eventKey = "external:$source`:$taskId`:$((Get-Date).ToString('yyyy-MM-dd')):$stateHash"
$payload = [ordered]@{
    status = $status
    summary = $summary
    siteCount = $results.Count
    problemCount = $problems.Count
    abandonedCount = $abandonedCount
    selectedSiteCount = $selectedResults.Count
    selectedProblemCount = $selectedProblems.Count
    selectedAbandonedCount = $selectedAbandonedCount
    selectedOrigins = $selectedOriginList
    selectedTotal = $selectedTotal
    selectedProcessedTotal = $selectedProcessedTotal
    selectedSummary = $selectedSummary
    runState = $reportRunState
    plannedTotal = $plannedTotal
    processedTotal = $processedTotal
    isComplete = [bool]$isCompleteFinalReport
    eventKey = $eventKey
    mode = $mode
}
if ($Preview -or $mode -eq 'none') {
    $payload.accepted = $false
    $payload.preview = [bool]$Preview
    $payload | ConvertTo-Json -Compress
    return
}
if ($mode -ne 'command') { throw "不支持的通知模式：$mode" }
if (-not $OutboxPath) { $OutboxPath = Join-Path $root 'data\notification-outbox' }
[System.IO.Directory]::CreateDirectory($OutboxPath) | Out-Null

$eventBytes = [System.Text.Encoding]::UTF8.GetBytes($eventKey)
$eventHash = Get-Sha256Hex $eventBytes
$itemPath = Join-Path $OutboxPath "$eventHash.json"
$payloadMaterial = @($eventKey, $taskId, $name, $source, $status, $summary) -join "`n"
$payloadHash = Get-Sha256Hex ([System.Text.Encoding]::UTF8.GetBytes($payloadMaterial))
$now = [DateTimeOffset]::UtcNow
$existing = $null
if (Test-Path -LiteralPath $itemPath) {
    try { $existing = Get-Content -Raw -Encoding UTF8 -LiteralPath $itemPath | ConvertFrom-Json }
    catch { throw "通知 outbox 条目损坏：$itemPath" }
    if ([string]$existing.eventKey -ne $eventKey) { throw '通知 outbox 事件哈希冲突。' }
}

$item = [ordered]@{
    schemaVersion = 1
    eventKey = $eventKey
    payloadHash = $payloadHash
    taskId = $taskId
    name = $name
    source = $source
    status = $status
    summary = $summary
    abandonedCount = $abandonedCount
    selectedSiteCount = $selectedResults.Count
    selectedProblemCount = $selectedProblems.Count
    selectedAbandonedCount = $selectedAbandonedCount
    selectedOrigins = $selectedOriginList
    selectedTotal = $selectedTotal
    selectedProcessedTotal = $selectedProcessedTotal
    selectedSummary = $selectedSummary
    createdAt = if ($existing.createdAt) { [string]$existing.createdAt } else { $now.ToString('o') }
    updatedAt = $now.ToString('o')
    nextAttemptAt = if ($existing.delivered -eq $true) { $null } elseif ($existing.nextAttemptAt) { [string]$existing.nextAttemptAt } else { $now.ToString('o') }
    attempts = if ($null -ne $existing.attempts) { [int]$existing.attempts } else { 0 }
    delivered = [bool]($existing.delivered -eq $true)
    deliveredAt = if ($existing.deliveredAt) { [string]$existing.deliveredAt } else { $null }
    disposition = if ($existing.disposition) { [string]$existing.disposition } else { $null }
    lastError = if ($existing.lastError) { Remove-SensitiveText $existing.lastError } else { $null }
}

$temporary = "$itemPath.$PID.$([guid]::NewGuid().ToString('N')).tmp"
try {
    [System.IO.File]::WriteAllText($temporary, ($item | ConvertTo-Json -Depth 4), [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $itemPath -Force
}
finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
}

$payload.accepted = [bool]$item.delivered
$payload.enqueued = -not [bool]$item.delivered
$payload | ConvertTo-Json -Compress
