using System.Diagnostics;

namespace Velmren.Delivery;

internal static partial class Program
{
    static readonly TimeSpan UpdateRelaunchExitTimeout = TimeSpan.FromSeconds(30);
    static readonly TimeSpan UpdateRelaunchActivationTimeout = TimeSpan.FromSeconds(5);
    static readonly TimeSpan UpdateRelaunchStatusTimeout = TimeSpan.FromSeconds(1);

    static async Task RelaunchForUpdate(string root, int browserPid,
        Dictionary<string, string> options, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        root = CanonicalRoot(root);
        _ = ReadOwnership(root, validateInventory: false);
        _ = GetSettings(root);
        if (Current(root) is null) throw new InvalidDataException("A committed installed browser is required.");
        if (browserPid <= 0 || browserPid == Environment.ProcessId)
            throw new InvalidDataException("An installed browser PID is required.");

        // Validate routing before waiting or changing the installed release. The
        // native caller supplies the actual directory, including external profiles.
        var launchOptions = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["user-data-dir"] = BrowserProfile(root, Required(options, "user-data-dir")),
            ["restore-session"] = "true",
            ["incognito"] = Boolean(options, "incognito", false).ToString()
        };
        var profileDirectory = BrowserProfileDirectory(options.GetValueOrDefault("profile-directory"));
        if (profileDirectory is not null) launchOptions["profile-directory"] = profileDirectory;

        Process? browser;
        try { browser = Process.GetProcessById(browserPid); }
        catch (ArgumentException) { browser = null; } // The native shutdown can win the spawn race.
        using (browser)
        {
            if (browser is not null)
            {
                try
                {
                    // Retain this handle throughout the wait; never look up the PID
                    // again after it could have been reused by an unrelated process.
                    _ = browser.Handle;
                    if (!browser.HasExited)
                    {
                        var executable = browser.MainModule?.FileName
                            ?? throw new InvalidDataException("Browser executable is unavailable.");
                        ValidateMonitorExecutable(root, executable);
                    }
                }
                catch (InvalidOperationException) when (browser.HasExited) { }
                catch (System.ComponentModel.Win32Exception) when (browser.HasExited) { }

                Event(root, "update-relaunch-waiting", detail: browserPid.ToString());
                using var exitBudget = CancellationTokenSource.CreateLinkedTokenSource(token);
                exitBudget.CancelAfter(UpdateRelaunchExitTimeout);
                try { await browser.WaitForExitAsync(exitBudget.Token); }
                catch (OperationCanceledException) when (!token.IsCancellationRequested)
                {
                    await ReportUpdateRelaunchStatus(root, "up-to-date", "restart-deferred",
                        "update-relaunch-deferred", "The original browser is still running.", token);
                    return;
                }
            }
        }
        token.ThrowIfCancellationRequested();
        Event(root, "update-relaunch-parent-exited", detail: browserPid.ToString());

        // The old launcher and native monitor release their shared leases after
        // observing browser exit. Activation retains its normal locks and checks.
        using (var activationBudget = CancellationTokenSource.CreateLinkedTokenSource(token))
        {
            activationBudget.CancelAfter(UpdateRelaunchActivationTimeout);
            try
            {
                while (true)
                {
                    using (var operation = await Lock(root, activationBudget.Token))
                    {
                        TryActivate(root, activationBudget.Token);
                        if (Current(root, "pending.json") is null && !File.Exists(SafePath(root, LauncherJournal)))
                            break;
                    }
                    await Task.Delay(100, activationBudget.Token);
                }
            }
            catch (OperationCanceledException) when (!token.IsCancellationRequested)
            {
                await ReportUpdateRelaunchStatus(root, "up-to-date", "restart-deferred",
                    "update-relaunch-deferred", "Activation is waiting for another session or operation.", token);
            }
            catch (Exception error) when (error is not OperationCanceledException &&
                !File.Exists(SafePath(root, LauncherJournal)))
            {
                // Launch independently validates the committed browser and retries
                // ordinary recovery; an unfinished launcher swap is never bypassed.
                await ReportUpdateRelaunchStatus(root, "error", "activation-failed",
                    "update-relaunch-failed", SafeError(error), token);
            }
        }

        Event(root, "update-relaunch-starting", Current(root)?.Version);
        await Launch(root, false, launchOptions, token);
    }

    static async Task ReportUpdateRelaunchStatus(string root, string phase, string errorCode,
        string action, string detail, CancellationToken token)
    {
        try
        {
            using var budget = CancellationTokenSource.CreateLinkedTokenSource(token);
            budget.CancelAfter(UpdateRelaunchStatusTimeout);
            using var operation = await Lock(root, budget.Token);
            WriteUpdateUiStatus(root, phase, errorCode: errorCode, cancellationToken: budget.Token);
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested)
        {
            Event(root, "update-relaunch-status-deferred", detail: "Installation operation is busy.");
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            Event(root, "update-relaunch-status-deferred", detail: SafeError(error));
        }
        Event(root, action, detail: detail);
    }
}
