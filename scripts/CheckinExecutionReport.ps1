function Find-CheckinExecutionReport([string]$LogsRoot, [string]$ExecutionId, [int]$Attempt = 0,
    [string]$PlanFingerprint = '', [datetime]$Now = (Get-Date)) {
    if ($ExecutionId -cnotmatch '^[a-f0-9]{32}$' -or -not (Test-Path -LiteralPath $LogsRoot)) { return $null }
    $today = $Now.ToString('yyyyMMdd')
    $pattern = "^$today-\d{6}-$ExecutionId-([1-9]\d?)$"
    $candidates = @(Get-ChildItem -LiteralPath $LogsRoot -Directory -Filter "$today-*-$ExecutionId-*" -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_.Name -cmatch $pattern -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            [pscustomobject]@{ Directory = $_; Attempt = [int]$Matches[1] }
        }
    })
    foreach ($candidate in @($candidates | Where-Object { $Attempt -eq 0 -or $_.Attempt -eq $Attempt } | Sort-Object Attempt -Descending)) {
        $attemptId = "$ExecutionId-$($candidate.Attempt)"
        foreach ($entry in @(@{ Name = 'result.json'; State = 'final' }, @{ Name = 'progress.json'; State = 'in_progress' })) {
            $path = Join-Path $candidate.Directory.FullName $entry.Name
            try {
                $file = Get-Item -LiteralPath $path -ErrorAction Stop
                if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
                $report = Get-Content -Raw -Encoding UTF8 -LiteralPath $path | ConvertFrom-Json
                if ([string]$report.executionAttemptId -cne $attemptId `
                    -or [string]$report.runId -cne $candidate.Directory.Name `
                    -or [string]$report.runState -ne $entry.State -or $null -eq $report.results) { continue }
                if ($PlanFingerprint -and [string]$report.planFingerprint -cne $PlanFingerprint) { continue }
                return [pscustomobject]@{ Path = $path; Report = $report; LastWriteTime = $file.LastWriteTime }
            }
            catch { }
        }
    }
    return $null
}
