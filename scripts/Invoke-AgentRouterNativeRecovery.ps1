[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$AccountKey)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Resolve-Runtime.ps1')
. (Join-Path $PSScriptRoot 'AgentRouterAccount.ps1')
$config = Get-Content -Raw -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
$account = Resolve-AgentRouterAccountConfig -Accounts @($config.agentrouterAccounts) -AccountKey $AccountKey
if ([string]$account.provider -ne 'LinuxDO' -or -not (Test-TargetFirstAgentRouterOAuth $account)) { throw 'Native target recovery requires a target-first LinuxDO account.' }
$node = Resolve-CheckinNode $config
$browser = Resolve-CheckinBrowser $config
$profileValue = [string]$account.automationUserDataDir
$profile = if ([System.IO.Path]::IsPathRooted($profileValue)) { [System.IO.Path]::GetFullPath($profileValue) }
    else { [System.IO.Path]::GetFullPath((Join-Path $root $profileValue)) }
$dataRoot = [System.IO.Path]::GetFullPath((Join-Path $root 'data')).TrimEnd('\') + '\'
if (-not $profile.StartsWith($dataRoot, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid isolated account profile.' }
if (Test-Path -LiteralPath (Join-Path $root 'tmp\agentrouter-manual-state.json')) { throw 'A dedicated manual session already exists.' }
if (Test-Path -LiteralPath (Join-Path $root 'tmp\agentrouter-native-state.json')) { throw 'A native recovery record already exists; resume it before starting another browser.' }
if (@(Get-CheckinProfileBrowserProcesses -Config $config -ProfilePath $profile).Count -gt 0) { throw 'The isolated account profile is occupied.' }
$probe = @(& $node (Join-Path $root 'src\probe-agentrouter-session.mjs') 'https://agentrouter.org' $AccountKey --recovery-state)
if ($LASTEXITCODE -ne 0) { throw 'Unable to verify the existing logout checkpoint.' }
$recovery = [string]$probe[-1] | ConvertFrom-Json
if ($recovery.action -ne 'resume' -or $recovery.nativeAllowed -ne $true) {
    '{"status":"needs_attention","oauthStage":"oauth_retry_budget_exhausted"}'
    return
}
& $node (Join-Path $root 'src\prepare-native-browser-profile.mjs') $profile 'Default' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Unable to prepare the isolated native profile.' }
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
try { $listener.Start(); $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port }
finally { $listener.Stop() }
$marker = [guid]::NewGuid().ToString('N')
$arguments = @("--user-data-dir=`"$profile`"", '--profile-directory=Default', '--new-window', "--checkin-launch=$marker",
    '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-component-update',
    '--window-position=-32000,-32000', '--window-size=1400,900', '--remote-debugging-address=127.0.0.1',
    "--remote-debugging-port=$port", 'https://agentrouter.org/login')
$nativeResult = $null
$nativeStatePath = Join-Path $root 'tmp\agentrouter-native-state.json'
$nativeState = $null
try {
    $nativeProcess = Start-Process -FilePath $browser.Executable -ArgumentList $arguments -WindowStyle Hidden -PassThru
    $nativeState = [ordered]@{
        schemaVersion = 1; stage = 'automatic_native'; accountKey = $AccountKey; profile = $profile
        pid = [int]$nativeProcess.Id; processStartedAt = $nativeProcess.StartTime.ToUniversalTime().ToString('o')
        startedAt = (Get-Date).ToUniversalTime().ToString('o'); launchMarker = $marker; nativeDebugPort = $port
    }
    Write-AgentRouterProviderState -Path $nativeStatePath -State $nativeState
    $oauthArguments = @((Join-Path $root 'src\oauth-login.mjs'), 'https://agentrouter.org', 'LinuxDO',
        '--login-url', 'https://agentrouter.org/login', '--automation-user-data-dir', $profile,
        '--account-id', $AccountKey, '--native-cdp-port', [string]$port,
        '--diagnostic-stage', 'automatic_native_target', '--private-result')
    if ($null -ne $account.oauthWaitMs) { $oauthArguments += @('--wait-ms', [string]$account.oauthWaitMs) }
    # Bound the child independently so the PowerShell finally block retains
    # time to save and close its own browser even if the Node helper hangs.
    $start = [System.Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $node
    $start.WorkingDirectory = $root
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    if ($null -ne $start.PSObject.Properties['ArgumentList']) {
        foreach ($argument in $oauthArguments) { [void]$start.ArgumentList.Add($argument) }
    } else { $start.Arguments = ($oauthArguments | ForEach-Object { '"' + $_ + '"' }) -join ' ' }
    $worker = [System.Diagnostics.Process]::new()
    try {
        $worker.StartInfo = $start
        [void]$worker.Start()
        $stdoutTask = $worker.StandardOutput.ReadToEndAsync()
        $stderrTask = $worker.StandardError.ReadToEndAsync()
        if (-not $worker.WaitForExit(180000)) {
            $worker.Kill()
            [void]$worker.WaitForExit(5000)
            $lines = @('{"status":"needs_attention","oauthStage":"helper_timeout"}')
        } else { $lines = @($stdoutTask.GetAwaiter().GetResult() -split '\r?\n') }
    } finally { $worker.Dispose() }
    for ($index = $lines.Count - 1; $index -ge 0; $index--) {
        try {
            $candidate = [string]$lines[$index] | ConvertFrom-Json
            if ($candidate.status -in @('logged_in','needs_attention')) { $nativeResult = $candidate; break }
        } catch { }
    }
}
finally {
    # Only this automatic off-screen window may be closed here. Never close a
    # visible handoff, another account or the user's ordinary browser.
    if ($nativeState) {
        $owned = @(Get-CheckinManualSessionBrowserProcesses -Config $config -ProfilePath $profile -State ([pscustomobject]$nativeState))
        foreach ($item in $owned) {
            $process = Get-Process -Id ([int]$item.ProcessId) -ErrorAction SilentlyContinue
            if ($process) { [void]$process.CloseMainWindow() }
        }
        $deadline = (Get-Date).AddSeconds(20)
        while (@(Get-CheckinProfileBrowserProcesses -Config $config -ProfilePath $profile).Count -gt 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
        if (@(Get-CheckinProfileBrowserProcesses -Config $config -ProfilePath $profile).Count -gt 0) { throw 'The automatic native browser did not close normally.' }
        # Failed inventory/closure deliberately retains the identity for the next
        # handoff. Only a confirmed closed window may lose this recovery record.
        if (Test-Path -LiteralPath $nativeStatePath) {
            $savedNativeState = Get-Content -Raw -LiteralPath $nativeStatePath | ConvertFrom-Json
            if ([string]$savedNativeState.launchMarker -ceq $marker) { Remove-Item -LiteralPath $nativeStatePath -Force }
        }
    }
}
if (-not $nativeResult) { $nativeResult = [pscustomobject]@{status='needs_attention';oauthStage='helper_failed'} }
$nativeResult | ConvertTo-Json -Compress -Depth 8
