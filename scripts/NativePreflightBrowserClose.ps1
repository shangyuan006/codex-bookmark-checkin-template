function Close-NativePreflightBrowser {
    param(
        [Parameter(Mandatory)][scriptblock]$GetProcesses,
        [Parameter(Mandatory)][scriptblock]$RequestClose,
        [int]$TimeoutSeconds = 20,
        [int]$GraceSeconds = 10,
        [scriptblock]$Now = { [datetimeoffset]::UtcNow },
        [scriptblock]$Wait = { param($Milliseconds) Start-Sleep -Milliseconds $Milliseconds }
    )
    $remaining = @(& $GetProcesses)
    if ($remaining.Count -eq 0) { return }
    & $RequestClose $remaining
    for ($phase = 0; $phase -lt 2; $phase++) {
        $seconds = @($TimeoutSeconds, $GraceSeconds)[$phase]
        $deadline = (& $Now).AddSeconds($seconds)
        do {
            & $Wait 500
            $remaining = @(& $GetProcesses)
            if ($remaining.Count -eq 0) { return }
        } while ((& $Now) -lt $deadline)
        if ($phase -eq 0) {
            # Re-read the exact project profile before a second graceful request.
            # Never kill a browser or continue while its profile is still occupied.
            & $RequestClose $remaining
        }
    }
    throw '原生 WAF 预热窗口仍占用项目配置；正常关闭及延迟复查均未完成，保留进度并停止。'
}
