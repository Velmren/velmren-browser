[CmdletBinding()]
param(
  [string]$TrustDirectory,
  [Parameter(Mandatory)][string]$OutputDirectory,
  [ValidateSet('Development', 'Release')][string]$Mode = 'Development',
  [string]$PublicKey,
  [string]$Policy,
  [string]$Version = '1.0.0'
)
$ErrorActionPreference = 'Stop'
$project = Join-Path $PSScriptRoot 'Velmren.Delivery.csproj'
$outputPath = [IO.Path]::GetFullPath($OutputDirectory)
$buildStage = Join-Path $outputPath ('build-' + [Guid]::NewGuid().ToString('N'))
$repoPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..')).TrimEnd('\') + '\'
$properties = @("-p:DeliveryMode=$Mode", "-p:Version=$Version", "-p:BaseIntermediateOutputPath=$buildStage/obj/", "-p:BaseOutputPath=$buildStage/bin/")
if ($Mode -eq 'Release') {
  if ($TrustDirectory -or !$PublicKey -or !$Policy) {
    throw 'Release requires explicit -PublicKey and -Policy; -TrustDirectory is development-only. Release keys are never generated.'
  }
  $publicKeyPath = (Resolve-Path -LiteralPath $PublicKey -ErrorAction Stop).Path
  $policyPath = (Resolve-Path -LiteralPath $Policy -ErrorAction Stop).Path
  $pem = [IO.File]::ReadAllText($publicKeyPath)
  if ($pem.Contains('PRIVATE KEY') -or !$pem.Contains('-----BEGIN PUBLIC KEY-----')) {
    throw 'Release public-key input must contain only an RSA public key, never a private key.'
  }
  $rsa = [Security.Cryptography.RSA]::Create()
  try {
    $rsa.ImportFromPem($pem)
    if ($rsa.KeySize -lt 3072) { throw 'Release signing requires an RSA key of at least 3072 bits.' }
  } finally { $rsa.Dispose() }
  $properties += "-p:DeliveryPolicyFile=$policyPath"
} else {
  if (!$TrustDirectory -or $PublicKey -or $Policy) {
    throw 'Development requires -TrustDirectory; -PublicKey and -Policy are release-only.'
  }
  $trustPath = [IO.Path]::GetFullPath($TrustDirectory)
  if ($trustPath.StartsWith($repoPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Development signing keys must be outside the source repository.'
  }
  $privateKey = Join-Path $trustPath 'private.pem'
  $publicKeyPath = Join-Path $trustPath 'public.pem'
  if (!(Test-Path -LiteralPath $privateKey) -and !(Test-Path -LiteralPath $publicKeyPath)) {
    & dotnet run --project $project -c Release '-p:DeliveryMode=Development' -- keygen --directory $trustPath
    if ($LASTEXITCODE -ne 0) { throw 'Development key generation failed.' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    & icacls $privateKey /inheritance:r /grant:r "${identity}:(F)" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not restrict the private-key ACL.' }
  }
  if (!(Test-Path -LiteralPath $privateKey) -or !(Test-Path -LiteralPath $publicKeyPath)) {
    throw 'Both existing private.pem and public.pem are required; existing keys are never replaced.'
  }
}
& dotnet publish $project -c Release -r win-x64 --self-contained true '-p:PublishSingleFile=true' '-p:IncludeNativeLibrariesForSelfExtract=true' "-p:PinnedPublicKey=$publicKeyPath" @properties -o $outputPath --nologo
if ($LASTEXITCODE -ne 0) { throw 'Installer publish failed.' }
$enginePath = Join-Path $outputPath 'VelmrenDelivery.exe'
$bundledAssembly = Join-Path $buildStage 'bundled-VelmrenDelivery.dll'
& (Join-Path $PSScriptRoot 'Export-BundleAssembly.ps1') -Bundle $enginePath -AssemblyName 'VelmrenDelivery.dll' -Destination $bundledAssembly
$compiledAssembly = Join-Path $buildStage 'bin/Release/net10.0/win-x64/VelmrenDelivery.dll'
if ((Get-FileHash -LiteralPath $compiledAssembly -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $bundledAssembly -Algorithm SHA256).Hash) {
  throw 'Bundled engine differs from this build output; this output must not be distributed.'
}
$inspection = & (Join-Path $PSScriptRoot 'tests/Inspect-RegistryImports.ps1') -Assembly $bundledAssembly | ConvertFrom-Json
$inspection | Add-Member -NotePropertyName engineSha256 -NotePropertyValue (Get-FileHash -LiteralPath $enginePath -Algorithm SHA256).Hash.ToLowerInvariant()
$inspection | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $outputPath 'registry-inspection.json') -Encoding utf8NoBOM
& (Join-Path $outputPath 'VelmrenDelivery.exe') policy | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Embedded delivery policy validation failed; this output must not be distributed.' }
[pscustomobject]@{
  Installer = Join-Path $outputPath 'VelmrenDelivery.exe'
  Mode = $Mode
  PublicKeySha256 = (Get-FileHash -LiteralPath $publicKeyPath -Algorithm SHA256).Hash
  Trust = "$Mode RSA-PSS manifest signing only; no Authenticode signature or Windows trust changes."
} | ConvertTo-Json
