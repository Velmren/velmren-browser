[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [string]$StateDir,
    [string]$Policy,
    [string]$Label = 'Codex'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

try {
    # The relay preserves MCP's byte stream and hides both native child processes.
    Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;

public static class VelmrenMcpRelay {
    static async Task Pump(Stream source, Stream destination) {
        byte[] buffer = new byte[8192];
        int read;
        while ((read = await source.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false)) != 0) {
            await destination.WriteAsync(buffer, 0, read).ConfigureAwait(false);
            // Pipe FileStreams buffer small MCP messages; deliver each chunk now.
            await destination.FlushAsync().ConfigureAwait(false);
        }
    }
    static string Quote(string value) {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') {
                result.Append('\\', slashes * 2 + 1).Append(c);
            } else {
                result.Append('\\', slashes).Append(c);
            }
            slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    static ProcessStartInfo Info(string executable, string[] args) {
        var quoted = new string[args.Length];
        for (int i = 0; i < args.Length; i++) quoted[i] = Quote(args[i]);
        return new ProcessStartInfo(executable, String.Join(" ", quoted)) {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true,
            RedirectStandardError = true
        };
    }
    public static string Resolve(string executable) {
        using (var process = Process.Start(Info(executable, new[] { "resolve" }))) {
            process.StandardInput.Close();
            Task<string> output = process.StandardOutput.ReadToEndAsync();
            Task<string> errors = process.StandardError.ReadToEndAsync();
            if (!process.WaitForExit(90000)) {
                // This is our launcher child only, never a browser or shared broker.
                process.Kill();
                throw new InvalidOperationException("Installation resolver timed out.");
            }
            Task.WaitAll(output, errors);
            if (process.ExitCode != 0 || output.Result.Length > 65536)
                throw new InvalidOperationException("Installation resolver failed.");
            return output.Result;
        }
    }
    public static int Run(string executable, string[] args) {
        using (var process = Process.Start(Info(executable, args))) {
            Task output = Pump(process.StandardOutput.BaseStream, Console.OpenStandardOutput());
            Task errors = Pump(process.StandardError.BaseStream, Console.OpenStandardError());
            Pump(Console.OpenStandardInput(), process.StandardInput.BaseStream).ContinueWith(task => {
                try { process.StandardInput.Close(); } catch { }
            });
            process.WaitForExit();
            Task.WaitAll(output, errors);
            return process.ExitCode;
        }
    }
}
'@
    $resolvedRoot = [System.IO.Path]::GetFullPath($InstallRoot)
    $installation = [VelmrenMcpRelay]::Resolve((Join-Path $resolvedRoot 'Velmren.exe')) | ConvertFrom-Json
    foreach ($field in @('agentRuntime', 'appRoot', 'browser', 'agentStateDir')) {
        if (-not $installation.$field -or -not [System.IO.Path]::IsPathRooted($installation.$field)) {
            throw 'Invalid installation runtime.'
        }
    }
    $entry = Join-Path $installation.appRoot 'agent/managed-mcp.mjs'
    if (-not (Test-Path -LiteralPath $entry -PathType Leaf) -or
        -not (Test-Path -LiteralPath $installation.agentRuntime -PathType Leaf)) {
        throw 'Installed MCP runtime is missing.'
    }
    $resolvedState = $installation.agentStateDir
    if ($StateDir) { $resolvedState = [System.IO.Path]::GetFullPath($StateDir) }
    # Reuse the verified resolution; do not hash the signed payload a second time.
    $arguments = @($entry, '--browser', $installation.browser, '--state-dir', $resolvedState, '--label', $Label)
    if ($Policy) { $arguments += @('--policy', [System.IO.Path]::GetFullPath($Policy)) }
    exit [VelmrenMcpRelay]::Run($installation.agentRuntime, $arguments)
} catch {
    [Console]::Error.WriteLine('velmren-mcp: INSTALLATION_UNAVAILABLE: Cannot start the installed managed MCP runtime.')
    exit 1
}
