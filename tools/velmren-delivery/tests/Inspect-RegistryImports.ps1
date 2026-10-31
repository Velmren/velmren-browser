param([Parameter(Mandatory)][string]$Assembly)
$ErrorActionPreference = 'Stop'
$path = (Resolve-Path -LiteralPath $Assembly).Path
$stream = [IO.File]::OpenRead($path)
$pe = [Reflection.PortableExecutable.PEReader]::new($stream)
try {
  $reader = [Reflection.Metadata.PEReaderExtensions]::GetMetadataReader($pe)
  $imports = @(foreach ($handle in $reader.MethodDefinitions) {
    $method = $reader.GetMethodDefinition($handle)
    if (($method.Attributes -band [Reflection.MethodAttributes]::PinvokeImpl) -ne 0) {
      $reader.GetString($method.GetImport().Name)
    }
  })
  $flushTypes = @(foreach ($handle in $reader.MemberReferences) {
    $member = $reader.GetMemberReference($handle)
    if ($reader.GetString($member.Name) -eq 'Flush' -and $member.Parent.Kind -eq [Reflection.Metadata.HandleKind]::TypeReference) {
      $type = $reader.GetTypeReference([Reflection.Metadata.TypeReferenceHandle]$member.Parent)
      $reader.GetString($type.Namespace) + '.' + $reader.GetString($type.Name)
    }
  })
  $result = [ordered]@{
    assembly = $path
    sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    nativeImports = $imports
    registryRenamePresent = [bool]($imports -match 'RegRenameKey|NtRenameKey')
    registryFlushPresent = [bool](($imports -match 'RegFlushKey') -or ($flushTypes -contains 'Microsoft.Win32.RegistryKey'))
    inspection = 'PE metadata only; installer assembly not loaded or executed'
  }
  $result | ConvertTo-Json
  if ($result.registryRenamePresent -or $result.registryFlushPresent) { throw 'Forbidden registry operation found in assembly.' }
} finally { $pe.Dispose(); $stream.Dispose() }
