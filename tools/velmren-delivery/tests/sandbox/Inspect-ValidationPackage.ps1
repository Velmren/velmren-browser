#requires -Version 7.4
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$PackageDirectory,
  [string]$OutputFile
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$package = (Resolve-Path -LiteralPath $PackageDirectory).Path.TrimEnd('\', '/')
$manifest = Get-Content -Raw -LiteralPath (Join-Path $package 'package-manifest.json') | ConvertFrom-Json
if ($manifest.schema -ne 1 -or $manifest.purpose -ne 'disposable-windows-development-validation') {
  throw 'Unknown validation package format.'
}
function PackagePath([string]$Relative) {
  if ([IO.Path]::IsPathRooted($Relative) -or $Relative.Contains(':')) { throw "Invalid package path: $Relative" }
  $path = [IO.Path]::GetFullPath((Join-Path $package $Relative))
  if (!$path.StartsWith($package + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Package path escapes its directory: $Relative"
  }
  return $path
}
$items = @(Get-ChildItem -LiteralPath $package -Recurse -Force)
if (@($items | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) {
  throw 'Validation packages must not contain links or reparse points.'
}
$recorded = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($entry in $manifest.files) {
  if (!$recorded.Add($entry.path)) { throw "Duplicate package inventory path: $($entry.path)" }
  $path = PackagePath $entry.path
  $file = Get-Item -LiteralPath $path
  if ($file.PSIsContainer -or $file.Length -ne $entry.bytes -or
      (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $entry.sha256) {
    throw "Package hash or length mismatch: $($entry.path)"
  }
}
foreach ($file in $items | Where-Object { !$_.PSIsContainer }) {
  $relative = [IO.Path]::GetRelativePath($package, $file.FullName).Replace('\', '/')
  if ($relative -ne 'package-manifest.json' -and !$recorded.Contains($relative)) {
    throw "Unrecorded package file: $relative"
  }
}
if (-not ('VelmrenValidation.EmbeddedAssembly' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.IO;
namespace VelmrenValidation {
  public static class EmbeddedAssembly {
    public static int FindExact(string executable, string assembly) {
      byte[] container = File.ReadAllBytes(executable), target = File.ReadAllBytes(assembly);
      if (target.Length < 512) throw new InvalidDataException("Invalid assembly length.");
      int offset = container.AsSpan().IndexOf(target.AsSpan());
      if (offset < 0) throw new InvalidDataException("Audited assembly is not embedded byte-for-byte in executable.");
      if (container.AsSpan(offset + target.Length).IndexOf(target.AsSpan()) >= 0)
        throw new InvalidDataException("Audited assembly occurs more than once in executable.");
      return offset;
    }
  }
}
'@
}
$expected = @{
  'engine-a'='engines/engine-a/VelmrenDelivery.exe'
  'engine-b'='engines/engine-b/VelmrenDelivery.exe'
  'engine-incompatible'='engines/engine-incompatible/VelmrenDelivery.exe'
  'launcher-tests'='engines/launcher-tests/Velmren.Delivery.LauncherTests.exe'
}
$names = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$audits = @(foreach ($payload in $manifest.payloads) {
  if (!$expected.ContainsKey($payload.name) -or !$names.Add($payload.name) -or
      $payload.executable -cne $expected[$payload.name] -or $payload.assembly -cne "audit/$($payload.name).dll" -or
      $payload.bundleAudit -cne "audit/$($payload.name).bundle-audit.json") {
    throw 'Unexpected, duplicate, or incorrectly mapped executable in package manifest.'
  }
  $exe = PackagePath $payload.executable
  $dll = PackagePath $payload.assembly
  if (!$recorded.Contains($payload.executable) -or !$recorded.Contains($payload.assembly)) {
    throw 'Executable or assembly is absent from the hash inventory.'
  }
  $metadata = & (Join-Path $package 'scripts/Inspect-RegistryImports.ps1') -Assembly $dll | ConvertFrom-Json
  $buildAudit = Get-Content -Raw -LiteralPath (PackagePath $payload.bundleAudit) | ConvertFrom-Json
  $exeSha256 = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
  if (!$recorded.Contains($payload.bundleAudit) -or $buildAudit.engineSha256 -ne $exeSha256 -or
      $buildAudit.sha256 -ne $metadata.sha256 -or $buildAudit.registryRenamePresent -or $buildAudit.registryFlushPresent) {
    throw 'Exact bundle-extraction build audit does not match the executable and assembly.'
  }
  $offset = [VelmrenValidation.EmbeddedAssembly]::FindExact($exe, $dll)
  [ordered]@{
    name = $payload.name
    executable = $payload.executable
    executableSha256 = $exeSha256
    embeddedAssemblyOffset = $offset
    metadata = $metadata
  }
})
if ($audits.Count -ne 4) {
  throw 'Expected exactly three engines and the launcher test executable.'
}
$result = [ordered]@{
  passed = $true
  inspectedUtc = [DateTime]::UtcNow.ToString('o')
  packageManifestSha256 = (Get-FileHash -LiteralPath (Join-Path $package 'package-manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant()
  fileCount = $recorded.Count
  payloads = $audits
  execution = 'None: file hashes, PE metadata, and exact embedded assembly bytes only.'
}
$json = $result | ConvertTo-Json -Depth 12
if ($OutputFile) { $json | Set-Content -LiteralPath $OutputFile -Encoding utf8NoBOM }
$json
