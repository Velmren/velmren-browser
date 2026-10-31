#requires -Version 5.1
<#
Creates a local JSON report and a ZIP containing only that report.
Reads fixed installation paths only; never reads profile or agent-state.
No registry, process control, network calls, or raw error/detail export.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$OutputParent,
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Programs\Velmren')
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$script:JsonHasDateKind = (Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')

function Read-Json([string]$Text) {
    $arguments = @{ InputObject = $Text }
    # PowerShell 7.5+ otherwise converts timestamps before validation.
    if ($script:JsonHasDateKind) { $arguments.DateKind = 'String' }
    return (ConvertFrom-Json @arguments)
}

function Resolve-LocalPath([string]$Value) {
    $normalized = $Value.Replace('/', '\')
    if ($normalized -notmatch '\A[A-Za-z]:\\') {
        throw 'Use an absolute local drive path.'
    }
    $fullPath = [IO.Path]::GetFullPath($normalized)
    $drive = New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($fullPath))
    if ($drive.DriveType -notin @([IO.DriveType]::Fixed, [IO.DriveType]::Removable)) {
        throw 'A local fixed or removable drive is required.'
    }
    if ($fullPath.Length -eq 3) { return $fullPath }
    return $fullPath.TrimEnd('\')
}

function Assert-NoLinks([string]$Path) {
    $cursor = $Path
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'Linked paths are excluded from diagnostics.'
            }
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
}

function Get-FileStatus([string]$RelativePath) {
    $result = [ordered]@{ path = $RelativePath; status = 'missing' }
    try {
        $path = Join-Path $script:Root $RelativePath
        Assert-NoLinks $path
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            $item = Get-Item -LiteralPath $path -Force
            $result.status = 'present'
            $result.bytes = $item.Length
            $result.lastWriteUtc = $item.LastWriteTimeUtc.ToString('o')
        }
    } catch { $result.status = 'unavailable-or-linked' }
    return [pscustomobject]$result
}

function Read-BoundedUtf8([string]$Path, [int]$Limit, [bool]$Tail) {
    Assert-NoLinks $Path
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return @{ status = 'missing'; text = ''; truncated = $false }
    }
    $stream = $null
    try {
        $sharing = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
        $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, $sharing)
        $length = $stream.Length
        if (-not $Tail -and $length -gt $Limit) {
            return @{ status = 'too-large'; text = ''; truncated = $true }
        }
        $start = [Math]::Max([long]0, $length - $Limit)
        if (-not $Tail) { $start = 0 }
        [void]$stream.Seek($start, [IO.SeekOrigin]::Begin)
        $count = [int][Math]::Min([long]$Limit, $length - $start)
        $buffer = New-Object byte[] $count
        $read = 0
        while ($read -lt $count) {
            $next = $stream.Read($buffer, $read, $count - $read)
            if ($next -eq 0) { break }
            $read += $next
        }
        # A byte tail can begin inside a UTF-8 character or a JSON record.
        $offset = 0
        if ($start -gt 0) {
            while ($offset -lt $read -and $buffer[$offset] -ne 10) { $offset++ }
            if ($offset -lt $read) { $offset++ }
        }
        $encoding = New-Object Text.UTF8Encoding ($false, $true)
        $body = $encoding.GetString($buffer, $offset, $read - $offset).TrimStart([char]0xFEFF)
        return @{ status = 'read'; text = $body; truncated = ($start -gt 0) }
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

function Get-CanonicalVersion($Value) {
    if ($Value -isnot [string] -or $Value -notmatch '\A(0|[1-9][0-9]{0,9})\.(0|[1-9][0-9]{0,9})\.(0|[1-9][0-9]{0,9})\.(0|[1-9][0-9]{0,9})\z') {
        return $null
    }
    $parsed = $null
    if (-not [Version]::TryParse($Value, [ref]$parsed)) { return $null }
    return $Value
}

function Get-CurrentVersion {
    try {
        $source = Read-BoundedUtf8 (Join-Path $script:Root 'current.json') 4096 $false
        if ($source.status -ne 'read') { return @{ status = $source.status; version = $null } }
        $pointer = Read-Json $source.text
        $version = Get-CanonicalVersion $pointer.version
        if (-not $version) { return @{ status = 'invalid'; version = $null } }
        return @{ status = 'read'; version = $version }
    } catch { return @{ status = 'unavailable-or-invalid'; version = $null } }
}

function Get-SafeEvents {
    $result = [ordered]@{ status = 'missing'; byteLimit = 65536; recordLimit = 200; truncated = $false; skippedRecords = 0; records = @() }
    $allowedActions = @(
        'up-to-date', 'staged', 'download-resumed', 'downloaded',
        'activation-deferred', 'launcher-update-rejected', 'activated',
        'agents-started', 'browser-started', 'launch-timing', 'update-check-failed',
        'agents-exited', 'browser-exited', 'installed', 'registered',
        'registration-refreshed', 'registration-refresh-failed',
        'launcher-bootstrap-updated', 'launcher-replaced', 'launcher-update-complete',
        'launcher-recovered-committed', 'launcher-update-rolled-back'
    )
    try {
        $source = Read-BoundedUtf8 (Join-Path $script:Root 'events.jsonl') 65536 $true
        $result.status = $source.status
        $result.truncated = $source.truncated
        if ($source.status -ne 'read') { return [pscustomobject]$result }
        $lines = @($source.text -split '\r?\n' | Where-Object { $_.Length -gt 0 })
        if ($lines.Count -gt 200) { $result.truncated = $true; $lines = $lines[($lines.Count - 200)..($lines.Count - 1)] }
        $records = New-Object 'Collections.Generic.List[object]'
        foreach ($line in $lines) {
            try {
                if ($line.Length -gt 4096) { throw 'Record too large.' }
                $entry = Read-Json $line
                if ($entry.action -isnot [string] -or $allowedActions -cnotcontains $entry.action) { throw 'Unknown action.' }
                if ($entry.time -isnot [string] -or $entry.time -notmatch '\A[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,7})?(Z|[+-][0-9]{2}:[0-9]{2})\z') { throw 'Invalid time.' }
                $time = [DateTimeOffset]::Parse($entry.time, [Globalization.CultureInfo]::InvariantCulture)
                $version = Get-CanonicalVersion $entry.version
                if ($null -ne $entry.version -and -not $version) { throw 'Invalid version.' }
                # Never serialize the original record, detail, exception, or path.
                $records.Add([pscustomobject][ordered]@{ timeUtc = $time.UtcDateTime.ToString('o'); action = $entry.action; version = $version })
            } catch { $result.skippedRecords++ }
        }
        $result.records = @($records.ToArray())
    } catch { $result.status = 'unavailable-or-invalid' }
    return [pscustomobject]$result
}

try {
    $script:Root = Resolve-LocalPath $InstallRoot
    $destinationParent = Resolve-LocalPath $OutputParent
    Assert-NoLinks $destinationParent
    if (-not (Test-Path -LiteralPath $destinationParent -PathType Container)) { throw 'Output parent must already exist.' }
    if ($destinationParent.Equals($script:Root, [StringComparison]::OrdinalIgnoreCase) -or
        $destinationParent.StartsWith($script:Root + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Choose an output folder outside the installation.'
    }
} catch { throw 'Use an existing local output folder outside the installation; linked and network paths are not supported.' }

$installStatus = 'missing'
try {
    Assert-NoLinks $script:Root
    if (Test-Path -LiteralPath $script:Root -PathType Container) { $installStatus = 'present' }
} catch { $installStatus = 'unavailable-or-linked' }

$current = Get-CurrentVersion
$files = @('Velmren.exe', 'VelmrenMaintenance.exe')
if ($current.version) {
    $versionPrefix = 'versions\' + $current.version + '\app\'
    $files += @($versionPrefix + 'browser\velmren.exe'; $versionPrefix + 'browser\chrome.dll'; $versionPrefix + 'runtime\node.exe'; $versionPrefix + 'agent\broker.mjs')
}
$defaultRoot = Resolve-LocalPath (Join-Path $env:LOCALAPPDATA 'Programs\Velmren')
$location = if ($script:Root.Equals($defaultRoot, [StringComparison]::OrdinalIgnoreCase)) { '%LOCALAPPDATA%\Programs\Velmren' } else { '<custom-install-folder>' }
$report = [ordered]@{
    schema = 1
    collectedUtc = [DateTime]::UtcNow.ToString('o')
    system = [ordered]@{
        windowsVersion = [Environment]::OSVersion.Version.ToString()
        os64Bit = [Environment]::Is64BitOperatingSystem
        process64Bit = [Environment]::Is64BitProcess
        powerShellVersion = $PSVersionTable.PSVersion.ToString()
    }
    installation = [ordered]@{ location = $location; status = $installStatus; current = $current; files = @($files | ForEach-Object { Get-FileStatus $_ }) }
    events = Get-SafeEvents
}

# CreateNew prevents replacing an existing report; the ZIP includes only our JSON.
$directoryName = 'Velmren-diagnostics-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$outputDirectory = Join-Path $destinationParent $directoryName
if (Test-Path -LiteralPath $outputDirectory) { throw 'Output directory already exists.' }
[void][IO.Directory]::CreateDirectory($outputDirectory)
$jsonPath = Join-Path $outputDirectory 'report.json'
$jsonStream = [IO.File]::Open($jsonPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try {
    $jsonBytes = (New-Object Text.UTF8Encoding $false).GetBytes(($report | ConvertTo-Json -Depth 8))
    $jsonStream.Write($jsonBytes, 0, $jsonBytes.Length)
} finally { $jsonStream.Dispose() }

$zipPath = Join-Path $outputDirectory 'report.zip'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::Open($zipPath, [IO.Compression.ZipArchiveMode]::Create)
try { [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $jsonPath, 'report.json') }
finally { $zip.Dispose() }

Write-Output ('Report folder: ' + $outputDirectory)
Write-Output 'Only report.json is included in report.zip. Nothing was uploaded.'
