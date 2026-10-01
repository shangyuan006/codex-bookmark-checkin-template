function Test-CheckinCycleCurrent($Result, $Config, [datetimeoffset]$Now = [datetimeoffset]::Now, $FallbackTimestamp = $null) {
    $rule = $Config.siteCycleRules.([string]$Result.origin)
    if ($null -eq $rule -or $Result.status -notin @('signed','already_signed')) { return $true }
    $zoneId = if ($rule.timeZone) { [string]$rule.timeZone } else { 'Asia/Shanghai' }
    $resetAt = if ($rule.resetAt) { [string]$rule.resetAt } else { '00:00' }
    if ($resetAt -notmatch '^([01]\d|2[0-3]):([0-5]\d)$') { throw 'Cycle resetAt must use HH:mm' }
    $minutes = [int]$Matches[1] * 60 + [int]$Matches[2]
    $zone = [TimeZoneInfo]::FindSystemTimeZoneById($zoneId)
    $localNow = [TimeZoneInfo]::ConvertTime($Now, $zone)
    $startDay = $localNow.Date
    if ($localNow.Hour * 60 + $localNow.Minute -lt $minutes) { $startDay = $startDay.AddDays(-1) }
    $startLocal = [datetime]::SpecifyKind($startDay.AddMinutes($minutes), [DateTimeKind]::Unspecified)
    if ($zone.IsInvalidTime($startLocal)) { throw 'Cycle reset time does not exist in this timezone on this date' }
    $start = [TimeZoneInfo]::ConvertTimeToUtc($startLocal, $zone)
    $timestamp = if ($Result.observedAt) { $Result.observedAt } elseif ($Result.evidence.confirmedAt) { $Result.evidence.confirmedAt } else { $FallbackTimestamp }
    try { $observed = [datetimeoffset]$timestamp } catch { return $false }
    if ($null -eq $timestamp) { return $false }
    return $observed -le $Now -and $observed.UtcDateTime -ge $start
}
