using System.Diagnostics;

namespace Velmren.Delivery;

internal static partial class Program
{
    const string UpdateMonitorFile = "update-monitor.lock";

    // Native launches (taskbar, session restore, direct EXE) use the same updater
    // as the stable launcher. A waiting monitor takes over if its owner exits.
    static async Task MonitorNativeBrowser(string root, int browserPid, CancellationToken token)
    {
        root = CanonicalRoot(root);
        var settings = GetSettings(root);
        if (browserPid <= 0 || browserPid == Environment.ProcessId)
            throw new InvalidDataException("A running installed browser PID is required.");
        Process browser;
        try { browser = Process.GetProcessById(browserPid); }
        catch (ArgumentException) { return; }
        using (browser)
        {
            // Capture the process handle before inspecting its executable; PID reuse
            // must never attach this monitor to a different process later.
            try { _ = browser.Handle; if (browser.HasExited) return; }
            catch (InvalidOperationException) { return; }
            var executable = browser.MainModule?.FileName
                ?? throw new InvalidDataException("Browser executable is unavailable.");
            ValidateMonitorExecutable(root, executable);
            FileStream lease;
            try { lease = new FileStream(SafePath(root, "run.lock"), FileMode.Open, FileAccess.Read, FileShare.Read); }
            catch (IOException) when (browser.HasExited) { return; }
            using (lease)
            {
                Event(root, "native-monitor-started", detail: browserPid.ToString());
                await SuperviseUpdates(root, settings.PollSeconds,
                    () => !browser.HasExited || BrowserRunning(root), token);
            }
        }
        using (var operation = await Lock(root, token)) TryActivate(root, token, cleanupRetired: true);
        Event(root, "native-monitor-exited", Current(root)?.Version);
    }

    static void ValidateMonitorExecutable(string root, string executable)
    {
        _ = ReadOwnership(root, validateInventory: false);
        var relative = Path.GetRelativePath(root, Path.GetFullPath(executable)).Replace('\\', '/');
        var parts = relative.Split('/');
        if (parts.Length < 4 || parts[0] != "versions" || parts[2] != "app")
            throw new InvalidDataException("Monitor PID does not belong to an installed release.");
        _ = VersionOf(parts[1]);
        var appRoot = Path.Combine(VersionDirectory(root, parts[1]), "app");
        var config = ReadBrowserLaunchConfiguration(root, parts[1]);
        if (!SafePath(appRoot, config.Browser).Equals(Path.GetFullPath(executable), StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Monitor PID is not the signed browser executable.");
    }

    static async Task<FileStream?> TryOwnUpdateMonitor(string root, CancellationToken token)
    {
        var path = SafePath(root, UpdateMonitorFile);
        // Older installations acquire ownership before creating the new lock file.
        // Existing unowned files are never adopted or overwritten.
        if (File.Exists(SafePath(root, OwnershipFile)) &&
            !ReadOwnership(root, validateInventory: false).Files.Contains(UpdateMonitorFile, StringComparer.OrdinalIgnoreCase))
        {
            using var budget = CancellationTokenSource.CreateLinkedTokenSource(token);
            budget.CancelAfter(TimeSpan.FromSeconds(2));
            using var operation = await Lock(root, budget.Token);
            TrackOwned(root, [UpdateMonitorFile]);
        }
        try { return new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
        catch (IOException) { return null; }
    }

    static async Task SuperviseUpdates(string root, int interval, Func<bool> sessionRunning, CancellationToken token)
    {
        FileStream? monitor = null;
        var next = DateTimeOffset.MinValue;
        try
        {
            while (sessionRunning())
            {
                token.ThrowIfCancellationRequested();
                if (DateTimeOffset.UtcNow >= next)
                {
                    try
                    {
                        if (monitor is null)
                        {
                            monitor = await TryOwnUpdateMonitor(root, token);
                            if (monitor is not null)
                                Event(root, "update-monitor-acquired", detail: Environment.ProcessId.ToString());
                        }
                        if (monitor is not null)
                        {
                            // The browser is already open. The initial background
                            // transfer needs the same budget as subsequent attempts.
                            Event(root, "update-check-started", Current(root)?.Version);
                            await Update(root, token);
                            next = DateTimeOffset.UtcNow.AddSeconds(interval);
                        }
                        else next = DateTimeOffset.UtcNow.AddSeconds(1);
                    }
                    catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
                    catch (Exception error)
                    {
                        Event(root, "update-check-failed", detail: SafeError(error));
                        next = DateTimeOffset.UtcNow.AddSeconds(Math.Min(interval, 30));
                    }
                }
                await Task.Delay(1000, token);
            }
        }
        finally { monitor?.Dispose(); }
    }
}
