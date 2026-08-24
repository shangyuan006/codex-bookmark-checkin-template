function Get-NativeFallbackOnlyOrigins($Config) {
    $origins = @()
    $entries = @($Config.nativeWafPreflightUrls) + @($Config.nativeChallengePreflight)
    foreach ($entry in $entries) {
        if ($entry -is [string] -or $entry.fallbackOnly -ne $true -or $null -ne $entry.action) { continue }
        try {
            $uri = [uri][string]$entry.url
            if ($uri.Scheme -in @('http', 'https') -and $uri.Host) {
                $origins += $uri.GetLeftPart([System.UriPartial]::Authority)
            }
        }
        catch { }
    }
    return @($origins | Sort-Object -Unique)
}

function Get-NativeFallbackRetryOrigins($Report, [string[]]$Origins) {
    if (-not (Test-IsCompleteFinalReport $Report) -or @($Origins).Count -eq 0) { return @() }
    $originSet = @{}
    foreach ($origin in @($Origins)) { $originSet[[string]$origin] = $true }
    $fallbackStatuses = @(
        'error', 'interactive_challenge', 'managed_challenge_timeout',
        'needs_attention', 'unconfirmed', 'visited', 'clicked'
    )
    return @($Report.results | Where-Object {
        $originSet.ContainsKey([string]$_.origin) -and [string]$_.status -in $fallbackStatuses
    } | ForEach-Object { [string]$_.origin } | Sort-Object -Unique)
}

function Test-NeedsNativeFallbackRetry($Report, [string[]]$Origins) {
    return @(Get-NativeFallbackRetryOrigins -Report $Report -Origins $Origins).Count -gt 0
}
