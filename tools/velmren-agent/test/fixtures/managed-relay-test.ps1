param([Parameter(Mandatory = $true)][string]$NodePath)
$ErrorActionPreference = 'Stop'
$launcher = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '../../Start-VelmrenMcp.ps1')
$definition = [regex]::Match($launcher, "(?s)Add-Type -TypeDefinition @'\r?\n(.*?)\r?\n'@").Groups[1].Value
Add-Type -TypeDefinition $definition
$arguments = @('-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)) + "\n"); process.stderr.write("relay-stderr"); process.stdin.pipe(process.stdout)', 'space and "quote"', 'C:\trailing slash\')
exit [VelmrenMcpRelay]::Run($NodePath, $arguments)
