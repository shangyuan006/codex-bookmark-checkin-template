[CmdletBinding()]
param([ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedRequestId,
    [ValidateRange(0,60)][int]$WaitSeconds = 0)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Resolve-Runtime.ps1')
. (Join-Path $PSScriptRoot 'AgentRouterAccount.ps1')
. (Join-Path $PSScriptRoot 'ManualInteraction.ps1')
. (Join-Path $PSScriptRoot 'ManualAbandonment.ps1')
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
$requestPath = Join-Path $root 'tmp\manual-interaction-requests.json'
function Save-ManualInteractionRequest($Status, $Sessions) {
    $hash = [System.Security.Cryptography.SHA256]::Create()
    try { $key = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($root.ToLowerInvariant())))).Replace('-', '') }
    finally { $hash.Dispose() }
    $mutex = [System.Threading.Mutex]::new($false, "Local\CheckinManualRequests_$key")
    $owned = $false
    try {
        try { $owned = $mutex.WaitOne(5000) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
        if (-not $owned) { throw '人工请求记录正被更新，请稍后重试。' }
        $records = if (Test-Path -LiteralPath $requestPath) { @(Get-Content -Raw -LiteralPath $requestPath | ConvertFrom-Json) } else { @() }
        if ($Status.requestId -in @($records.requestId)) { return }
        $record = [pscustomobject]@{ requestId = $Status.requestId; createdAt = (Get-Date).ToUniversalTime().ToString('o')
            identities = @($Sessions | Where-Object { $_.closed -ne $true -and $_.detached -ne $true } | ForEach-Object identity)
            targets = @($Status.targets) }
        $records = @(@($records) + $record | Select-Object -Last 24)
        [void][System.IO.Directory]::CreateDirectory((Split-Path -Parent $requestPath))
        $temporary = "$requestPath.$PID.tmp"
        try {
            [System.IO.File]::WriteAllText($temporary, (ConvertTo-Json -InputObject @($records) -Depth 6), [System.Text.UTF8Encoding]::new($false))
            Move-Item -LiteralPath $temporary -Destination $requestPath -Force
        } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
    } finally {
        if ($owned) { [void]$mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}
function Test-RequestedManualTarget($Target, $Requested) {
    return @($Requested | Where-Object {
        [string]$_.origin -ceq [string]$Target.origin -and [string]$_.accountKey -ceq [string]$Target.accountKey
    }).Count -gt 0
}
function Read-CurrentManualStatus {
$reportPath = Join-Path $root 'logs\latest.json'
$report = if (Test-Path -LiteralPath $reportPath) { Get-Content -Raw -Encoding UTF8 -LiteralPath $reportPath | ConvertFrom-Json } else { $null }
$sessions = @()
foreach ($kind in @('ordinary', 'agentrouter')) {
    $name = if ($kind -eq 'ordinary') { 'manual-session.json' } else { 'agentrouter-manual-state.json' }
    $path = Join-Path $root "tmp\$name"
    if (-not (Test-Path -LiteralPath $path)) { continue }
    $state = Get-Content -Raw -Encoding UTF8 -LiteralPath $path | ConvertFrom-Json
    $profile = [string]$config.automationUserDataDir
    if ($kind -eq 'agentrouter') {
        $account = Resolve-AgentRouterAccountConfig -Accounts @($config.agentrouterAccounts) -AccountKey $state.accountKey
        $profile = [string]$account.automationUserDataDir
    }
    $identity = if ($state.sessionId) { [string]$state.sessionId } else { [string]$state.launchMarker }
    $visible = $false
    if ($state.mode -eq 'live_checkin') {
        $owner = Get-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue
        if ($owner -and $owner.ProcessName -eq 'node' -and (Test-CheckinProcessStartIdentity $owner (ConvertTo-CheckinUtcDateTime $state.processStartedAt))) {
            $processes = @(Get-CheckinProfileBrowserProcesses -Config $config -ProfilePath $profile)
        } else { $processes = @() }
    } else {
        $processes = @(Get-CheckinManualSessionBrowserProcesses -Config $config -ProfilePath $profile -State $state)
    }
    $visible = @($processes | ForEach-Object { Get-Process -Id ([int]$_.ProcessId) -ErrorAction SilentlyContinue } | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Responding }).Count -gt 0
    $targets = if ($kind -eq 'agentrouter') { @([pscustomobject]@{ origin = [string]$account.origin; accountKey = [string]$state.accountKey }) } else { @($state.targets) }
    $sessions += [pscustomobject]@{ identity = $identity; visible = $visible; targets = $targets }
}
$requests = if (Test-Path -LiteralPath $requestPath) { @(Get-Content -Raw -LiteralPath $requestPath | ConvertFrom-Json) } else { @() }
$expected = @($requests | Where-Object requestId -CEQ $ExpectedRequestId | Select-Object -Last 1)
$historyPath = Join-Path $root 'tmp\manual-session-history.json'
if (Test-Path -LiteralPath $historyPath) {
    $history = Get-Content -Raw -LiteralPath $historyPath | ConvertFrom-Json
    $today = Get-ManualVerificationShanghaiDate (Get-Date)
    foreach ($closed in @($history.sessions)) {
        if ((Get-ManualVerificationShanghaiDate ([datetime]$closed.closedAt)) -ne $today) { continue }
        if ($ExpectedRequestId -and ($expected.Count -ne 1 -or [string]$closed.identity -notin @($expected[0].identities))) { continue }
        if ([string]$closed.identity -in @($sessions.identity)) { continue }
        $sessions += [pscustomobject]@{ identity = [string]$closed.identity; visible = $false; closed = $true
            targets = @($closed.targets); closeReason = [string]$closed.closeReason
            closedAt = [string]$closed.closedAt; completionConfirmed = $closed.completionConfirmed -eq $true }
    }
}
if ($ExpectedRequestId) {
    $scoped = @()
    if ($expected.Count -eq 1) {
        foreach ($session in @($sessions)) {
            if ([string]$session.identity -notin @($expected[0].identities)) { continue }
            $selected = @($session.targets | Where-Object { Test-RequestedManualTarget $_ @($expected[0].targets) })
            if ($selected.Count -eq 0) { continue }
            $session.targets = $selected
            $scoped += $session
        }
        $seen = @($scoped | ForEach-Object targets)
        $missing = @($expected[0].targets | Where-Object { -not (Test-RequestedManualTarget $_ $seen) })
        if ($missing.Count -gt 0) {
            # Preserve every original target even if a helper crashed before
            # writing its closure event; unrelated sessions stay outside it.
            $scoped += [pscustomobject]@{ identity = ''; visible = $false; detached = $true; targets = $missing }
        }
    }
    $sessions = $scoped
}
$abandoned = Get-TodayAbandonedOrigins -Path (Join-Path $root 'tmp\manual-abandon.json') -Now (Get-Date)
$status = Get-ManualInteractionStatus -Report $report -Sessions $sessions -AbandonedOrigins @($abandoned.Keys) -ExpectedRequestId $ExpectedRequestId
if ($status.mayAskUser -and $status.requestId -notin @($requests.requestId)) {
    Save-ManualInteractionRequest $status $sessions
}
return $status
}
$status = Read-CurrentManualStatus
$initial = $status | ConvertTo-Json -Depth 6 -Compress
$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ($WaitSeconds -gt 0 -and $status.activeSessionCount -gt 0 -and (Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 1
    $status = Read-CurrentManualStatus
    if (($status | ConvertTo-Json -Depth 6 -Compress) -cne $initial) { break }
}
$status | ConvertTo-Json -Depth 6
