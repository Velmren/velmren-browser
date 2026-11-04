[CmdletBinding()]
param([Parameter(Mandatory)][string]$WorkDirectory)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$work = [IO.Path]::GetFullPath($WorkDirectory)
if (Test-Path -LiteralPath $work) { throw 'Choose a new packaging test directory; existing evidence is retained.' }
New-Item -ItemType Directory -Path $work | Out-Null
$delivery = Split-Path $PSScriptRoot
$checks = [Collections.Generic.List[string]]::new()
function Assert([bool]$Condition, [string]$Name) {
  if (!$Condition) { throw "Packaging check failed: $Name" }
  $checks.Add($Name)
}
function Write-Fixture([string]$Relative, [string]$Contents = 'non-executed packaging fixture') {
  $path = Join-Path $work $Relative
  New-Item -ItemType Directory -Path (Split-Path $path) -Force | Out-Null
  [IO.File]::WriteAllText($path, $Contents)
}
function Assert-Rejected([string]$Name, [scriptblock]$Action) {
  $rejected = $false
  try { & $Action | Out-Null } catch { $rejected = $true }
  Assert $rejected $Name
}
function Hash-Bytes([byte[]]$Bytes) { [Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($Bytes)) }
function Resource-Hashes([string]$Assembly) {
  $stream = [IO.File]::OpenRead($Assembly)
  $pe = [Reflection.PortableExecutable.PEReader]::new($stream)
  try {
    $metadata = [Reflection.Metadata.PEReaderExtensions]::GetMetadataReader($pe)
    $base = $pe.PEHeaders.CorHeader.ResourcesDirectory.RelativeVirtualAddress
    $hashes = @{}
    $configuration = $null
    $engineHash = $null
    foreach ($handle in $metadata.ManifestResources) {
      $resource = $metadata.GetManifestResource($handle)
      if (!$resource.Implementation.IsNil) { throw 'External assembly resource is unexpected.' }
      $reader = $pe.GetSectionData($base + [int]$resource.Offset).GetReader()
      $size = $reader.ReadInt32()
      $name = $metadata.GetString($resource.Name)
      $bytes = $reader.ReadBytes($size)
      $hashes[$name] = Hash-Bytes $bytes
      if ($name -eq 'Setup.Payload.Config') { $configuration = [Text.Encoding]::UTF8.GetString($bytes).TrimStart([char]0xfeff) | ConvertFrom-Json }
      if ($name -eq 'Setup.Payload.Engine') {
        $input = [IO.MemoryStream]::new($bytes, $false)
        $gzip = [IO.Compression.GZipStream]::new($input, [IO.Compression.CompressionMode]::Decompress)
        try { $engineHash = [Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($gzip)) }
        finally { $gzip.Dispose(); $input.Dispose() }
      }
    }
    return @{Hashes=$hashes;Configuration=$configuration;EngineHash=$engineHash}
  } finally { $pe.Dispose(); $stream.Dispose() }
}
foreach ($path in @(
  'browser/velmren.exe', 'browser/156.1.98.0.manifest', 'browser/chrome.dll', 'browser/resources.pak',
  'browser/icudtl.dat', 'browser/v8_context_snapshot.bin', 'browser/vk_swiftshader_icd.json',
  'browser/locales/en-US.pak', 'browser/locales/ru.pak', 'browser/locales/en-US.pak.info', 'browser/resources/resource.pak', 'browser/chrome_proxy.exe',
  'browser/VkLayer_khronos_validation.dll', 'browser/VkICD_mock_icd.dll', 'browser/dbghelp.dll', 'browser/dbgcore.dll', 'browser/msdia140.dll', 'browser/symsrv.dll', 'browser/test_trace_processor.dll',
  'browser/dxcompiler.dll', 'browser/dxil.dll', 'browser/vulkan-1.dll', 'browser/vk_swiftshader.dll',
  'browser/chrome.exe', 'browser/test.exe', 'browser/debug.pdb', 'browser/ignored.obj',
  'agent/broker.mjs', 'agent/package.json', 'agent/README.md', 'agent/Start-VelmrenMcp.ps1', 'agent/public/index.html',
  'agent/node_modules/fixture/index.js', 'agent/node_modules/fixture/LICENSE', 'runtime/node.exe', 'runtime/LICENSE'
)) { Write-Fixture $path }
$browser = Join-Path $work 'browser'
$agent = Join-Path $work 'agent'
$node = Join-Path $work 'runtime/node.exe'
$stage = Join-Path $delivery 'Stage-Payload.ps1'
$stageArguments = @{ BrowserDirectory = $browser; AgentDirectory = $agent; NodeExecutable = $node }
Assert-Rejected 'nested staging destination rejected' { & $stage @stageArguments -Destination (Join-Path $browser 'resources/nested-payload') }
Assert (!(Test-Path -LiteralPath (Join-Path $browser 'resources/nested-payload'))) 'nested rejection leaves sources untouched'
Assert-Rejected 'missing runtime license rejected' { & $stage @stageArguments -NodeLicense (Join-Path $work 'missing-license') -Destination (Join-Path $work 'missing-license-payload') }
Assert (!(Test-Path -LiteralPath (Join-Path $work 'missing-license-payload'))) 'missing license rejected before staging'
Assert-Rejected 'unpaired engine rejected' { & $stage @stageArguments -DeliveryEngine $node -Destination (Join-Path $work 'unpaired-payload') }

$trust = Join-Path $work 'isolated-fixture-trust'
New-Item -ItemType Directory -Path $trust | Out-Null
$rsa = [Security.Cryptography.RSA]::Create(3072)
try {
  $publicKey = Join-Path $trust 'public.pem'
  $privateKey = Join-Path $trust 'private.pem'
  [IO.File]::WriteAllText($publicKey, $rsa.ExportSubjectPublicKeyInfoPem())
  [IO.File]::WriteAllText($privateKey, $rsa.ExportPkcs8PrivateKeyPem())
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  & icacls $privateKey /inheritance:r /grant:r "${identity}:(F)" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Fixture private key ACL failed.' }
  $release = Join-Path $work 'release'
  $version = '9.8.7.6'
  $packageUrl = "https://updates.example.invalid/releases/preview-$version/velmren-$version.zip"
  & (Join-Path $delivery 'Build-ReleaseBundle.ps1') -BrowserDirectory $browser -AgentDirectory $agent -NodeExecutable $node -PublicKey $publicKey -PrivateKey $privateKey -Policy (Join-Path $delivery 'ReleasePolicy.example.json') -Version $version -OutputDirectory $release -PackageUrl $packageUrl *> (Join-Path $work 'build.log')
  Assert (Test-Path -LiteralPath (Join-Path $release 'setup/VelmrenSetup.exe')) 'full Release bundle built'
  $record = Get-Content -LiteralPath (Join-Path $release 'release.json') -Raw | ConvertFrom-Json
  Assert (!$record.published -and !$record.authenticodeSigned) 'publication and Authenticode claims accurate'
  $envelope = Get-Content -LiteralPath (Join-Path $release 'bundle/manifest.json') -Raw | ConvertFrom-Json
  $payloadBytes = [Convert]::FromBase64String($envelope.payload)
  Assert ($rsa.VerifyData($payloadBytes, [Convert]::FromBase64String($envelope.signature), [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pss)) 'manifest RSA-PSS signature verified'
  $manifest = [Text.Encoding]::UTF8.GetString($payloadBytes) | ConvertFrom-Json
  Assert ($manifest.schema -eq 2 -and $manifest.product -eq 'velmren' -and $manifest.channel -eq 'preview' -and $manifest.platform -eq 'win-x64' -and $manifest.version -eq $version) 'signed release identity verified'
  $zipPath = Join-Path $release "bundle/$($manifest.package)"
  Assert ((Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant() -eq $manifest.sha256 -and (Get-Item -LiteralPath $zipPath).Length -eq $manifest.size) 'signed archive hash and size verified'
  Assert ($manifest.compactArchive.format -eq '7z' -and $manifest.compactArchive.package -eq "velmren-$version.7z" -and $manifest.compactArchive.sha256 -eq $record.compactPackageSha256 -and $manifest.compactArchive.size -eq $record.compactPackageBytes) 'signed compact archive descriptor matches generated package'
  Assert ($manifest.packageUrl -eq $packageUrl -and $manifest.compactArchive.packageUrl -eq ($packageUrl.Substring(0, $packageUrl.Length - 4) + '.7z')) 'immutable ZIP and compact URLs are distinct valid argument values'
  $archive = [IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    Assert ($archive.Entries.Count -eq $manifest.files.Count) 'complete archive inventory'
    foreach ($file in $manifest.files) {
      $entry = $archive.GetEntry($file.path)
      if (!$entry -or $entry.Length -ne $file.size) { throw "Inventory mismatch: $($file.path)" }
      $input = $entry.Open()
      try { $hash = [Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($input)) } finally { $input.Dispose() }
      if ($hash -cne $file.sha256) { throw "Archive content mismatch: $($file.path)" }
      if ((Get-FileHash -LiteralPath (Join-Path $release "payload/$($file.path)") -Algorithm SHA256).Hash.ToLowerInvariant() -cne $hash) { throw "Staged content mismatch: $($file.path)" }
    }
    $checks.Add('every signed file matches staged and archived bytes')
  } finally { $archive.Dispose() }
  $paths = @($manifest.files.path)
  Assert ($paths -ccontains 'agent/Start-VelmrenMcp.ps1') 'signed inventory includes managed MCP launcher'
  foreach ($required in 'browser/156.1.98.0.manifest', 'browser/chrome.dll', 'browser/locales/en-US.pak', 'browser/vk_swiftshader_icd.json', 'runtime/node.exe', 'agent/broker.mjs', 'agent/public/index.html', 'agent/node_modules/fixture/index.js', 'agent/node_modules/fixture/LICENSE', 'licenses/Brave-MPL-2.0.txt', 'licenses/Chromium-LICENSE.txt', 'licenses/Node-LICENSE.txt', 'delivery/Velmren.exe', 'delivery/VelmrenMaintenance.exe') {
    Assert ($paths -ccontains $required) "signed inventory includes $required"
  }
  Assert (!($paths -match 'private\.pem|\.pdb$|\.obj$|browser/(chrome|test)\.exe$')) 'build artifacts and private key excluded'
  Assert (!($paths -match '\.pak\.info$|browser/(VkLayer_khronos_validation|VkICD_mock_icd|dbghelp|dbgcore|msdia140|symsrv|test_trace_processor)\.dll$')) 'GRIT metadata and build-only DLLs excluded'
  foreach ($required in 'browser/locales/ru.pak', 'browser/dxcompiler.dll', 'browser/dxil.dll', 'browser/vulkan-1.dll', 'browser/vk_swiftshader.dll', 'licenses/Delivery-THIRD-PARTY-NOTICES.txt') {
    Assert ($paths -ccontains $required) "runtime or license preserved: $required"
  }
  $config = Get-Content -LiteralPath (Join-Path $release 'payload/delivery-app.json') -Raw | ConvertFrom-Json
  Assert ($config.browser -eq 'browser/velmren.exe' -and $config.agent -eq 'runtime/node.exe' -and $config.launcher -eq 'delivery/Velmren.exe' -and $config.setup -eq 'delivery/VelmrenMaintenance.exe') 'signed app paths verified'
  $engineHash = (Get-FileHash -LiteralPath (Join-Path $release 'engine/VelmrenDelivery.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
  Assert ($record.engineSha256 -eq $engineHash -and $record.registryInspection.engineSha256 -eq $engineHash -and !$record.registryInspection.registryRenamePresent -and !$record.registryInspection.registryFlushPresent) 'exact engine passes static registry gate'
  $engineResources = Resource-Hashes $record.registryInspection.assembly
  Assert ($engineResources.Hashes['Velmren.ThirdPartyNotices'] -eq (Get-FileHash -LiteralPath (Join-Path $delivery 'THIRD-PARTY-NOTICES.txt') -Algorithm SHA256).Hash.ToLowerInvariant()) 'standalone engine and its embedded setup copy carry the dependency notice'
  Assert ((Get-FileHash -LiteralPath (Join-Path $release 'payload/delivery/Velmren.exe') -Algorithm SHA256).Hash.ToLowerInvariant() -eq $engineHash) 'signed launcher matches fresh engine'
  foreach ($pair in @(@('maintenance', 'VelmrenMaintenance'), @('setup', 'VelmrenSetup'), @('offline-setup', 'VelmrenSetup'))) {
    $details = Resource-Hashes (Join-Path $release "$($pair[0])/$($pair[1]).exe")
    $resources = $details.Hashes
    Assert ($details.Configuration.EngineSha256 -eq $engineHash -and $details.Configuration.EngineSize -eq (Get-Item -LiteralPath (Join-Path $release 'engine/VelmrenDelivery.exe')).Length) "$($pair[1]) pins exact fresh engine identity"
    Assert ($resources['Setup.Brand.Logo'] -eq (Get-FileHash -LiteralPath (Join-Path $delivery '../../app/theme/velmren/logo-preview.png') -Algorithm SHA256).Hash.ToLowerInvariant() -and $resources['Setup.Brand.Icon'] -eq (Get-FileHash -LiteralPath (Join-Path $delivery '../../app/theme/brave/win/brave.ico') -Algorithm SHA256).Hash.ToLowerInvariant()) "$($pair[0]) embeds the checked-in Velmren branding"
    if ($pair[0] -eq 'setup') {
      Assert ($details.EngineHash -eq $engineHash -and $details.Configuration.EngineSource -eq 'gzip') 'online setup decompresses to the exact fresh engine'
      Assert ($record.setupKind -eq 'online' -and $resources.Count -eq 4 -and !$resources.ContainsKey('Setup.Payload.Package') -and !$resources.ContainsKey('Setup.Payload.Manifest')) 'primary setup embeds engine public configuration and two branding resources without browser payload'
      Assert ((Get-Item -LiteralPath $record.setup).Length -lt (Get-Item -LiteralPath (Join-Path $release 'engine/VelmrenDelivery.exe')).Length) 'online setup compresses its one bootstrap engine'
    }
    if ($pair[0] -eq 'offline-setup') {
      Assert ($resources['Setup.Payload.Manifest'] -eq $record.manifestSha256 -and $resources['Setup.Payload.Package'] -eq $record.packageSha256) 'setup embeds exact signed offline bundle'
      Assert ($resources.Count -eq 5 -and !$resources.ContainsKey('Setup.Payload.Engine') -and $details.Configuration.EngineSource -eq 'package') 'offline setup reuses the packaged engine without a duplicate'
      Assert ((Get-FileHash -LiteralPath $record.offlineSetup -Algorithm SHA256).Hash.ToLowerInvariant() -eq $record.offlineSetupSha256) 'offline setup hash recorded'
    }
    if ($pair[0] -eq 'maintenance') {
      Assert ($resources.Count -eq 3 -and !$resources.ContainsKey('Setup.Payload.Engine') -and $details.Configuration.EngineSource -eq 'installed') 'maintenance reuses the verified installed engine without an embedded runtime'
      Assert ((Get-Item -LiteralPath (Join-Path $release 'maintenance/VelmrenMaintenance.exe')).Length -lt 2MB) 'maintenance remains below two MiB'
    }
  }
  Assert-Rejected 'existing release output retained' { & (Join-Path $delivery 'Build-ReleaseBundle.ps1') -BrowserDirectory $browser -AgentDirectory $agent -NodeExecutable $node -PublicKey $publicKey -PrivateKey $privateKey -Policy (Join-Path $delivery 'ReleasePolicy.example.json') -Version $version -OutputDirectory $release }
  Assert ((Get-FileHash -LiteralPath (Join-Path $release 'setup/VelmrenSetup.exe') -Algorithm SHA256).Hash.ToLowerInvariant() -eq $record.setupSha256) 'existing setup remains unchanged'
  [ordered]@{ passed = $checks.Count; checks = $checks; release = $release; commandsExecuted = @('policy', 'package'); fixtureOnly = $true; installed = $false; registryActions = $false } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $work 'result.json') -Encoding utf8NoBOM
  Write-Output "Passed $($checks.Count) host-safe release packaging checks. Evidence: $(Join-Path $work 'result.json')"
} finally { $rsa.Dispose() }
