#requires -Version 7.0
<#
.SYNOPSIS
Fetches the pinned official Windows x64 release optimization profiles.
.DESCRIPTION
Existing files are verified and never overwritten or removed. Offline mode is
read-only and checks the embedded release manifest without accessing the network.
The compressed Chromium source is retained as .verified-source.gz.
.EXAMPLE
./Fetch-ReleaseProfiles.ps1 -Offline
.EXAMPLE
./Fetch-ReleaseProfiles.ps1 -BuildRoot D:/work/velmren -ValidateOnly
#>
[CmdletBinding()]
param(
  [string]$BuildRoot = (Join-Path $PSScriptRoot '../../../..'),
  [switch]$Offline,
  [switch]$ValidateOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$src = Join-Path ([IO.Path]::GetFullPath($BuildRoot)) 'src'
$readOnly = $Offline -or $ValidateOnly
$pgoName = 'chrome-win64-8078-1791914084-9e68df2d71b94d8bf96c8b27a992be93ef2c3a22-76bc3b6e85cd9747dd523096133759445011c770.profdata'
$v8Version = '15.6.75.19'
$v8Revision = '392e44423f46d75904da712fadea4c7d5d97967f'

# Names follow Chromium DEPS and v8/tools/builtins-pgo/download_profiles.py.
# GCS metadata was verified on 2026-10-31. Generations and checksums deliberately
# require an explicit manifest update when the checkout's release pins change.
$profiles = @(
  @{
    bucket = 'chromium-optimization-profiles'
    object = "pgo_profiles/$pgoName"
    relativePath = "chrome/build/pgo_profiles/$pgoName"
    generation = '1791922001212358'
    md5 = 'k7KHR91UQXzeafckT+b6zA=='
    encoding = 'gzip'
    storedSize = 110571347L
    storedSha256 = 'a972219cb6192160bfb1b965d005a609f94779d21b4837f911ecc986cf0a1bab'
    size = 511863160L
    sha256 = 'b7715c93d37bb24d7242d456033fea17b69b5ee47d89dca8ec2cbbf712626a42'
  }
)
$v8Files = @(
  @('meta.json', '1792147008783532', 'Jw1i0fVULmhmvbgpANsXOQ==', 206L,
    '4486bbaa51052a8d37101b2b1babf53e1804db99d4e980197f4d2ec2abe0019f'),
  @('x64.profile', '1792147004623567', 'BmGMM8Sv0+m5ScPkBnVErQ==', 5258348L,
    'fdd0847daf5d443a2f6f42884e344bd9c11a0a8e14c342e4d405a021a5dfca89'),
  @('x64-rl.profile', '1792147007541360', 'ktf2oNNMXRh6GKlpT2cLIg==', 5393565L,
    '89f825521e39ddc3e064f9c42f030711bec6ac05f08f008baef9f995476b00a9'),
  @('x86.profile', '1792147003208328', 'WRYCpLwRmhcgj16xqiAJow==', 4791172L,
    'e390d6a4ef2930b144e46cc0b89211fbdf57fac2f099a5510a1fc59f9209bb56'),
  @('x86-rl.profile', '1792147006116568', 'o87e+fLWcudVE6ywXwx8RQ==', 4917418L,
    '60ab711404c36391782ab521dd74972a56b2d7fa95f7068a5e70e0b114d60205')
)
foreach ($file in $v8Files) {
  $profiles += @{
    bucket = 'chromium-v8-builtins-pgo'
    object = "by-version/$v8Version/$($file[0])"
    relativePath = "v8/tools/builtins-pgo/profiles/$($file[0])"
    generation = $file[1]
    md5 = $file[2]
    encoding = ''
    storedSize = $file[3]
    storedSha256 = $file[4]
    size = $file[3]
    sha256 = $file[4]
  }
}

function Assert-File {
  param([string]$Path, [long]$Size, [string]$Sha256, [string]$Md5 = '')
  if (!(Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Expected a regular file: $Path"
  }
  if ((Get-Item -LiteralPath $Path).Length -ne $Size) {
    throw "Conflicting file length; preserved unchanged: $Path"
  }
  if ($Md5) {
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.MD5]::Create()
    try { $actualMd5 = [Convert]::ToBase64String($algorithm.ComputeHash($stream)) }
    finally { $algorithm.Dispose(); $stream.Dispose() }
    if ($actualMd5 -cne $Md5) {
      throw "Conflicting GCS MD5; preserved unchanged: $Path"
    }
  }
  if ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -ine $Sha256) {
    throw "Conflicting SHA-256; preserved unchanged: $Path"
  }
}

function Publish-File {
  param([string]$TemporaryPath, [string]$Path, [long]$Size,
    [string]$Sha256, [string]$Md5 = '')
  Assert-File $TemporaryPath $Size $Sha256 $Md5
  # File.Move without overwrite is atomic on the destination volume. A racing
  # writer can never cause us to replace an existing profile, even identical data.
  try { [IO.File]::Move($TemporaryPath, $Path) }
  catch {
    if (!(Test-Path -LiteralPath $Path)) { throw }
    Assert-File $Path $Size $Sha256 $Md5
    Write-Warning "Identical destination preserved; staged file retained: $TemporaryPath"
  }
}

function Get-ObjectUrl {
  param([hashtable]$Profile)
  'https://storage.googleapis.com/storage/v1/b/{0}/o/{1}?generation={2}' -f `
    $Profile.bucket, [Uri]::EscapeDataString($Profile.object), $Profile.generation
}

function Assert-RemoteMetadata {
  param([Net.Http.HttpClient]$Client, [hashtable]$Profile)
  $url = (Get-ObjectUrl $Profile) + '&fields=bucket,name,generation,size,md5Hash,contentEncoding'
  $json = $Client.GetStringAsync($url).GetAwaiter().GetResult()
  $metadata = $json | ConvertFrom-Json -AsHashtable
  $encoding = if ($metadata.ContainsKey('contentEncoding')) { $metadata.contentEncoding } else { '' }
  if ($metadata.bucket -cne $Profile.bucket -or
      $metadata.name -cne $Profile.object -or
      $metadata.generation -cne $Profile.generation -or
      [long]$metadata.size -ne $Profile.storedSize -or
      $metadata.md5Hash -cne $Profile.md5 -or
      $encoding -cne $Profile.encoding) {
    throw "Official GCS metadata differs from the pinned manifest: $($Profile.object)"
  }
}

function Receive-Object {
  param([Net.Http.HttpClient]$Client, [hashtable]$Profile, [string]$Path)
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path)) | Out-Null
  $temporaryPath = "$Path.partial.$([Guid]::NewGuid().ToString('N'))"
  Write-Host "Fetching pinned object: $($Profile.object)"
  $response = $null
  $output = $null
  try {
    $response = $Client.GetAsync((Get-ObjectUrl $Profile) + '&alt=media',
      [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    $response.EnsureSuccessStatusCode() | Out-Null
    $output = [IO.File]::Open($temporaryPath, [IO.FileMode]::CreateNew,
      [IO.FileAccess]::Write, [IO.FileShare]::None)
    $response.Content.CopyToAsync($output).GetAwaiter().GetResult()
  } catch {
    throw "Download failed; any partial file is retained at ${temporaryPath}: $($_.Exception.Message)"
  } finally {
    if ($null -ne $output) { $output.Dispose() }
    if ($null -ne $response) { $response.Dispose() }
  }
  Publish-File $temporaryPath $Path $Profile.storedSize $Profile.storedSha256 $Profile.md5
}

function Expand-Profile {
  param([hashtable]$Profile, [string]$SourcePath, [string]$Path)
  # GCS hashes describe the stored gzip bytes, not the decompressed profile.
  Assert-File $SourcePath $Profile.storedSize $Profile.storedSha256 $Profile.md5
  $temporaryPath = "$Path.partial.$([Guid]::NewGuid().ToString('N'))"
  $sourceStream = $null
  $gzip = $null
  $output = $null
  try {
    $sourceStream = [IO.File]::OpenRead($SourcePath)
    $gzip = [IO.Compression.GZipStream]::new($sourceStream, [IO.Compression.CompressionMode]::Decompress)
    $output = [IO.File]::Open($temporaryPath, [IO.FileMode]::CreateNew,
      [IO.FileAccess]::Write, [IO.FileShare]::None)
    $gzip.CopyTo($output)
  } catch {
    throw "Decompression failed; any partial file is retained at ${temporaryPath}: $($_.Exception.Message)"
  } finally {
    if ($null -ne $output) { $output.Dispose() }
    if ($null -ne $gzip) { $gzip.Dispose() }
    if ($null -ne $sourceStream) { $sourceStream.Dispose() }
  }
  Publish-File $temporaryPath $Path $Profile.size $Profile.sha256
}

$checkoutPgoName = (Get-Content -LiteralPath (Join-Path $src 'chrome/build/win64.pgo.txt') -Raw).Trim()
if ($checkoutPgoName -cne $pgoName) {
  throw 'Chromium win64.pgo.txt differs from the release manifest; review and update the pins explicitly.'
}
$versionHeader = Get-Content -LiteralPath (Join-Path $src 'v8/include/v8-version.h') -Raw
$versionParts = foreach ($define in @('V8_MAJOR_VERSION', 'V8_MINOR_VERSION', 'V8_BUILD_NUMBER', 'V8_PATCH_LEVEL')) {
  $match = [regex]::Match($versionHeader, "(?m)^#define\s+$define\s+(\d+)\s*$")
  if (!$match.Success) { throw "V8 version header lacks $define" }
  $match.Groups[1].Value
}
if (($versionParts -join '.') -cne $v8Version) {
  throw 'V8 version differs from the release manifest; review and update the pins explicitly.'
}
$deps = Get-Content -LiteralPath (Join-Path $src 'DEPS') -Raw
$revisionMatch = [regex]::Match($deps, "'v8_revision':\s*'([0-9a-f]{40})'")
if (!$revisionMatch.Success -or $revisionMatch.Groups[1].Value -cne $v8Revision) {
  throw 'Chromium DEPS V8 revision differs from the release manifest.'
}

# Preflight all existing files before making network requests or creating files.
foreach ($profile in $profiles) {
  $path = Join-Path $src $profile.relativePath
  $storedPath = if ($profile.encoding -eq 'gzip') { "$path.verified-source.gz" } else { $path }
  if (Test-Path -LiteralPath $storedPath) {
    Assert-File $storedPath $profile.storedSize $profile.storedSha256 $profile.md5
  } elseif ($readOnly) { throw "Required stored profile is missing: $storedPath" }
  if ($profile.encoding -eq 'gzip') {
    if (Test-Path -LiteralPath $path) { Assert-File $path $profile.size $profile.sha256 }
    elseif ($readOnly) { throw "Required decompressed profile is missing: $path" }
  }
}

$client = $null
$handler = $null
try {
  if (!$Offline) {
    $handler = [Net.Http.HttpClientHandler]::new()
    $handler.AutomaticDecompression = [Net.DecompressionMethods]::None
    $client = [Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromMinutes(30)
    # Keep stored bytes intact so their MD5 matches GCS before decompression.
    $client.DefaultRequestHeaders.AcceptEncoding.ParseAdd('gzip')
    foreach ($profile in $profiles) { Assert-RemoteMetadata $client $profile }
    if (!$readOnly) {
      foreach ($profile in $profiles) {
        $path = Join-Path $src $profile.relativePath
        $storedPath = if ($profile.encoding -eq 'gzip') { "$path.verified-source.gz" } else { $path }
        if (!(Test-Path -LiteralPath $storedPath)) { Receive-Object $client $profile $storedPath }
        if ($profile.encoding -eq 'gzip' -and !(Test-Path -LiteralPath $path)) {
          Expand-Profile $profile $storedPath $path
        }
      }
    }
  }
} finally {
  if ($null -ne $client) { $client.Dispose() }
  elseif ($null -ne $handler) { $handler.Dispose() }
}

$v8Metadata = Get-Content -LiteralPath (Join-Path $src 'v8/tools/builtins-pgo/profiles/meta.json') -Raw |
  ConvertFrom-Json -AsHashtable
if ($v8Metadata.version -cne $v8Version -or $v8Metadata.revision -cne $v8Revision -or
    (($v8Metadata.profile | Sort-Object) -join ',') -cne 'x64,x64-rl,x86,x86-rl') {
  throw 'V8 profile metadata does not match the pinned version, revision, and profile set.'
}

[ordered]@{
  status = 'verified'
  mode = if ($Offline) { 'offline' } elseif ($ValidateOnly) { 'validate-only' } else { 'fetch' }
  chromiumProfile = $pgoName
  v8Version = $v8Version
  v8Revision = $v8Revision
  files = @($profiles | ForEach-Object {
    [ordered]@{ path = Join-Path $src $_.relativePath; sha256 = $_.sha256 }
  })
} | ConvertTo-Json -Depth 4
