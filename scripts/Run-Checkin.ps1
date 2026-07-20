[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$SuppressReport,
    [int]$Attempts = 0
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Resolve-Runtime.ps1')
$reporterScript = Join-Path $PSScriptRoot 'Submit-UnifiedCheckinReport.ps1'
$startedAt = Get-Date
$runnerStatus = 'failed'
$runnerMessage = '签到任务尚未开始。'
$nodeExitCode = 1
$locationPushed = $false

try {
    Push-Location $root
    $locationPushed = $true
    $configPath = Join-Path $root 'config\config.json'
    if (-not (Test-Path -LiteralPath $configPath)) { throw '尚未初始化，请先运行 scripts\Initialize-Checkin.ps1。' }
    $config = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
    $node = Resolve-CheckinNode $config

    $timeoutMinutes = if ($null -ne $config.taskTimeoutMinutes) { [int]$config.taskTimeoutMinutes } else { 25 }
    if ($timeoutMinutes -lt 5 -or $timeoutMinutes -gt 55) { throw 'taskTimeoutMinutes 必须为 5 到 55 分钟。' }
    $runAttempts = if ($Attempts -gt 0) { $Attempts } elseif ($null -ne $config.taskRunAttempts) { [int]$config.taskRunAttempts } else { 2 }
    if ($runAttempts -lt 1 -or $runAttempts -gt 3) { throw '任务级重试次数必须为 1 到 3。' }
    if ($DryRun) { $runAttempts = 1 }
    $retryDelayMinutes = if ($null -ne $config.taskRetryDelayMinutes) { [int]$config.taskRetryDelayMinutes } else { 3 }
    if ($retryDelayMinutes -lt 0 -or $retryDelayMinutes -gt 30) { throw '任务级重试间隔必须为 0 到 30 分钟。' }

    $arguments = @((Join-Path $root 'src\index.mjs'))
    if ($DryRun) { $arguments += '--dry-run' }

    if (-not $DryRun -and (@($config.syncSavedLoginOrigins).Count -gt 0 -or $config.syncBookmarkSavedLogins -ne $false)) {
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
            $runArguments = @($arguments)
            $latestReport = Join-Path $root 'logs\latest.json'
            if ($attempt -gt 1 -and (Test-Path -LiteralPath $latestReport)) {
                $runArguments += @('--resume-report', $latestReport)
            }
            if (@($config.nativeWafPreflightUrls).Count -gt 0 -or @($config.nativeChallengePreflight).Count -gt 0) {
                $preflightOrigins = @()
                if ($attempt -gt 1 -and (Test-Path -LiteralPath $latestReport)) {
                    $previous = Get-Content -Raw -Encoding UTF8 -LiteralPath $latestReport | ConvertFrom-Json
                    $preflightOrigins = @($previous.results | Where-Object { $_.status -notin @('signed', 'already_signed', 'not_available') } | ForEach-Object { [string]$_.origin })
                }
                if ($preflightOrigins.Count -gt 0) { & (Join-Path $PSScriptRoot 'Prepare-NativeWafSession.ps1') -Origins $preflightOrigins }
                elseif ($attempt -eq 1) { & (Join-Path $PSScriptRoot 'Prepare-NativeWafSession.ps1') }
            }

            Write-Output "开始签到任务级尝试 $attempt/$runAttempts。"
            $process = Start-Process -FilePath $node -ArgumentList $runArguments -NoNewWindow -PassThru
            $finishedInTime = $process.WaitForExit($timeoutMinutes * 60 * 1000)
            if (-not $finishedInTime) {
                try { $process.Kill($true) } catch { try { $process.Kill() } catch { } }
                [void]$process.WaitForExit(10000)
                $nodeExitCode = 124
                $runnerStatus = 'timeout'
                $runnerMessage = "第 $attempt 次尝试超过 $timeoutMinutes 分钟。"
            }
            else {
                $nodeExitCode = $process.ExitCode
                $runnerStatus = 'completed'
                $runnerMessage = "任务级尝试 $attempt/$runAttempts 已结束，退出码 $nodeExitCode。"
            }
            if ($nodeExitCode -eq 0) { break }
            if ($attempt -lt $runAttempts -and $retryDelayMinutes -gt 0) { Start-Sleep -Seconds ($retryDelayMinutes * 60) }
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
        $latestReport = Join-Path $root 'logs\latest.json'
        $freshReport = Test-Path -LiteralPath $latestReport
        if ($freshReport) { $freshReport = (Get-Item -LiteralPath $latestReport).LastWriteTime -ge $startedAt.AddSeconds(-2) }
        try {
            if ($freshReport) { & $reporterScript -RunnerStatus $runnerStatus -RunnerMessage $runnerMessage -ReportPath $latestReport }
            else { & $reporterScript -RunnerStatus $runnerStatus -RunnerMessage $runnerMessage }
        }
        catch {
            Write-Warning "结果通知失败：$($_.Exception.Message)"
            if ($nodeExitCode -eq 0) { $nodeExitCode = 3 }
        }
    }
    if ($locationPushed) { Pop-Location }
}

exit $nodeExitCode
