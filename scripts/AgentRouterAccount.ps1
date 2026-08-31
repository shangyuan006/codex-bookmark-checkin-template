function ConvertTo-AgentRouterAccountKey([object]$Value) {
    $normalized = ([string]$Value).Trim().ToLowerInvariant() -replace '[^a-z0-9_-]+', '-'
    if ($normalized -notmatch '^[a-z0-9][a-z0-9_-]{0,63}$') {
        throw 'Agent Router accountKey must contain 1-64 ASCII letters, digits, underscores, or hyphens.'
    }
    return $normalized
}

function Resolve-AgentRouterPowerShellExecutable {
    $current = try { [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName } catch { $null }
    foreach ($candidate in @(
        $current,
        (Join-Path $PSHOME 'pwsh.exe'),
        (Join-Path $PSHOME 'powershell.exe')
    )) {
        if (-not $candidate) { continue }
        $name = [System.IO.Path]::GetFileName([string]$candidate)
        if ($name -in @('pwsh.exe', 'powershell.exe') -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return [System.IO.Path]::GetFullPath([string]$candidate)
        }
    }
    foreach ($name in @('pwsh.exe', 'powershell.exe')) {
        $command = Get-Command -Name $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command -and $command.Source) { return [string]$command.Source }
    }
    throw 'Unable to resolve the current PowerShell executable.'
}

function ConvertTo-AgentRouterOrigin([object]$Value) {
    $raw = [string]$Value
    $uri = try { [uri]$raw } catch { $null }
    if (-not $raw -or $raw -ne $raw.Trim() `
        -or -not $uri -or $uri.Scheme -ne 'https' -or -not $uri.Host -or $uri.UserInfo `
        -or $uri.AbsolutePath -ne '/' -or $uri.Query -or $uri.Fragment) {
        throw 'Agent Router origin must be an HTTPS origin without credentials.'
    }
    return $uri.GetLeftPart([System.UriPartial]::Authority).TrimEnd('/').ToLowerInvariant()
}

function Resolve-AgentRouterAccountConfig {
    param(
        [Parameter(Mandatory = $true)][object[]]$Accounts,
        [Parameter(Mandatory = $true)][string]$AccountKey,
        [string]$Origin = 'https://agentrouter.org'
    )

    $requestedAccountKey = ConvertTo-AgentRouterAccountKey $AccountKey
    $requestedOrigin = ConvertTo-AgentRouterOrigin $Origin
    $matches = @($Accounts | Where-Object {
        $configuredKey = [string]$_.accountKey
        if (-not $configuredKey) { $configuredKey = [string]$_.accountId }
        if (-not $configuredKey) { $configuredKey = [string]$_.id }
        (ConvertTo-AgentRouterOrigin $_.origin) -eq $requestedOrigin `
            -and (ConvertTo-AgentRouterAccountKey $configuredKey) -eq $requestedAccountKey
    })
    if ($matches.Count -ne 1) {
        throw "Expected exactly one Agent Router account configuration for accountKey '$requestedAccountKey'; found $($matches.Count)."
    }
    return $matches[0]
}
