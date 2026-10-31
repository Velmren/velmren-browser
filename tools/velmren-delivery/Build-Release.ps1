[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Installer,
  [Parameter(Mandatory)][string]$PayloadDirectory,
  [Parameter(Mandatory)][string]$Version,
  [Parameter(Mandatory)][string]$FeedDirectory,
  [Parameter(Mandatory)][string]$PrivateKey,
  [string]$PackageUrl
)
$ErrorActionPreference = 'Stop'
$privateKeyPath = (Resolve-Path -LiteralPath $PrivateKey -ErrorAction Stop).Path
$repoPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..')).TrimEnd('\') + '\'
if ($privateKeyPath.StartsWith($repoPath, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Signing private keys must be outside the source repository.'
}
$arguments = @('package', '--payload', $PayloadDirectory, '--version', $Version, '--feed-directory', $FeedDirectory, '--private-key', $privateKeyPath)
if ($PackageUrl) { $arguments += @('--package-url', $PackageUrl) }
# The Release engine is a WinExe; a pipeline makes PowerShell await its exit.
& $Installer @arguments | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'Release packaging failed.' }
