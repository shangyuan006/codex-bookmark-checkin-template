[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $root 'config\config.json'
$initialConfig = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
$statePath = Join-Path $root 'data\scheduler-state.json'
$heartbeatPath = Join-Path $root 'data\scheduler-heartbeat.json'
$mutexCreated = $false
$mutexName = if ($initialConfig.schedulerMutexName) { [string]$initialConfig.schedulerMutexName } else { 'Local\CodexBookmarkDailyCheckinScheduler' }
$mutex = [System.Threading.Mutex]::new($true, $mutexName, [ref]$mutexCreated)
if (-not $mutexCreated) { exit 0 }

function Read-SchedulerState {
    if (-not (Test-Path -LiteralPath $statePath)) { return [pscustomobject]@{ lastRunDate = $null } }
    try { return Get-Content -Raw -Encoding UTF8 -LiteralPath $statePath | ConvertFrom-Json }
    catch { return [pscustomobject]@{ lastRunDate = $null } }
}

function Write-SchedulerHeartbeat([string]$phase) {
    $temporary = "$heartbeatPath.$PID.tmp"
    [System.IO.File]::WriteAllText($temporary, ([ordered]@{ processId = $PID; updatedAt = (Get-Date).ToString('o'); phase = $phase } | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $heartbeatPath -Force
}

function Test-LatestReportValid([datetime]$now, $config, [Nullable[datetime]]$notBefore = $null) {
    $latestPath = Join-Path $root 'logs\latest.json'
    if (-not (Test-Path -LiteralPath $latestPath)) { return $false }
    try {
        if ($null -ne $notBefore -and (Get-Item -LiteralPath $latestPath).LastWriteTime -lt ([datetime]$notBefore).AddSeconds(-2)) { return $false }
        $latest = Get-Content -Raw -Encoding UTF8 -LiteralPath $latestPath | ConvertFrom-Json
        $minimumTargets = [Math]::Max(1, [int]$config.minimumBookmarkTargetCount)
        return [string]$latest.runId -like "$($now.ToString('yyyyMMdd'))-*" -and @($latest.results).Count -ge $minimumTargets
    }
    catch { return $false }
}

function Write-SchedulerState([datetime]$finishedAt, [int]$exitCode, [bool]$reportValid) {
    $latestPath = Join-Path $root 'logs\latest.json'
    $latestRunId = $null
    if (Test-Path -LiteralPath $latestPath) {
        try { $latestRunId = [string](Get-Content -Raw -Encoding UTF8 -LiteralPath $latestPath | ConvertFrom-Json).runId } catch { }
    }
    $state = [ordered]@{
        lastRunDate = if ($reportValid) { $finishedAt.ToString('yyyy-MM-dd') } else { $null }
        lastFinishedAt = $finishedAt.ToString('o')
        lastExitCode = $exitCode
        lastRunId = $latestRunId
        reportValid = $reportValid
    }
    $temporary = "$statePath.$PID.tmp"
    [System.IO.File]::WriteAllText($temporary, ($state | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $statePath -Force
}

try {
    while ($true) {
        try {
            Write-SchedulerHeartbeat 'idle'
            $config = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
            $schedule = [string]$config.schedule
            if ($schedule -notmatch '^([01]\d|2[0-3]):[0-5]\d$') { throw "无效签到时间：$schedule" }

            $now = Get-Date
            $scheduledToday = [datetime]::ParseExact("$($now.ToString('yyyy-MM-dd')) $schedule", 'yyyy-MM-dd HH:mm', $null)
            $state = Read-SchedulerState
            $alreadyRanToday = [string]$state.lastRunDate -eq $now.ToString('yyyy-MM-dd') -and (Test-LatestReportValid $now $config)

            if (-not $alreadyRanToday -and $now -ge $scheduledToday) {
                Write-SchedulerHeartbeat 'running_checkin'
                $runScript = Join-Path $PSScriptRoot 'Run-Checkin.ps1'
                $runStartedAt = Get-Date
                $shell = (Get-Command pwsh,powershell -ErrorAction SilentlyContinue | Select-Object -First 1).Source
                if (-not $shell) { throw '未找到 PowerShell 可执行文件。' }
                $process = Start-Process -FilePath $shell -ArgumentList @(
                    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
                    '-ExecutionPolicy', 'Bypass', '-File', $runScript
                ) -WindowStyle Hidden -PassThru
                while (-not $process.HasExited) {
                    Write-SchedulerHeartbeat 'running_checkin'
                    Start-Sleep -Seconds 15
                    $process.Refresh()
                }
                $exitCode = $process.ExitCode
                $finishedAt = Get-Date
                $reportValid = Test-LatestReportValid $finishedAt $config $runStartedAt
                Write-SchedulerState $finishedAt $exitCode $reportValid
            }
        }
        catch {
            $message = ([string]$_.Exception.Message) -replace '[\r\n\t]+', ' '
            Write-Warning "后台调度循环发生可恢复异常：$message"
        }

        Start-Sleep -Seconds 60
    }
}
finally {
    $mutex.ReleaseMutex() | Out-Null
    $mutex.Dispose()
}
