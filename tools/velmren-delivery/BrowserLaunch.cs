using System.Diagnostics;

namespace Velmren.Delivery;

internal static partial class Program
{
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
                if (current is not null && !transaction)
                    return new(lease, settings, current, lockWaitMs, settingsMs);

                // Never wait for recovery while retaining our own shared lease.
                lease.Dispose();
                if (recovered) throw new InvalidOperationException("Installation recovery did not complete; close Velmren and retry the installer.");
                recovered = true;
                if (current is null) await InitialUpdateCheck(root, token);
                else
                {
                    using var budget = CancellationTokenSource.CreateLinkedTokenSource(token);
                    budget.CancelAfter(StartupUpdateTimeout);
                    using var operation = await Lock(root, budget.Token);
                    TryActivate(root, token);
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
