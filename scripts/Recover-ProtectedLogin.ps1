[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Origin,
    [Parameter(Mandatory = $true)][string]$LoginUrl
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Resolve-Runtime.ps1')
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
$node = Resolve-CheckinNode $config
$uri = [uri]$Origin
$loginUri = [uri]$LoginUrl
if ($uri.Scheme -ne 'https' -or $loginUri.GetLeftPart([System.UriPartial]::Authority) -ne $uri.GetLeftPart([System.UriPartial]::Authority)) {
    throw '受保护登录地址不属于目标 HTTPS origin。'
}

$hostKey = ($uri.DnsSafeHost -replace '[^a-z0-9.-]', '_').ToLowerInvariant()
$credentialPath = Join-Path $root "data\credentials\$hostKey.json"
if (-not (Test-Path -LiteralPath $credentialPath)) {
    Write-Output '{"status":"credential_missing"}'
    exit 2
}
$stored = Get-Content -Raw -Encoding UTF8 -LiteralPath $credentialPath | ConvertFrom-Json
if ([string]$stored.origin -ne $uri.GetLeftPart([System.UriPartial]::Authority)) { throw '受保护凭据来源不匹配。' }

function Unprotect-Text([string]$Value) {
    $secure = ConvertTo-SecureString $Value
    $pointer = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

$usernamePlain = $null
$passwordPlain = $null
try {
    $usernamePlain = Unprotect-Text ([string]$stored.usernameProtected)
    $passwordPlain = Unprotect-Text ([string]$stored.passwordProtected)
    $start = [System.Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $node
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    [void]$start.ArgumentList.Add((Join-Path $root 'src\credential-login.mjs'))
    [void]$start.ArgumentList.Add($uri.GetLeftPart([System.UriPartial]::Authority))
    [void]$start.ArgumentList.Add($loginUri.AbsoluteUri)
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $start
    [void]$process.Start()
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.StandardInput.WriteLine((@{ username = $usernamePlain; password = $passwordPlain } | ConvertTo-Json -Compress))
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(180000)) {
        try { $process.Kill($true) } catch { try { $process.Kill() } catch { } }
        Write-Output '{"status":"timeout"}'
        exit 2
    }
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    if ($stdout) { Write-Output $stdout.Trim() }
    else {
        $diagnostic = if ($stderr -match 'user data directory|profile.*(?:use|lock)|ProcessSingleton') { 'profile_busy' }
        elseif ($stderr -match 'Timeout|timed out') { 'timeout' }
        elseif ($stderr -match 'strict mode|selector|Unexpected token') { 'form_unsupported' }
        else { 'helper_failed' }
        Write-Output (@{ status = 'failed'; diagnostic = $diagnostic } | ConvertTo-Json -Compress)
    }
    exit $process.ExitCode
}
finally {
    $usernamePlain = $null
    $passwordPlain = $null
}
