#requires -Version 5.1
# Synthetic files only. No real installation, registry access, or browser launch.
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$OutputDirectory)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Write-Utf8([string]$Path, [string]$Text) {
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path))
    [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false))
}
function Collect([string]$Root, [string]$Destination) {
    $before = @(Get-ChildItem -LiteralPath $Destination -Directory | ForEach-Object { $_.Name })
    & $script:Collector -InstallRoot $Root -OutputParent $Destination | Out-Null
    $created = @(Get-ChildItem -LiteralPath $Destination -Directory | Where-Object { $before -notcontains $_.Name })
    Assert ($created.Count -eq 1) 'Collector must create exactly one new report directory.'
    $directory = $created[0].FullName
    $entries = @(Get-ChildItem -LiteralPath $directory -File)
    Assert ($entries.Count -eq 2) 'Report directory must contain only JSON and ZIP.'
    $jsonPath = Join-Path $directory 'report.json'
    $text = [IO.File]::ReadAllText($jsonPath)
    Assert (-not $text.Contains($script:Secret)) 'Private marker leaked into JSON.'
    Assert (-not $text.Contains($Root)) 'Installation path leaked into JSON.'
    if ($env:USERNAME) { Assert (-not $text.Contains($env:USERNAME)) 'Local username leaked into JSON.' }
    $zip = [IO.Compression.ZipFile]::OpenRead((Join-Path $directory 'report.zip'))
    try {
        Assert ($zip.Entries.Count -eq 1 -and $zip.Entries[0].FullName -eq 'report.json') 'ZIP contains unexpected files.'
        $reader = New-Object IO.StreamReader ($zip.Entries[0].Open())
        try { Assert ($reader.ReadToEnd() -ceq $text) 'ZIP report differs from JSON.' }
        finally { $reader.Dispose() }
    } finally { $zip.Dispose() }
    return (ConvertFrom-Json -InputObject $text)
}

if (Test-Path -LiteralPath $OutputDirectory) { throw 'Use a new test output directory.' }
[void][IO.Directory]::CreateDirectory($OutputDirectory)
$base = [IO.Path]::GetFullPath($OutputDirectory)
$script:Collector = Join-Path $PSScriptRoot 'Collect-VelmrenDiagnostics.ps1'
$script:Secret = 'PRIVATE-CONTENT-MUST-NOT-BE-EXPORTED-72819'
$root = Join-Path $base 'synthetic-install'
$reports = Join-Path $base 'reports'
[void][IO.Directory]::CreateDirectory($reports)
$version = '156.1.98.0'
$app = Join-Path $root ('versions\' + $version + '\app')
foreach ($name in @('Velmren.exe', 'VelmrenMaintenance.exe')) { Write-Utf8 (Join-Path $root $name) 'synthetic binary; do not execute' }
foreach ($name in @('browser\velmren.exe', 'browser\chrome.dll', 'runtime\node.exe', 'agent\broker.mjs')) { Write-Utf8 (Join-Path $app $name) 'synthetic payload; do not execute' }
Write-Utf8 (Join-Path $root 'current.json') ('{"version":"' + $version + '","extra":"' + $script:Secret + '"}')
foreach ($name in @('profile\Cookies', 'profile\History', 'profile\Login Data', 'agent-state\private.pem', 'installation.json')) {
    Write-Utf8 (Join-Path $root $name) $script:Secret
}
$journal = New-Object Text.StringBuilder
for ($index = 0; $index -lt 280; $index++) {
    $detail = $script:Secret + ('x' * 500)
    $action = if (($index % 2) -eq 0) { 'browser-started' } else { 'update-check-failed' }
    [void]$journal.AppendLine((@{ time = '2026-10-31T10:11:12.1234567+00:00'; action = $action; version = $version; detail = $detail } | ConvertTo-Json -Compress))
}
foreach ($entry in @(
    @{ time = '2026-10-31T10:11:12Z'; action = $script:Secret; version = $version },
    @{ time = $script:Secret; action = 'activated'; version = $version },
    @{ time = '2026-10-31T10:11:12Z'; action = 'activated'; version = '..\profile' },
    @{ time = '2026-10-31T10:11:12Z'; action = 'activated'; version = '01.2.3.4' },
    @{ time = '2026-10-31T10:11:12Z'; action = 'activated'; version = '9999999999.2.3.4' },
    @{ time = '2026-10-31T10:11:12Z'; action = 'activated'; version = $version; detail = ('x' * 4500) },
    @{ time = '2026-10-31T11:12:13Z'; action = 'browser-exited'; version = $version; detail = $script:Secret },
    @{ time = '2026-10-31T11:12:14Z'; action = 'update-check-failed'; version = $null; detail = $script:Secret }
)) { [void]$journal.AppendLine(($entry | ConvertTo-Json -Compress)) }
[void]$journal.Append('{"partial":')
Write-Utf8 (Join-Path $root 'events.jsonl') $journal.ToString()
$before = @(Get-ChildItem -LiteralPath $root -Recurse -File | ForEach-Object { (Get-FileHash -LiteralPath $_.FullName).Hash }) -join ','
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$report = Collect $root $reports
Assert ($report.system.powerShellVersion -like '5.1.*') 'Run this regression with Windows PowerShell 5.1.'
Assert ($report.installation.status -eq 'present' -and $report.installation.current.version -eq $version) 'Valid installation pointer was not recognized.'
Assert ($report.installation.files.Count -eq 6 -and @($report.installation.files | Where-Object { $_.status -ne 'present' }).Count -eq 0) 'Fixed payload metadata was not collected.'
Assert ($report.events.truncated -and $report.events.records.Count -gt 0 -and $report.events.records.Count -le 200) 'Bounded journal tail was not collected.'
Assert ($report.events.skippedRecords -ge 7) 'Invalid, oversized, and partial records must be skipped.'
Assert ($report.events.records[-1].action -eq 'update-check-failed' -and $null -eq $report.events.records[-1].version) 'Valid event without a version was lost.'
foreach ($event in $report.events.records) { Assert (($event.PSObject.Properties.Name -join ',') -eq 'timeUtc,action,version') 'An event included an unexpected property.' }
$after = @(Get-ChildItem -LiteralPath $root -Recurse -File | ForEach-Object { (Get-FileHash -LiteralPath $_.FullName).Hash }) -join ','
Assert ($before -ceq $after) 'Collector modified synthetic installation files.'

$timingDetails = @(
    (@{ preparationMs = 120; settingsMs = 2.5; lockWaitMs = 0; validationMs = 90; processStartMs = 20; path = $script:Secret; exception = $script:Secret } | ConvertTo-Json -Compress),
    (@{ preparationMs = -1; settingsMs = '123'; lockWaitMs = $true; validationMs = 86400001; processStartMs = @{ secret = $script:Secret } } | ConvertTo-Json -Compress),
    ('invalid-json-' + $script:Secret)
)
$timingJournal = New-Object Text.StringBuilder
foreach ($detail in $timingDetails) {
    [void]$timingJournal.AppendLine((@{ time = '2026-11-02T12:13:14Z'; action = 'launch-timing'; version = $version; detail = $detail } | ConvertTo-Json -Compress))
}
[void]$timingJournal.AppendLine((@{ time = '2026-11-02T12:13:14Z'; action = 'browser-started'; version = $version; detail = $timingDetails[0] } | ConvertTo-Json -Compress))
Write-Utf8 (Join-Path $root 'events.jsonl') $timingJournal.ToString()
$timed = Collect $root $reports
Assert ($timed.events.records.Count -eq 4) 'Malformed timing details must preserve safe event metadata.'
$timing = $timed.events.records[0].timingsMs
Assert (($timing.PSObject.Properties.Name -join ',') -eq 'preparationMs,settingsMs,lockWaitMs,validationMs,processStartMs') 'Timing whitelist changed or private properties leaked.'
Assert ($timing.preparationMs -eq 120 -and $timing.settingsMs -eq 2.5 -and $timing.lockWaitMs -eq 0 -and $timing.validationMs -eq 90 -and $timing.processStartMs -eq 20) 'Safe numeric timing measurements were lost.'
foreach ($event in $timed.events.records[1..3]) {
    Assert (($event.PSObject.Properties.Name -join ',') -eq 'timeUtc,action,version') 'Invalid timing values or unrelated event details were exported.'
}

$shortEvent = '{"time":"2026-10-31T12:13:14Z","action":"activated","version":"156.1.98.0"}'
Write-Utf8 (Join-Path $root 'events.jsonl') (($shortEvent + "`n") * 250)
$limited = Collect $root $reports
Assert ($limited.events.records.Count -eq 200 -and $limited.events.truncated) 'Record limit did not retain the last 200 records.'

$missing = Collect (Join-Path $base 'does-not-exist') $reports
Assert ($missing.installation.status -eq 'missing' -and $missing.events.status -eq 'missing') 'Missing installation must be reported without failure.'
Write-Utf8 (Join-Path $root 'current.json') ('x' * 4097)
$oversized = Collect $root $reports
Assert ($oversized.installation.current.status -eq 'too-large' -and $oversized.installation.files.Count -eq 2) 'Oversized pointer was not rejected.'
Write-Utf8 (Join-Path $root 'current.json') '{"version":"..\\profile"}'
$invalid = Collect $root $reports
Assert ($null -eq $invalid.installation.current.version -and $invalid.installation.files.Count -eq 2) 'Invalid pointer influenced payload paths.'
$denied = $false
try { & $script:Collector -InstallRoot $root -OutputParent $root | Out-Null } catch { $denied = $true }
Assert $denied 'Collector allowed output inside the installation.'
$denied = $false
try { & $script:Collector -InstallRoot $root -OutputParent '\\localhost\share' | Out-Null } catch { $denied = $true }
Assert $denied 'Collector allowed a network output path.'

$linkedRoot = Join-Path $base 'linked-install'
[void](New-Item -ItemType Junction -Path $linkedRoot -Target $root)
$linked = Collect $linkedRoot $reports
Assert ($linked.installation.status -eq 'unavailable-or-linked' -and $linked.events.records.Count -eq 0) 'Collector followed a linked installation.'
$denied = $false
try { & $script:Collector -InstallRoot (Join-Path $base 'does-not-exist') -OutputParent $linkedRoot | Out-Null } catch { $denied = $true }
Assert $denied 'Collector allowed output through a linked directory.'
Write-Output ('PASS: Windows PowerShell 5.1 synthetic diagnostics; artifacts retained in ' + $base)
