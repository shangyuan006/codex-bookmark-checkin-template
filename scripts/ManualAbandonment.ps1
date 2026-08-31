function ConvertTo-ManualAbandonmentOrigin([object]$Value) {
    $raw = [string]$Value
    $uri = try { [uri]$raw } catch { $null }
    if (-not $raw -or $raw -ne $raw.Trim() `
        -or -not $uri -or -not $uri.IsAbsoluteUri `
        -or $uri.Scheme -ne 'https' -or -not $uri.Host -or $uri.UserInfo `
        -or $uri.AbsolutePath -ne '/' -or $uri.Query -or $uri.Fragment) {
        return $null
    }
    return $uri.GetLeftPart([System.UriPartial]::Authority).TrimEnd('/').ToLowerInvariant()
}

function Get-TodayAbandonedOrigins {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [datetime]$Now = (Get-Date)
    )

    $empty = @{}
    if (-not (Test-Path -LiteralPath $Path)) { return $empty }
    try {
        $document = Get-Content -Raw -Encoding UTF8 -LiteralPath $Path | ConvertFrom-Json
        if ([int]$document.schemaVersion -ne 1 `
            -or [string]$document.date -ne $Now.ToString('yyyyMMdd') `
            -or $null -eq $document.PSObject.Properties['origins']) {
            return $empty
        }
        $origins = @{}
        foreach ($rawOrigin in @($document.origins)) {
            $origin = ConvertTo-ManualAbandonmentOrigin $rawOrigin
            if (-not $origin) { return @{} }
            $origins[$origin] = $true
        }
        return $origins
    }
    catch { return $empty }
}
