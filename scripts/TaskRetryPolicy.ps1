function Test-ReauthAccountAuthoritativelyComplete($Report, [string]$AccountKey) {
    if ($null -eq $Report -or -not $AccountKey) { return $false }

    foreach ($result in @($Report.results)) {
        if ([string]$result.origin -ne 'https://agentrouter.org') { continue }
        foreach ($account in @($result.accountResults)) {
            if ([string]$account.accountKey -ieq $AccountKey `
                -and [string]$account.status -in @('signed', 'already_signed')) {
                return $true
            }
        }
    }
    return $false
}
