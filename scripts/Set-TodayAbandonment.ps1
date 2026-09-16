[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string[]]$Origins
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

if (Test-Path -LiteralPath $manualSessionPath) {
    throw '普通人工窗口仍在跟踪中；请使用 Close-ManualLogin.ps1 -Abandon 正常关闭并记录。'
}
if (Test-Path -LiteralPath $agentRouterSessionPath) {
    throw 'Agent Router 人工窗口仍在跟踪中；请先完成或关闭该专用会话。'
}
$requested = @{}
foreach ($rawOrigin in @($Origins)) {
    $origin = ConvertTo-ManualAbandonmentOrigin $rawOrigin
    if (-not $origin) { throw "今日放弃只接受规范的 HTTPS origin：$rawOrigin" }
    $requested[$origin] = $true
}
if ($requested.Count -eq 0) { throw '至少需要一个今日放弃 origin。' }

$pendingVerification = $null
if (Test-Path -LiteralPath $verificationPath) {
    $pendingVerification = Get-PendingManualVerification -Path $verificationPath
    if ($null -eq $pendingVerification `
        -or -not (Test-ManualVerificationCurrentDayDocument $pendingVerification.Document (Get-Date))) {
        throw '现有人工复核记录不是今天有效的待复核状态，拒绝自动覆盖。'
    }
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

$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
$node = Resolve-CheckinNode $config
$attentionArguments = @((Join-Path $root 'src\attention-urls.mjs'))
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

$document = Write-TodayManualAbandonment -Path $abandonPath -Targets $targets
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
    if ($handoff -and [string]$handoff.sourceRunId -eq [string]$selection.sourceRunId) {
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
} | ConvertTo-Json
