[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'TaskRuntimeBudget.ps1')
$schedulerScript = Join-Path $PSScriptRoot 'Start-UserScheduler.ps1'
$configPath = Join-Path $root 'config\config.json'
$heartbeatPath = Join-Path $root 'data\scheduler-heartbeat.json'
$mutexCreated = $false
$mutex = [System.Threading.Mutex]::new($true, 'Local\CodexBookmarkDailyCheckinWatchdog', [ref]$mutexCreated)
if (-not $mutexCreated) { exit 0 }

function Write-Heartbeat {
    $path = Join-Path $root 'data\scheduler-watchdog-heartbeat.json'
    $temp = "$path.$PID.tmp"
    [System.IO.File]::WriteAllText($temp, ([ordered]@{ processId = $PID; updatedAt = (Get-Date).ToString('o') } | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temp -Destination $path -Force
}

try {
    while ($true) {
        Write-Heartbeat
        $processes = @(Get-CimInstance Win32_Process | Where-Object {
            $_.Name -in @('pwsh.exe', 'powershell.exe') -and $_.CommandLine -like "*-File*$schedulerScript*"
        })
        $fresh = $false
        if (Test-Path -LiteralPath $heartbeatPath) {
            try {
                $heartbeat = Get-Content -Raw -Encoding UTF8 $heartbeatPath | ConvertFrom-Json
                $maxMinutes = 5
                if ([string]$heartbeat.phase -eq 'running_checkin') {
                    $config = Get-Content -Raw -Encoding UTF8 $configPath | ConvertFrom-Json
                    $maxMinutes = Get-CheckinTaskRuntimeBudgetMinutes $config
                }
                $fresh = (Get-Date) - [datetime]$heartbeat.updatedAt -lt [timespan]::FromMinutes($maxMinutes)
            } catch { $fresh = $false }
        }
        if ($processes.Count -eq 0 -or -not $fresh) {
            $processes | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
            Start-Process -FilePath 'pwsh.exe' -ArgumentList @('-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',$schedulerScript) -WindowStyle Hidden
        }
        Start-Sleep -Seconds 60
    }
} finally {
    $mutex.ReleaseMutex() | Out-Null
    $mutex.Dispose()
}
