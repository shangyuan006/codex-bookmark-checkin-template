[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$AccountKey,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{32}$')][string]$SessionMarker,
    [int]$TimeoutSeconds = 900
)
$ErrorActionPreference = 'Stop'
$statePath = Join-Path (Split-Path -Parent $PSScriptRoot) 'tmp\agentrouter-manual-state.json'
. (Join-Path $PSScriptRoot 'Resolve-Runtime.ps1')
$config = Get-Content -Raw -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'config\config.json') | ConvertFrom-Json
$node = Resolve-CheckinNode $config
$nextInspectionAt = Get-Date
$deadline = (Get-Date).AddSeconds([Math]::Max(1, [Math]::Min(900, $TimeoutSeconds)))
$completionSeenAt = $null
while ((Get-Date) -lt $deadline -and (Test-Path -LiteralPath $statePath)) {
    $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
    if ([string]$state.accountKey -cne $AccountKey -or [string]$state.launchMarker -cne $SessionMarker) { break }
    $completion = $state.oauthCompletion
    if ($state.nativeContinuationReady -eq $true -and $state.stage -eq 'agentrouter' `
        -and [int]$state.nativeDebugPort -ge 1024 -and [int]$state.nativeDebugPort -le 65535 `
        -and (Get-Date) -ge $nextInspectionAt `
        -and [string]$completion.status -ne 'logged_in') {
        $nextInspectionAt = (Get-Date).AddSeconds(5)
        # Revalidate ownership before every CDP inspection. A stale port or
        # reused PID must never control another browser; unknown stays open.
        try {
            $owned = @(Get-CheckinManualSessionBrowserProcesses -Config $config -ProfilePath ([string]$state.profile) -State $state | Where-Object {
                [int]$_.ProcessId -eq [int]$state.pid `
                    -and $_.CommandLine -match "(?:^|\s)--remote-debugging-port=$($state.nativeDebugPort)(?:\s|$)"
            })
            if ($owned.Count -eq 1) {
                $null = @(& $node (Join-Path (Split-Path -Parent $PSScriptRoot) 'src\native-oauth-continuation.mjs') ([string]$state.nativeDebugPort) $AccountKey)
            }
        } catch { }
        Start-Sleep -Seconds 1
        continue
    }
    if ([string]$state.stage -eq 'agentrouter' -and [string]$completion.status -eq 'logged_in' `
        -and [string]$completion.oauthStage -eq 'completed' -and [string]$completion.launchMarker -ceq $SessionMarker) {
        if (-not $completionSeenAt) { $completionSeenAt = Get-Date }
        # The opener normally completes itself. Recover only after it has had
        # time to persist/close, without starting OAuth or touching a challenge.
        if (((Get-Date) - $completionSeenAt).TotalSeconds -ge 10) {
            & (Join-Path $PSScriptRoot 'Complete-AgentRouterLogin.ps1') -AccountKey $AccountKey -ExpectedLaunchMarker $SessionMarker
            break
        }
    }
    Start-Sleep -Seconds 1
}
