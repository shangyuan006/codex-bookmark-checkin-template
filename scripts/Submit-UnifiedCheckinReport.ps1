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

if ($RunnerStatus -eq 'timeout') { $status = 'timeout' }
elseif ($problems.status -contains 'interactive_challenge' -or $problems.status -contains 'login_required') { $status = 'needs_attention' }
elseif ($problems.status -contains 'managed_challenge_timeout') { $status = 'timeout' }
elseif ($problems.status -contains 'error' -or $problems.status -contains 'failed' -or $RunnerStatus -eq 'failed') { $status = 'failed' }
elseif ($problems.Count -gt 0) { $status = 'unconfirmed' }
elseif ($statuses -contains 'signed') { $status = 'success' }
elseif ($statuses -contains 'already_signed') { $status = 'already_done' }
else { $status = 'skipped' }

$summary = if ($results.Count -gt 0) { "共 $($results.Count) 站：完成 $done，未开放 $notAvailable，异常 $($problems.Count)。" } else { Compress-Text $RunnerMessage 160 }
if ($problems.Count -gt 0) {
    $brief = @($problems | Select-Object -First 3 | ForEach-Object {
        $hostName = try { ([uri]$_.origin).DnsSafeHost } catch { Compress-Text $_.origin 30 }
        $reason = switch ([string]$_.status) {
            'login_required' { '登录失效' }
            'interactive_challenge' { '需要验证' }
            'managed_challenge_timeout' { '验证超时' }
            'no_action' { '未找到入口' }
            'visited' { '结果未确认' }
            'clicked' { '结果未确认' }
            default { Compress-Text $_.reason 40 }
        }
        "$hostName：$reason"
    }) -join '；'
    $summary += " 异常：$brief"
}
$summary = Compress-Text $summary 300

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
