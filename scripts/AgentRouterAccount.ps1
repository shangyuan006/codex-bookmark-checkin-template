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

function Invoke-LinuxDoProviderSessionProbe {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Node,
        [Parameter(Mandatory = $true)][string]$Profile,
        [Parameter(Mandatory = $true)][string]$DiagnosticStage
    )
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $probeOutput = @(& $Node (Join-Path $Root 'src\oauth-provider-session.mjs') `
            'https://agentrouter.org' 'LinuxDO' '--automation-user-data-dir' $Profile `
            '--diagnostic-stage' $DiagnosticStage 2>$null)
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    for ($index = $probeOutput.Count - 1; $index -ge 0; $index--) {
        try {
            $probe = [string]$probeOutput[$index] | ConvertFrom-Json
            if ([string]$probe.status -in @('valid', 'invalid', 'unknown', 'not_supported')) {
                $attempts = 0
                if (-not [int]::TryParse([string]$probe.attempts, [ref]$attempts) -or $attempts -lt 1) {
                    $attempts = 1
                }
                return [pscustomobject]@{
                    Status = [string]$probe.status
                    Attempts = $attempts
                    ChallengeObserved = $probe.challengeObserved -eq $true
                    RateLimited = $probe.rateLimited -eq $true
                }
            }
        }
        catch { }
    }
    return [pscustomobject]@{ Status = 'unknown'; Attempts = 0; ChallengeObserved = $false; RateLimited = $false }
}

function Write-AgentRouterProviderState([string]$Path, $State) {
    [System.IO.Directory]::CreateDirectory((Split-Path -Parent $Path)) | Out-Null
    $temporary = "$Path.$PID.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        [System.IO.File]::WriteAllText(
            $temporary,
            ($State | ConvertTo-Json -Depth 4),
            [System.Text.UTF8Encoding]::new($false)
        )
        Move-Item -LiteralPath $temporary -Destination $Path -Force -ErrorAction Stop
    }
    finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        }
    }
}

function Get-AgentRouterProviderProbeBackoffMinutes([int]$FailureCount, [bool]$RateLimited = $false) {
    $boundedCount = [Math]::Max(1, [Math]::Min(5, $FailureCount))
    $minutes = [int][Math]::Min(30, 2 * [Math]::Pow(2, $boundedCount - 1))
    if ($RateLimited) { $minutes = [Math]::Max(10, $minutes) }
    return $minutes
}

function Test-AgentRouterProviderProbeDue($State, [datetimeoffset]$Now = [datetimeoffset]::UtcNow) {
    $eligibleAt = [datetimeoffset]::MinValue
    if ($State.nextProbeAt -is [datetime]) {
        $eligibleAt = [datetimeoffset]([datetime]$State.nextProbeAt).ToUniversalTime()
    }
    elseif ($State.nextProbeAt -is [datetimeoffset]) {
        $eligibleAt = ([datetimeoffset]$State.nextProbeAt).ToUniversalTime()
    }
    elseif (-not [datetimeoffset]::TryParse([string]$State.nextProbeAt, [ref]$eligibleAt)) {
        return $false
    }
    return $eligibleAt -le $Now
}
