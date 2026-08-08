[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
. (Join-Path $PSScriptRoot 'Resolve-Runtime.ps1')
$node = Resolve-CheckinNode $config
$browser = Resolve-CheckinBrowser $config
$originHelper = Join-Path $root 'src\login-sync-origins.mjs'
$origins = @($config.syncSavedLoginOrigins)
if ($config.syncBookmarkSavedLogins -ne $false) {
    if (-not (Test-Path -LiteralPath $node)) { throw "未找到 Node.js 运行时：$node" }
    $discoveredText = & $node $originHelper
    if ($LASTEXITCODE -ne 0) { throw '读取书签登录同步范围失败。' }
    $parsedOrigins = $discoveredText | ConvertFrom-Json
    $origins = @($parsedOrigins)
}
if ($origins.Count -eq 0) { return }

$allowedHosts = @($origins | ForEach-Object {
    $uri = [uri][string]$_
    if ($uri.Scheme -ne 'https' -or -not $uri.Host) { throw "无效登录同步来源：$_" }
    $uri.DnsSafeHost
} | Select-Object -Unique)

$profilePath = [string]$config.automationUserDataDir
$activeAutomationBrowser = @(Get-CheckinAutomationBrowserProcesses $config)
if ($activeAutomationBrowser.Count -gt 0) { throw "机器人专用 $($browser.DisplayName) 正在运行，不能同步登录记录。" }

$python = Resolve-CheckinPython $config
$helper = Join-Path $PSScriptRoot 'Sync-ChromeSavedLogins.py'

foreach ($required in @($python, $helper)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "登录同步所需文件不存在：$required" }
}

$sourceState = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path ([string]$config.sourceUserDataDir) 'Local State') | ConvertFrom-Json
$targetState = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $profilePath 'Local State') | ConvertFrom-Json
if (-not $sourceState.os_crypt.encrypted_key -or $sourceState.os_crypt.encrypted_key -ne $targetState.os_crypt.encrypted_key) {
    throw "源 $($browser.DisplayName) 与机器人配置的加密主密钥不一致，拒绝同步登录记录。"
}

$allowedJson = ConvertTo-Json -InputObject @($allowedHosts) -Compress
$copied = 0
$databases = 0
foreach ($databaseName in @('Login Data', 'Login Data For Account')) {
    $source = Join-Path ([string]$config.sourceUserDataDir) "$([string]$config.sourceProfileDirectory)\$databaseName"
    $target = Join-Path $profilePath "Default\$databaseName"
    if (-not (Test-Path -LiteralPath $source) -or -not (Test-Path -LiteralPath $target)) { continue }
    $resultText = & $python $helper $source $target $allowedJson
    if ($LASTEXITCODE -ne 0) { throw "$($browser.DisplayName) 登录记录同步失败（$databaseName），退出码 $LASTEXITCODE。" }
    $result = $resultText | ConvertFrom-Json
    $copied += [int]$result.copied
    $databases += 1
}
if ($databases -eq 0) { throw "未找到可同步的 $($browser.DisplayName) 登录数据库。" }
Write-Output "已从 $databases 个 $($browser.DisplayName) 密码库为 $($allowedHosts.Count) 个书签来源同步 $copied 条加密登录记录。"
