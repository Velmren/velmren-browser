[CmdletBinding()]
param(
  [string]$BuildRoot = (Join-Path $PSScriptRoot '../../../..'),
  [ValidateRange(1,16)][int]$Jobs = 4,
  [string]$Target = 'brave',
  [string]$EnvironmentScript
)
$ErrorActionPreference = 'Stop'
$BuildRoot = [IO.Path]::GetFullPath($BuildRoot)
if (!$PSBoundParameters.ContainsKey('EnvironmentScript')) {
  $localEnvironment = Join-Path $BuildRoot 'Enter-VelmrenEnvironment.ps1'
  if (Test-Path -LiteralPath $localEnvironment -PathType Leaf) {
    $EnvironmentScript = $localEnvironment
  }
}
if ($EnvironmentScript) {
  $EnvironmentScript = [IO.Path]::GetFullPath($EnvironmentScript)
  if (!(Test-Path -LiteralPath $EnvironmentScript -PathType Leaf)) {
    throw "Environment script not found: $EnvironmentScript"
  }
  . $EnvironmentScript
}
if($env:BUILD_ID -or $env:TEAMCITY_VERSION){throw 'CI flags must be absent; do not clean local build output.'}
$buildRootPrefix = $BuildRoot.Replace('\', '/').TrimEnd('/') + '/'
$buildRootPattern = '(?i)(?:^|[\s"''=])' + [regex]::Escape($buildRootPrefix)
$runningBuild = Get-CimInstance Win32_Process -Filter "Name='siso.exe'" | Where-Object {
  ($_.ExecutablePath -and $_.ExecutablePath.Replace('\', '/').StartsWith(
    $buildRootPrefix, [StringComparison]::OrdinalIgnoreCase)) -or
  ($_.CommandLine -and $_.CommandLine.Replace('\', '/') -match $buildRootPattern)
}
if ($runningBuild) { throw "A native build is already running under $BuildRoot." }
$src=Join-Path $BuildRoot 'src'
$repo=Join-Path $src 'brave'
$out=Join-Path $src 'out/Release'
$pgoName=(Get-Content (Join-Path $src 'chrome/build/win64.pgo.txt') -Raw).Trim()
& (Join-Path $PSScriptRoot 'Fetch-ReleaseProfiles.ps1') -BuildRoot $BuildRoot -Offline
New-Item -ItemType Directory -Path $out -Force|Out-Null
$argsFile=Join-Path $out 'args.gn'
$argsText="import(`"//out/Release/args_generated.gni`")`n"+(Get-Content (Join-Path $PSScriptRoot 'release.gni') -Raw).Replace("`r`n","`n")
if(Test-Path -LiteralPath $argsFile){
  if((Get-Content -LiteralPath $argsFile -Raw).Replace("`r`n","`n") -ne $argsText){throw 'Existing Release args.gn differs; preserve it and reconcile explicitly.'}
}else{[IO.File]::WriteAllText($argsFile,$argsText)}
$stamp=[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
New-Item -ItemType Directory -Path (Join-Path $BuildRoot 'logs') -Force | Out-Null
$log=Join-Path $BuildRoot "logs/release-browser-$stamp.log"
$resultPath=Join-Path $BuildRoot "logs/release-browser-$stamp.json"
$result=[ordered]@{stage='building';startedAt=[DateTimeOffset]::UtcNow.ToString('o');launcherPid=$PID;output=$out;log=$log;jobs=$Jobs;target=$Target;pgo=$pgoName;exitCode=$null}
$result|ConvertTo-Json|Set-Content $resultPath
$env:SISO_LIMITS="local=$Jobs"
Push-Location $repo
try{
  & node build/commands/scripts/build.ts Release --target $Target --skip_signing --use_remoteexec=false --ninja "j:$Jobs" *> $log
  $result.exitCode=$LASTEXITCODE
  $result.stage=if($LASTEXITCODE -eq 0){'built'}else{'failed'}
}finally{
  Pop-Location
  if ($null -eq $result.exitCode) {
    $result.stage = 'interrupted'
    $result.exitCode = 130
  }
  $result.finishedAt=[DateTimeOffset]::UtcNow.ToString('o')
  $result|ConvertTo-Json|Set-Content $resultPath
}
$result|ConvertTo-Json
exit $result.exitCode
