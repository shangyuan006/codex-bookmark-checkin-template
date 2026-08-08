function Get-CheckinTaskTimeoutMinutes($Config) {
    $value = if ($null -ne $Config.taskTimeoutMinutes) { [int]$Config.taskTimeoutMinutes } else { 25 }
    if ($value -lt 5 -or $value -gt 55) { throw 'taskTimeoutMinutes must be between 5 and 55.' }
    return $value
}

function Get-CheckinTaskRunAttempts($Config, [int]$Override = 0) {
    $value = if ($Override -gt 0) { $Override } elseif ($null -ne $Config.taskRunAttempts) { [int]$Config.taskRunAttempts } else { 2 }
    if ($value -lt 1 -or $value -gt 3) { throw 'taskRunAttempts must be between 1 and 3.' }
    return $value
}

function Get-CheckinTaskRetryDelayMinutes($Config) {
    $value = if ($null -ne $Config.taskRetryDelayMinutes) { [int]$Config.taskRetryDelayMinutes } else { 3 }
    if ($value -lt 0 -or $value -gt 30) { throw 'taskRetryDelayMinutes must be between 0 and 30.' }
    return $value
}

function Get-CheckinPreflightWaitSeconds($Config) {
    $items = @($Config.nativeWafPreflightUrls) + @($Config.nativeChallengePreflight)
    $seconds = 0
    foreach ($item in $items) {
        if ($null -eq $item) { continue }
        $waitSeconds = if ($item -is [string] -or $null -eq $item.waitSeconds) { 30 } else { [int]$item.waitSeconds }
        $boundedWaitSeconds = [Math]::Max(5, [Math]::Min(120, $waitSeconds))
        $passiveOnly = $item -isnot [string] -and [bool]$item.passiveOnly
        $inspectionAttempts = if ($passiveOnly) { 1 } else { 2 }
        $seconds += $boundedWaitSeconds * $inspectionAttempts
    }
    return $seconds
}

function Get-CheckinTaskRuntimeBudgetMinutes($Config, [int]$Attempts = 0) {
    $timeoutMinutes = Get-CheckinTaskTimeoutMinutes $Config
    $runAttempts = Get-CheckinTaskRunAttempts $Config $Attempts
    $retryDelayMinutes = Get-CheckinTaskRetryDelayMinutes $Config
    $preflightMinutes = [Math]::Ceiling((Get-CheckinPreflightWaitSeconds $Config) * $runAttempts / 60.0)
    $bufferMinutes = if ($null -ne $Config.taskRuntimeBufferMinutes) { [int]$Config.taskRuntimeBufferMinutes } else { 10 }
    $bufferMinutes = [Math]::Max(5, [Math]::Min(30, $bufferMinutes))
    return ($timeoutMinutes * $runAttempts) + ($retryDelayMinutes * [Math]::Max(0, $runAttempts - 1)) + $preflightMinutes + $bufferMinutes
}
