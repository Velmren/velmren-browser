[CmdletBinding()]
param([Parameter(Mandatory)][string]$WorkDirectory)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$work = [IO.Path]::GetFullPath($WorkDirectory)
if (Test-Path -LiteralPath $work) { throw 'Choose a new test directory; existing evidence is retained.' }
New-Item -ItemType Directory -Path $work | Out-Null
$project = Join-Path $PSScriptRoot 'Velmren.Delivery.csproj'
$checks = [Collections.Generic.List[string]]::new()
function Assert([bool]$Value, [string]$Message) { if (!$Value) { throw $Message } }
function Invoke-Check([string]$Name, [string]$Exe, [string[]]$Arguments, [bool]$Success = $true) {
  $output = & $Exe @Arguments 2>&1 | Out-String
  Assert (($LASTEXITCODE -eq 0) -eq $Success) "Check $Name returned $LASTEXITCODE : $output"
  $output | Set-Content -LiteralPath (Join-Path $work "$Name.log") -Encoding utf8NoBOM
  $checks.Add($Name)
  return $output
}
$trust = Join-Path $work 'isolated-test-trust'
New-Item -ItemType Directory -Path $trust | Out-Null
$rsa = [Security.Cryptography.RSA]::Create(3072)
try {
  $privateKey = Join-Path $trust 'private.pem'
  $publicKey = Join-Path $trust 'public.pem'
  [IO.File]::WriteAllText($privateKey, $rsa.ExportPkcs8PrivateKeyPem())
  [IO.File]::WriteAllText($publicKey, $rsa.ExportSubjectPublicKeyInfoPem())
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  & icacls $privateKey /inheritance:r /grant:r "${identity}:(F)" | Out-Null
  Assert ($LASTEXITCODE -eq 0) 'Test private key ACL failed.'
  $policy = Join-Path $PSScriptRoot 'ReleasePolicy.example.json'
  $output = Join-Path $work 'release-installer'
  Invoke-Check 'release-requires-inputs' 'dotnet' @('build', $project, '-c', 'Release', '-p:DeliveryMode=Release', '--nologo') $false | Out-Null
  Invoke-Check 'release-requires-policy' 'dotnet' @('build', $project, '-c', 'Release', '-p:DeliveryMode=Release', "-p:PinnedPublicKey=$publicKey", '--nologo') $false | Out-Null
  Invoke-Check 'release-requires-public-key' 'dotnet' @('build', $project, '-c', 'Release', '-p:DeliveryMode=Release', "-p:DeliveryPolicyFile=$policy", '--nologo') $false | Out-Null
  Invoke-Check 'release-refuses-private-key-resource' 'dotnet' @('build', $project, '-c', 'Release', '-p:DeliveryMode=Release', "-p:PinnedPublicKey=$privateKey", "-p:DeliveryPolicyFile=$policy", '--nologo') $false | Out-Null
  Invoke-Check 'release-build-script-never-generates-keys' 'pwsh' @('-NoProfile', '-File', (Join-Path $PSScriptRoot 'Build-Installer.ps1'), '-Mode', 'Release', '-TrustDirectory', (Join-Path $work 'forbidden-build-keys'), '-OutputDirectory', (Join-Path $work 'forbidden-output')) $false | Out-Null
  Assert (!(Test-Path (Join-Path $work 'forbidden-build-keys'))) 'Release build script generated keys.'
  Invoke-Check 'release-rejects-development-policy' 'pwsh' @('-NoProfile', '-File', (Join-Path $PSScriptRoot 'Build-Installer.ps1'), '-Mode', 'Release', '-PublicKey', $publicKey, '-Policy', (Join-Path $PSScriptRoot 'DevelopmentPolicy.json'), '-OutputDirectory', (Join-Path $work 'invalid-policy-installer')) $false | Out-Null
  Invoke-Check 'release-publish' 'pwsh' @('-NoProfile', '-File', (Join-Path $PSScriptRoot 'Build-Installer.ps1'), '-Mode', 'Release', '-PublicKey', $publicKey, '-Policy', $policy, '-OutputDirectory', $output) | Out-Null
  $installer = Join-Path $output 'VelmrenDelivery.exe'
  $embedded = Invoke-Check 'embedded-policy' $installer @('policy') | ConvertFrom-Json
  Assert ($embedded.mode -eq 'Release' -and $embedded.schema -eq 2 -and $embedded.product -eq 'velmren' -and $embedded.channel -eq 'preview' -and $embedded.platform -eq 'win-x64') 'Release policy identity differs.'
  Invoke-Check 'release-keygen-disabled' $installer @('keygen', '--directory', (Join-Path $work 'forbidden-keys'), '--mode', 'Development') $false | Out-Null
  Assert (!(Test-Path (Join-Path $work 'forbidden-keys'))) 'Release keygen created keys.'
  Invoke-Check 'runtime-switches-cannot-allow-http' $installer @('install', '--root', (Join-Path $work 'forbidden-install'), '--feed', 'http://127.0.0.1:1234/', '--mode', 'Development', '--allow-http', 'true', '--policy', (Join-Path $PSScriptRoot 'DevelopmentPolicy.json')) $false | Out-Null
  Assert (!(Test-Path (Join-Path $work 'forbidden-install'))) 'Rejected feed created installation.'
  Invoke-Check 'runtime-feed-must-match' $installer @('install', '--root', (Join-Path $work 'forbidden-other-feed'), '--feed', 'https://cdn.example.invalid/other/') $false | Out-Null
  $payload = Join-Path $work 'payload'
  $feed = Join-Path $work 'feed'
  New-Item -ItemType Directory -Path $payload, $feed | Out-Null
  'non-executed synthetic payload' | Set-Content -LiteralPath (Join-Path $payload 'synthetic.exe') -Encoding utf8NoBOM
  @{ browser = 'synthetic.exe' } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $payload 'delivery-app.json') -Encoding utf8NoBOM
  $packageUri = 'https://cdn.example.invalid/releases/1.2.3.4.zip?signature=must-not-appear-in-logs'
  Invoke-Check 'schema2-package' 'pwsh' @('-NoProfile', '-File', (Join-Path $PSScriptRoot 'Build-Release.ps1'), '-Installer', $installer, '-PayloadDirectory', $payload, '-Version', '1.2.3.4', '-FeedDirectory', $feed, '-PrivateKey', $privateKey, '-PackageUrl', $packageUri) | Out-Null
  $envelope = Get-Content -Raw -LiteralPath (Join-Path $feed 'latest.json') | ConvertFrom-Json
  $bytes = [Convert]::FromBase64String($envelope.payload)
  Assert ($rsa.VerifyData($bytes, [Convert]::FromBase64String($envelope.signature), [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pss)) 'Signature does not verify.'
  $manifest = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
  Assert ($manifest.schema -eq 2 -and $manifest.product -eq 'velmren' -and $manifest.channel -eq 'preview' -and $manifest.platform -eq 'win-x64' -and $manifest.packageUrl -ceq $packageUri) 'Signed manifest identity/package URL differs.'
  $checks.Add('schema2-signature-and-package-url')
  $installed = Join-Path $work 'synthetic-installed'
  $version = Join-Path $installed 'versions/1.2.3.4'
  New-Item -ItemType Directory -Path $version | Out-Null
  Copy-Item -LiteralPath $payload -Destination (Join-Path $version 'app') -Recurse
  @{ version = '1.2.3.4' } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $installed 'current.json') -Encoding utf8NoBOM
  @{ schema = 1; feed = $embedded.feedUri; pollSeconds = 120 } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $installed 'installation.json') -Encoding utf8NoBOM
  Copy-Item -LiteralPath (Join-Path $feed 'latest.json') -Destination (Join-Path $version 'manifest.json')
  Invoke-Check 'valid-signed-release-resolves' $installer @('resolve', '--root', $installed) | Out-Null
  foreach ($mutation in @(
    @{ Name='schema1-rejected'; Field='schema'; Value=1 },
    @{ Name='development-product-rejected'; Field='product'; Value='velmren-local-development' },
    @{ Name='wrong-channel-rejected'; Field='channel'; Value='stable' },
    @{ Name='wrong-platform-rejected'; Field='platform'; Value='linux-x64' },
    @{ Name='http-package-rejected'; Field='packageUrl'; Value='http://cdn.example.invalid/file.zip' },
    @{ Name='unlisted-package-host-rejected'; Field='packageUrl'; Value='https://other.example.invalid/file.zip' }
  )) {
    $changed = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
    $changed.($mutation.Field) = $mutation.Value
    $signed = [Text.Encoding]::UTF8.GetBytes(($changed | ConvertTo-Json -Depth 10))
    @{ payload=[Convert]::ToBase64String($signed); signature=[Convert]::ToBase64String($rsa.SignData($signed, [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pss)) } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $version 'manifest.json') -Encoding utf8NoBOM
    Invoke-Check $mutation.Name $installer @('resolve', '--root', $installed) $false | Out-Null
  }
  $tampered = [Text.Encoding]::UTF8.GetString($bytes).Replace('preview', 'stable')
  @{ payload=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($tampered)); signature=$envelope.signature } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $version 'manifest.json') -Encoding utf8NoBOM
  Invoke-Check 'signature-tamper-rejected' $installer @('resolve', '--root', $installed) $false | Out-Null
  $wrong = [Security.Cryptography.RSA]::Create(3072)
  try { [IO.File]::WriteAllText((Join-Path $trust 'wrong-private.pem'), $wrong.ExportPkcs8PrivateKeyPem()) } finally { $wrong.Dispose() }
  Invoke-Check 'wrong-signing-key-rejected' $installer @('package', '--payload', $payload, '--version', '1.2.3.5', '--feed-directory', $feed, '--private-key', (Join-Path $trust 'wrong-private.pem')) $false | Out-Null
  Assert (!(Test-Path (Join-Path $feed 'velmren-1.2.3.5.zip'))) 'Wrong key published a ZIP.'
  $logMatches = Get-ChildItem -LiteralPath $work -Filter '*.log' | Select-String -SimpleMatch 'must-not-appear-in-logs'
  Assert (!$logMatches) 'Signed URL query appeared in logs.'
  $checks.Add('signed-query-not-logged')
  @{ passed=$checks.Count; checks=$checks; installer=$installer; privateKey=$privateKey } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $work 'result.json') -Encoding utf8NoBOM
  Get-Content -LiteralPath (Join-Path $work 'result.json')
} finally { $rsa.Dispose() }
