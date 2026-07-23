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
    if (-not $resolvedReport.StartsWith($logsRoot, [System.StringComparison]::OrdinalIgnoreCase)) { throw '报告必须位于本项目 logs 目录。' }
    $results = @((Get-Content -Raw -Encoding UTF8 -LiteralPath $resolvedReport | ConvertFrom-Json).results)
}

$statuses = @($results | ForEach-Object { [string]$_.status })
$done = @($statuses | Where-Object { $_ -in @('signed', 'already_signed') }).Count
$notAvailable = @($statuses | Where-Object { $_ -eq 'not_available' }).Count
$problems = @($results | Where-Object { $_.status -notin @('signed', 'already_signed', 'not_available') })
$attentionCount = @($problems | Where-Object { $_.status -in @('interactive_challenge', 'login_required', 'needs_attention') }).Count
$timeoutCount = @($problems | Where-Object { $_.status -eq 'managed_challenge_timeout' }).Count
$hardFailureCount = @($problems | Where-Object { $_.status -in @('error', 'failed') }).Count

if ($RunnerStatus -eq 'timeout') { $status = 'timeout' }
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

$summary = if ($results.Count -gt 0) { "共 $($results.Count) 站：`n$done 个签到正常`n$notAvailable 个未开放签到" } else { Compress-Text $RunnerMessage 160 }
if ($problems.Count -gt 0) {
    $summary += "`n需关注 $($problems.Count) 个："
    $brief = @($problems | ForEach-Object {
        $hostName = try { ([uri]$_.origin).DnsSafeHost } catch { Compress-Text $_.origin 30 }
        $reason = switch ([string]$_.status) {
            'login_required' { '登录失效' }
            'interactive_challenge' { '需要验证' }
            'managed_challenge_timeout' { '验证超时' }
            'deferred' {
                if ($_.nextEligibleAt) { try { "限频，计划 $(([datetime]$_.nextEligibleAt).ToLocalTime().ToString('HH:mm')) 重试" } catch { '限频，已安排重试' } }
                else { '限频，已安排重试' }
            }
            'no_action' { '未找到入口' }
            'visited' { '结果未确认' }
            'clicked' { '结果未确认' }
            default { Compress-Text $_.reason 40 }
        }
        "- $hostName：$reason"
    }) -join "`n"
    $summary += "`n$brief"
}
if ($summary.Length -gt 950) { $summary = $summary.Substring(0, 947) + "…`n（其余站点请查看本地日志）" }

$notification = $config.notification
$mode = if ($notification.mode) { [string]$notification.mode } else { 'none' }
$payload = [ordered]@{ status = $status; summary = $summary; siteCount = $results.Count; problemCount = $problems.Count; mode = $mode }
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
}
$arguments = @($notification.arguments | ForEach-Object {
    $value = [string]$_
    foreach ($entry in $values.GetEnumerator()) { $value = $value.Replace($entry.Key, $entry.Value) }
    $value
})
& $executable @arguments
if ($LASTEXITCODE -ne 0) { throw "通知程序退出码：$LASTEXITCODE" }
