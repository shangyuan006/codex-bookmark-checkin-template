[CmdletBinding()]
param(
    [ValidateSet('completed', 'failed', 'timeout', 'skipped')]
    [string]$RunnerStatus = 'completed',
    [string]$RunnerMessage = '',
    [string]$ReportPath,
    [switch]$Preview
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
$report = $null
$results = @()

function Compress-Text([object]$Value, [int]$MaximumLength = 120) {
    $text = ([string]$Value -replace "`e\[[0-?]*[ -/]*[@-~]", '' -replace '[\r\n\t]+', ' ' -replace '\s{2,}', ' ').Trim()
    $text = ($text -replace '\s*Call log:.*$', '').Trim()
    if ($text.Length -gt $MaximumLength) { return $text.Substring(0, $MaximumLength) + '…' }
    return $text
}

if ($ReportPath) {
    $resolvedReport = (Resolve-Path -LiteralPath $ReportPath).Path
    $logsRoot = [System.IO.Path]::GetFullPath((Join-Path $root 'logs'))
    $logsPrefix = $logsRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $resolvedReport.StartsWith($logsPrefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw '报告必须位于本项目 logs 目录。' }
    $report = Get-Content -Raw -Encoding UTF8 -LiteralPath $resolvedReport | ConvertFrom-Json
    $results = @($report.results)
}

$statuses = @($results | ForEach-Object { [string]$_.status })
$reportRunState = if ($null -ne $report) { [string]$report.runState } else { '' }
$plannedTotal = if ($null -ne $report -and $null -ne $report.plannedTotal) { [int]$report.plannedTotal } else { $results.Count }
$processedTotal = if ($null -ne $report -and $null -ne $report.processedTotal) { [int]$report.processedTotal } else { $results.Count }
$isCompleteFinalReport = $null -ne $report `
    -and $reportRunState -eq 'final' `
    -and $report.isComplete -eq $true `
    -and $plannedTotal -gt 0 `
    -and $processedTotal -ge $plannedTotal `
    -and $results.Count -ge $plannedTotal
$isPartialReport = $null -ne $report -and -not $isCompleteFinalReport
$done = @($statuses | Where-Object { $_ -in @('signed', 'already_signed') }).Count
$notAvailable = @($statuses | Where-Object { $_ -eq 'not_available' }).Count
$problems = @($results | Where-Object { $_.status -notin @('signed', 'already_signed', 'not_available') })
$attentionCount = @($problems | Where-Object { $_.status -in @('interactive_challenge', 'login_required', 'needs_attention') }).Count
$timeoutCount = @($problems | Where-Object { $_.status -eq 'managed_challenge_timeout' }).Count
$hardFailureCount = @($problems | Where-Object { $_.status -in @('error', 'failed') }).Count

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
    $heading = if ($isCompleteFinalReport) { "共 $plannedTotal 站：" } else { "已处理 $processedTotal/$plannedTotal 站（任务未完成）：" }
    "$heading`n$done 个签到正常`n$notAvailable 个未开放签到"
}
else { Compress-Text $RunnerMessage 160 }
if ($problems.Count -gt 0) {
    $summary += "`n需关注 $($problems.Count) 个："
    $brief = @($problems | ForEach-Object {
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
if ($summary.Length -gt 950) { $summary = $summary.Substring(0, 947) + "…`n（其余站点请查看本地日志）" }

$stateParts = @($results | Sort-Object origin | ForEach-Object {
    "$([string]$_.origin)=$([string]$_.status):$([string]$_.retryCause)"
})
$stateMaterial = if ($stateParts.Count -gt 0) { "$status|$reportRunState|$($stateParts -join '|')" } else { "$status|$RunnerStatus" }
$stateBytes = [System.Text.Encoding]::UTF8.GetBytes($stateMaterial)
$stateHashBytes = [System.Security.Cryptography.SHA256]::HashData($stateBytes)
$stateHash = [System.Convert]::ToHexString($stateHashBytes).Substring(0, 16).ToLowerInvariant()
$eventKey = "external:browser-codex:bookmark_daily:$((Get-Date).ToString('yyyy-MM-dd')):$stateHash"

$notification = $config.notification
$mode = if ($notification.mode) { [string]$notification.mode } else { 'none' }
$payload = [ordered]@{
    status = $status
    summary = $summary
    siteCount = $results.Count
    problemCount = $problems.Count
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
$executable = [string]$notification.executable
if (-not $executable) { throw '命令型通知缺少 executable。' }
if (-not (Test-Path -LiteralPath $executable)) {
    $command = Get-Command $executable -ErrorAction SilentlyContinue
    if (-not $command) { throw "通知程序不存在：$executable" }
    $executable = $command.Source
}
$values = @{
    '{status}' = $status
    '{summary}' = $summary
    '{taskId}' = [string]$notification.taskId
    '{name}' = [string]$notification.name
    '{source}' = [string]$notification.source
    '{eventKey}' = $eventKey
}
$arguments = @($notification.arguments | ForEach-Object {
    $value = [string]$_
    foreach ($entry in $values.GetEnumerator()) { $value = $value.Replace($entry.Key, $entry.Value) }
    $value
})
& $executable @arguments
if ($LASTEXITCODE -ne 0) { throw "通知程序退出码：$LASTEXITCODE" }
