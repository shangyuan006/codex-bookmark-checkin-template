[CmdletBinding()]
param([string]$Root)

$ErrorActionPreference = 'Stop'
$root = if ($Root) { [System.IO.Path]::GetFullPath($Root) } else { Split-Path -Parent $PSScriptRoot }

$patterns = [ordered]@{
    'Windows user path' = '(?i)[A-Z]:\\Users\\[^\\\s''"]+'
    'Private workspace path' = '(?i)[A-Z]:\\AIWorkspace\\'
    'Email address' = '(?i)\b[A-Z0-9._%+-]+@(?!example\.com\b)[A-Z0-9.-]+\.[A-Z]{2,}\b'
    'Telegram bot token' = '\b\d{7,12}:[A-Za-z0-9_-]{30,}\b'
    'OpenAI-style secret' = '\bsk-[A-Za-z0-9_-]{20,}\b'
    'GitHub token' = '\bgh[opusr]_[A-Za-z0-9]{20,}\b'
    'Assigned secret' = '(?i)[''"]?(password|passwd|cookie|authorization|secret|api[_-]?key|access[_-]?token)[''"]?\s*[:=]\s*[''"][^{}$%<][^''"]{5,}[''"]'
}

$binaryExtensions = '^\.(png|jpg|jpeg|gif|webp|ico|bmp|tiff?|zip|gz|7z|rar|pdf|exe|dll|pdb|woff2?|ttf|otf)$'
# Node uses NUL-delimited Git paths, rejects links, and redacts filenames that
# contain private values. Binary file in public scope remains a blocking finding.
try {
    . (Join-Path $PSScriptRoot 'Resolve-Runtime.ps1')
    $node = Resolve-CheckinNode $null
    $policy = [ordered]@{
        patterns = @($patterns.GetEnumerator() | ForEach-Object { @{ rule = $_.Key; pattern = $_.Value } })
        binaryExtensions = $binaryExtensions
    }
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $output = @($policy | ConvertTo-Json -Depth 6 -Compress | & $node (Join-Path (Split-Path -Parent $PSScriptRoot) 'src/private-value-scan.mjs') '--root' $root '--patterns-stdin' 2>$null)
    $scanExitCode = $LASTEXITCODE
    $result = ($output -join [Environment]::NewLine) | ConvertFrom-Json
    if ($null -eq $result.safe) { throw 'Invalid scan report' }
    $result | ConvertTo-Json -Depth 6
    exit $scanExitCode
} catch {
    @{ safe = $false; scannedFiles = 0; findings = @(@{ file = '[scanner]'; line = 0; rule = 'Public safety scan failed' }) } | ConvertTo-Json -Depth 6
    exit 2
}
