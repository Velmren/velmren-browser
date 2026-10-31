[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Bundle,
  [Parameter(Mandatory)][string]$AssemblyName,
  [Parameter(Mandatory)][string]$Destination
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (Test-Path -LiteralPath $Destination) { throw 'Bundle inspection output must be new.' }
$sdk = (& dotnet --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not identify the build SDK.' }
$sdkRoot = Join-Path (Split-Path (Get-Command dotnet).Source) "sdk/$sdk"
[void][Reflection.Assembly]::LoadFrom((Join-Path $sdkRoot 'Microsoft.NET.HostModel.dll'))
$path = (Resolve-Path -LiteralPath $Bundle).Path
[long]$header = 0
if (![Microsoft.NET.HostModel.Bundle.Bundler]::IsBundle($path, [ref]$header)) { throw 'Expected a .NET single-file bundle.' }
$stream = [IO.File]::OpenRead($path)
$reader = [IO.BinaryReader]::new($stream)
try {
  if ($header -le 0 -or $header -ge $stream.Length) { throw 'Invalid bundle header location.' }
  $stream.Position = $header
  # Format: dotnet/runtime src/installer/managed/Microsoft.NET.HostModel/Bundle/{Manifest,FileEntry}.cs.
  $major = $reader.ReadUInt32()
  $minor = $reader.ReadUInt32()
  if ($major -ne 6 -or $minor -ne 0) { throw "Unsupported bundle format $major.$minor; review the inspection gate for this SDK." }
  $count = $reader.ReadInt32()
  if ($count -lt 1 -or $count -gt 10000) { throw 'Invalid bundle entry count.' }
  $null = $reader.ReadString()
  $stream.Position += 40 # deps/runtimeconfig locations and flags in format 6.
  $selected = $null
  for ($i = 0; $i -lt $count; $i++) {
    $offset = $reader.ReadInt64()
    $size = $reader.ReadInt64()
    $compressedSize = $reader.ReadInt64()
    $type = $reader.ReadByte()
    $name = $reader.ReadString()
    if ($name -ceq $AssemblyName) {
      if ($selected -or $type -ne 1 -or $offset -lt 0 -or $size -le 0 -or $size -gt [int]::MaxValue -or $compressedSize -lt 0) { throw 'Invalid bundled assembly entry.' }
      $storedSize = if ($compressedSize) { $compressedSize } else { $size }
      if ($storedSize -gt [int]::MaxValue -or $offset -gt $header - $storedSize) { throw 'Bundled assembly extends beyond its data section.' }
      $selected = @{ Offset = $offset; Size = $size; StoredSize = $storedSize; Compressed = $compressedSize -gt 0 }
    }
  }
  if (!$selected) { throw "Assembly $AssemblyName is absent from bundle." }
  $stream.Position = $selected.Offset
  $bytes = $reader.ReadBytes([int]$selected.StoredSize)
  if ($bytes.Length -ne $selected.StoredSize) { throw 'Truncated bundled assembly.' }
  $output = [IO.File]::Open([IO.Path]::GetFullPath($Destination), [IO.FileMode]::CreateNew)
  try {
    if ($selected.Compressed) {
      $input = [IO.MemoryStream]::new($bytes, $false)
      $deflate = [IO.Compression.DeflateStream]::new($input, [IO.Compression.CompressionMode]::Decompress)
      try { $deflate.CopyTo($output) } finally { $deflate.Dispose(); $input.Dispose() }
    } else { $output.Write($bytes) }
    if ($output.Length -ne $selected.Size) { throw 'Bundled assembly length differs from its header.' }
  } finally { $output.Dispose() }
} finally { $reader.Dispose(); $stream.Dispose() }
