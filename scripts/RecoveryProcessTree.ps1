[CmdletBinding()]
param(
    [ValidateSet('Snapshot', 'Stop')][string]$Mode,
    [int]$RootProcessId,
    [string]$SnapshotBase64
)
$ErrorActionPreference = 'Stop'
function Get-Identity($ProcessInfo) {
    if (-not $ProcessInfo.CreationDate) { return $null }
    [pscustomobject]@{
        pid = [int]$ProcessInfo.ProcessId
        parent = [int]$ProcessInfo.ParentProcessId
        started = $ProcessInfo.CreationDate.ToUniversalTime().Ticks.ToString()
    }
}
function Get-Descendants($Processes, $Seeds) {
    $selected = @{}
    foreach ($seed in $Seeds) { $selected[[int]$seed.pid] = $seed }
    do {
        $changed = $false
        foreach ($processInfo in $Processes) {
            $id = [int]$processInfo.ProcessId
            $parent = [int]$processInfo.ParentProcessId
            if (-not $selected.ContainsKey($id) -and $selected.ContainsKey($parent)) {
                $identity = Get-Identity $processInfo
                if ([long]$identity.started -ge [long]$selected[$parent].started) {
                    $selected[$id] = $identity
                    $changed = $true
                }
            }
        }
    } while ($changed)
    return @($selected.Values)
}
if ($Mode -eq 'Snapshot') {
    if ($RootProcessId -le 0) { throw 'Invalid recovery PID' }
    $processes = @(Get-CimInstance Win32_Process)
    $rootProcess = $processes | Where-Object ProcessId -EQ $RootProcessId | Select-Object -First 1
    $snapshot = if ($rootProcess) { @(Get-Descendants $processes @((Get-Identity $rootProcess))) } else { @() }
    ConvertTo-Json -InputObject @($snapshot) -Compress
    exit 0
}
if (-not $SnapshotBase64) { throw 'Missing recovery process snapshot' }
$snapshot = @([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($SnapshotBase64)) | ConvertFrom-Json)
foreach ($entry in $snapshot) {
    if ([int]$entry.pid -le 0 -or [string]$entry.started -notmatch '^\d+$') { throw 'Invalid process identity' }
}
# A captured child remains identifiable even after its parent has exited.
# Re-check creation times before stopping anything to avoid PID reuse.
for ($pass = 0; $pass -lt 3; $pass++) {
    $processes = @(Get-CimInstance Win32_Process)
    $live = @($processes | ForEach-Object {
        $identity = Get-Identity $_
        if (@($snapshot | Where-Object { $_.pid -eq $identity.pid -and $_.started -eq $identity.started }).Count -gt 0) { $identity }
    })
    if ($live.Count -eq 0) { exit 0 }
    $snapshot = @(Get-Descendants $processes $live)
    foreach ($entry in @($snapshot | Sort-Object { [long]$_.started } -Descending)) {
        $current = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$entry.pid)"
        if ($current -and (Get-Identity $current).started -eq $entry.started) {
            $process = Get-Process -Id $entry.pid -ErrorAction SilentlyContinue
            if ($process -and [Math]::Abs($process.StartTime.ToUniversalTime().Ticks - [long]$entry.started) -lt 10) {
                $process.Kill()
                [void]$process.WaitForExit(3000)
            }
        }
    }
}
throw 'Recovery descendants did not exit after bounded cleanup'
