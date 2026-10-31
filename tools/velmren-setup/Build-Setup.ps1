[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$EnginePath,
    [string]$BundleDirectory,
    [string]$Feed,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [ValidateSet('win-x64', 'win-arm64')][string]$Runtime = 'win-x64',
    [ValidateSet('VelmrenSetup', 'VelmrenMaintenance')][string]$Name,
    [string]$Version = '1.0.0'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-NoLinks([string]$Path) {
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Reparse points are not supported: $current"
            }
        }
        $current = [IO.Path]::GetDirectoryName($current)
    }
}

$engine = [IO.Path]::GetFullPath($EnginePath)
Assert-NoLinks $engine
if (-not (Test-Path -LiteralPath $engine -PathType Leaf) -or [IO.Path]::GetExtension($engine) -ne '.exe') {
    throw 'EnginePath must point to a published, self-contained engine EXE.'
}

$feedValue = $null
if ($Feed) {
    $feedUri = $null
    if (-not [Uri]::TryCreate($Feed, [UriKind]::Absolute, [ref]$feedUri) -or
        $feedUri.Scheme -ne 'https' -or $feedUri.UserInfo -or $feedUri.Fragment) {
        throw 'Feed must be an absolute HTTPS URL without credentials or a fragment.'
    }
    $feedValue = $Feed
}

$resources = [ordered]@{ 'Setup.Payload.Engine' = $engine }
$packageName = $null
if ($BundleDirectory) {
    $bundle = [IO.Path]::GetFullPath($BundleDirectory)
    Assert-NoLinks $bundle
    $manifestPath = Join-Path $bundle 'manifest.json'
    Assert-NoLinks $manifestPath
    if ((Get-Item -LiteralPath $manifestPath).Length -gt 16MB) { throw 'Manifest exceeds 16 MiB.' }
    $envelope = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if (-not $envelope.payload -or -not $envelope.signature) { throw 'Expected signed manifest envelope.' }
    $manifest = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($envelope.payload)) | ConvertFrom-Json
    $packageName = [string]$manifest.package
    if (-not $packageName -or $packageName -ne [IO.Path]::GetFileName($packageName) -or
        $packageName.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0 -or
        -not $packageName.EndsWith('.zip', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Manifest package must be a ZIP filename directly inside BundleDirectory.'
    }
    $packagePath = Join-Path $bundle $packageName
    Assert-NoLinks $packagePath
    if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) { throw 'Signed manifest package is missing.' }
    $resources.Add('Setup.Payload.Manifest', $manifestPath)
    $resources.Add('Setup.Payload.Package', $packagePath)
}

if (-not $Name) { $Name = if ($BundleDirectory -or $Feed) { 'VelmrenSetup' } else { 'VelmrenMaintenance' } }
$parsedVersion = $null
if (-not [Version]::TryParse($Version, [ref]$parsedVersion)) { throw 'Version must be numeric.' }
$output = [IO.Path]::GetFullPath($OutputDirectory)
Assert-NoLinks $output
[IO.Directory]::CreateDirectory($output) | Out-Null
$stage = Join-Path $output ('build-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($stage) | Out-Null
$configPath = Join-Path $stage 'payload.json'
@{ Feed = $feedValue; Package = $packageName } | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding utf8
$resources.Add('Setup.Payload.Config', $configPath)

$props = Join-Path $stage 'payload.props'
$settings = [Xml.XmlWriterSettings]::new()
$settings.Indent = $true
$writer = [Xml.XmlWriter]::Create($props, $settings)
try {
    $writer.WriteStartElement('Project')
    $writer.WriteStartElement('ItemGroup')
    foreach ($resource in $resources.GetEnumerator()) {
        $writer.WriteStartElement('EmbeddedResource')
        $writer.WriteAttributeString('Include', $resource.Value)
        $writer.WriteElementString('LogicalName', $resource.Key)
        $writer.WriteEndElement()
    }
    $writer.WriteEndElement()
    $writer.WriteEndElement()
}
finally { $writer.Dispose() }

$project = Join-Path $PSScriptRoot 'Velmren.Setup.csproj'
$publish = Join-Path $stage 'publish'
$dotnetArguments = @(
    'publish', $project, '-c', 'Release', '-r', $Runtime, '--self-contained', 'true',
    '-o', $publish,
    '-p:PublishSingleFile=true', '-p:IncludeNativeLibrariesForSelfExtract=true',
    '-p:EnableCompressionInSingleFile=true', '-p:DebugType=none',
    "-p:BaseIntermediateOutputPath=$stage/obj/", "-p:BaseOutputPath=$stage/bin/",
    "-p:SetupPayloadProps=$props", "-p:AssemblyName=$Name", "-p:Version=$Version"
)
& dotnet @dotnetArguments
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed with exit code $LASTEXITCODE" }
$built = Join-Path $publish ($Name + '.exe')
$destination = Join-Path $output ($Name + '.exe')
Copy-Item -LiteralPath $built -Destination $destination -Force
$hash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
[ordered]@{
    executable = $destination
    sha256 = $hash
    size = (Get-Item -LiteralPath $destination).Length
    runtime = $Runtime
    bundle = [bool]$BundleDirectory
    onlineFeed = [bool]$Feed
    signed = $false
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output ($Name + '.build.json')) -Encoding utf8
Write-Output "Built $destination"
Write-Output "SHA-256 $hash"
