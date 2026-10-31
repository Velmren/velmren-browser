#requires -Version 7.4
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ResultDirectory,
  [ValidateSet('Sandbox','VirtualMachine')][string]$EnvironmentKind = 'VirtualMachine',
  [switch]$DisposableWindowsConfirmed,
  [switch]$AllowLiveRegistryTests
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (!$DisposableWindowsConfirmed -or !$AllowLiveRegistryTests) {
  throw 'Run only inside a disposable Windows guest and explicitly pass -DisposableWindowsConfirmed -AllowLiveRegistryTests.'
}
if (!$IsWindows -or ![Environment]::Is64BitOperatingSystem) { throw 'A Windows x64 guest is required.' }
$package = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -Raw -LiteralPath (Join-Path $package 'package-manifest.json') | ConvertFrom-Json
if ([string]::Equals($env:COMPUTERNAME, $manifest.buildMachine, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Refusing live registry tests on the machine that built the package.'
}
$computer = Get-CimInstance Win32_ComputerSystem
if (($computer.Manufacturer + ' ' + $computer.Model) -notmatch 'Virtual|VMware|KVM|QEMU|Xen|Parallels|Bochs') {
  throw 'The machine does not identify as a virtual machine. Use a clean disposable Windows VM or Windows Sandbox.'
}
if ($EnvironmentKind -eq 'Sandbox' -and $env:USERNAME -ne 'WDAGUtilityAccount') {
  throw 'Sandbox mode requires the Windows Sandbox guest account.'
}
$resultRoot = [IO.Path]::GetFullPath($ResultDirectory)
if ($resultRoot.StartsWith($package.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or $resultRoot -eq $package) {
  throw 'Results must be outside the read-only package directory.'
}
New-Item -ItemType Directory -Path $resultRoot -Force | Out-Null
$run = Join-Path $resultRoot ('run-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path $run | Out-Null
$work = Join-Path ([IO.Path]::GetTempPath()) ('VelmrenValidation-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
$phases = [Collections.Generic.List[object]]::new()
$summary = [ordered]@{
  schema = 1; status = 'running'; startedUtc = [DateTime]::UtcNow.ToString('o')
  packageId = $manifest.packageId; environmentKind = $EnvironmentKind
  machine = $env:COMPUTERNAME; manufacturer = $computer.Manufacturer; model = $computer.Model
  operatingSystem = [Environment]::OSVersion.VersionString
  guestWork = $work; phases = $phases; error = $null
}
function Save-Summary {
  $summary | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $run 'result.json') -Encoding utf8NoBOM
}
function Run-Suite([string]$Name, [string]$Executable, [string[]]$Arguments, [int]$TimeoutSeconds) {
  $phase = [ordered]@{ name=$Name; status='running'; startedUtc=[DateTime]::UtcNow.ToString('o'); exitCode=$null }
  $phases.Add($phase); Save-Summary
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $Executable; $start.UseShellExecute = $false; $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
  foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
  $start.Environment['VELMREN_ALLOW_LIVE_REGISTRY_TESTS'] = '1'
  $start.Environment['DOTNET_CLI_TELEMETRY_OPTOUT'] = '1'
  $process = [Diagnostics.Process]::new(); $process.StartInfo = $start
  $stdout = [IO.File]::Create((Join-Path $run ($Name + '.stdout.log')))
  $stderr = [IO.File]::Create((Join-Path $run ($Name + '.stderr.log')))
  $started = $false
  $outCopy = $null; $errCopy = $null
  try {
    $started = $process.Start()
    if (!$started) { throw "Could not start $Name." }
    $outCopy = $process.StandardOutput.BaseStream.CopyToAsync($stdout)
    $errCopy = $process.StandardError.BaseStream.CopyToAsync($stderr)
    if (!$process.WaitForExit($TimeoutSeconds * 1000)) { throw "$Name exceeded $TimeoutSeconds seconds." }
    [Threading.Tasks.Task]::WhenAll([Threading.Tasks.Task[]]@($outCopy,$errCopy)).GetAwaiter().GetResult()
    $phase.exitCode = $process.ExitCode
    if ($process.ExitCode -ne 0) { throw "$Name exited $($process.ExitCode); see $Name.stderr.log." }
    $suiteResult = Get-Content -Raw -LiteralPath (Join-Path $work "$Name/result.json") | ConvertFrom-Json
    $passed = if ($Name -eq 'lifecycle') { $suiteResult.result -eq 'passed' } else { $suiteResult.passed -eq $true }
    if (!$passed -or @($suiteResult.checks).Count -eq 0) { throw "$Name did not report successful checks." }
    $phase.status = 'passed'; $phase['checkCount'] = @($suiteResult.checks).Count
    Copy-Item -LiteralPath (Join-Path $work "$Name/result.json") -Destination (Join-Path $run "$Name.result.json")
  } catch {
    $phase.status = 'failed'; throw
  } finally {
    if ($started -and !$process.HasExited) { $process.Kill($true); $process.WaitForExit() }
    if ($null -ne $outCopy -and $null -ne $errCopy) {
      [Threading.Tasks.Task]::WhenAll([Threading.Tasks.Task[]]@($outCopy,$errCopy)).GetAwaiter().GetResult()
    }
    $stdout.Dispose(); $stderr.Dispose(); $process.Dispose()
    $phase['finishedUtc'] = [DateTime]::UtcNow.ToString('o'); Save-Summary
  }
}
$transcript = $false
try {
  Start-Transcript -LiteralPath (Join-Path $run 'transcript.log') | Out-Null; $transcript = $true
  Save-Summary
  Copy-Item -LiteralPath (Join-Path $package 'package-manifest.json') -Destination $run
  & (Join-Path $PSScriptRoot 'Inspect-ValidationPackage.ps1') -PackageDirectory $package -OutputFile (Join-Path $run 'preflight-audit.json') | Out-Null
  $phases.Add([ordered]@{name='static-preflight';status='passed'}); Save-Summary
  $engineA = Join-Path $package 'engines/engine-a/VelmrenDelivery.exe'
  $engineB = Join-Path $package 'engines/engine-b/VelmrenDelivery.exe'
  $incompatible = Join-Path $package 'engines/engine-incompatible/VelmrenDelivery.exe'
  $privateKey = Join-Path $package 'trust/TEST-ONLY-private.pem'
  Run-Suite 'lifecycle' (Join-Path $package 'runtime/pwsh.exe') @(
    '-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
    (Join-Path $PSScriptRoot 'Test-InstallLifecycle.ps1'),'-Installer',$engineA,
    '-PrivateKey',$privateKey,'-WorkDirectory',(Join-Path $work 'lifecycle'),'-AllowLiveRegistryTests'
  ) 1200
  Run-Suite 'launcher' (Join-Path $package 'engines/launcher-tests/Velmren.Delivery.LauncherTests.exe') @(
    (Join-Path $work 'launcher'),$engineA,$engineB,$incompatible,$privateKey
  ) 600
  $summary.status = 'passed'
} catch {
  $summary.status = 'failed'; $summary.error = $_.ToString()
  $_ | Out-String | Set-Content -LiteralPath (Join-Path $run 'error.log') -Encoding utf8NoBOM
} finally {
  try {
    $diagnostics = Join-Path $run 'diagnostics'
    foreach ($file in Get-ChildItem -LiteralPath $work -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in '.log','.json','.jsonl' }) {
      $target = Join-Path $diagnostics ([IO.Path]::GetRelativePath($work, $file.FullName))
      New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
      Copy-Item -LiteralPath $file.FullName -Destination $target
    }
  } catch { $summary['exportError'] = $_.ToString(); $summary.status = 'failed' }
  $summary['finishedUtc'] = [DateTime]::UtcNow.ToString('o'); Save-Summary
  if ($transcript) { Stop-Transcript | Out-Null }
}
Write-Output "Validation $($summary.status). Results: $run"
if ($summary.status -ne 'passed') { exit 1 }
