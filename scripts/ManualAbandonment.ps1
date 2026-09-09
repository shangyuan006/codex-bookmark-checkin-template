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

function Write-TodayManualAbandonment {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][object[]]$Targets,
        [datetime]$Now = (Get-Date)
    )

    $originSet = Get-TodayAbandonedOrigins -Path $Path -Now $Now
    foreach ($target in @($Targets)) {
        $origin = ConvertTo-ManualAbandonmentOrigin $target.origin
        if (-not $origin) { throw '今日放弃目标必须是规范的 HTTPS origin。' }
        $originSet[$origin] = $true
    }
    $document = [ordered]@{
        schemaVersion = 1
        date = $Now.ToString('yyyyMMdd')
        createdAt = $Now.ToUniversalTime().ToString('o')
        origins = @($originSet.Keys | Sort-Object)
    }
    [System.IO.Directory]::CreateDirectory((Split-Path -Parent $Path)) | Out-Null
    $temporaryPath = "$Path.$PID.tmp"
    [System.IO.File]::WriteAllText(
        $temporaryPath,
        ($document | ConvertTo-Json -Depth 4),
        [System.Text.UTF8Encoding]::new($false)
    )
    Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
    return [pscustomobject]$document
}
