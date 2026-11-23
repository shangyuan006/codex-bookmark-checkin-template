[CmdletBinding()]
param([string[]]$Origins = @())

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
. (Join-Path $PSScriptRoot 'Resolve-Runtime.ps1')
$node = Resolve-CheckinNode $config
$browser = Resolve-CheckinBrowser $config
$originHelper = Join-Path $root 'src\login-sync-origins.mjs'
$originArguments = @($originHelper)
if ($Origins.Count -gt 0) { $originArguments += @('--origins', ($Origins -join ',')) }
$discoveredText = & $node @originArguments
if ($LASTEXITCODE -ne 0) { throw '读取书签登录同步范围失败。' }
$authorizedOrigins = @($discoveredText | ConvertFrom-Json)
if ($authorizedOrigins.Count -eq 0) { return }

$allowedHosts = @($authorizedOrigins | ForEach-Object {
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

# Native PowerShell invocation strips quotes from JSON arguments. Use a
# delimiter-safe host list; the Python helper still accepts the legacy JSON form.
$scoped = $Origins.Count -gt 0
$allowedArgument = if ($scoped) { $authorizedOrigins -join ',' } else { $allowedHosts -join ',' }
$scopeArgument = if ($scoped) { @('--exact-origins') } else { @() }
$allowedCount = if ($scoped) { $authorizedOrigins.Count } else { $allowedHosts.Count }
$copied = 0
$databases = 0
$populatedOriginCount = 0
foreach ($databaseName in @('Login Data', 'Login Data For Account')) {
    $source = Join-Path ([string]$config.sourceUserDataDir) "$([string]$config.sourceProfileDirectory)\$databaseName"
    $target = Join-Path $profilePath "Default\$databaseName"
    if (-not (Test-Path -LiteralPath $source) -or -not (Test-Path -LiteralPath $target)) { continue }
    $resultText = & $python $helper $source $target $allowedArgument @scopeArgument
    if ($LASTEXITCODE -ne 0) { throw "$($browser.DisplayName) 登录记录同步失败（$databaseName），退出码 $LASTEXITCODE。" }
    $result = $resultText | ConvertFrom-Json
    $copied += [int]$result.copied
    $currentPopulatedCount = if ($null -ne $result.populated_origins) { [int]$result.populated_origins } else { 0 }
    if ($currentPopulatedCount -gt $populatedOriginCount) { $populatedOriginCount = $currentPopulatedCount }
    $databases += 1
}
if ($databases -eq 0) { throw "未找到可同步的 $($browser.DisplayName) 登录数据库。" }
$missingOriginCount = [Math]::Max(0, $allowedCount - $populatedOriginCount)
Write-Output "已从 $databases 个 $($browser.DisplayName) 密码库检查 $allowedCount 个书签来源：其中 $populatedOriginCount 个来源有保存记录，$missingOriginCount 个来源没有保存记录；同步 $copied 条加密登录记录。"
