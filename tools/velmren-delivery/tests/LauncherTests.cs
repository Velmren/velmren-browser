using System.Diagnostics;
using System.Text.Json;
#if !HOST_FILE_TESTS
using Microsoft.Win32;
#endif

namespace Velmren.Delivery;

internal static class LauncherTests
{
    public static async Task<int> Main(string[] args)
    {
#if !HOST_FILE_TESTS
        if (Environment.GetEnvironmentVariable("VELMREN_ALLOW_LIVE_REGISTRY_TESTS") != "1")
            throw new InvalidOperationException("This suite writes to the live registry. Run in disposable Windows with VELMREN_ALLOW_LIVE_REGISTRY_TESTS=1; use RegistrationTests for host-safe validation.");
#endif
        return await Program.RunLauncherTests(args);
    }
}

internal static partial class Program
{
    internal static async Task<int> RunLauncherTests(string[] args)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        if (args.Length != 5) throw new ArgumentException("Expected new work directory, engine A, engine B, incompatible engine and private key.");
        var work = Path.GetFullPath(args[0]);
        if (Directory.Exists(work)) throw new InvalidOperationException("Choose a fresh evidence directory.");
        Directory.CreateDirectory(work);
        var checks = new List<string>();
        void Check(bool valid, string name) { if (!valid) throw new InvalidOperationException(name); checks.Add(name); }
        var engineA = Path.GetFullPath(args[1]); var engineB = Path.GetFullPath(args[2]);
        var incompatible = Path.GetFullPath(args[3]); var privateKey = Path.GetFullPath(args[4]);
        var feed = Path.Combine(work, "feed"); Directory.CreateDirectory(feed);
        string Bundle(string version, string launcher)
        {
            var payload = Path.Combine(work, "payload-" + version);
            Directory.CreateDirectory(Path.Combine(payload, "delivery"));
            File.Copy(engineA, Path.Combine(payload, "synthetic.exe"));
            File.Copy(launcher, Path.Combine(payload, "delivery", "Velmren.exe"));
            File.WriteAllBytes(Path.Combine(payload, "delivery-app.json"), Bytes(new AppConfig("synthetic.exe", ["synthetic-app", "--seconds", "4"], Launcher: "delivery/Velmren.exe")));
            Package(payload, version, feed, privateKey, null);
            var bundle = Path.Combine(work, "bundle-" + version); Directory.CreateDirectory(bundle);
            File.Copy(Path.Combine(feed, "manifest-" + version + ".json"), Path.Combine(bundle, "manifest.json"));
            File.Copy(Path.Combine(feed, "velmren-" + version + ".zip"), Path.Combine(bundle, "velmren-" + version + ".zip"));
            return bundle;
        }
        async Task Run(string exe, params string[] command)
        {
            using var p = new Process { StartInfo = new ProcessStartInfo { FileName = exe, UseShellExecute = false,
                CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true } };
            foreach (var item in command) p.StartInfo.ArgumentList.Add(item);
            p.Start();
            using var budget = new CancellationTokenSource(TimeSpan.FromMinutes(2));
            var output = p.StandardOutput.ReadToEndAsync(budget.Token); var error = p.StandardError.ReadToEndAsync(budget.Token);
            try { await p.WaitForExitAsync(budget.Token); }
            finally { if (!p.HasExited) { p.Kill(true); await p.WaitForExitAsync(); } }
            File.AppendAllText(Path.Combine(work, "commands.log"), string.Join(' ', command) + "\n" + await output + await error);
            if (p.ExitCode != 0) throw new InvalidOperationException($"Fixture command {command[0]} failed: {await error}");
        }
        const string versionA = "1.0.0.1", versionB = "1.0.0.2";
        var bundleA = Bundle(versionA, engineA); var bundleB = Bundle(versionB, engineB);
        var bootstrapRoot = Path.Combine(work, "bootstrap");
        await Run(engineA, "install-bundle", "--root", bootstrapRoot, "--feed", "http://127.0.0.1:19879/", "--bundle-directory", bundleB);
        Check(Current(bootstrapRoot)?.Version == versionB && Hash(Path.Combine(bootstrapRoot, "Velmren.exe")) == Hash(engineB), "Older bootstrap installer can install a newer signed launcher");
        var root = Path.Combine(work, "installed");
        await Run(engineA, "install-bundle", "--root", root, "--feed", "http://127.0.0.1:19879/", "--bundle-directory", bundleA);
        var stable = Path.Combine(root, "Velmren.exe");
        Check(Current(root)?.Version == versionA && Hash(stable) == Hash(engineA), "Initial bundle installs its exact signed launcher");
        File.WriteAllText(Path.Combine(root, "profile", "retained.txt"), "retained profile");
        await Run(stable, "install-bundle", "--root", root, "--feed", "http://127.0.0.1:19879/", "--bundle-directory", bundleB);
        Check(Current(root)?.Version == versionB && Hash(stable) == Hash(engineB), "Running stable launcher atomically replaces itself and activates B");
        Check(!File.Exists(Path.Combine(root, LauncherJournal)), "Successful launcher transaction is committed");
        Check(Directory.EnumerateFiles(root, "launcher-*.previous.exe").Any(f => Hash(f) == Hash(engineA)), "Previous signed launcher is retained for recovery");
        Check(File.ReadAllText(Path.Combine(root, "profile", "retained.txt")) == "retained profile", "Launcher replacement preserves profile bytes");

        // Replay precise durable states at the transaction boundary, without killing
        // user processes or adding crash switches to the shipped executable.
        void ResetA()
        {
            var copy = Path.Combine(root, "test-reset.exe"); File.Copy(engineA, copy, true);
            File.Replace(copy, stable, null);
            Atomic(Path.Combine(root, "current.json"), Bytes(new Pointer(versionA)));
            Atomic(Path.Combine(root, "pending.json"), Bytes(new Pointer(versionB)));
        }
        ResetA();
        using (var operation = await Lock(root))
        using (var lease = new FileStream(Path.Combine(root, "run.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None))
        {
            var transaction = PrepareLauncher(root, new Pointer(versionA), new Pointer(versionB), default)!;
            Check(Hash(stable) == Hash(engineB) && Current(root)?.Version == versionA, "Crash fixture reaches swapped launcher before pointer commit");
            RecoverLauncher(root);
            Check(Hash(stable) == Hash(engineA) && Current(root)?.Version == versionA && !File.Exists(Path.Combine(root, LauncherJournal)), "Interrupted pre-commit replacement rolls back atomically");
            transaction = PrepareLauncher(root, new Pointer(versionA), new Pointer(versionB), default)!;
            Atomic(Path.Combine(root, "current.json"), Bytes(new Pointer(versionB)));
            RecoverLauncher(root);
            Check(Hash(stable) == Hash(engineB) && !File.Exists(Path.Combine(root, LauncherJournal)), "Interrupted post-commit replacement completes recovery");
        }
        ResetA();
        using (var operation = await Lock(root))
        using (var lease = new FileStream(Path.Combine(root, "run.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None))
        {
            var transaction = PrepareLauncher(root, new Pointer(versionA), new Pointer(versionB), default)!;
            var backup = TransactionPath(root, transaction, ".previous.exe");
            File.WriteAllText(backup, "tampered");
            var rejected = false;
            try { RecoverLauncher(root); } catch (System.Security.Cryptography.CryptographicException) { rejected = true; }
            Check(rejected && Hash(stable) == Hash(engineB) && File.Exists(Path.Combine(root, LauncherJournal)), "Corrupt rollback executable is never restored or executed");
            File.Copy(engineA, backup, true); RecoverLauncher(root);
            Check(Hash(stable) == Hash(engineA), "Restoring the authentic backup allows recovery");
        }
        ResetA();
        using (var operation = await Lock(root))
        using (var lease = new FileStream(Path.Combine(root, "run.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None))
        {
            var transaction = new LauncherTransaction(1, Guid.NewGuid().ToString("N"), versionA, versionB);
            Atomic(Path.Combine(root, LauncherJournal), Bytes(transaction));
            RecoverLauncher(root);
            Check(Hash(stable) == Hash(engineA) && !File.Exists(Path.Combine(root, LauncherJournal)), "Crash before ReplaceFile leaves the old stable launcher usable");
        }
        Check(TryActivate(root) && Current(root)?.Version == versionB, "Activation retries successfully after rollback");
        ResetA();
        using (var operation = await Lock(root))
        using (var lease = new FileStream(Path.Combine(root, "run.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None))
            _ = PrepareLauncher(root, new Pointer(versionA), new Pointer(versionB), default);
        using (var budget = new CancellationTokenSource(TimeSpan.FromSeconds(15)))
        {
            var prepared = await PrepareBrowserLaunch(root, budget.Token);
            using (prepared.Lease)
                Check(prepared.Current.Version == versionB && !File.Exists(Path.Combine(root, LauncherJournal)), "Normal launch releases its shared lease before interrupted transaction recovery");
        }
#if !HOST_FILE_TESTS
        var testId = Guid.NewGuid().ToString("N");
        var previousId = Environment.GetEnvironmentVariable("VELMREN_DELIVERY_TEST_ID");
        var previousShell = Environment.GetEnvironmentVariable("VELMREN_DELIVERY_TEST_SHELL_ROOT");
        var registryPath = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Velmren-Development-Test-" + testId;
        try
        {
            Environment.SetEnvironmentVariable("VELMREN_DELIVERY_TEST_ID", testId);
            Environment.SetEnvironmentVariable("VELMREN_DELIVERY_TEST_SHELL_ROOT", Path.Combine(work, "shell"));
            await Register(root, false, default);
            using (var key = Registry.CurrentUser.OpenSubKey(registryPath, writable: true)) key!.SetValue("VelmrenOwner", "temporarily unavailable");
            ScheduleRegistrationRefresh(root, new Pointer(versionB));
            RetryRegistrationRefresh(root, default);
            Check(File.Exists(Path.Combine(root, RegistrationRefreshFile)), "Failed registration refresh retains its durable retry obligation");
            using (var key = Registry.CurrentUser.OpenSubKey(registryPath, writable: true))
            {
                key!.SetValue("VelmrenOwner", ReadOwnership(root).Id);
                key.SetValue("DisplayVersion", versionA);
            }
            TryActivate(root);
            using (var key = Registry.CurrentUser.OpenSubKey(registryPath))
                Check(!File.Exists(Path.Combine(root, RegistrationRefreshFile)) && key!.GetValue("DisplayVersion") as string == versionB,
                    "Next activation retries registration even with no new release");
        }
        finally
        {
            Environment.SetEnvironmentVariable("VELMREN_DELIVERY_TEST_ID", previousId);
            Environment.SetEnvironmentVariable("VELMREN_DELIVERY_TEST_SHELL_ROOT", previousShell);
            using (var key = Registry.CurrentUser.OpenSubKey(registryPath))
            {
                if (key is not null && key.GetValue("InstallLocation") as string != root)
                    throw new InvalidDataException("Refusing to remove unrelated test registration.");
            }
            Registry.CurrentUser.DeleteSubKey(registryPath, throwOnMissingSubKey: false);
        }
#endif
        var badBundle = Bundle("1.0.0.3", incompatible);
        await Run(stable, "install-bundle", "--root", root, "--feed", "http://127.0.0.1:19879/", "--bundle-directory", badBundle);
        Check(Current(root)?.Version == versionB && Hash(stable) == Hash(engineB), "Incompatible signed launcher cannot replace the working release");
        Check(File.ReadAllText(Path.Combine(root, "events.jsonl")).Contains("launcher-update-rejected", StringComparison.Ordinal), "Rejected launcher is reported in update events");
        Check(File.ReadAllText(Path.Combine(root, "profile", "retained.txt")) == "retained profile", "All recovery and rejection paths preserve profile bytes");
#if HOST_FILE_TESTS
        const bool liveRegistry = false;
#else
        const bool liveRegistry = true;
#endif
        File.WriteAllBytes(Path.Combine(work, "result.json"), Bytes(new { passed = true, liveRegistry, count = checks.Count, checks }));
        Console.WriteLine($"PASS {checks.Count} launcher transaction checks");
        return 0;
    }
}
