[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Installer,
  [Parameter(Mandatory)][string]$PrivateKey,
  [Parameter(Mandatory)][string]$WorkDirectory,
  [int]$Port = 18791,
  [switch]$AllowLiveRegistryTests
)
$ErrorActionPreference = 'Stop'
if (!$AllowLiveRegistryTests) { throw 'This suite writes to the live Windows registry. Use a disposable Windows environment and explicitly pass -AllowLiveRegistryTests. For host-safe validation run Velmren.Delivery.RegistrationTests.csproj.' }
$PSNativeCommandUseErrorActionPreference = $false
$work = [IO.Path]::GetFullPath($WorkDirectory)
if (Test-Path -LiteralPath $work) { throw 'Choose a fresh lifecycle QA directory.' }
New-Item -ItemType Directory -Path $work | Out-Null
$checks = [Collections.Generic.List[string]]::new()
$children = [Collections.Generic.List[Diagnostics.Process]]::new()
$feed = Join-Path $work 'feed'
$payload = Join-Path $work 'payload'
$root = Join-Path $work 'installed'
$testId = [Guid]::NewGuid().ToString('N')
$shellRoot = Join-Path $work 'shell'
$oldTestId = $env:VELMREN_DELIVERY_TEST_ID
$oldShellRoot = $env:VELMREN_DELIVERY_TEST_SHELL_ROOT
$env:VELMREN_DELIVERY_TEST_ID = $testId
$env:VELMREN_DELIVERY_TEST_SHELL_ROOT = $shellRoot
$registry = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Velmren-Development-Test-$testId"
function Assert([bool]$Condition, [string]$Message) { if (!$Condition) { throw $Message } }
function Run([string[]]$Arguments, [int]$Expected = 0) {
  $output = & $Installer @Arguments 2>&1
  $exitCode = $LASTEXITCODE
  $output | Out-String | Add-Content -LiteralPath (Join-Path $work 'commands.log')
  Assert ($exitCode -eq $Expected) "Expected exit $Expected, got $exitCode for $($Arguments[0]): $output"
  return $output
}
function Start-Worker([string[]]$Arguments, [string]$Name) {
  $argumentsQuoted = @($Arguments | ForEach-Object { '"' + $_ + '"' })
  $process = Start-Process -FilePath $Installer -ArgumentList $argumentsQuoted -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $work "$Name.stdout.log") -RedirectStandardError (Join-Path $work "$Name.stderr.log")
  $children.Add($process)
  return $process
}
function Wait-For([scriptblock]$Condition, [int]$Seconds = 30) {
  $limit = [DateTime]::UtcNow.AddSeconds($Seconds)
  while (!( & $Condition)) { if ([DateTime]::UtcNow -gt $limit) { throw 'Lifecycle test condition timed out.' }; Start-Sleep -Milliseconds 25 }
}
function Bundle([string]$Version) {
  $directory = Join-Path $work "bundle-$Version"
  New-Item -ItemType Directory -Path $directory | Out-Null
  Copy-Item -LiteralPath (Join-Path $feed "manifest-$Version.json") -Destination (Join-Path $directory 'manifest.json')
  Copy-Item -LiteralPath (Join-Path $feed "velmren-$Version.zip") -Destination $directory
  return $directory
}
function Install-Bundle([string]$Destination, [string]$Bundle, [int]$Expected = 0) {
  Run @('install-bundle','--root',$Destination,'--bundle-directory',$Bundle,'--feed',"http://127.0.0.1:$Port/") $Expected | Out-Null
}
try {
  New-Item -ItemType Directory -Path $feed,$payload,(Join-Path $payload 'delivery'),(Join-Path $payload 'assets') | Out-Null
  Copy-Item -LiteralPath $Installer -Destination (Join-Path $payload 'synthetic.exe')
  Copy-Item -LiteralPath $Installer -Destination (Join-Path $payload 'agent.exe')
  Copy-Item -LiteralPath $Installer -Destination (Join-Path $payload 'delivery/VelmrenMaintenance.exe')
  'signed resource' | Set-Content -LiteralPath (Join-Path $payload 'assets/value.txt') -Encoding utf8NoBOM
  @{browser='synthetic.exe';browserArguments=@('synthetic-app','--seconds','30');agent='agent.exe';agentArguments=@('synthetic-app','--seconds','30');setup='delivery/VelmrenMaintenance.exe'} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $payload 'delivery-app.json') -Encoding utf8NoBOM
  Run @('package','--payload',$payload,'--version','1.0.0.0','--feed-directory',$feed,'--private-key',$PrivateKey) | Out-Null
  'signed newer resource' | Set-Content -LiteralPath (Join-Path $payload 'assets/value.txt') -Encoding utf8NoBOM
  $maintenanceUpdate = [IO.File]::Open((Join-Path $payload 'delivery/VelmrenMaintenance.exe'),[IO.FileMode]::Append,[IO.FileAccess]::Write)
  try { $maintenanceUpdate.WriteByte(0) } finally { $maintenanceUpdate.Dispose() }
  Run @('package','--payload',$payload,'--version','1.0.0.1','--feed-directory',$feed,'--private-key',$PrivateKey) | Out-Null
  $bundle0 = Bundle '1.0.0.0'; $bundle1 = Bundle '1.0.0.1'
  $cancel = Join-Path $work 'cancel.signal'
  [IO.File]::WriteAllText($cancel, 'cancel')
  $cancelledRoot = Join-Path $work 'cancelled-before-start'
  Run @('install-bundle','--root',$cancelledRoot,'--bundle-directory',$bundle0,'--feed',"http://127.0.0.1:$Port/",'--cancel-file',$cancel) 2 | Out-Null
  Assert (!(Test-Path -LiteralPath $cancelledRoot)) 'Pre-cancelled install wrote its root.'
  Assert (Test-Path -LiteralPath $cancel) 'Engine deleted caller-owned cancellation signal.'
  $checks.Add('pre-cancelled operation exits 2 without root writes or deleting signal')
  $unrelated = Join-Path $work 'unrelated'
  New-Item -ItemType Directory -Path $unrelated | Out-Null
  'untouched' | Set-Content -LiteralPath (Join-Path $unrelated 'user.txt')
  Install-Bundle $unrelated $bundle0 1
  Run @('uninstall','--root',$unrelated) 1 | Out-Null
  Assert ((Get-Content -Raw -LiteralPath (Join-Path $unrelated 'user.txt')).Trim() -eq 'untouched') 'Unrelated root modified.'
  $checks.Add('install and uninstall reject unrelated nonempty roots')
  Install-Bundle $root $bundle0
  Install-Bundle $root $bundle0
  $checks.Add('signed offline bundle installs and repeat install resumes idempotently')
  $marker = Join-Path $root '.velmren-owner.json'
  $originalMarker = [IO.File]::ReadAllBytes($marker)
  foreach ($field in 'ownerSid','root','product','channel','platform') {
    $owner = Get-Content -Raw -LiteralPath $marker | ConvertFrom-Json
    $owner.$field = 'wrong-identity'
    $owner | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $marker -Encoding utf8NoBOM
    Run @('uninstall','--root',$root) 1 | Out-Null
    Install-Bundle $root $bundle0 1
    [IO.File]::WriteAllBytes($marker,$originalMarker)
  }
  $checks.Add('canonical root, SID and product/channel/platform marker mismatch rejected')
  $registryOwner = Get-Content -Raw -LiteralPath $marker | ConvertFrom-Json
  $registryRelative = $registry.Substring(6)
  $registryStageRelative = $registryRelative + '.installing-' + $registryOwner.id
  $registryStage = 'HKCU:\' + $registryStageRelative
  $registryOwner | Add-Member -NotePropertyName registration -NotePropertyValue ([pscustomobject]@{key=$registryRelative;testId=$testId;testRoot=$shellRoot;links=@();temporaryLinks=@();registryStage=$registryStageRelative}) -Force
  $registryOwner | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $marker -Encoding utf8NoBOM
  New-Item -Path $registry -Force | Out-Null
  Run @('register','--root',$root,'--desktop','true') 1 | Out-Null
  Assert ((Get-Item -LiteralPath $registry).ValueCount -eq 0) 'Unrelated empty final key was adopted.'
  Remove-Item -LiteralPath $registry
  New-Item -Path $registryStage -Force | Out-Null
  New-ItemProperty -LiteralPath $registryStage -Name UserData -Value 'preserve unrelated value' | Out-Null
  Run @('register','--root',$root,'--desktop','true') 1 | Out-Null
  Assert ((Get-ItemProperty -LiteralPath $registryStage).UserData -eq 'preserve unrelated value') 'Unrelated staged registry value was overwritten.'
  Remove-ItemProperty -LiteralPath $registryStage -Name UserData
  New-ItemProperty -LiteralPath $registryStage -Name VelmrenOwner -Value $registryOwner.id | Out-Null
  Run @('register','--root',$root,'--desktop','true') | Out-Null
  Assert (!(Test-Path -LiteralPath $registryStage)) 'Completed uninstall registration retained its staging key.'
  $checks.Add('HKCU registration migrates partial owned legacy staging without rename and rejects unrelated entries')
  $link = Join-Path $shellRoot 'StartMenu/Velmren Development.lnk'
  $desktop = Join-Path $shellRoot 'Desktop/Velmren Development.lnk'
  $ws = New-Object -ComObject WScript.Shell
  try { $shortcut = $ws.CreateShortcut($link); Assert ($shortcut.TargetPath -eq (Join-Path $root 'Velmren.exe')) 'Shortcut does not target stable launcher.' }
  finally { if ($shortcut) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }; [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($ws) }
  Assert (Test-Path -LiteralPath $desktop) 'Optional desktop shortcut missing.'
  $ownedLinkBytes = [IO.File]::ReadAllBytes($link)
  [IO.File]::WriteAllText($link,'unrelated replacement shortcut')
  Run @('register','--root',$root,'--desktop','true') 1 | Out-Null
  Assert ([IO.File]::ReadAllText($link) -eq 'unrelated replacement shortcut') 'Register overwrote an unrelated shortcut.'
  [IO.File]::WriteAllBytes($link,$ownedLinkBytes)
  $registration = Get-ItemProperty -LiteralPath $registry
  Assert ($registration.UninstallString.Contains('VelmrenMaintenance.exe')) 'Signed maintenance UI not used in uninstall entry.'
  Assert ($registration.UninstallString.Contains(' --uninstall --root ')) 'Maintenance UI uninstall flag differs from frontend contract.'
  Assert ((Get-FileHash -LiteralPath (Join-Path $root 'VelmrenMaintenance.exe')).Hash -eq (Get-FileHash -LiteralPath (Join-Path $root 'versions/1.0.0.0/app/delivery/VelmrenMaintenance.exe')).Hash) 'Maintenance copy differs from signed payload.'
  $registrationOwner = Get-Content -Raw -LiteralPath $marker | ConvertFrom-Json
  $interruptedLink = $link + '.' + $registrationOwner.id + '.installing.lnk'
  Copy-Item -LiteralPath $link -Destination $interruptedLink
  $registrationOwner.registration | Add-Member -NotePropertyName temporaryLinks -NotePropertyValue @($interruptedLink) -Force
  $registrationOwner | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $marker -Encoding utf8NoBOM
  Run @('register','--root',$root,'--desktop','true') | Out-Null
  Assert (!(Test-Path -LiteralPath $interruptedLink)) 'Repeated registration did not reconcile owned staged shortcut.'
  $checks.Add('registration resumes its journaled shortcut transaction')
  Run @('register','--root',$root,'--desktop','false') | Out-Null
  Assert (!(Test-Path -LiteralPath $desktop)) 'Desktop false did not remove the previously owned shortcut.'
  Run @('register','--root',$root,'--setup-path',$Installer) 1 | Out-Null
  $checks.Add('isolated HKCU + stable Start menu/optional Desktop registration uses signed maintenance only')
  [IO.File]::WriteAllText((Join-Path $root 'profile/Bookmarks'),'saved bookmarks')
  [IO.File]::WriteAllText((Join-Path $root 'agent-state/state.json'),'saved agent state')
  $bookmarks = (Get-FileHash -LiteralPath (Join-Path $root 'profile/Bookmarks')).Hash
  $agentState = (Get-FileHash -LiteralPath (Join-Path $root 'agent-state/state.json')).Hash
  $runLease = [IO.File]::Open((Join-Path $root 'run.lock'),[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  try { Run @('uninstall','--root',$root) 1 | Out-Null } finally { $runLease.Dispose() }
  Assert (Test-Path -LiteralPath (Join-Path $root 'current.json')) 'Busy uninstall deleted program files.'
  $checks.Add('uninstall refuses active launcher lease without modifying install')
  foreach ($executable in 'synthetic.exe','agent.exe') {
    $app = Join-Path $root "versions/1.0.0.0/app/$executable"
    $process = Start-Process -FilePath $app -ArgumentList @('synthetic-app','--seconds','30','--user-data-dir',('"' + (Join-Path $root 'profile') + '"')) -WindowStyle Hidden -PassThru
    $children.Add($process)
    try {
      Wait-For { !$process.HasExited }; Run @('uninstall','--root',$root) 1 | Out-Null
      $config = Join-Path $root 'versions/1.0.0.0/app/delivery-app.json'
      $savedConfig = $config + '.saved'
      Move-Item -LiteralPath $config -Destination $savedConfig
      try { Run @('uninstall','--root',$root) 1 | Out-Null; Assert (Test-Path -LiteralPath (Join-Path $root 'current.json')) 'Missing app config bypassed busy-process check.' }
      finally { Move-Item -LiteralPath $savedConfig -Destination $config }
      Assert (!$process.HasExited) 'Uninstaller stopped the browser or broker.'
    }
    finally { if (!$process.HasExited) { Stop-Process -Id $process.Id -Force; $process.WaitForExit() } }
  }
  $checks.Add('uninstall refuses standalone installed browser and broker without killing either')
  $checks.Add('owned executable inventory detects busy browser and broker even when app configuration is missing')
  $assets = Join-Path $root 'versions/1.0.0.0/app/assets'
  $savedAssets = Join-Path $root 'saved-assets'
  Move-Item -LiteralPath $assets -Destination $savedAssets
  $outside = Join-Path $work 'outside'
  New-Item -ItemType Directory -Path $outside | Out-Null
  'outside untouched' | Set-Content -LiteralPath (Join-Path $outside 'value.txt')
  New-Item -ItemType Junction -Path $assets -Target $outside | Out-Null
  try { Run @('uninstall','--root',$root) 1 | Out-Null; Assert (Test-Path -LiteralPath (Join-Path $root 'current.json')) 'Reparse rejection happened after deleting install.' }
  finally { [IO.Directory]::Delete($assets); Move-Item -LiteralPath $savedAssets -Destination $assets }
  $checks.Add('uninstall preflights owned paths and rejects junction traversal before deletion')
  $waitCancel = Join-Path $work 'lock-cancel.signal'
  $operation = [IO.File]::Open((Join-Path $root 'operation.lock'),[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try {
    $waiter = Start-Worker @('install-bundle','--root',$root,'--bundle-directory',$bundle0,'--feed',"http://127.0.0.1:$Port/",'--cancel-file',$waitCancel) 'lock-waiter'
    [IO.File]::WriteAllText($waitCancel,'cancel')
    Assert ($waiter.WaitForExit(8000)) 'Cancellation did not interrupt operation lock wait within 8 seconds.'
    Assert ($waiter.ExitCode -eq 2) 'Cancelled lock waiter did not exit 2.'
  } finally { $operation.Dispose() }
  $checks.Add('cancellation interrupts operation-lock wait within GUI grace period')
  Install-Bundle $root $bundle1
  $refreshed = Get-ItemProperty -LiteralPath $registry
  Assert ($refreshed.DisplayVersion -eq '1.0.0.1') 'Activation did not refresh the owned uninstall version.'
  Assert ((Get-FileHash -LiteralPath (Join-Path $root 'VelmrenMaintenance.exe')).Hash -eq (Get-FileHash -LiteralPath (Join-Path $payload 'delivery/VelmrenMaintenance.exe')).Hash) 'Activation did not refresh signed maintenance.'
  $checks.Add('activation refreshes signed stable maintenance and matching HKCU version without touching shortcuts')
  Install-Bundle $root $bundle0 1
  $checks.Add('bundle uses same anti-downgrade checks as network update')
  'keep this unrelated file' | Set-Content -LiteralPath (Join-Path $root 'user-note.txt')
  $busyMaintenance = [IO.File]::Open((Join-Path $root 'VelmrenMaintenance.exe'),[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  try {
    $uninstallOutput = Run @('uninstall','--root',$root)
    Assert (($uninstallOutput | Out-String).Contains('VelmrenMaintenance.exe')) 'Uninstall did not report retained busy maintenance.'
  } finally { $busyMaintenance.Dispose() }
  Assert (!(Test-Path -LiteralPath $registry)) 'Uninstall registry entry remains.'
  Assert (!(Test-Path -LiteralPath $link)) 'Owned shortcut remains.'
  Assert (Test-Path -LiteralPath (Join-Path $root 'user-note.txt')) 'Unrelated root file was deleted.'
  Assert ((Get-FileHash -LiteralPath (Join-Path $root 'profile/Bookmarks')).Hash -eq $bookmarks) 'Uninstall changed saved profile.'
  Assert ((Get-FileHash -LiteralPath (Join-Path $root 'agent-state/state.json')).Hash -eq $agentState) 'Uninstall changed agent state.'
  Run @('uninstall','--root',$root) | Out-Null
  Assert (!(Test-Path -LiteralPath (Join-Path $root 'VelmrenMaintenance.exe'))) 'Later cleanup did not reconcile retained maintenance.'
  $checks.Add('uninstall preserves saved data/unrelated files and reports then reconciles busy maintenance')
  Install-Bundle $root $bundle0 1
  Install-Bundle $root $bundle1
  Assert ((Get-FileHash -LiteralPath (Join-Path $root 'profile/Bookmarks')).Hash -eq $bookmarks) 'Reinstall changed saved profile.'
  $checks.Add('retained owned root permits reinstall while maintaining high-water downgrade protection')
  $interruptedOwner = Get-Content -Raw -LiteralPath $marker | ConvertFrom-Json
  $interruptedOwner.state = 'retained'
  $interruptedOwner | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $marker -Encoding utf8NoBOM
  Remove-Item -LiteralPath (Join-Path $root 'versions/1.0.0.1/app/assets/value.txt')
  Run @('resolve','--root',$root) 1 | Out-Null
  Install-Bundle $root $bundle1
  Run @('resolve','--root',$root) | Out-Null
  Assert ((Get-FileHash -LiteralPath (Join-Path $root 'profile/Bookmarks')).Hash -eq $bookmarks) 'Interrupted uninstall recovery changed saved profile.'
  $checks.Add('reinstall reconciles an interrupted uninstall with a partial immutable version')
  $badBundle = Join-Path $work 'bad-bundle'
  New-Item -ItemType Directory -Path $badBundle | Out-Null
  Copy-Item -LiteralPath (Join-Path $bundle0 'manifest.json') -Destination $badBundle
  [IO.File]::WriteAllText((Join-Path $badBundle 'velmren-1.0.0.0.zip'),'corrupt package')
  $badRoot = Join-Path $work 'bad-installed'
  Install-Bundle $badRoot $badBundle 1
  Assert (!(Test-Path -LiteralPath (Join-Path $badRoot 'current.json'))) 'Corrupt bundle activated.'
  Copy-Item -LiteralPath (Join-Path $bundle0 'velmren-1.0.0.0.zip') -Destination $badBundle -Force
  Install-Bundle $badRoot $badBundle
  $checks.Add('corrupt bundle never activates; same marked incomplete root resumes with intact package')
  $signatureBundle = Join-Path $work 'bad-signature'
  New-Item -ItemType Directory -Path $signatureBundle | Out-Null
  $envelope = Get-Content -Raw -LiteralPath (Join-Path $bundle0 'manifest.json') | ConvertFrom-Json
  $signature = [Convert]::FromBase64String($envelope.signature); $signature[0] = $signature[0] -bxor 1
  $envelope.signature = [Convert]::ToBase64String($signature)
  $envelope | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $signatureBundle 'manifest.json') -Encoding utf8NoBOM
  $signatureRoot = Join-Path $work 'signature-root'
  Install-Bundle $signatureRoot $signatureBundle 1
  Assert (!(Test-Path -LiteralPath $signatureRoot)) 'Untrusted manifest caused root writes.'
  $checks.Add('invalid bundle signature is rejected before claiming the destination')
  $large = [IO.File]::Create((Join-Path $payload 'large.bin'))
  try { $large.SetLength(512MB) } finally { $large.Dispose() }
  Run @('package','--payload',$payload,'--version','1.0.0.2','--feed-directory',$feed,'--private-key',$PrivateKey) | Out-Null
  $bundle2 = Bundle '1.0.0.2'
  $extractRoot = Join-Path $work 'extract-resume'
  $extractCancel = Join-Path $work 'extract-cancel.signal'
  $extractWorker = Start-Worker @('install-bundle','--root',$extractRoot,'--bundle-directory',$bundle2,'--feed',"http://127.0.0.1:$Port/",'--cancel-file',$extractCancel) 'extract-worker'
  Wait-For { @(Get-ChildItem -LiteralPath (Join-Path $extractRoot 'staging') -Filter large.bin -Recurse -ErrorAction SilentlyContinue).Count -gt 0 }
  [IO.File]::WriteAllText($extractCancel,'cancel')
  Assert ($extractWorker.WaitForExit(8000)) 'Extraction did not cancel within GUI grace period.'
  Assert ($extractWorker.ExitCode -eq 2) 'Cancelled extraction did not exit 2.'
  Assert (!(Test-Path -LiteralPath (Join-Path $extractRoot 'current.json'))) 'Cancelled extraction activated.'
  Install-Bundle $extractRoot $bundle2
  $checks.Add('cancellation interrupts extraction within 8 seconds; same owned root resumes safely')
  Copy-Item -LiteralPath (Join-Path $feed 'manifest-1.0.0.1.json') -Destination (Join-Path $feed 'latest.json') -Force
  $server = Start-Worker @('serve','--directory',$feed,'--port',"$Port",'--truncate-first-package','32768') 'range-server'
  Wait-For { try { (Invoke-WebRequest "http://127.0.0.1:$Port/latest.json" -TimeoutSec 1).StatusCode -eq 200 } catch { $false } }
  $networkRoot = Join-Path $work 'network-resume'
  Run @('install','--root',$networkRoot,'--feed',"http://127.0.0.1:$Port/") 1 | Out-Null
  Run @('install','--root',$networkRoot,'--feed',"http://127.0.0.1:$Port/") | Out-Null
  Assert ((Get-Content -Raw -LiteralPath (Join-Path $networkRoot 'events.jsonl')).Contains('download-resumed')) 'Repeated install did not use HTTP Range.'
  $checks.Add('repeating network install resumes interrupted HTTP Range download')
  $cancelPort = $Port + 100
  $stallServer = Start-Worker @('serve','--directory',$feed,'--port',"$cancelPort",'--stall-first','package') 'cancel-server'
  Wait-For { try { (Invoke-WebRequest "http://127.0.0.1:$cancelPort/latest.json" -TimeoutSec 1).StatusCode -eq 200 } catch { $false } }
  $downloadRoot = Join-Path $work 'cancel-download'
  $downloadCancel = Join-Path $work 'download-cancel.signal'
  $downloadWorker = Start-Worker @('install','--root',$downloadRoot,'--feed',"http://127.0.0.1:$cancelPort/",'--cancel-file',$downloadCancel) 'download-worker'
  Wait-For { @(Get-ChildItem -LiteralPath (Join-Path $downloadRoot 'downloads') -Filter '*.part' -ErrorAction SilentlyContinue).Count -gt 0 }
  [IO.File]::WriteAllText($downloadCancel,'cancel')
  Assert ($downloadWorker.WaitForExit(8000)) 'Stalled download did not cancel within GUI grace period.'
  Assert ($downloadWorker.ExitCode -eq 2) 'Cancelled download did not exit 2.'
  Assert (!(Test-Path -LiteralPath (Join-Path $downloadRoot 'current.json'))) 'Cancelled network install activated.'
  Assert (Test-Path -LiteralPath $downloadCancel) 'Engine removed the download cancellation signal.'
  $checks.Add('cancellation interrupts a stalled network response within 8 seconds and retains caller signal')
  [pscustomobject]@{result='passed';checks=$checks;registryIdentity=$registry;work=$work} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $work 'result.json') -Encoding utf8NoBOM
  Get-Content -LiteralPath (Join-Path $work 'result.json')
} finally {
  foreach ($process in $children) { try { if (!$process.HasExited) { Stop-Process -Id $process.Id -Force; $process.WaitForExit() } } catch {} }
  if (Test-Path -LiteralPath $registry) { Remove-Item -LiteralPath $registry -Recurse }
  if ($registryStage -and (Test-Path -LiteralPath $registryStage)) { Remove-Item -LiteralPath $registryStage -Recurse }
  $env:VELMREN_DELIVERY_TEST_ID = $oldTestId
  $env:VELMREN_DELIVERY_TEST_SHELL_ROOT = $oldShellRoot
}
