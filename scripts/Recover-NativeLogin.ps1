[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Origin,
    [string]$LoginUrl
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
. (Join-Path $PSScriptRoot 'Resolve-Runtime.ps1')
$node = Resolve-CheckinNode $config
$originUri = [uri]$Origin
if ($originUri.Scheme -ne 'https' -or -not $originUri.Host) { throw '原生登录恢复来源无效。' }
$targetUrl = if ($LoginUrl) { [uri]$LoginUrl } else { [uri]::new($originUri, '/login') }
if ($targetUrl.GetLeftPart([System.UriPartial]::Authority) -ne $originUri.GetLeftPart([System.UriPartial]::Authority)) {
    throw '原生登录恢复地址不属于目标站点。'
}

$profilePath = [string]$config.automationUserDataDir
$existing = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like "*$profilePath*" })
if ($existing.Count -gt 0) { throw '机器人专用 Chrome 正被占用，无法恢复登录。' }

$debugPort = Get-Random -Minimum 12000 -Maximum 32000
$originValue = $originUri.GetLeftPart([System.UriPartial]::Authority)
try {
    & (Join-Path $PSScriptRoot 'Open-PlainLoginChrome.ps1') -Offscreen -RemoteDebuggingPort $debugPort -Urls @($targetUrl.AbsoluteUri)
    Start-Sleep -Seconds 3
    & $node (Join-Path $root 'src\native-login.mjs') $debugPort $originValue
    if ($LASTEXITCODE -ne 0) { throw '原生 Chrome 未能自动恢复登录。' }
}
finally {
    $targets = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object {
        $_.CommandLine -like "*$profilePath*"
    })
    $targetIds = @($targets.ProcessId)
    $roots = @($targets | Where-Object { $targetIds -notcontains $_.ParentProcessId })
    foreach ($processInfo in $roots) {
        $process = Get-Process -Id $processInfo.ProcessId -ErrorAction SilentlyContinue
        if ($process) { [void]$process.CloseMainWindow() }
    }
    Start-Sleep -Seconds 3
    Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object {
        $_.CommandLine -like "*$profilePath*"
    } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
