[CmdletBinding()]
param([switch]$Json, [switch]$ReadyOnly, [ValidateRange(0,60)][int]$WaitSeconds = 30)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Resolve-Runtime.ps1')
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
$statePath = Join-Path $root 'tmp\manual-session.json'
function Write-ContinuationStatus([string]$Status, [string]$Reason, [string]$Message, [int]$PendingCount) {
    $result = [pscustomobject]@{ state = $Status; reason = $Reason; message = $Message
        retryable = $Status -eq 'busy'; retryAfterSeconds = 5; completionConfirmed = $false
        processedCount = 0; completedCount = 0; unresolvedCount = $PendingCount }
    if ($Json) { $result | ConvertTo-Json -Compress } else { Write-Output $Message }
}
if (-not (Test-Path -LiteralPath $statePath)) {
    Write-ContinuationStatus 'session_closed' 'session_not_active' '原同页会话已结束，无需重复接续。' 0
    return
}
$state = Get-Content -Raw -Encoding UTF8 -LiteralPath $statePath | ConvertFrom-Json
if ([string]$state.launchMarker -notmatch '^[a-f0-9]{32}$') { throw '项目会话标识无效，保留窗口。' }
$sessionMarker = [string]$state.launchMarker
$continuationMutex = [System.Threading.Mutex]::new($false, "Local\CheckinManualContinue_$sessionMarker")
$continuationOwned = $false
$mutexName = if ($config.runMutexName) { [string]$config.runMutexName } else { 'Local\CodexBookmarkCheckinRun' }
$mutex = [System.Threading.Mutex]::new($false, $mutexName)
$owned = $false
try {
    $deadline = [datetime]::UtcNow.AddSeconds($(if ($ReadyOnly) { 0 } else { $WaitSeconds }))
    $remainingMs = { [int][Math]::Max(0, ($deadline - [datetime]::UtcNow).TotalMilliseconds) }
    try { $continuationOwned = $continuationMutex.WaitOne((& $remainingMs)) }
    catch [System.Threading.AbandonedMutexException] { $continuationOwned = $true }
    if (-not $continuationOwned) {
        Write-ContinuationStatus 'busy' 'manual_continuation_busy' '当前窗口正在由另一接续步骤处理，保留窗口并稍后继续。' ([int]$state.targetCount)
        return
    }
    try { $owned = $mutex.WaitOne((& $remainingMs)) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
    if (-not $owned) {
        Write-ContinuationStatus 'busy' 'run_busy' '其他项目步骤正占用运行锁，保留窗口并稍后继续。' ([int]$state.targetCount)
        return
    }
    if (-not (Test-Path -LiteralPath $statePath)) {
        Write-ContinuationStatus 'session_closed' 'session_not_active' '等待期间原同页会话已结束，无需重复接续。' 0
        return
    }
    $state = Get-Content -Raw -Encoding UTF8 -LiteralPath $statePath | ConvertFrom-Json
    if ([string]$state.launchMarker -cne $sessionMarker) {
        Write-ContinuationStatus 'session_changed' 'session_identity_changed' '原同页会话已改变，本次不操作新窗口。' ([int]$state.targetCount)
        return
    }
    if ($state.mode -ne 'native' -or $state.controlledCheckin -ne $true -or $state.windowReady -ne $true) {
        throw '当前窗口不是受控同页接续会话。'
    }
    $port = [int]$state.nativeDebugPort
    if ($port -lt 1024 -or $port -gt 65535) { throw '项目调试端口记录无效。' }
    $sessionBrowsers = @(Get-CheckinManualSessionBrowserProcesses -Config $config -ProfilePath ([string]$config.automationUserDataDir) -State $state)
    $owner = @($sessionBrowsers | Where-Object {
        [string]$_.CommandLine -match "(?:^|\s)--remote-debugging-port=$port(?:\s|$)" `
            -and [string]$_.CommandLine -match '--remote-debugging-address=127\.0\.0\.1(?:\s|$)'
    })
    if ($owner.Count -ne 1 -or [int]$owner[0].ProcessId -ne [int]$state.pid) { throw '项目浏览器与调试端口身份不匹配，拒绝连接。' }
    $process = Get-Process -Id ([int]$state.pid) -ErrorAction Stop
    if (-not (Test-CheckinProcessStartIdentity -Process $process -RecordedStart (ConvertTo-CheckinUtcDateTime $state.processStartedAt) -ToleranceSeconds 2)) {
        throw '项目浏览器进程身份已改变，拒绝连接。'
    }
    $continuationArguments = @((Join-Path $root 'src\manual-native-continuation.mjs'), '--continue')
    if ($ReadyOnly) { $continuationArguments += '--ready-only' }
    $raw = @(& (Resolve-CheckinNode $config) @continuationArguments)
    if ($LASTEXITCODE -ne 0) { throw '同页接续失败，保留项目窗口。' }
    $result = ($raw -join [Environment]::NewLine) | ConvertFrom-Json
    $result | Add-Member -NotePropertyName state -NotePropertyValue 'continued' -Force
    if ($Json) { $result | ConvertTo-Json -Compress }
    else { Write-Output "同页接续：确认完成 $($result.completedCount) 个，仍待处理 $($result.unresolvedCount) 个；未完成页面保留。" }
}
finally {
    if ($owned) { [void]$mutex.ReleaseMutex() }
    $mutex.Dispose()
    if ($continuationOwned) { [void]$continuationMutex.ReleaseMutex() }
    $continuationMutex.Dispose()
}
