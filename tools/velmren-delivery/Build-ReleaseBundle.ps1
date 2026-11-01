[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$BrowserDirectory,
  [Parameter(Mandatory)][string]$AgentDirectory,
  [Parameter(Mandatory)][string]$NodeExecutable,
  [Parameter(Mandatory)][string]$PublicKey,
  [Parameter(Mandatory)][string]$PrivateKey,
  [Parameter(Mandatory)][string]$Policy,
  [Parameter(Mandatory)][string]$Version,
  [Parameter(Mandatory)][string]$OutputDirectory,
  [string]$PackageUrl,
  [string]$NodeLicense
)
$ErrorActionPreference = 'Stop'
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) { throw 'Choose a new release output directory; existing artifacts are retained.' }
New-Item -ItemType Directory -Path $output | Out-Null
$engineDirectory = Join-Path $output 'engine'
& (Join-Path $PSScriptRoot 'Build-Installer.ps1') -Mode Release -PublicKey $PublicKey -Policy $Policy -Version $Version -OutputDirectory $engineDirectory
$engine = Join-Path $engineDirectory 'VelmrenDelivery.exe'
$setupBuilder = Join-Path $PSScriptRoot '../velmren-setup/Build-Setup.ps1'
$maintenanceDirectory = Join-Path $output 'maintenance'
& $setupBuilder -EnginePath $engine -OutputDirectory $maintenanceDirectory -Name VelmrenMaintenance -Version $Version
$payload = Join-Path $output 'payload'
& (Join-Path $PSScriptRoot 'Stage-Payload.ps1') -BrowserDirectory $BrowserDirectory -AgentDirectory $AgentDirectory -NodeExecutable $NodeExecutable -NodeLicense $NodeLicense -DeliveryEngine $engine -MaintenanceExecutable (Join-Path $maintenanceDirectory 'VelmrenMaintenance.exe') -Destination $payload
$feed = Join-Path $output 'feed'
& (Join-Path $PSScriptRoot 'Build-Release.ps1') -Installer $engine -PayloadDirectory $payload -Version $Version -FeedDirectory $feed -PrivateKey $PrivateKey -PackageUrl $PackageUrl
$bundle = Join-Path $output 'bundle'
New-Item -ItemType Directory -Path $bundle | Out-Null
Copy-Item -LiteralPath (Join-Path $feed "manifest-$Version.json") -Destination (Join-Path $bundle 'manifest.json')
Copy-Item -LiteralPath (Join-Path $feed "velmren-$Version.zip") -Destination (Join-Path $bundle "velmren-$Version.zip")
$setupDirectory = Join-Path $output 'setup'
$releasePolicy = Get-Content -LiteralPath $Policy -Raw | ConvertFrom-Json
& $setupBuilder -EnginePath $engine -Feed $releasePolicy.feedUri -OutputDirectory $setupDirectory -Name VelmrenSetup -Version $Version
$setup = Join-Path $setupDirectory 'VelmrenSetup.exe'
$offlineDirectory = Join-Path $output 'offline-setup'
& $setupBuilder -EnginePath $engine -BundleDirectory $bundle -OutputDirectory $offlineDirectory -Name VelmrenSetup -Version $Version
$offlineSetup = Join-Path $offlineDirectory 'VelmrenSetup.exe'
$support = Join-Path $PSScriptRoot '../velmren-setup/support'
$supportFiles = @(foreach ($name in 'SECOND-PC-RU.md', 'Collect-VelmrenDiagnostics.ps1') {
  $destination = Join-Path $setupDirectory $name
  Copy-Item -LiteralPath (Join-Path $support $name) -Destination $destination
  [ordered]@{name=$name;sha256=(Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()}
})
[ordered]@{
  version = $Version
  setup = $setup
  setupKind = 'online'
  setupSha256 = (Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash.ToLowerInvariant()
  offlineSetup = $offlineSetup
  offlineSetupSha256 = (Get-FileHash -LiteralPath $offlineSetup -Algorithm SHA256).Hash.ToLowerInvariant()
  supportFiles = $supportFiles
  engineSha256 = (Get-FileHash -LiteralPath $engine -Algorithm SHA256).Hash.ToLowerInvariant()
  maintenanceSha256 = (Get-FileHash -LiteralPath (Join-Path $maintenanceDirectory 'VelmrenMaintenance.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
  manifestSha256 = (Get-FileHash -LiteralPath (Join-Path $bundle 'manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant()
  packageSha256 = (Get-FileHash -LiteralPath (Join-Path $bundle "velmren-$Version.zip") -Algorithm SHA256).Hash.ToLowerInvariant()
  packageBytes = (Get-Item -LiteralPath (Join-Path $bundle "velmren-$Version.zip")).Length
  compactPackage = (Join-Path $feed "velmren-$Version.7z")
  compactPackageSha256 = (Get-FileHash -LiteralPath (Join-Path $feed "velmren-$Version.7z") -Algorithm SHA256).Hash.ToLowerInvariant()
  compactPackageBytes = (Get-Item -LiteralPath (Join-Path $feed "velmren-$Version.7z")).Length
  registryInspection = (Get-Content -LiteralPath (Join-Path $engineDirectory 'registry-inspection.json') -Raw | ConvertFrom-Json)
  feedDirectory = $feed
  policy = $releasePolicy
  publicKeySha256 = (Get-FileHash -LiteralPath $PublicKey -Algorithm SHA256).Hash.ToLowerInvariant()
  authenticodeSigned = $false
  published = $false
} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $output 'release.json') -Encoding utf8NoBOM
Write-Output "Prepared $setup; no upload or public publication was performed."
