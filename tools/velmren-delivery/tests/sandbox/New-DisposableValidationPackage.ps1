#requires -Version 7.4
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$OutputDirectory,
  [string]$Dotnet = 'dotnet',
  [string]$PowerShellHome = $PSHOME,
  [switch]$SkipArchive
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
Set-StrictMode -Version Latest
if (!$IsWindows -or ![Environment]::Is64BitProcess) { throw 'Build this Windows x64 package from 64-bit PowerShell 7.4 or later.' }
$delivery = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$repository = [IO.Path]::GetFullPath((Join-Path $delivery '../..')).TrimEnd('\', '/')
$output = [IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\', '/')
if ($output -eq $repository -or $output.StartsWith($repository + '\', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Use a fresh output directory outside the repository; it will contain disposable test-only signing material.'
}
if (Test-Path -LiteralPath $output) { throw 'OutputDirectory must not already exist. Existing artifacts are never replaced.' }
$runtime = (Resolve-Path -LiteralPath $PowerShellHome).Path
foreach ($required in 'pwsh.exe','System.Management.Automation.dll','Microsoft.PowerShell.ConsoleHost.dll') {
  if (!(Test-Path -LiteralPath (Join-Path $runtime $required) -PathType Leaf)) { throw "PowerShell runtime is incomplete: $required" }
}
$dotnetPath = (Get-Command $Dotnet -CommandType Application).Source
New-Item -ItemType Directory -Path $output | Out-Null
$package = Join-Path $output 'package'
$build = Join-Path $output 'build'
$source = Join-Path $package 'source'
$scripts = Join-Path $package 'scripts'
$trust = Join-Path $package 'trust'
New-Item -ItemType Directory -Path $package,$build,$source,$scripts,$trust,(Join-Path $source 'tests/sandbox'),(Join-Path $package 'audit'),(Join-Path $output 'results') | Out-Null
Copy-Item -LiteralPath (Join-Path $repository 'app/theme/brave/win/brave.ico') -Destination (Join-Path $source 'app.ico')
$sourceFiles = @((Get-ChildItem -LiteralPath $delivery -Filter '*.cs' -File).Name) + @(
  'Velmren.Delivery.csproj','DevelopmentPolicy.json','Test-InstallLifecycle.ps1','Export-BundleAssembly.ps1','Build-Installer.ps1',
  'tests/LauncherTests.cs','tests/Velmren.Delivery.LauncherTests.csproj','tests/Inspect-RegistryImports.ps1'
) + @(Get-ChildItem -LiteralPath $PSScriptRoot -File | ForEach-Object { 'tests/sandbox/' + $_.Name })
foreach ($relative in $sourceFiles) { Copy-Item -LiteralPath (Join-Path $delivery $relative) -Destination (Join-Path $source $relative) }
Copy-Item -LiteralPath (Join-Path $source 'Test-InstallLifecycle.ps1'),(Join-Path $source 'tests/Inspect-RegistryImports.ps1'),
  (Join-Path $PSScriptRoot 'Inspect-ValidationPackage.ps1'),(Join-Path $PSScriptRoot 'Run-GuestValidation.ps1') -Destination $scripts
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'README.md') -Destination (Join-Path $package 'README.md')
$sourceInventory = @(foreach ($file in Get-ChildItem -LiteralPath $source -File -Recurse | Sort-Object FullName) {
  [ordered]@{path=[IO.Path]::GetRelativePath($source,$file.FullName).Replace('\','/');sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
})
$sourceInventory | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $package 'source-manifest.json') -Encoding utf8NoBOM
$rsa = [Security.Cryptography.RSA]::Create(3072)
try {
  [IO.File]::WriteAllText((Join-Path $trust 'TEST-ONLY-private.pem'),$rsa.ExportPkcs8PrivateKeyPem())
  [IO.File]::WriteAllText((Join-Path $trust 'TEST-ONLY-public.pem'),$rsa.ExportSubjectPublicKeyInfoPem())
} finally { $rsa.Dispose() }
$different = [Security.Cryptography.RSA]::Create(3072)
try { [IO.File]::WriteAllText((Join-Path $trust 'INCOMPATIBLE-TEST-ONLY-public.pem'),$different.ExportSubjectPublicKeyInfoPem()) }
finally { $different.Dispose() }
'Fresh disposable fixture keys; no release key input exists. Never use these keys or executables for a release.' |
  Set-Content -LiteralPath (Join-Path $trust 'README.txt') -Encoding utf8NoBOM
$payloads = [Collections.Generic.List[object]]::new()
function Publish-Fixture([string]$Name, [string]$Project, [string]$AssemblyName, [string]$PublicKey, [string]$Version) {
  $publish = Join-Path $build "publish/$Name"
  $bin = Join-Path $build "bin/$Name/"
  $obj = Join-Path $build "obj/$Name/"
  $arguments = @('publish',$Project,'-c','Release','-r','win-x64','--self-contained','true','--nologo','-o',$publish,
    '-p:PublishSingleFile=true','-p:IncludeNativeLibrariesForSelfExtract=true','-p:EnableCompressionInSingleFile=false',
    '-p:PublishReadyToRun=false','-p:PublishTrimmed=false','-p:DebugType=none','-p:DeliveryMode=Development',
    "-p:PinnedPublicKey=$PublicKey","-p:Version=$Version","-p:ApplicationIcon=$(Join-Path $source 'app.ico')",
    "-p:BaseOutputPath=$bin","-p:BaseIntermediateOutputPath=$obj")
  Write-Host "Publishing $Name from the captured fixed source (no fixture execution)."
  & $dotnetPath @arguments *> (Join-Path $build "$Name.build.log")
  if ($LASTEXITCODE -ne 0) { throw "Publish failed for $Name; see $build/$Name.build.log." }
  $destination = Join-Path $package "engines/$Name"
  New-Item -ItemType Directory -Path $destination | Out-Null
  Copy-Item -LiteralPath (Join-Path $publish "$AssemblyName.exe") -Destination $destination
  $assembly = Join-Path $bin "Release/net10.0/win-x64/$AssemblyName.dll"
  $extracted = Join-Path $package "audit/$Name.dll"
  # Use the same final-bundle gate as Build-Installer, without its policy
  # execution. The guest package must never run a delivery engine on the host.
  & (Join-Path $source 'Export-BundleAssembly.ps1') -Bundle (Join-Path $destination "$AssemblyName.exe") -AssemblyName "$AssemblyName.dll" -Destination $extracted
  if ((Get-FileHash -LiteralPath $assembly -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $extracted -Algorithm SHA256).Hash) {
    throw "Final bundle assembly differs from the fresh $Name build."
  }
  $inspection = & (Join-Path $source 'tests/Inspect-RegistryImports.ps1') -Assembly $extracted | ConvertFrom-Json
  $inspection | Add-Member -NotePropertyName engineSha256 -NotePropertyValue (Get-FileHash -LiteralPath (Join-Path $destination "$AssemblyName.exe") -Algorithm SHA256).Hash.ToLowerInvariant()
  $inspection | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $package "audit/$Name.bundle-audit.json") -Encoding utf8NoBOM
  $payloads.Add([ordered]@{name=$Name;executable="engines/$Name/$AssemblyName.exe";assembly="audit/$Name.dll";bundleAudit="audit/$Name.bundle-audit.json";version=$Version;publicKeySha256=(Get-FileHash -LiteralPath $PublicKey -Algorithm SHA256).Hash.ToLowerInvariant()})
}
$project = Join-Path $source 'Velmren.Delivery.csproj'
$publicKey = Join-Path $trust 'TEST-ONLY-public.pem'
Publish-Fixture 'engine-a' $project 'VelmrenDelivery' $publicKey '0.0.1'
Publish-Fixture 'engine-b' $project 'VelmrenDelivery' $publicKey '0.0.2'
Publish-Fixture 'engine-incompatible' $project 'VelmrenDelivery' (Join-Path $trust 'INCOMPATIBLE-TEST-ONLY-public.pem') '0.0.3'
Publish-Fixture 'launcher-tests' (Join-Path $source 'tests/Velmren.Delivery.LauncherTests.csproj') 'Velmren.Delivery.LauncherTests' $publicKey '0.0.1'
if ((Get-FileHash -LiteralPath (Join-Path $package 'engines/engine-a/VelmrenDelivery.exe')).Hash -eq
    (Get-FileHash -LiteralPath (Join-Path $package 'engines/engine-b/VelmrenDelivery.exe')).Hash) { throw 'Engine A and B must differ.' }
Write-Host 'Copying the installed portable PowerShell runtime.'
$runtimeDestination = Join-Path $package 'runtime'
New-Item -ItemType Directory -Path $runtimeDestination | Out-Null
foreach ($item in Get-ChildItem -LiteralPath $runtime -Force) { Copy-Item -LiteralPath $item.FullName -Destination $runtimeDestination -Recurse }
$files = @(foreach ($file in Get-ChildItem -LiteralPath $package -File -Recurse -Force | Sort-Object FullName) {
  [ordered]@{path=[IO.Path]::GetRelativePath($package,$file.FullName).Replace('\','/');bytes=$file.Length;sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
})
$manifest = [ordered]@{
  schema=1;purpose='disposable-windows-development-validation';packageId=[Guid]::NewGuid().ToString('N')
  createdUtc=[DateTime]::UtcNow.ToString('o');buildMachine=$env:COMPUTERNAME
  mode='Development';runtime='win-x64';dotnetSdk=(& $dotnetPath --version | Out-String).Trim()
  powershellVersion=(Get-Item -LiteralPath (Join-Path $runtime 'pwsh.exe')).VersionInfo.ProductVersion;payloads=$payloads;files=$files
  trust='Fresh RSA-3072 test-only key; incompatible engine pins a different fresh public key. No release trust or certificate-store changes.'
}
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $package 'package-manifest.json') -Encoding utf8NoBOM
& (Join-Path $scripts 'Inspect-ValidationPackage.ps1') -PackageDirectory $package -OutputFile (Join-Path $output 'host-static-audit.json') | Out-Null
$hostPackage = [Security.SecurityElement]::Escape($package)
$hostResults = [Security.SecurityElement]::Escape((Join-Path $output 'results'))
$command = '&quot;C:\VelmrenValidationPackage\runtime\pwsh.exe&quot; -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File &quot;C:\VelmrenValidationPackage\scripts\Run-GuestValidation.ps1&quot; -EnvironmentKind Sandbox -ResultDirectory &quot;C:\VelmrenValidationResults&quot; -DisposableWindowsConfirmed -AllowLiveRegistryTests'
@"
<Configuration>
  <Networking>Disable</Networking>
  <vGPU>Disable</vGPU>
  <ClipboardRedirection>Disable</ClipboardRedirection>
  <MemoryInMB>4096</MemoryInMB>
  <MappedFolders>
    <MappedFolder><HostFolder>$hostPackage</HostFolder><SandboxFolder>C:\VelmrenValidationPackage</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>$hostResults</HostFolder><SandboxFolder>C:\VelmrenValidationResults</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
  </MappedFolders>
  <LogonCommand><Command>$command</Command></LogonCommand>
</Configuration>
"@ | Set-Content -LiteralPath (Join-Path $output 'Run-In-WindowsSandbox.wsb') -Encoding utf8NoBOM
if (!$SkipArchive) {
  Write-Host 'Writing the offline guest package archive.'
  [IO.Compression.ZipFile]::CreateFromDirectory($package,(Join-Path $output 'velmren-disposable-windows-validation.zip'),[IO.Compression.CompressionLevel]::Optimal,$false)
}
$result = [ordered]@{
  package=$package;manifestSha256=(Get-FileHash -LiteralPath (Join-Path $package 'package-manifest.json')).Hash.ToLowerInvariant()
  staticAudit=(Join-Path $output 'host-static-audit.json');sandboxConfiguration=(Join-Path $output 'Run-In-WindowsSandbox.wsb')
  archive=$(if (!$SkipArchive) { Join-Path $output 'velmren-disposable-windows-validation.zip' } else { $null })
  execution='No delivery executable or live registry test was executed. Guest execution remains required.'
}
if (!$SkipArchive) { $result['archiveSha256'] = (Get-FileHash -LiteralPath $result.archive -Algorithm SHA256).Hash.ToLowerInvariant() }
$result | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'build-result.json') -Encoding utf8NoBOM
$result | ConvertTo-Json
