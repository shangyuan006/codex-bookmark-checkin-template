[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string[]]$Origins,
    [ValidateSet('user_requested', 'network_unavailable')]
    [string]$Reason = 'user_requested',
    [switch]$PreserveSession
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Resolve-Runtime.ps1')
. (Join-Path $PSScriptRoot 'ManualAbandonment.ps1')
. (Join-Path $PSScriptRoot 'ManualVerification.ps1')

$manualSessionPath = Join-Path $root 'tmp\manual-session.json'
$agentRouterSessionPath = Join-Path $root 'tmp\agentrouter-manual-state.json'
$verificationPath = Join-Path $root 'tmp\manual-verification.json'
$handoffPath = Join-Path $root 'tmp\manual-handoff.json'
$abandonPath = Join-Path $root 'tmp\manual-abandon.json'

$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
$mutexName = if ($config.runMutexName) { [string]$config.runMutexName } else { 'Local\CodexBookmarkCheckinRun' }
$mutex = [System.Threading.Mutex]::new($false, $mutexName)
$owned = $false
try {
try { $owned = $mutex.WaitOne(10000) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
if (-not $owned) { throw '签到任务仍在操作当前会话，请稍后记录今日放弃。' }
if ((Test-Path -LiteralPath $manualSessionPath) -and -not $PreserveSession) {
    throw '普通人工窗口仍在跟踪中；请使用 Close-ManualLogin.ps1 -Abandon 正常关闭并记录。'
}
if ((Test-Path -LiteralPath $agentRouterSessionPath) -and -not $PreserveSession) {
    throw 'Agent Router 人工窗口仍在跟踪中；请先完成或关闭该专用会话。'
}
$requested = @{}
foreach ($rawOrigin in @($Origins)) {
    $origin = ConvertTo-ManualAbandonmentOrigin $rawOrigin
    if (-not $origin) { throw "今日放弃只接受规范的 HTTPS origin：$rawOrigin" }
    $requested[$origin] = $true
}
if ($requested.Count -eq 0) { throw '至少需要一个今日放弃 origin。' }

if ($PreserveSession) {
    if (-not (Test-Path -LiteralPath $manualSessionPath)) { throw '保留窗口模式需要当前受控会话。' }
    $session = Get-Content -Raw -Encoding UTF8 -LiteralPath $manualSessionPath | ConvertFrom-Json
    $todayPrefix = (Get-Date).ToString('yyyyMMdd') + '-'
    $profileMatches = [string]::Equals([IO.Path]::GetFullPath([string]$session.profile),
        [IO.Path]::GetFullPath([string]$config.automationUserDataDir), [StringComparison]::OrdinalIgnoreCase)
    if ([int]$session.schemaVersion -lt 2 -or $session.mode -ne 'native' -or $session.controlledCheckin -ne $true -or $session.windowReady -ne $true `
        -or -not $profileMatches -or [string]$session.sourceRunId -notlike "$todayPrefix*" `
        -or [string]$session.launchMarker -notmatch '^[a-f0-9]{32}$' `
        -or [int]$session.pid -le 0 -or $null -eq (ConvertTo-CheckinUtcDateTime $session.processStartedAt) `
        -or [int]$session.nativeDebugPort -lt 1024 -or [int]$session.nativeDebugPort -gt 65535 `
        -or @($session.targets).Count -ne [int]$session.targetCount -or [int]$session.targetCount -lt 1) {
        throw '保留窗口模式只接受今天的有效受控项目会话。'
    }
    foreach ($origin in @($requested.Keys)) {
        if (@($session.targets | Where-Object { (ConvertTo-ManualAbandonmentOrigin $_.origin) -eq $origin }).Count -ne 1) {
            throw '放弃目标不在当前受控会话中，保留其余页面。'
        }
    }
    $owners = @(Get-CheckinManualSessionBrowserProcesses -Config $config -State $session -ProfilePath $session.profile)
    if ($owners.Count -ne 1 -or [int]$owners[0].ProcessId -ne [int]$session.pid) {
        throw '无法确认受控会话身份，拒绝记录部分放弃。'
    }
    if (Test-Path -LiteralPath $agentRouterSessionPath) {
        # Record only selected ordinary targets while the independent account
        # window remains open. Neither browser profile is closed or modified.
        $dedicated = Get-Content -Raw -Encoding UTF8 -LiteralPath $agentRouterSessionPath | ConvertFrom-Json
        . (Join-Path $PSScriptRoot 'AgentRouterAccount.ps1')
        $accountKey = ConvertTo-AgentRouterAccountKey $dedicated.accountKey
        $accounts = @($config.agentrouterAccounts | Where-Object {
            $configuredKey = [string]$_.accountKey
            if (-not $configuredKey) { $configuredKey = [string]$_.accountId }
            if (-not $configuredKey) { $configuredKey = [string]$_.id }
            (ConvertTo-AgentRouterAccountKey $configuredKey) -ceq $accountKey
        })
        $dedicatedOrigin = if ($accounts.Count -eq 1) { ConvertTo-ManualAbandonmentOrigin $accounts[0].origin } else { $null }
        $dedicatedProfile = if ($accounts.Count -eq 1 -and $accounts[0].automationUserDataDir) {
            $profileValue = [string]$accounts[0].automationUserDataDir
            [IO.Path]::GetFullPath($(if ([IO.Path]::IsPathRooted($profileValue)) { $profileValue } else { Join-Path $root $profileValue }))
        } else { $null }
        if (-not $dedicatedOrigin -or -not $dedicatedProfile -or -not $dedicated.profile `
            -or -not [string]::Equals($dedicatedProfile, [IO.Path]::GetFullPath([string]$dedicated.profile), [StringComparison]::OrdinalIgnoreCase) `
            -or [string]::Equals($dedicatedProfile, [IO.Path]::GetFullPath([string]$session.profile), [StringComparison]::OrdinalIgnoreCase) `
            -or $requested.ContainsKey($dedicatedOrigin)) {
            throw '专用账号会话不独立或目标重叠，保留窗口且不记录放弃。'
        }
    }
}

$pendingVerification = $null
if (Test-Path -LiteralPath $verificationPath) {
    $verificationDocument = try {
        Get-Content -Raw -Encoding UTF8 -LiteralPath $verificationPath | ConvertFrom-Json
    }
    catch { throw '现有人工复核记录无法读取，拒绝自动覆盖。' }
    $completedVerification = [int]$verificationDocument.schemaVersion -eq 1 `
        -and [string]$verificationDocument.state -eq 'verification_complete' `
        -and $verificationDocument.authoritativeEvidenceRequired -eq $false `
        -and @($verificationDocument.targets).Count -gt 0 `
        -and @($verificationDocument.targets | Where-Object {
            -not (Test-ManualVerificationTargetTerminal $_)
        }).Count -eq 0
    if (-not $completedVerification) {
        $pendingVerification = Get-PendingManualVerification -Path $verificationPath
        if ($null -eq $pendingVerification `
            -or -not (Test-ManualVerificationCurrentDayDocument $pendingVerification.Document (Get-Date))) {
            throw '现有人工复核记录不是今天有效的待复核状态，拒绝自动覆盖。'
        }
    }
}
if ($null -ne $pendingVerification) {
    $pendingOriginSet = @{}
    foreach ($origin in @($pendingVerification.Origins)) {
        $pendingOriginSet[[string]$origin] = $true
    }
    foreach ($origin in @($requested.Keys)) {
        if (-not $pendingOriginSet.ContainsKey([string]$origin)) {
            throw '仍有人工操作后的权威复核记录；只能直接放弃该记录中的待复核目标。'
        }
    }
}

$node = Resolve-CheckinNode $config
$attentionArguments = @((Join-Path $root 'src\attention-urls.mjs'), '--for-abandonment')
foreach ($origin in @($requested.Keys | Sort-Object)) {
    $attentionArguments += @('--origin', $origin)
}
$rawHandoff = @(& $node @attentionArguments)
if ($LASTEXITCODE -ne 0) { throw '无法从当前书签和当天结果验证今日放弃目标。' }
$selection = try { ($rawHandoff -join [Environment]::NewLine) | ConvertFrom-Json } catch { $null }
$todayPrefix = (Get-Date).ToString('yyyyMMdd') + '-'
$targets = @($selection.targets)
if (-not $selection `
    -or [string]$selection.sourceRunId -notlike "$todayPrefix*" `
    -or $targets.Count -ne $requested.Count) {
    throw '今日放弃目标没有匹配到当天完整结果中的当前书签未终态项。'
}
foreach ($target in $targets) {
    $origin = ConvertTo-ManualAbandonmentOrigin $target.origin
    if (-not $origin -or -not $requested.ContainsKey($origin) `
        -or [string]$target.previousStatus -in @('signed', 'already_signed', 'not_available')) {
        throw '今日放弃目标验证结果不一致。'
    }
}

$document = Write-TodayManualAbandonment -Path $abandonPath -Targets $targets -Reason $Reason
Sync-TodayAbandonmentReport -Root $root -Node $node
if ($null -ne $pendingVerification) {
    $remainingTargets = @($pendingVerification.Document.targets | Where-Object {
        $origin = ConvertTo-ManualAbandonmentOrigin $_.origin
        -not $origin -or -not $requested.ContainsKey($origin)
    })
    $remainingPendingCount = @($remainingTargets | Where-Object {
        -not (Test-ManualVerificationTargetTerminal $_)
    }).Count
    if ($remainingPendingCount -eq 0) {
        Remove-Item -LiteralPath $verificationPath -Force
    }
    else {
        $pendingVerification.Document.targets = @($remainingTargets)
        $pendingVerification.Document.state = 'pending_verification'
        $pendingVerification.Document.authoritativeEvidenceRequired = $true
        $temporaryVerificationPath = "$verificationPath.$PID.tmp"
        try {
            [System.IO.File]::WriteAllText(
                $temporaryVerificationPath,
                ($pendingVerification.Document | ConvertTo-Json -Depth 8),
                [System.Text.UTF8Encoding]::new($false)
            )
            Move-Item -LiteralPath $temporaryVerificationPath -Destination $verificationPath -Force
        }
        finally {
            if (Test-Path -LiteralPath $temporaryVerificationPath) {
                Remove-Item -LiteralPath $temporaryVerificationPath -Force -ErrorAction SilentlyContinue
            }
        }
    }
}
if (Test-Path -LiteralPath $handoffPath) {
    $handoff = try { Get-Content -Raw -Encoding UTF8 -LiteralPath $handoffPath | ConvertFrom-Json } catch { $null }
    if ($handoff -and (Test-ManualVerificationCurrentDayDocument $handoff (Get-Date))) {
        $remaining = @($handoff.targets | Where-Object {
            $origin = ConvertTo-ManualAbandonmentOrigin $_.origin
            -not $origin -or -not $requested.ContainsKey($origin)
        })
        if ($remaining.Count -eq 0) {
            Remove-Item -LiteralPath $handoffPath -Force
        }
        else {
            $handoff.targets = @($remaining)
            if ($null -ne $handoff.PSObject.Properties['targetCount']) {
                $handoff.targetCount = $remaining.Count
            }
            $temporaryPath = "$handoffPath.$PID.tmp"
            [System.IO.File]::WriteAllText(
                $temporaryPath,
                ($handoff | ConvertTo-Json -Depth 8),
                [System.Text.UTF8Encoding]::new($false)
            )
            Move-Item -LiteralPath $temporaryPath -Destination $handoffPath -Force
        }
    }
}

[pscustomobject]@{
    recorded = $true
    date = [string]$document.date
    addedCount = $targets.Count
    totalAbandonedCount = @($document.origins).Count
    reason = $Reason
} | ConvertTo-Json
}
finally {
    if ($owned) { [void]$mutex.ReleaseMutex() }
    $mutex.Dispose()
}
