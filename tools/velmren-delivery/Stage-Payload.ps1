[CmdletBinding()]
param(
  [Parameter(Mandatory)][Alias('ComponentDirectory')][string]$BrowserDirectory,
  [Parameter(Mandatory)][string]$AgentDirectory,
  [Parameter(Mandatory)][string]$Destination,
  [string]$NodeExecutable = (Get-Command node -ErrorAction Stop).Source,
  [string]$DeliveryEngine,
  [string]$MaintenanceExecutable,
  [string]$NodeLicense
)
$ErrorActionPreference = 'Stop'
function Assert-NoReparse([string]$Path) {
  $current = [IO.Path]::GetFullPath($Path)
  while ($current) {
    if (Test-Path -LiteralPath $current) {
      if ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse path rejected: $current" }
    }
    $current = [IO.Path]::GetDirectoryName($current)
  }
}
$target = [IO.Path]::GetFullPath($Destination)
foreach ($source in $BrowserDirectory, $AgentDirectory) {
  $sourceRoot = [IO.Path]::GetFullPath($source).TrimEnd('\', '/')
  if (!(Test-Path -LiteralPath $sourceRoot -PathType Container)) { throw "Source directory is missing: $sourceRoot" }
  if ($target.TrimEnd('\', '/') -eq $sourceRoot -or $target.StartsWith($sourceRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Payload destination must be outside browser and agent source directories.'
  }
}
if ((Test-Path -LiteralPath $target) -and !(Test-Path -LiteralPath $target -PathType Container)) { throw 'Payload destination must be a directory.' }
if (!$NodeLicense) { $NodeLicense = Join-Path ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($NodeExecutable))) 'LICENSE' }
foreach ($path in $target, $BrowserDirectory, $AgentDirectory, $NodeExecutable) { Assert-NoReparse $path }
if ([bool]$DeliveryEngine -ne [bool]$MaintenanceExecutable) { throw 'Provide both DeliveryEngine and MaintenanceExecutable for an installable release.' }
foreach ($path in @($DeliveryEngine, $MaintenanceExecutable, $NodeLicense) | Where-Object { $_ }) { Assert-NoReparse $path }
foreach ($path in @($NodeExecutable, $NodeLicense, $DeliveryEngine, $MaintenanceExecutable, (Join-Path $BrowserDirectory 'velmren.exe'), (Join-Path $AgentDirectory 'broker.mjs')) | Where-Object { $_ }) {
  if (!(Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required payload input is missing: $path" }
}
foreach ($name in 'public', 'node_modules') {
  if (!(Test-Path -LiteralPath (Join-Path $AgentDirectory $name) -PathType Container)) { throw "Agent $name directory is required; prepare production dependencies before staging." }
}
if ((Test-Path -LiteralPath $target) -and @(Get-ChildItem -LiteralPath $target -Force).Count) {
  throw 'Payload staging destination must be new or empty.'
}
function Copy-TreeSafe([string]$Source, [string]$Target) {
  $item = Get-Item -LiteralPath $Source -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse source rejected: $Source" }
  if ($item.PSIsContainer) {
    New-Item -ItemType Directory -Path $Target -Force | Out-Null
    foreach ($child in Get-ChildItem -LiteralPath $Source -Force) {
      Copy-TreeSafe $child.FullName (Join-Path $Target $child.Name)
    }
  } else {
    Copy-Item -LiteralPath $Source -Destination $Target
  }
}
$browser = Join-Path $target 'browser'
$agent = Join-Path $target 'agent'
$runtime = Join-Path $target 'runtime'
New-Item -ItemType Directory -Path $browser, $agent, $runtime -Force | Out-Null
if (!(Test-Path -LiteralPath (Join-Path $BrowserDirectory 'velmren.exe'))) { throw 'Browser velmren.exe is missing.' }
$runtimePaks = @(
  'brave_100_percent.pak', 'brave_200_percent.pak', 'brave_resources.pak',
  'chrome_100_percent.pak', 'chrome_200_percent.pak',
  'headless_command_resources.pak', 'resources.pak'
)
foreach ($file in Get-ChildItem -LiteralPath $BrowserDirectory -File) {
  # These are build/test diagnostics, excluded by Chromium's Windows release manifest.
  if ($file.Name -in 'VkLayer_khronos_validation.dll', 'VkICD_mock_icd.dll', 'dbghelp.dll', 'dbgcore.dll', 'msdia140.dll', 'symsrv.dll', 'test_trace_processor.dll') { continue }
  # Native browser tests share this output directory; their resource packs are not runtime inputs.
  if ($file.Extension -eq '.pak' -and $file.Name -notin $runtimePaks) { continue }
  if ($file.Extension -in '.dll', '.pak', '.bin', '.dat', '.manifest' -or $file.Name -in 'velmren.exe', 'chrome_proxy.exe', 'chrome_pwa_launcher.exe', 'notification_helper.exe', 'vulkan-1.dll', 'vk_swiftshader_icd.json') {
    Copy-TreeSafe $file.FullName (Join-Path $browser $file.Name)
  }
}
$locales = Join-Path $BrowserDirectory 'locales'
if (Test-Path -LiteralPath $locales) {
  Assert-NoReparse $locales
  $localesTarget = Join-Path $browser 'locales'
  New-Item -ItemType Directory -Path $localesTarget -Force | Out-Null
  # .pak.info contains GRIT build-time resource/source mappings, never runtime translations.
  foreach ($locale in Get-ChildItem -LiteralPath $locales -File -Filter '*.pak') {
    Copy-TreeSafe $locale.FullName (Join-Path $localesTarget $locale.Name)
  }
}
foreach ($name in 'resources', 'MEIPreload', 'IwaKeyDistribution', 'hyphen-data') {
  $source = Join-Path $BrowserDirectory $name
  if (Test-Path -LiteralPath $source) { Copy-TreeSafe $source (Join-Path $browser $name) }
}
foreach ($file in Get-ChildItem -LiteralPath $AgentDirectory -File) {
  if ($file.Extension -in '.mjs', '.json', '.md', '.ps1') { Copy-TreeSafe $file.FullName (Join-Path $agent $file.Name) }
}
Copy-TreeSafe (Join-Path $AgentDirectory 'public') (Join-Path $agent 'public')
$modules = Join-Path $AgentDirectory 'node_modules'
if (!(Test-Path -LiteralPath $modules)) { throw 'Agent production node_modules are required; run npm ci --omit=dev in the agent project first.' }
Copy-TreeSafe $modules (Join-Path $agent 'node_modules')
Copy-TreeSafe $NodeExecutable (Join-Path $runtime 'node.exe')
$config = @{
  browser = 'browser/velmren.exe'
  browserArguments = @()
  agent = 'runtime/node.exe'
  agentArguments = @('agent/broker.mjs', 'daemon', '--browser', '{browser}', '--state-dir', '{agentStateDir}', '--port', '0')
}
if ($DeliveryEngine) {
  $delivery = Join-Path $target 'delivery'
  New-Item -ItemType Directory -Path $delivery -Force | Out-Null
  Copy-TreeSafe $DeliveryEngine (Join-Path $delivery 'Velmren.exe')
  Copy-TreeSafe $MaintenanceExecutable (Join-Path $delivery 'VelmrenMaintenance.exe')
  $config.launcher = 'delivery/Velmren.exe'
  $config.setup = 'delivery/VelmrenMaintenance.exe'
}
$licenses = Join-Path $target 'licenses'
New-Item -ItemType Directory -Path $licenses -Force | Out-Null
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
Copy-TreeSafe (Join-Path $repo 'LICENSE') (Join-Path $licenses 'Brave-MPL-2.0.txt')
Copy-TreeSafe (Join-Path $repo '../LICENSE') (Join-Path $licenses 'Chromium-LICENSE.txt')
Copy-TreeSafe $NodeLicense (Join-Path $licenses 'Node-LICENSE.txt')
Copy-TreeSafe (Join-Path $repo 'components/velmren/resources/licenses') (Join-Path $licenses 'Shields')
Copy-TreeSafe (Join-Path $repo 'components/velmren/resources/PROVENANCE.json') (Join-Path $licenses 'Shields-PROVENANCE.json')
if ($DeliveryEngine) {
  Copy-TreeSafe (Join-Path $PSScriptRoot 'THIRD-PARTY-NOTICES.txt') (Join-Path $licenses 'Delivery-THIRD-PARTY-NOTICES.txt')
  Copy-TreeSafe (Join-Path $PSScriptRoot 'native/LZMA-SDK-26.05.txt') (Join-Path $licenses 'LZMA-SDK-26.05.txt')
}
$config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $target 'delivery-app.json') -Encoding utf8NoBOM
$files = @(Get-ChildItem -LiteralPath $target -File -Recurse)
[pscustomobject]@{ Payload = $target; Files = $files.Count; Bytes = ($files | Measure-Object Length -Sum).Sum } | ConvertTo-Json
