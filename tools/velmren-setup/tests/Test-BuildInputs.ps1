[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$EnginePath,
    [Parameter(Mandatory = $true)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$builder = Join-Path $PSScriptRoot '../Build-Setup.ps1'
$output = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($output) | Out-Null
$checks = [Collections.Generic.List[string]]::new()
function Assert-Rejected([string]$Name, [scriptblock]$Operation) {
    $rejected = $false
    try { & $Operation | Out-Null }
    catch { $rejected = $true }
    if (-not $rejected) { throw "Expected build input rejection: $Name" }
    $checks.Add($Name)
}
Assert-Rejected 'HTTP feed rejected' { & $builder -EnginePath $EnginePath -Feed 'http://example.test/manifest.json' -OutputDirectory $output }
Assert-Rejected 'Feed credentials rejected' { & $builder -EnginePath $EnginePath -Feed 'https://name:password@example.test/manifest.json' -OutputDirectory $output }
Assert-Rejected 'Feed fragment rejected' { & $builder -EnginePath $EnginePath -Feed 'https://example.test/manifest.json#fragment' -OutputDirectory $output }
$bundle = Join-Path $output 'bad-bundle'
[IO.Directory]::CreateDirectory($bundle) | Out-Null
$manifestPath = Join-Path $bundle 'manifest.json'
foreach ($name in @('../outside.zip', 'C:\outside.zip', 'inside\outside.zip', 'private.pem', 'missing.zip')) {
    $payload = @{ package = $name } | ConvertTo-Json -Compress
    @{ payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload)); signature = 'fixture-only' } | ConvertTo-Json | Set-Content -LiteralPath $manifestPath -Encoding utf8
    Assert-Rejected "Package rejected: $name" { & $builder -EnginePath $EnginePath -BundleDirectory $bundle -OutputDirectory $output }
}
$checks | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'build-input-results.json') -Encoding utf8
Write-Output "PASS $($checks.Count) build input checks"
