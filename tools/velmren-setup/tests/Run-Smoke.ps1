[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$output = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($output) | Out-Null
$fakeOutput = Join-Path $output 'fake-engine'
& dotnet publish (Join-Path $PSScriptRoot 'FakeEngine/FakeEngine.csproj') -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:DebugType=none -o $fakeOutput --nologo
if ($LASTEXITCODE -ne 0) { throw 'Fake engine build failed.' }
$bundle = Join-Path $output 'fake-bundle'
[IO.Directory]::CreateDirectory($bundle) | Out-Null
$zipOutput = [IO.File]::Create((Join-Path $bundle 'velmren-1.0.0.0.zip'))
$zip = [IO.Compression.ZipArchive]::new($zipOutput, [IO.Compression.ZipArchiveMode]::Create)
try {
    $entry = $zip.CreateEntry('delivery/Velmren.exe', [IO.Compression.CompressionLevel]::Optimal)
    $entryOutput = $entry.Open()
    $engineInput = [IO.File]::OpenRead((Join-Path $fakeOutput 'FakeEngine.exe'))
    try { $engineInput.CopyTo($entryOutput) }
    finally { $engineInput.Dispose(); $entryOutput.Dispose() }
}
finally { $zip.Dispose(); $zipOutput.Dispose() }
$manifest = @{ package = 'velmren-1.0.0.0.zip'; version = '1.0.0.0' } | ConvertTo-Json -Compress
@{ payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($manifest)); signature = 'fixture-not-a-signature' } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $bundle 'manifest.json') -Encoding utf8
'not-a-real-key' | Set-Content -LiteralPath (Join-Path $bundle 'private.pem') -Encoding utf8
$setupOutput = Join-Path $output 'published-setup'
& (Join-Path $PSScriptRoot '../Build-Setup.ps1') -EnginePath (Join-Path $fakeOutput 'FakeEngine.exe') -BundleDirectory $bundle -OutputDirectory $setupOutput
$props = Get-ChildItem -LiteralPath $setupOutput -Filter 'build-*' -Directory | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
$propsPath = Join-Path $props.FullName 'payload.props'
& dotnet run --project (Join-Path $PSScriptRoot 'Setup.Smoke.csproj') -c Release "-p:SetupPayloadProps=$propsPath" -- $output
if ($LASTEXITCODE -ne 0) { throw 'Setup smoke checks failed.' }
foreach ($mode in @('maintenance', 'online')) {
    $artifactOutput = Join-Path $output $mode
    $buildArguments = @{ EnginePath = (Join-Path $fakeOutput 'FakeEngine.exe'); OutputDirectory = $artifactOutput }
    if ($mode -eq 'online') { $buildArguments.Feed = 'https://updates.example/fixture/' }
    & (Join-Path $PSScriptRoot '../Build-Setup.ps1') @buildArguments
    $stage = Get-ChildItem -LiteralPath $artifactOutput -Filter 'build-*' -Directory | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    $modeProps = Join-Path $stage.FullName 'payload.props'
    & dotnet run --project (Join-Path $PSScriptRoot 'Setup.Smoke.csproj') -c Release "-p:SetupPayloadProps=$modeProps" -- $artifactOutput --payload-only (Join-Path $fakeOutput 'FakeEngine.exe')
    if ($LASTEXITCODE -ne 0) { throw "$mode payload checks failed." }
}
