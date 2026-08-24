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

    $recordedStart = [datetime]::MinValue
    $recordedStartText = if ($State.processStartedAt) {
        [string]$State.processStartedAt
    }
    else {
        [string]$State.startedAt
    }
    if (-not $recordedStartText -or -not [datetime]::TryParse($recordedStartText, [ref]$recordedStart)) {
        return @()
    }
    $toleranceSeconds = if ($State.processStartedAt) { 5 } else { 30 }
    return @($profileProcesses | Where-Object {
        $candidate = Get-Process -Id ([int]$_.ProcessId) -ErrorAction SilentlyContinue
        if (-not $candidate) {
            $false
        }
        else {
            try {
                $candidate.StartTime.ToUniversalTime() -ge $recordedStart.ToUniversalTime().AddSeconds(-$toleranceSeconds)
            }
            catch { $false }
        }
    })
}
