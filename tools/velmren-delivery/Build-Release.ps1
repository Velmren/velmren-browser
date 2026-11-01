[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Installer,
  [Parameter(Mandatory)][string]$PayloadDirectory,
  [Parameter(Mandatory)][string]$Version,
  [Parameter(Mandatory)][string]$FeedDirectory,
  [Parameter(Mandatory)][string]$PrivateKey,
  [string]$PackageUrl,
  [string]$SevenZipExecutable = (Join-Path $PSScriptRoot '../../../third_party/lzma_sdk/bin/host_platform/7za.exe'),
  [switch]$NoCompactArchive
)
$ErrorActionPreference = 'Stop'
$privateKeyPath = (Resolve-Path -LiteralPath $PrivateKey -ErrorAction Stop).Path
$repoPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..')).TrimEnd('\') + '\'
if ($privateKeyPath.StartsWith($repoPath, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Signing private keys must be outside the source repository.'
}
$arguments = @('package', '--payload', $PayloadDirectory, '--version', $Version, '--feed-directory', $FeedDirectory, '--private-key', $privateKeyPath)
if ($PackageUrl) { $arguments += @('--package-url', $PackageUrl) }
if (!$NoCompactArchive) {
  $compressor = (Resolve-Path -LiteralPath $SevenZipExecutable -ErrorAction Stop).Path
  $payload = (Resolve-Path -LiteralPath $PayloadDirectory -ErrorAction Stop).Path
  $feed = [IO.Path]::GetFullPath($FeedDirectory)
  if ($Version -notmatch '^\d+\.\d+\.\d+\.\d+$') { throw 'Expected a four-part numeric release version.' }
  $compact = Join-Path $feed "velmren-$Version.7z"
  if ((Test-Path -LiteralPath $compact) -or (Test-Path -LiteralPath (Join-Path $feed "velmren-$Version.zip")) -or (Test-Path -LiteralPath (Join-Path $feed "manifest-$Version.json"))) {
    throw 'Release artifacts already exist; choose a new version or output directory.'
  }
  New-Item -ItemType Directory -Path $feed -Force | Out-Null
  $list = Join-Path $feed ".compact-input-$Version.txt"
  $items = @(Get-ChildItem -LiteralPath $payload -Recurse -Force)
  if (@($items | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw 'Reparse payload entries are forbidden.' }
  $names = @($items | Where-Object { !$_.PSIsContainer } | ForEach-Object { [IO.Path]::GetRelativePath($payload, $_.FullName).Replace('\', '/') } | Sort-Object)
  if (!$names.Count -or @($names | Where-Object { $_ -match '[\r\n]' }).Count) { throw 'Compact archive requires regular payload filenames.' }
  [IO.File]::WriteAllLines($list, $names, [Text.UTF8Encoding]::new($false))
  Push-Location -LiteralPath $payload
  try {
    & $compressor a -t7z -m0=LZMA2 -mx=9 -md=64m -mmt=4 -ms=on -spf2 -scsUTF-8 -bso0 -bsp0 $compact "@$list"
    if ($LASTEXITCODE -ne 0) { throw 'Compact release compression failed.' }
  } finally { Pop-Location }
  $arguments += @('--compact-archive', $compact)
  if ($PackageUrl) {
    $uri = [Uri]$PackageUrl
    if (!$uri.IsAbsoluteUri -or !$uri.AbsolutePath.EndsWith("/velmren-$Version.zip", [StringComparison]::Ordinal) -or $uri.Query -or $uri.Fragment) {
      throw 'PackageUrl must end with the immutable release ZIP filename.'
    }
    $arguments += @('--compact-package-url', ($PackageUrl.Substring(0, $PackageUrl.Length - 4) + '.7z'))
  }
}
# The Release engine is a WinExe; a pipeline makes PowerShell await its exit.
& $Installer @arguments | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'Release packaging failed.' }
