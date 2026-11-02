using System.Diagnostics;

namespace Velmren.Delivery;

internal static partial class Program
{
    static string BrowserProfile(string root, string? requested)
    {
        if (requested is null) return SafePath(root, "profile");
        if (!Path.IsPathFullyQualified(requested)) throw new InvalidDataException("Browser profile must be an absolute path.");
        var profile = Path.GetFullPath(requested);
        NoLinks(profile);
        return profile;
    }

    static string? BrowserProfileDirectory(string? requested)
    {
        if (requested is null) return null;
        ValidateRelativePath(requested);
        if (requested.Contains('/') || requested.Contains('\\')) throw new InvalidDataException("Profile directory must be a single folder name.");
        return requested;
    }

    internal sealed record LaunchPreparation(FileStream Lease, Settings Settings, Pointer Current,
        double LockWaitMs, double SettingsMs);

    // A committed installation can run while the updater downloads or stages.
    // Activation/uninstall require an exclusive run lease, not this operation lock.
    static async Task<LaunchPreparation> PrepareBrowserLaunch(string root, CancellationToken token)
    {
        var recovered = false;
        double lockWaitMs = 0, settingsMs = 0;
        while (true)
        {
            FileStream lease;
            var timer = Stopwatch.StartNew();
            using (var budget = CancellationTokenSource.CreateLinkedTokenSource(token))
            {
                budget.CancelAfter(StartupUpdateTimeout);
                var path = SafePath(root, "run.lock");
                while (true)
                {
                    budget.Token.ThrowIfCancellationRequested();
                    try { lease = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read); break; }
                    catch (IOException) { await Task.Delay(25, budget.Token); }
                }
            }
            lockWaitMs += timer.Elapsed.TotalMilliseconds;
            try
            {
                timer.Restart();
                var settings = GetSettings(root);
                settingsMs += timer.Elapsed.TotalMilliseconds;
                var current = Current(root);
                var transaction = File.Exists(SafePath(root, LauncherJournal));
                var pending = File.Exists(SafePath(root, "pending.json"));
                if (current is not null && !transaction && (!pending || recovered))
                    return new(lease, settings, current, lockWaitMs, settingsMs);

                // Never wait for recovery while retaining our own shared lease.
                lease.Dispose();
                if (recovered) throw new InvalidOperationException("Installation recovery did not complete; close Velmren and retry the installer.");
                recovered = true;
                if (current is null) await InitialUpdateCheck(root, token);
                else
                {
                    try
                    {
                        using var budget = CancellationTokenSource.CreateLinkedTokenSource(token);
                        budget.CancelAfter(StartupUpdateTimeout);
                        using var operation = await Lock(root, budget.Token);
                        TryActivate(root, token);
                    }
                    catch (OperationCanceledException) when (!token.IsCancellationRequested && !transaction)
                    {
                        // A pending update can wait for the next exit if another
                        // operation is busy; the committed version remains usable.
                    }
                    catch (Exception error) when (error is not OperationCanceledException && !transaction &&
                        !File.Exists(SafePath(root, LauncherJournal)) && Current(root)?.Version == current.Version)
                    {
                        // A rejected pending payload must not strand the independently
                        // validated committed browser. Never bypass recovery of a swap.
                        Event(root, "activation-rejected", detail: SafeError(error));
                    }
                }
            }
            catch { lease.Dispose(); throw; }
        }
    }

    static AppConfig ReadBrowserLaunchConfiguration(string root, string version)
    {
        var verified = ReadInstalledManifest(root, version);
        var appRoot = Path.Combine(VersionDirectory(root, version), "app");
        var configFile = verified.Manifest.Files.Single(f => f.Path == "delivery-app.json");
        var configPath = SafePath(appRoot, configFile.Path);
        VerifySingleFile(configPath, configFile);
        var config = Read<AppConfig>(configPath);
        ValidateApp(appRoot, config);
        EnsureSandboxReadAccess(appRoot);
        return config;
    }
}
