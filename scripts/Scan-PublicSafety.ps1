[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$git = Get-Command git -ErrorAction SilentlyContinue

if ($git -and (Test-Path -LiteralPath (Join-Path $root '.git'))) {
    $relativeFiles = @(
        & $git.Source -C $root ls-files
        & $git.Source -C $root ls-files --others --exclude-standard
    ) | Select-Object -Unique | Where-Object { $_ -ne 'logs/.gitkeep' }
}
else {
    $relativeFiles = @(Get-ChildItem -LiteralPath $root -Recurse -File | ForEach-Object {
        $_.FullName.Substring($root.Length + 1).Replace('\', '/')
    } | Where-Object {
        $_ -notmatch '^(node_modules|data|logs|tmp|outputs|work|\.git)/' -and
        $_ -notin @('config/config.json', 'config/config.local.json', 'config/qa-rules.local.json', 'setup/answers.json')
    })
}

$patterns = [ordered]@{
    'Windows user path' = '(?i)[A-Z]:\\Users\\[^\\\s''"]+'
    'Private workspace path' = '(?i)[A-Z]:\\AIWorkspace\\'
    'Email address' = '(?i)\b[A-Z0-9._%+-]+@(?!example\.com\b)[A-Z0-9.-]+\.[A-Z]{2,}\b'
    'Telegram bot token' = '\b\d{7,12}:[A-Za-z0-9_-]{30,}\b'
    'OpenAI-style secret' = '\bsk-[A-Za-z0-9_-]{20,}\b'
    'GitHub token' = '\bgh[opusr]_[A-Za-z0-9]{20,}\b'
    'Assigned secret' = '(?i)[''"]?(password|passwd|cookie|authorization|secret|api[_-]?key|access[_-]?token)[''"]?\s*[:=]\s*[''"][^{}$%<][^''"]{5,}[''"]'
}

$findings = @()
$binaryExtensions = '^\.(png|jpg|jpeg|gif|webp|ico|bmp|tiff?|zip|gz|7z|rar|pdf|exe|dll|pdb|woff2?|ttf|otf)$'
foreach ($relative in $relativeFiles) {
    $fullPath = Join-Path $root $relative
    if (-not (Test-Path -LiteralPath $fullPath)) { continue }
    if ([System.IO.Path]::GetExtension($fullPath) -match $binaryExtensions) {
        $findings += [pscustomobject]@{ file = $relative; line = 0; rule = 'Binary file in public scope' }
        continue
    }
    $lineNumber = 0
    $lines = try { @(Get-Content -LiteralPath $fullPath -ErrorAction Stop) } catch {
        $findings += [pscustomobject]@{ file = $relative; line = 0; rule = 'Unreadable public file' }
        @()
    }
    foreach ($line in $lines) {
        $lineNumber += 1
        foreach ($entry in $patterns.GetEnumerator()) {
            if ($relative -eq 'scripts/Scan-PublicSafety.ps1' -and $entry.Key -eq 'Assigned secret') { continue }
            if ($line -match $entry.Value) {
                $findings += [pscustomobject]@{ file = $relative; line = $lineNumber; rule = $entry.Key }
            }
        }
    }
}

$result = [ordered]@{ safe = $findings.Count -eq 0; scannedFiles = $relativeFiles.Count; findings = $findings }
$result | ConvertTo-Json -Depth 6
if ($findings.Count -gt 0) { exit 1 }
