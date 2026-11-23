function Resolve-CheckinExecutable {
    param(
        [string]$Configured,
        [string[]]$CommandNames,
        [switch]$Optional
    )

    if ($Configured) {
        if (Test-Path -LiteralPath $Configured) { return (Resolve-Path -LiteralPath $Configured).Path }
        $configuredCommand = Get-Command $Configured -ErrorAction SilentlyContinue
        if ($configuredCommand) { return $configuredCommand.Source }
    }
    foreach ($name in $CommandNames) {
        $command = Get-Command $name -ErrorAction SilentlyContinue
        if ($command -and $command.Source -notmatch 'WindowsApps\\python(?:3)?\.exe$') { return $command.Source }
    }
    if ($Optional) { return $null }
    throw "未找到运行时：$($CommandNames -join ', ')"
}

function Resolve-CheckinNode {
    param($Config)
    return Resolve-CheckinExecutable -Configured ([string]$Config.nodeExecutable) -CommandNames @('node.exe', 'node')
}

function Resolve-CheckinPython {
    param($Config, [switch]$Optional)
    return Resolve-CheckinExecutable -Configured ([string]$Config.pythonExecutable) -CommandNames @('python.exe', 'python3.exe', 'python', 'python3') -Optional:$Optional
}

function Resolve-CheckinBrowser {
    param($Config, [switch]$OptionalExecutable)

    $configured = if ($Config.browserExecutable) {
        [string]$Config.browserExecutable
    }
    else {
        [string]$Config.chromeExecutable
    }
    $browserId = if ($Config.browser) { [string]$Config.browser } else { 'chrome' }
    $commandNames = @(if ($browserId -eq 'edge') { 'msedge.exe' } else { 'chrome.exe' })
    $executable = Resolve-CheckinExecutable -Configured $configured -CommandNames $commandNames -Optional:$OptionalExecutable
    $processName = if ($Config.browserProcessName) {
        [string]$Config.browserProcessName
    }
    else {
        if ($executable) { [System.IO.Path]::GetFileName($executable) } else { [string]$commandNames[0] }
    }
    $displayName = if ($Config.browserDisplayName) {
        [string]$Config.browserDisplayName
    }
    elseif ($browserId -eq 'edge') {
        'Microsoft Edge'
    }
    else {
        'Google Chrome'
    }
    return [pscustomobject]@{
        Id = $browserId
        DisplayName = $displayName
        Executable = $executable
        ProcessName = $processName
    }
}

function Get-CheckinWmiProcesses {
    param([Parameter(Mandatory = $true)][string]$Filter)

    # Use the same local Win32 provider and permissions. Never substitute an
    # empty inventory when either query fails.
    if (Get-Command Get-WmiObject -ErrorAction SilentlyContinue) {
        return @(Get-WmiObject -Class Win32_Process -Filter $Filter -ErrorAction Stop)
    }
    Add-Type -AssemblyName System.Management -ErrorAction Stop
    $searcher = [System.Management.ManagementObjectSearcher]::new("SELECT Name,ProcessId,CommandLine FROM Win32_Process WHERE $Filter")
    $searcher.Options.Timeout = [TimeSpan]::FromSeconds(5)
    $collection = $null
    try {
        $collection = $searcher.Get()
        return @($collection | ForEach-Object {
            [pscustomobject]@{ Name = [string]$_.Name; ProcessId = [int]$_.ProcessId; CommandLine = [string]$_.CommandLine }
        })
    }
    finally {
        if ($collection) { $collection.Dispose() }
        $searcher.Dispose()
    }
}

function Get-CheckinCimProcesses {
    param([Parameter(Mandatory = $true)][string]$Filter)

    # A cancelled inventory is unknown, not an empty list of running browsers.
    $retryDelays = @(250, 750, 1500)
    for ($attempt = 1; $attempt -le 4; $attempt++) {
        try { return @(Get-CimInstance -ClassName Win32_Process -Filter $Filter -OperationTimeoutSec 5 -ErrorAction Stop) }
        catch {
            if ($attempt -eq 4) {
                try { return @(Get-CheckinWmiProcesses -Filter $Filter) } catch { }
                try { return @(Get-CheckinDirectProcesses -Filter $Filter) } catch { }
                throw [System.Management.Automation.ErrorRecord]::new(
                    [System.InvalidOperationException]::new('无法确认项目浏览器进程，保留会话状态。'),
                    'CheckinProcessQueryFailed', [System.Management.Automation.ErrorCategory]::ResourceUnavailable, $null)
            }
            Start-Sleep -Milliseconds $retryDelays[$attempt - 1]
        }
    }
}

function Get-CheckinLocalProcessSnapshot {
    param([string]$ProcessName, [int]$ProcessId = 0)
    # Enumerate locally without WMI list queries. Reading any matching start
    # time must succeed: an inaccessible process is not an absent process.
    return @(Get-Process -ErrorAction Stop | Where-Object {
        if ($ProcessId -gt 0) { $_.Id -eq $ProcessId }
        else { $_.ProcessName -ieq [IO.Path]::GetFileNameWithoutExtension($ProcessName) }
    } | ForEach-Object {
        [pscustomobject]@{ ProcessId = [int]$_.Id; Name = "$($_.ProcessName).exe"
            StartedAt = $_.StartTime.ToUniversalTime() }
    })
}

function Get-CheckinDirectProcessObject {
    param([int]$ProcessId, [int]$TimeoutSeconds = 5)
    Add-Type -AssemblyName System.Management -ErrorAction Stop
    $options = [System.Management.ObjectGetOptions]::new()
    $options.Timeout = [TimeSpan]::FromSeconds($TimeoutSeconds)
    $item = [System.Management.ManagementObject]::new([System.Management.ManagementScope]::new(),
        [System.Management.ManagementPath]::new("Win32_Process.Handle='$ProcessId'"), $options)
    try {
        $item.psbase.Get()
        return [pscustomobject]@{ Name = [string]$item['Name']; ProcessId = [int]$item['ProcessId']
            CommandLine = [string]$item['CommandLine']
            StartedAt = [System.Management.ManagementDateTimeConverter]::ToDateTime([string]$item['CreationDate']).ToUniversalTime() }
    }
    finally { $item.psbase.Dispose() }
}

function Get-CheckinDirectProcesses {
    param([Parameter(Mandatory = $true)][string]$Filter)
    $processName = ''; $processId = 0
    if ($Filter -match "^Name='([a-zA-Z0-9_.-]+\.exe)'$") { $processName = $Matches[1] }
    elseif ($Filter -match '^ProcessId=([1-9][0-9]*)$' -and [int]::TryParse($Matches[1], [ref]$processId)) { }
    else { throw 'Unsupported direct process query' }
    $clock = [Diagnostics.Stopwatch]::StartNew()
    for ($attempt = 0; $attempt -lt 2; $attempt++) {
        try {
            $before = @(Get-CheckinLocalProcessSnapshot -ProcessName $processName -ProcessId $processId)
            if ($before.Count -gt 256) { throw 'Direct process inventory limit exceeded' }
            $rows = @()
            foreach ($candidate in $before) {
                if ($clock.Elapsed.TotalSeconds -ge 45) { throw 'Direct process inventory timeout' }
                $row = Get-CheckinDirectProcessObject -ProcessId $candidate.ProcessId
                if ($row.ProcessId -ne $candidate.ProcessId -or $row.Name -ine $candidate.Name `
                    -or -not $row.CommandLine -or $null -eq $row.StartedAt `
                    -or [Math]::Abs(($row.StartedAt - $candidate.StartedAt).TotalSeconds) -gt 1) {
                    throw 'Direct process identity changed'
                }
                $rows += $row
            }
            $after = @(Get-CheckinLocalProcessSnapshot -ProcessName $processName -ProcessId $processId)
            if ($clock.Elapsed.TotalSeconds -ge 45 -or $before.Count -ne $after.Count) { throw 'Incomplete direct inventory' }
            foreach ($candidate in $before) {
                $matching = @($after | Where-Object {
                    $_.ProcessId -eq $candidate.ProcessId -and $_.Name -ieq $candidate.Name `
                        -and $_.StartedAt.Ticks -eq $candidate.StartedAt.Ticks
                })
                if ($matching.Count -ne 1) { throw 'Direct inventory changed during lookup' }
            }
            return $rows
        }
        catch {
            if ($attempt -eq 1 -or $clock.Elapsed.TotalSeconds -ge 45) { throw }
        }
    }
}

function Test-CheckinBrowserProfileArgument {
    param([string]$CommandLine, [string]$ProfilePath)
    $matchesFound = [regex]::Matches($CommandLine, '(?:^|\s)(?:"--user-data-dir=([^"]+)"|--user-data-dir="([^"]+)"|--user-data-dir=([^\s"]+))(?=\s|$)')
    if ($matchesFound.Count -ne 1) { return $false }
    $value = @($matchesFound[0].Groups | Select-Object -Skip 1 | Where-Object { $_.Success })[0].Value
    try { return [string]::Equals([IO.Path]::GetFullPath($value), [IO.Path]::GetFullPath($ProfilePath), [StringComparison]::OrdinalIgnoreCase) }
    catch { return $false }
}

function Get-CheckinProfileBrowserProcesses {
    param(
        $Config,
        [Parameter(Mandatory = $true)]
        [string]$ProfilePath
    )

    $browser = Resolve-CheckinBrowser $Config -OptionalExecutable
    $resolvedProfilePath = [System.IO.Path]::GetFullPath($ProfilePath)
    if ($browser.ProcessName -notmatch '^[a-zA-Z0-9_.-]+\.exe$') { throw 'Invalid browser process name' }
    return @(Get-CheckinCimProcesses -Filter "Name='$($browser.ProcessName)'" | Where-Object {
        $_.Name -ieq $browser.ProcessName -and (Test-CheckinBrowserProfileArgument $_.CommandLine $resolvedProfilePath)
    })
}

function Wait-CheckinVisibleBrowserWindow {
    param(
        $Config,
        [Parameter(Mandatory = $true)]
        [string]$ProfilePath,
        [Parameter(Mandatory = $true)]
        [ValidatePattern('^[a-f0-9]{32}$')]
        [string]$LaunchMarker,
        [ValidateRange(2, 30)]
        [int]$TimeoutSeconds = 15,
        [ValidateRange(250, 5000)]
        [int]$StableMilliseconds = 1500
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $stablePid = 0
    $stableSince = $null
    do {
        $marked = @(Get-CheckinProfileBrowserProcesses -Config $Config -ProfilePath $ProfilePath | Where-Object {
            $_.CommandLine -match "(?:^|\s)--checkin-launch=$LaunchMarker(?:\s|$)"
        })
        $visible = @($marked | ForEach-Object {
            Get-Process -Id ([int]$_.ProcessId) -ErrorAction SilentlyContinue
        } | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Responding })

        if ($visible.Count -eq 1) {
            $candidate = $visible[0]
            if ($stablePid -ne [int]$candidate.Id) {
                $stablePid = [int]$candidate.Id
                $stableSince = Get-Date
            }
            elseif (((Get-Date) - $stableSince).TotalMilliseconds -ge $StableMilliseconds) {
                try { [void]$candidate.WaitForInputIdle(1000) } catch { }
                try {
                    $shell = New-Object -ComObject WScript.Shell
                    [void]$shell.AppActivate([int]$candidate.Id)
                }
                catch { }
                Start-Sleep -Milliseconds 250
                $candidate.Refresh()
                if ($candidate.MainWindowHandle -ne 0 -and $candidate.Responding) {
                    return [pscustomobject]@{
                        ProcessId = [int]$candidate.Id
                        ProcessStartedAt = $candidate.StartTime.ToUniversalTime().ToString('o')
                    }
                }
            }
        }
        else {
            $stablePid = 0
            $stableSince = $null
        }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    return $null
}

function ConvertTo-CheckinUtcDateTime {
    param([object]$Value)

    if ($null -eq $Value) { return $null }
    if ($Value -is [datetimeoffset]) { return $Value.UtcDateTime }
    if ($Value -is [datetime]) {
        if ($Value.Kind -eq [System.DateTimeKind]::Unspecified) {
            return [datetime]::SpecifyKind($Value, [System.DateTimeKind]::Local).ToUniversalTime()
        }
        return $Value.ToUniversalTime()
    }

    $parsed = [datetimeoffset]::MinValue
    if (-not [datetimeoffset]::TryParse(
        [string]$Value,
        [System.Globalization.CultureInfo]::InvariantCulture,
        [System.Globalization.DateTimeStyles]::AllowWhiteSpaces,
        [ref]$parsed
    )) {
        return $null
    }
    return $parsed.UtcDateTime
}

function Test-CheckinProcessStartIdentity {
    param(
        $Process,
        [object]$RecordedStart,
        [double]$ToleranceSeconds = 2
    )

    if (-not $Process) { return $false }
    $expectedStart = ConvertTo-CheckinUtcDateTime $RecordedStart
    if ($null -eq $expectedStart) { return $false }
    $actualStart = try { $Process.StartTime.ToUniversalTime() } catch { return $false }
    return [Math]::Abs(($actualStart - $expectedStart).TotalSeconds) -le $ToleranceSeconds
}

function Get-CheckinAutomationBrowserProcesses {
    param($Config)

    $profilePath = [System.IO.Path]::GetFullPath([string]$Config.automationUserDataDir)
    return @(Get-CheckinProfileBrowserProcesses -Config $Config -ProfilePath $profilePath)
}

function Get-CheckinManualSessionBrowserProcesses {
    param(
        $Config,
        $State,
        [Parameter(Mandatory = $true)]
        [string]$ProfilePath
    )

    try { $profileProcesses = @(Get-CheckinProfileBrowserProcesses -Config $Config -ProfilePath $ProfilePath) }
    catch {
        # A tracked PID permits a narrower query; it still needs the profile,
        # launch marker and start time below before any process can be used.
        if (-not $State.pid -or -not $State.processStartedAt -or [string]$State.launchMarker -notmatch '^[a-f0-9]{32}$') { throw }
        $trackedPid = 0
        if (-not [int]::TryParse([string]$State.pid, [ref]$trackedPid) -or $trackedPid -le 0) { throw }
        $browser = Resolve-CheckinBrowser $Config -OptionalExecutable
        $profileProcesses = @(Get-CheckinCimProcesses -Filter "ProcessId=$trackedPid" | Where-Object {
            $_.Name -ieq $browser.ProcessName -and (Test-CheckinBrowserProfileArgument $_.CommandLine $ProfilePath)
        })
    }
    if ($profileProcesses.Count -eq 0) { return @() }

    $launchMarker = [string]$State.launchMarker
    if ($launchMarker -and $launchMarker -match '^[a-f0-9]{32}$') {
        $marked = @($profileProcesses | Where-Object {
            $_.CommandLine -match "(?:^|\s)--checkin-launch=$launchMarker(?:\s|$)" -and `
                (-not $State.pid -or [int]$_.ProcessId -eq [int]$State.pid) -and `
                (-not $State.processStartedAt -or (Test-CheckinProcessStartIdentity `
                    (Get-Process -Id ([int]$_.ProcessId) -ErrorAction SilentlyContinue) $State.processStartedAt))
        })
        return $marked
    }

    $recordedStartValue = if ($State.processStartedAt) {
        $State.processStartedAt
    }
    else {
        $State.startedAt
    }
    $recordedStart = ConvertTo-CheckinUtcDateTime $recordedStartValue
    if ($null -eq $recordedStart) { return @() }
    $toleranceSeconds = if ($State.processStartedAt) { 5 } else { 30 }
    return @($profileProcesses | Where-Object {
        $candidate = Get-Process -Id ([int]$_.ProcessId) -ErrorAction SilentlyContinue
        if (-not $candidate) {
            $false
        }
        else {
            try {
                $candidate.StartTime.ToUniversalTime() -ge $recordedStart.AddSeconds(-$toleranceSeconds)
            }
            catch { $false }
        }
    })
}
