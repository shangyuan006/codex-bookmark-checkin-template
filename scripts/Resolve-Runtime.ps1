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
    $commandNames = if ($browserId -eq 'edge') { @('msedge.exe') } else { @('chrome.exe') }
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

function Get-CheckinProfileBrowserProcesses {
    param(
        $Config,
        [Parameter(Mandatory = $true)]
        [string]$ProfilePath
    )

    $browser = Resolve-CheckinBrowser $Config -OptionalExecutable
    $resolvedProfilePath = [System.IO.Path]::GetFullPath($ProfilePath)
    return @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -ieq $browser.ProcessName -and $_.CommandLine -like "*$resolvedProfilePath*"
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
            $_.CommandLine -like "*--checkin-launch=$LaunchMarker*"
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

    $profileProcesses = @(Get-CheckinProfileBrowserProcesses -Config $Config -ProfilePath $ProfilePath)
    if ($profileProcesses.Count -eq 0) { return @() }

    $launchMarker = [string]$State.launchMarker
    if ($launchMarker -and $launchMarker -match '^[a-f0-9]{32}$') {
        $marked = @($profileProcesses | Where-Object {
            $_.CommandLine -like "*--checkin-launch=$launchMarker*"
        })
        if ($marked.Count -gt 0) { return $marked }
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
