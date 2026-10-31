#requires -Version 7.4
[CmdletBinding()]
param([Parameter(Mandatory)][string]$WorkDirectory)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$evidence = [IO.Path]::GetFullPath($WorkDirectory)
if (Test-Path -LiteralPath $evidence) { throw 'Choose a fresh harness test directory.' }
New-Item -ItemType Directory -Path $evidence | Out-Null
$runner = Join-Path $PSScriptRoot 'Run-GuestValidation.ps1'
$checks = [Collections.Generic.List[string]]::new()
try {
  & $runner -ResultDirectory (Join-Path $evidence 'must-not-exist')
  throw 'Runner accepted absent guest/live-test confirmation.'
} catch {
  if ($_.ToString() -notlike '*explicitly pass -DisposableWindowsConfirmed -AllowLiveRegistryTests*') { throw }
}
if (Test-Path -LiteralPath (Join-Path $evidence 'must-not-exist')) { throw 'Rejected runner created a result directory.' }
$checks.Add('Missing guest/live-test switches reject before work or process creation')

# Exercise only the child-process orchestration functions with harmless pwsh
# commands. Do not evaluate the runner body or start a delivery executable.
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($runner,[ref]$tokens,[ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
$functions = $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in 'Save-Summary','Run-Suite' },$true)
if ($functions.Count -ne 2) { throw 'Expected the two process orchestration functions.' }
foreach ($function in $functions) { . ([ScriptBlock]::Create($function.Extent.Text)) }
$pwsh = Join-Path $PSHOME 'pwsh.exe'
foreach ($scenario in 'pass','nonzero','missing-result','timeout') {
  $run = Join-Path $evidence $scenario
  $work = Join-Path $run 'work'
  New-Item -ItemType Directory -Path $run,(Join-Path $work 'launcher') | Out-Null
  $phases = [Collections.Generic.List[object]]::new()
  $summary = [ordered]@{status='testing-harness';phases=$phases}
  if ($scenario -eq 'pass') {
    @{passed=$true;checks=@('harmless child finished')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $work 'launcher/result.json')
  }
  $command = switch ($scenario) {
    'pass' { 'Write-Output "harmless stdout"; [Console]::Error.WriteLine("harmless stderr"); exit 0' }
    'nonzero' { '[Console]::Error.WriteLine("expected failure"); exit 7' }
    'missing-result' { 'exit 0' }
    'timeout' { 'Start-Sleep -Seconds 30' }
  }
  $failure = $null
  try { Run-Suite 'launcher' $pwsh @('-NoLogo','-NoProfile','-NonInteractive','-Command',$command) 2 }
  catch { $failure = $_ }
  if ($scenario -eq 'pass') {
    if ($failure) { throw $failure }
    if ($phases[0].status -ne 'passed' -or $phases[0].checkCount -ne 1 -or
        !(Test-Path -LiteralPath (Join-Path $run 'launcher.result.json')) -or
        (Get-Content -Raw -LiteralPath (Join-Path $run 'launcher.stdout.log')) -notlike '*harmless stdout*' -or
        (Get-Content -Raw -LiteralPath (Join-Path $run 'launcher.stderr.log')) -notlike '*harmless stderr*') {
      throw 'Successful child evidence was not exported correctly.'
    }
  } else {
    if (!$failure -or $phases[0].status -ne 'failed') { throw "$scenario was not recorded as failed." }
    if ($scenario -eq 'nonzero' -and $phases[0].exitCode -ne 7) { throw 'Nonzero child exit was lost.' }
    if ($scenario -eq 'timeout' -and $failure.ToString() -notlike '*exceeded 2 seconds*') { throw $failure }
  }
  $checks.Add("Child-process $scenario path exports correct status and logs")
}
$inventory = Join-Path $evidence 'invalid-inventory'
New-Item -ItemType Directory -Path $inventory | Out-Null
'changed bytes' | Set-Content -LiteralPath (Join-Path $inventory 'fixture.txt')
@{schema=1;purpose='disposable-windows-development-validation';files=@(@{path='fixture.txt';bytes=1;sha256=('0' * 64)});payloads=@()} |
  ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $inventory 'package-manifest.json')
try {
  & (Join-Path $PSScriptRoot 'Inspect-ValidationPackage.ps1') -PackageDirectory $inventory | Out-Null
  throw 'Changed package file unexpectedly passed the static audit.'
} catch {
  if ($_.ToString() -notlike '*Package hash or length mismatch*') { throw }
}
$checks.Add('Changed package bytes fail before any executable or assembly audit')
@{passed=$true;execution='Harmless PowerShell child processes only; no delivery engine or registry suite.';checks=$checks} |
  ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $evidence 'result.json')
Get-Content -LiteralPath (Join-Path $evidence 'result.json')
