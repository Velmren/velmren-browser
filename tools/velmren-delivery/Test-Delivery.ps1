[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Installer,
  [Parameter(Mandatory)][string]$PrivateKey,
  [Parameter(Mandatory)][string]$WorkDirectory,
  [int]$Port = 18773,
  [switch]$CompactUpdate
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$work = [IO.Path]::GetFullPath($WorkDirectory)
if (Test-Path -LiteralPath $work) { throw 'Choose a new smoke-test directory; existing test evidence is retained.' }
New-Item -ItemType Directory -Path $work | Out-Null
$feed = Join-Path $work 'feed'
$payload = Join-Path $work 'payload'
$installRoot = Join-Path $work 'installed'
New-Item -ItemType Directory -Path $feed, $payload | Out-Null
New-Item -ItemType Directory -Path (Join-Path $payload 'assets') | Out-Null
'nested sandbox-readable resource' | Set-Content -LiteralPath (Join-Path $payload 'assets/nested.txt') -Encoding utf8NoBOM
Copy-Item -LiteralPath $Installer -Destination (Join-Path $payload 'synthetic.exe')
@{browser='synthetic.exe'; browserArguments=@('synthetic-app','--seconds','16')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $payload 'delivery-app.json') -Encoding utf8NoBOM
$checks = [Collections.Generic.List[string]]::new()
$server = $null
$launcher = $null
$stallServer = $null
$stallLauncher = $null
$startupSeconds = @{}
$sandboxCapabilities = @(
  'S-1-15-3-1024-3424233489-972189580-2057154623-747635277-1604371224-316187997-3786583170-1043257646',
  'S-1-15-3-1024-2302894289-466761758-1166120688-1039016420-2430351297-4240214049-4028510897-3317428798'
)
function Assert([bool]$Condition, [string]$Message) { if (!$Condition) { throw $Message } }
function Access-Sddl([string]$Path) {
  (Get-Acl -LiteralPath $Path).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
}
function Assert-SandboxAccess([string]$Version) {
  $app = Join-Path $installRoot "versions/$Version/app"
  $required = [Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [Security.AccessControl.FileSystemRights]::Synchronize
  foreach ($path in $app, (Join-Path $app 'synthetic.exe'), (Join-Path $app 'assets'), (Join-Path $app 'assets/nested.txt')) {
    $rules = (Get-Acl -LiteralPath $path).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
    foreach ($sid in $sandboxCapabilities) {
      $matches = @($rules | Where-Object {
        $_.IdentityReference.Value -eq $sid -and $_.AccessControlType -eq 'Allow' -and
        ($_.FileSystemRights -band $required) -eq $required -and
        !($_.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)
      })
      Assert ($matches.Count -gt 0) "Missing sandbox RX capability $sid on $path"
      if ($path -eq $app) {
        Assert (@($matches | Where-Object { ($_.InheritanceFlags -band 3) -eq 3 -and $_.PropagationFlags -eq 'None' }).Count -gt 0) 'App ACL is not inheritable by files and directories.'
      }
    }
  }
}
function Run-Delivery([string[]]$Arguments, [bool]$ShouldSucceed = $true) {
  $result = & $Installer @Arguments 2>&1
  $exitCode = $LASTEXITCODE
  $result | Out-String | Add-Content -LiteralPath (Join-Path $work 'commands.log')
  Assert (($exitCode -eq 0) -eq $ShouldSucceed) "Unexpected exit $exitCode for $($Arguments[0]): $result"
}
function Select-Release([string]$Version) {
  $source = Join-Path $feed "manifest-$Version.json"
  $temp = Join-Path $feed ('latest-swap-' + [Guid]::NewGuid().ToString('N'))
  [IO.File]::WriteAllBytes($temp, [IO.File]::ReadAllBytes($source))
  [IO.File]::Move($temp, (Join-Path $feed 'latest.json'), $true)
}
function Current-Version { (Get-Content -Raw -LiteralPath (Join-Path $installRoot 'current.json') | ConvertFrom-Json).version }
function Wait-For([scriptblock]$Condition, [int]$Timeout = 40) {
  $limit = [DateTime]::UtcNow.AddSeconds($Timeout)
  while (!( & $Condition)) { if ([DateTime]::UtcNow -gt $limit) { throw 'Smoke-test condition timed out.' }; Start-Sleep -Milliseconds 200 }
}
function Sign-Manifest($Manifest) {
  $bytes = [Text.Encoding]::UTF8.GetBytes(($Manifest | ConvertTo-Json -Depth 10))
  $rsa = [Security.Cryptography.RSA]::Create()
  try {
    $rsa.ImportFromPem([IO.File]::ReadAllText($PrivateKey))
    $signature = $rsa.SignData($bytes, [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pss)
    @{payload=[Convert]::ToBase64String($bytes);signature=[Convert]::ToBase64String($signature)} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $feed 'latest.json') -Encoding utf8NoBOM
  } finally { $rsa.Dispose() }
}
function Hostile-Archive([string]$Version, [string]$Kind) {
  $envelope = Get-Content -Raw -LiteralPath (Join-Path $feed 'manifest-1.0.0.1.json') | ConvertFrom-Json
  $manifest = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($envelope.payload)) | ConvertFrom-Json
  $manifest.version = $Version
  $manifest.compactArchive = $null
  $manifest.package = "velmren-$Version.zip"
  $zipPath = Join-Path $feed $manifest.package
  $input = [IO.Compression.ZipFile]::OpenRead((Join-Path $feed 'velmren-1.0.0.1.zip'))
  $output = [IO.Compression.ZipFile]::Open($zipPath, [IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($entry in $input.Entries) {
      $name = if ($entry.FullName -eq 'release.txt' -and $Kind -eq 'traversal') { '../escaped.txt' } else { $entry.FullName }
      $copy = $output.CreateEntry($name, [IO.Compression.CompressionLevel]::Fastest)
      if ($entry.FullName -eq 'release.txt' -and $Kind -eq 'symlink') { $copy.ExternalAttributes = -1577123840 }
      $source = $entry.Open(); $destination = $copy.Open()
      try { $source.CopyTo($destination) } finally { $source.Dispose(); $destination.Dispose() }
    }
  } finally { $input.Dispose(); $output.Dispose() }
  $manifest.size = (Get-Item -LiteralPath $zipPath).Length
  $manifest.sha256 = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
  Sign-Manifest $manifest
}
try {
  'release N' | Set-Content -LiteralPath (Join-Path $payload 'release.txt') -Encoding utf8NoBOM
  Run-Delivery @('package','--payload',$payload,'--version','1.0.0.0','--feed-directory',$feed,'--private-key',$PrivateKey)
  'release N+1' | Set-Content -LiteralPath (Join-Path $payload 'release.txt') -Encoding utf8NoBOM
  if ($CompactUpdate) {
    & (Join-Path $PSScriptRoot 'Build-Release.ps1') -Installer $Installer -PayloadDirectory $payload -Version '1.0.0.1' -FeedDirectory $feed -PrivateKey $PrivateKey
  } else {
    Run-Delivery @('package','--payload',$payload,'--version','1.0.0.1','--feed-directory',$feed,'--private-key',$PrivateKey)
  }
  Select-Release '1.0.0.0'
  $server = Start-Process -FilePath $Installer -ArgumentList @('serve','--directory',('"' + $feed + '"'),'--port',"$Port",'--truncate-first-package','32768') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $work 'feed.stdout.log') -RedirectStandardError (Join-Path $work 'feed.stderr.log')
  Wait-For { try { (Invoke-WebRequest "http://127.0.0.1:$Port/latest.json" -TimeoutSec 1).StatusCode -eq 200 } catch { $false } }
  Run-Delivery @('install','--root',$installRoot,'--feed',"http://127.0.0.1:$Port/",'--poll-seconds','1') $false
  Assert (!(Test-Path -LiteralPath (Join-Path $installRoot 'current.json'))) 'Interrupted install activated a partial release.'
  Assert (@(Get-ChildItem -LiteralPath (Join-Path $installRoot 'downloads') -Filter '*.part').Count -eq 1) 'Interrupted package was not retained.'
  $privateAcls = @{}
  foreach ($name in '.', 'profile', 'agent-state', 'versions') { $privateAcls[$name] = Access-Sddl (Join-Path $installRoot $name) }
  Run-Delivery @('update','--root',$installRoot)
  Assert ((Current-Version) -eq '1.0.0.0') 'Resume did not install N.'
  Assert ((Get-Content -Raw -LiteralPath (Join-Path $installRoot 'events.jsonl')).Contains('download-resumed')) 'HTTP range resume was not exercised.'
  $checks.Add('interrupted download resumed and activated only after validation')
  Assert-SandboxAccess '1.0.0.0'
  foreach ($name in $privateAcls.Keys) { Assert ((Access-Sddl (Join-Path $installRoot $name)) -eq $privateAcls[$name]) "Sandbox setup widened $name ACL." }
  $checks.Add('initial app executable and nested resources inherit both Chromium sandbox capabilities without widening profile, agent-state or ancestors')
  $profile = Join-Path $installRoot 'profile'
  foreach ($name in 'Preferences', 'Bookmarks', 'Login Data') { [IO.File]::WriteAllBytes((Join-Path $profile $name), [Text.Encoding]::UTF8.GetBytes("synthetic persistence: $name")) }
  $before = @{}; foreach ($name in 'Preferences', 'Bookmarks', 'Login Data') { $before[$name] = (Get-FileHash -LiteralPath (Join-Path $profile $name)).Hash }
  $launcher = Start-Process -FilePath (Join-Path $installRoot 'Velmren.exe') -ArgumentList @('launch','--root',('"' + $installRoot + '"')) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $work 'launcher.stdout.log') -RedirectStandardError (Join-Path $work 'launcher.stderr.log')
  Wait-For { Test-Path -LiteralPath (Join-Path $profile 'synthetic-running.txt') }
  Select-Release '1.0.0.1'
  Wait-For { Test-Path -LiteralPath (Join-Path $installRoot 'pending.json') }
  if ($CompactUpdate) {
    $compactEnvelope = Get-Content -LiteralPath (Join-Path $feed 'manifest-1.0.0.1.json') -Raw | ConvertFrom-Json
    $compactManifest = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($compactEnvelope.payload)) | ConvertFrom-Json
    Assert (Test-Path -LiteralPath (Join-Path $installRoot "downloads/$($compactManifest.compactArchive.sha256).7z")) 'Automatic updater did not select the signed compact archive.'
    Assert (!(Test-Path -LiteralPath (Join-Path $installRoot "downloads/$($compactManifest.sha256).zip"))) 'Automatic updater downloaded the compatibility ZIP unnecessarily.'
    $checks.Add('automatic update selects and verifies compact 7z while the compatibility ZIP stays available')
  }
  Assert ((Current-Version) -eq '1.0.0.0') 'Update activated while the application was running.'
  Assert (!$launcher.HasExited) 'The launcher exited before the deferred-activation check.'
  Wait-For { $launcher.HasExited }
  Assert ($launcher.ExitCode -eq 0) 'Launcher failed.'
  Assert ((Current-Version) -eq '1.0.0.1') 'Periodic update did not activate N+1 on exit.'
  Assert-SandboxAccess '1.0.0.1'
  foreach ($name in $privateAcls.Keys) { Assert ((Access-Sddl (Join-Path $installRoot $name)) -eq $privateAcls[$name]) "Update widened $name ACL." }
  $checks.Add('updated app inherits sandbox capabilities while private directory ACLs remain byte-for-byte unchanged')
  foreach ($name in $before.Keys) { Assert ((Get-FileHash -LiteralPath (Join-Path $profile $name)).Hash -eq $before[$name]) "Profile changed: $name" }
  $checks.Add('automatic periodic N -> N+1 with activation deferred until application exit')
  $checks.Add('synthetic settings, bookmarks, and password bytes preserved')
  Run-Delivery @('resolve','--root',$installRoot)
  $currentApp = Join-Path $installRoot 'versions/1.0.0.1/app'
  $expectedAppAcl = Access-Sddl $currentApp
  $withoutCapabilities = Get-Acl -LiteralPath $currentApp
  foreach ($sid in $sandboxCapabilities) { $withoutCapabilities.PurgeAccessRules([Security.Principal.SecurityIdentifier]::new($sid)) }
  Set-Acl -LiteralPath $currentApp -AclObject $withoutCapabilities
  Assert ((Access-Sddl $currentApp) -ne $expectedAppAcl) 'ACL repair fixture did not remove capability entries.'
  Run-Delivery @('resolve','--root',$installRoot)
  Assert-SandboxAccess '1.0.0.1'
  Assert ((Access-Sddl $currentApp) -eq $expectedAppAcl) 'ACL repair failed to preserve original unrelated ACEs.'
  Run-Delivery @('resolve','--root',$installRoot)
  Assert ((Access-Sddl $currentApp) -eq $expectedAppAcl) 'Repeated ACL repair was not idempotent.'
  foreach ($name in $privateAcls.Keys) { Assert ((Access-Sddl (Join-Path $installRoot $name)) -eq $privateAcls[$name]) "ACL repair widened $name ACL." }
  $checks.Add('resolve repairs legacy app ACLs idempotently and preserves unrelated ACEs')
  Select-Release '1.0.0.1'
  $bad = Get-Content -Raw -LiteralPath (Join-Path $feed 'latest.json') | ConvertFrom-Json
  $signature = [Convert]::FromBase64String($bad.signature); $signature[0] = $signature[0] -bxor 1; $bad.signature = [Convert]::ToBase64String($signature)
  $bad | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $feed 'latest.json') -Encoding utf8NoBOM
  Run-Delivery @('update','--root',$installRoot) $false
  Assert ((Current-Version) -eq '1.0.0.1') 'Bad signature changed active version.'
  $checks.Add('bad manifest signature rejected')
  Select-Release '1.0.0.0'
  Run-Delivery @('update','--root',$installRoot) $false
  $checks.Add('signed downgrade rejected')
  $originalEnvelope = Get-Content -Raw -LiteralPath (Join-Path $feed 'manifest-1.0.0.1.json') | ConvertFrom-Json
  $rebound = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($originalEnvelope.payload)) | ConvertFrom-Json
  $rebound.sha256 = 'a' * 64
  Sign-Manifest $rebound
  Run-Delivery @('update','--root',$installRoot) $false
  $checks.Add('signed same-version package rebinding rejected')
  Run-Delivery @('package','--payload',$payload,'--version','1.0.0.2','--feed-directory',$feed,'--private-key',$PrivateKey)
  $tampered = Join-Path $feed 'velmren-1.0.0.2.zip'
  $stream = [IO.File]::Open($tampered, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite)
  try { $stream.Position = 100; $old = $stream.ReadByte(); $stream.Position = 100; $stream.WriteByte($old -bxor 1) } finally { $stream.Dispose() }
  Run-Delivery @('update','--root',$installRoot) $false
  $checks.Add('package hash mismatch rejected')
  Hostile-Archive '1.0.0.3' 'traversal'
  Run-Delivery @('update','--root',$installRoot) $false
  Assert (!(Test-Path -LiteralPath (Join-Path $installRoot 'escaped.txt'))) 'Traversal escaped staging.'
  $checks.Add('signed ZIP traversal rejected before extraction')
  Hostile-Archive '1.0.0.4' 'symlink'
  Run-Delivery @('update','--root',$installRoot) $false
  Assert ((Current-Version) -eq '1.0.0.1') 'Rejected archive changed active version.'
  $checks.Add('signed ZIP symbolic-link entry rejected')
  $realTarget = Join-Path $work 'junction-target'; New-Item -ItemType Directory -Path $realTarget | Out-Null
  $junction = Join-Path $work 'junction'; New-Item -ItemType Junction -Path $junction -Target $realTarget | Out-Null
  Select-Release '1.0.0.1'
  Run-Delivery @('install','--root',(Join-Path $junction 'nested'),'--feed',"http://127.0.0.1:$Port/") $false
  Assert (!(Test-Path -LiteralPath (Join-Path $realTarget 'nested'))) 'Reparse installation target was followed.'
  $checks.Add('Windows junction destination rejected')
  $installedMarker = Join-Path $installRoot 'versions/1.0.0.1/app/release.txt'
  $originalMarker = [IO.File]::ReadAllBytes($installedMarker)
  $originalTimestamp = [IO.File]::GetLastWriteTimeUtc($installedMarker)
  $startCount = @(Get-Content -LiteralPath (Join-Path $installRoot 'events.jsonl') | Where-Object { $_.Contains('browser-started') }).Count
  try {
    $changed = [byte[]]$originalMarker.Clone()
    $changed[0] = $changed[0] -bxor 1
    [IO.File]::WriteAllBytes($installedMarker, $changed)
    [IO.File]::SetLastWriteTimeUtc($installedMarker, $originalTimestamp)
    Run-Delivery @('resolve','--root',$installRoot) $false
    Run-Delivery @('verify','--root',$installRoot) $false
  } finally { [IO.File]::WriteAllBytes($installedMarker, $originalMarker); [IO.File]::SetLastWriteTimeUtc($installedMarker, $originalTimestamp) }
  $checks.Add('same-size same-timestamp payload tampering rejected by full resolve and verify audits')
  foreach ($target in (Join-Path $currentApp 'delivery-app.json'), (Join-Path $installRoot 'versions/1.0.0.1/manifest.json')) {
    $original = [IO.File]::ReadAllBytes($target)
    try {
      $changed = [byte[]]$original.Clone(); $changed[25] = $changed[25] -bxor 1
      [IO.File]::WriteAllBytes($target, $changed)
      Run-Delivery @('launch','--root',$installRoot) $false
    } finally { [IO.File]::WriteAllBytes($target, $original) }
  }
  Assert (@(Get-Content -LiteralPath (Join-Path $installRoot 'events.jsonl') | Where-Object { $_.Contains('browser-started') }).Count -eq $startCount) 'Changed launch metadata started a browser.'
  $checks.Add('normal launch rejects modified signed manifest and launch configuration before execution')
  $extraFile = Join-Path $currentApp 'unlisted.txt'
  try {
    [IO.File]::WriteAllText($extraFile, 'not signed')
    Run-Delivery @('resolve','--root',$installRoot) $false
  } finally { [IO.File]::Delete($extraFile) }
  $missingBackup = Join-Path $work 'release-missing-backup.txt'
  try {
    [IO.File]::Move($installedMarker, $missingBackup)
    Run-Delivery @('resolve','--root',$installRoot) $false
  } finally { [IO.File]::Move($missingBackup, $installedMarker) }
  $checks.Add('extra and missing installed files rejected')
  $startCount = @(Get-Content -LiteralPath (Join-Path $installRoot 'events.jsonl') | Where-Object { $_.Contains('browser-started') }).Count
  foreach ($invalidUrl in '--user-data-dir=C:/outside-profile', '--remote-debugging-port=9222', 'file:///C:/Windows/win.ini', 'javascript:alert(1)', 'chrome://settings', 'relative/path') {
    Run-Delivery @('launch','--root',$installRoot,"--url=$invalidUrl") $false
  }
  Assert (@(Get-Content -LiteralPath (Join-Path $installRoot 'events.jsonl') | Where-Object { $_.Contains('browser-started') }).Count -eq $startCount) 'Invalid URL started a browser.'
  $checks.Add('URL switches, local files, scripts, internal routes and relative paths rejected before launch')
  $settingsPath = Join-Path $installRoot 'installation.json'
  $originalSettings = [IO.File]::ReadAllBytes($settingsPath)
  try {
    foreach ($mode in 'manifest', 'package') {
      if ($mode -eq 'package') { Run-Delivery @('package','--payload',$payload,'--version','1.0.0.5','--feed-directory',$feed,'--private-key',$PrivateKey) }
      $stallPort = $Port + $(if ($mode -eq 'manifest') { 1 } else { 2 })
      $stallLog = Join-Path $work "stalled-$mode.stdout.log"
      $stallServer = Start-Process -FilePath $Installer -ArgumentList @('serve','--directory',('"' + $feed + '"'),'--port',"$stallPort",'--stall-first',$mode) -WindowStyle Hidden -PassThru -RedirectStandardOutput $stallLog -RedirectStandardError (Join-Path $work "stalled-$mode.stderr.log")
      Wait-For { (Test-Path -LiteralPath $stallLog) -and ((Get-Content -Raw -LiteralPath $stallLog) -match 'listening') }
      $settings = [Text.Encoding]::UTF8.GetString($originalSettings) | ConvertFrom-Json
      $settings.feed = "http://127.0.0.1:$stallPort/"
      $settings.pollSeconds = 120
      $settings | ConvertTo-Json | Set-Content -LiteralPath $settingsPath -Encoding utf8NoBOM
      $runningMarker = Join-Path $profile 'synthetic-running.txt'
      $oldPid = Get-Content -Raw -LiteralPath $runningMarker
      $timer = [Diagnostics.Stopwatch]::StartNew()
      $stallLauncher = Start-Process -FilePath (Join-Path $installRoot 'Velmren.exe') -ArgumentList @('launch','--root',('"' + $installRoot + '"')) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $work "stalled-$mode-launcher.stdout.log") -RedirectStandardError (Join-Path $work "stalled-$mode-launcher.stderr.log")
      Wait-For { $newPid = Get-Content -Raw -LiteralPath $runningMarker; $newPid -match '^\d+$' -and $newPid -ne $oldPid } 12
      $timer.Stop()
      $startupSeconds[$mode] = [Math]::Round($timer.Elapsed.TotalSeconds, 2)
      Assert ($timer.Elapsed.TotalSeconds -lt 4) "Stalled $mode blocked browser startup."
      Wait-For { (Get-Content -Raw -LiteralPath $stallLog).Contains("Stalling $mode body after headers and 1 byte.") } 8
      $launcherLog = Join-Path $work "stalled-$mode-launcher.stdout.log"
      Wait-For { (Get-Content -Raw -LiteralPath $launcherLog).Contains('Initial update check exceeded') } 8
      Assert ((Current-Version) -eq '1.0.0.1') "Stalled $mode changed active release."
      $lockProbe = [IO.File]::Open((Join-Path $installRoot 'operation.lock'), [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
      $lockProbe.Dispose()
      if ($mode -eq 'package') {
        $envelope = Get-Content -Raw -LiteralPath (Join-Path $feed 'latest.json') | ConvertFrom-Json
        $offered = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($envelope.payload)) | ConvertFrom-Json
        $partial = Join-Path $installRoot "downloads/$($offered.sha256).zip.part"
        Assert ((Test-Path -LiteralPath $partial) -and (Get-Item -LiteralPath $partial).Length -eq 1) 'Stalled archive did not retain the resumable partial body.'
      }
      $checks.Add("browser starts before stalled $mode request; background timeout releases operation lock")
      foreach ($process in @($stallLauncher, $stallServer)) { if (!$process.HasExited) { $process.Kill($true); $process.WaitForExit() }; $process.Dispose() }
      $stallLauncher = $null; $stallServer = $null
    }
  } finally { [IO.File]::WriteAllBytes($settingsPath, $originalSettings) }
  Select-Release '1.0.0.1'
  $operationLease = [IO.File]::Open((Join-Path $installRoot 'operation.lock'), [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  $eventLease = [IO.File]::Open((Join-Path $installRoot 'events.jsonl'), [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  try {
    $runningMarker = Join-Path $profile 'synthetic-running.txt'
    $oldPid = Get-Content -LiteralPath $runningMarker -Raw
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $stallLauncher = Start-Process -FilePath (Join-Path $installRoot 'Velmren.exe') -ArgumentList @('launch','--root',('"' + $installRoot + '"')) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $work 'busy-update-launch.stdout.log') -RedirectStandardError (Join-Path $work 'busy-update-launch.stderr.log')
    Wait-For { (Get-Content -LiteralPath $runningMarker -Raw) -ne $oldPid } 4
    $startupSeconds['busyUpdater'] = [Math]::Round($timer.Elapsed.TotalSeconds, 2)
    Assert ($timer.Elapsed.TotalSeconds -lt 4) 'Updater operation lock blocked a committed browser launch.'
    $checks.Add('normal launch starts while another updater owns operation.lock')
    $leaseProtected = $false
    try { $probe = [IO.File]::Open((Join-Path $installRoot 'run.lock'), [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None); $probe.Dispose() }
    catch [IO.IOException] { $leaseProtected = $true }
    Assert $leaseProtected 'Log contention released supervision of a running browser.'
    $checks.Add('busy diagnostic log does not abort launch or release the shared activation lease')
  } finally { $eventLease.Dispose(); $operationLease.Dispose() }
  Wait-For { $stallLauncher.HasExited } 25
  Assert ($stallLauncher.ExitCode -eq 0) 'Concurrent launch failed after the updater lease was released.'
  $stallLauncher.Dispose(); $stallLauncher = $null

  $currentPath = Join-Path $installRoot 'current.json'
  $previousCurrent = [IO.File]::ReadAllBytes($currentPath)
  try {
    [IO.File]::Delete($currentPath)
    Run-Delivery @('launch','--root',$installRoot)
    Assert ((Current-Version) -eq '1.0.0.1') 'Missing-current startup recovery failed.'
    $checks.Add('missing-current recovery releases shared launch lease before full activation')
  } finally { if (!(Test-Path -LiteralPath $currentPath)) { [IO.File]::WriteAllBytes($currentPath, $previousCurrent) } }
  $result = [pscustomobject]@{passed=$true;checks=$checks;startupSeconds=$startupSeconds;installation=$installRoot;trust='test-only signed manifests; unsigned Windows binaries';syntheticProfileOnly=$true}
  $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $work 'result.json') -Encoding utf8NoBOM
  $result | ConvertTo-Json -Depth 5
} finally {
  foreach ($process in @($launcher, $server, $stallLauncher, $stallServer)) { if ($null -ne $process -and !$process.HasExited) { $process.Kill($true); $process.WaitForExit() }; if ($null -ne $process) { $process.Dispose() } }
}
