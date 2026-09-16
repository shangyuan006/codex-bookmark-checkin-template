function Get-CheckinRunOrigins([string[]]$Arguments) {
    $index = [Array]::IndexOf($Arguments, '--origins')
    if ($index -lt 0) { return @() }
    if ($index + 1 -ge $Arguments.Count -or -not $Arguments[$index + 1]) { throw 'Empty check-in origin scope' }
    return @($Arguments[$index + 1].Split(',') | Where-Object { $_ } | Select-Object -Unique)
}

function Select-CheckinPreflightTargets($Targets, [string[]]$ScopeOrigins = @(), [string[]]$ExcludedOrigins = @()) {
    $scope = @{}
    foreach ($origin in $ScopeOrigins) { $scope[$origin.TrimEnd('/')] = $true }
    $excluded = @{}
    foreach ($origin in $ExcludedOrigins) { $excluded[$origin.TrimEnd('/')] = $true }
    return @($Targets | Where-Object {
        $origin = ([string]$_.origin).TrimEnd('/')
        $origin -and -not $excluded.ContainsKey($origin) -and
            ($scope.Count -eq 0 -or $scope.ContainsKey($origin))
    })
}
