using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text.Json;

namespace Velmren.Delivery;

internal static class MonitorTests
{
    public static Task<int> Main(string[] args) => Program.RunMonitorTests(args);
}

internal sealed class MonitorTestProcess : IAsyncDisposable
{
    internal Process Process { get; }
    readonly Task<string> output;
    readonly Task<string> error;
    readonly string log;

    internal MonitorTestProcess(string executable, string log, params string[] arguments)
    {
        this.log = log;
        var start = new ProcessStartInfo(executable)
        {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true
        };
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        Process = Process.Start(start) ?? throw new InvalidOperationException("Test process did not start.");
        output = Process.StandardOutput.ReadToEndAsync();
        error = Process.StandardError.ReadToEndAsync();
    }

    internal async Task<int> Exit(TimeSpan? timeout = null)
    {
        using var budget = new CancellationTokenSource(timeout ?? TimeSpan.FromSeconds(45));
        await Process.WaitForExitAsync(budget.Token);
        await File.WriteAllTextAsync(log, await output + await error);
        return Process.ExitCode;
    }

    internal async Task Stop()
    {
        if (!Process.HasExited) Process.Kill(entireProcessTree: true);
        await Exit();
    }

    public async ValueTask DisposeAsync()
    {
        await Stop();
        Process.Dispose();
    }
}

internal sealed record MonitorRequest(string Path, long Offset, long Bytes, double Seconds, bool Completed);

internal sealed class MonitorTestFeed : IAsyncDisposable
{
    readonly HttpListener listener = new();
    readonly CancellationTokenSource stop = new();
    readonly ConcurrentBag<Task> responses = [];
    readonly Task accept;
    readonly string directory;
    internal readonly ConcurrentQueue<MonitorRequest> Requests = [];
    internal int PackageDelayMs { get; set; } = 200;
    internal string Url { get; }

    internal MonitorTestFeed(string directory)
    {
        this.directory = directory;
        var probe = new TcpListener(IPAddress.Loopback, 0);
        probe.Start();
        var port = ((IPEndPoint)probe.LocalEndpoint).Port;
        probe.Stop();
        Url = $"http://127.0.0.1:{port}/";
        listener.Prefixes.Add(Url);
        listener.Start();
        accept = Accept();
    }

    async Task Accept()
    {
        try
        {
            while (!stop.IsCancellationRequested)
            {
                var context = await listener.GetContextAsync().WaitAsync(stop.Token);
                responses.Add(Respond(context));
            }
        }
        catch (Exception exception) when (exception is OperationCanceledException or HttpListenerException or ObjectDisposedException) { }
    }

    async Task Respond(HttpListenerContext context)
    {
        var timer = Stopwatch.StartNew();
        var path = context.Request.Url!.AbsolutePath.TrimStart('/');
        long offset = 0, sent = 0;
        var completed = false;
        try
        {
            if (path != Path.GetFileName(path) || !File.Exists(Path.Combine(directory, path)))
            {
                context.Response.StatusCode = 404;
                return;
            }
            await using var input = File.OpenRead(Path.Combine(directory, path));
            if (context.Request.Headers["Range"] is { } range)
            {
                offset = long.Parse(range[6..].TrimEnd('-'));
                context.Response.StatusCode = 206;
                context.Response.Headers["Content-Range"] = $"bytes {offset}-{input.Length - 1}/{input.Length}";
                input.Position = offset;
            }
            context.Response.ContentLength64 = input.Length - offset;
            var buffer = new byte[(int)Math.Clamp((input.Length + 39) / 40, 8192, 4 * 1024 * 1024)];
            int count;
            while ((count = await input.ReadAsync(buffer, stop.Token)) != 0)
            {
                if (sent > 0 && path.EndsWith(".zip", StringComparison.Ordinal) && PackageDelayMs > 0)
                    await Task.Delay(PackageDelayMs, stop.Token);
                await context.Response.OutputStream.WriteAsync(buffer.AsMemory(0, count), stop.Token);
                await context.Response.OutputStream.FlushAsync(stop.Token);
                sent += count;
            }
            completed = true;
        }
        catch (Exception exception) when (exception is IOException or HttpListenerException or OperationCanceledException or ObjectDisposedException) { }
        finally
        {
            Requests.Enqueue(new(path, offset, sent, timer.Elapsed.TotalSeconds, completed));
            context.Response.Close();
        }
    }

    public async ValueTask DisposeAsync()
    {
        stop.Cancel();
        listener.Close();
        await accept;
        await Task.WhenAll(responses);
        stop.Dispose();
    }
}

internal static partial class Program
{
    internal static async Task<int> RunMonitorTests(string[] args)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        if (args.Length != 3) throw new ArgumentException("Expected fresh evidence directory, freshly built engine EXE and private key.");
        var work = Path.GetFullPath(args[0]);
        var engine = Path.GetFullPath(args[1]);
        var key = Path.GetFullPath(args[2]);
        if (Directory.Exists(work)) throw new InvalidOperationException("Choose a fresh evidence directory.");
        Directory.CreateDirectory(work);
        var checks = new List<string>();
        var evidence = new Dictionary<string, object>();
        void Check(bool condition, string name)
        {
            if (!condition) throw new InvalidOperationException(name);
            checks.Add(name);
            Console.WriteLine("PASS " + name);
        }
        void Reject(Action action, string name)
        {
            var rejected = false;
            try { action(); } catch (InvalidDataException) { rejected = true; }
            Check(rejected, name);
        }
        var sequence = 0;
        MonitorTestProcess Start(string executable, params string[] arguments) =>
            new(executable, Path.Combine(work, $"process-{++sequence:D2}-{arguments[0]}.log"), arguments);
        async Task Run(string executable, params string[] arguments)
        {
            await using var process = Start(executable, arguments);
            if (await process.Exit(TimeSpan.FromMinutes(2)) != 0)
                throw new InvalidOperationException("Fixture command failed: " + arguments[0]);
        }
        async Task Until(Func<bool> condition, string name, int seconds = 45)
        {
            var timer = Stopwatch.StartNew();
            while (!condition())
            {
                if (timer.Elapsed.TotalSeconds >= seconds) throw new TimeoutException(name);
                await Task.Delay(100);
            }
        }
        JsonElement[] Events(string root)
        {
            var path = Path.Combine(root, "events.jsonl");
            if (!File.Exists(path)) return [];
            try
            {
                return File.ReadAllLines(path).Where(line => line.Length > 0)
                    .Select(line => JsonSerializer.Deserialize<JsonElement>(line)).ToArray();
            }
            catch (Exception exception) when (exception is IOException or JsonException) { return []; }
        }
        JsonElement[] ActionEvents(string root, string action) => Events(root)
            .Where(entry => entry.GetProperty("action").GetString() == action).ToArray();
        bool OwnedBy(string root, int pid) => ActionEvents(root, "update-monitor-acquired")
            .Any(entry => entry.GetProperty("detail").GetString() == pid.ToString());
        bool ExclusiveAvailable(string root, string name)
        {
            try { using var stream = new FileStream(Path.Combine(root, name), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); return true; }
            catch (IOException) { return false; }
        }
        const string versionA = "1.0.0.1", versionB = "1.0.0.2";
        try
        {
            var inspectionPath = Path.Combine(Path.GetDirectoryName(engine)!, "registry-inspection.json");
            var inspection = JsonSerializer.Deserialize<JsonElement>(File.ReadAllText(inspectionPath));
            Check(!inspection.GetProperty("registryRenamePresent").GetBoolean()
                && !inspection.GetProperty("registryFlushPresent").GetBoolean()
                && inspection.GetProperty("engineSha256").GetString() == Hash(engine)
                && inspection.GetProperty("sha256").GetString() == Hash(inspection.GetProperty("assembly").GetString()!),
                "Fresh engine matches the successful PE registry-operation gate");
            evidence["engine"] = engine;
            evidence["engineSha256"] = Hash(engine);
            var feedPath = Path.Combine(work, "feed");
            Directory.CreateDirectory(feedPath);
            string Bundle(string version)
            {
                var payload = Path.Combine(work, "payload-" + version);
                Directory.CreateDirectory(payload);
                File.Copy(engine, Path.Combine(payload, "synthetic.exe"));
                File.WriteAllBytes(Path.Combine(payload, "delivery-app.json"),
                    Bytes(new AppConfig("synthetic.exe", ["synthetic-app", "--seconds", "240"])));
                File.WriteAllText(Path.Combine(payload, "release.txt"), version);
                Package(payload, version, feedPath, key);
                var bundle = Path.Combine(work, "bundle-" + version);
                Directory.CreateDirectory(bundle);
                File.Copy(Path.Combine(feedPath, "manifest-" + version + ".json"), Path.Combine(bundle, "manifest.json"));
                File.Copy(Path.Combine(feedPath, "velmren-" + version + ".zip"), Path.Combine(bundle, "velmren-" + version + ".zip"));
                return bundle;
            }
            var bundleA = Bundle(versionA);
            var bundleB = Bundle(versionB);
            await using var feed = new MonitorTestFeed(feedPath);
            async Task<string> InstallFixture(string name)
            {
                var root = Path.Combine(work, name);
                await Run(engine, "install-bundle", "--root", root, "--feed", feed.Url,
                    "--poll-seconds", "120", "--bundle-directory", bundleA);
                Check(Current(root)?.Version == versionA && ReadOwnership(root).Registration is null,
                    name + ": file-only installation starts at A without shell registration");
                File.WriteAllText(Path.Combine(root, "profile", "preserved.txt"), "profile sentinel " + name);
                return root;
            }
            void Activated(string root, string name)
            {
                Check(Current(root)?.Version == versionB && Current(root, "pending.json") is null,
                    name + ": exit activates staged B");
                Check(ExclusiveAvailable(root, "run.lock") && ExclusiveAvailable(root, UpdateMonitorFile),
                    name + ": session and supervisor leases are released");
                Check(File.ReadAllText(Path.Combine(root, "profile", "preserved.txt")) == "profile sentinel " + name,
                    name + ": profile bytes survive activation");
                Check(ReadOwnership(root).Registration is null, name + ": shell registration stays absent");
            }

            var normal = await InstallFixture("normal-launch");
            var custom = Path.Combine(work, "custom profile with spaces");
            Directory.CreateDirectory(Path.Combine(custom, "Profile 7"));
            File.WriteAllText(Path.Combine(custom, "Profile 7", "Preferences"), "custom profile preferences");
            await using (var launcher = Start(Path.Combine(normal, "Velmren.exe"), "launch", "--root", normal,
                "--user-data-dir", custom, "--profile-directory", "Profile 7"))
            {
                await Until(() => File.Exists(Path.Combine(custom, "synthetic-running.txt")), "Normal browser did not start");
                using var browser = Process.GetProcessById(int.Parse(File.ReadAllText(Path.Combine(custom, "synthetic-running.txt"))));
                Check(browser.MainModule?.FileName == Path.Combine(normal, "versions", versionA, "app", "synthetic.exe"),
                    "Normal launch starts the installed synthetic browser with a custom profile path containing spaces");
                try
                {
                    await Until(() => Current(normal, "pending.json")?.Version == versionB, "Normal first background download did not stage B");
                    var transfers = feed.Requests.Where(request => request.Path.EndsWith(".zip", StringComparison.Ordinal)).ToArray();
                    evidence["normalTransfers"] = transfers;
                    Check(transfers.Length == 1 && transfers[0].Completed && transfers[0].Offset == 0 && transfers[0].Seconds > 5,
                        "Normal first download runs beyond five seconds without cancellation or restart");
                    Check(!browser.HasExited && Current(normal)?.Version == versionA && ActionEvents(normal, "activation-deferred").Length > 0,
                        "Normal active browser defers activation while its update is staged");
                    Check(ActionEvents(normal, "update-check-failed").Length == 0,
                        "Normal initial background check has no five-second failure");
                    Check(!ExclusiveAvailable(normal, "run.lock") && !ExclusiveAvailable(normal, UpdateMonitorFile),
                        "Normal launcher holds both lifetime and updater leases");
                }
                finally { if (!browser.HasExited) { browser.Kill(); await browser.WaitForExitAsync(); } }
                Check(await launcher.Exit() == 0, "Normal launcher exits successfully after its browser");
            }
            Activated(normal, "normal-launch");
            Check(File.ReadAllText(Path.Combine(custom, "Profile 7", "Preferences")) == "custom profile preferences",
                "Custom profile directory and preferences are preserved after update");

            var native = await InstallFixture("native-takeover");
            var nativeBrowserPath = Path.Combine(native, "versions", versionA, "app", "synthetic.exe");
            await using (var browser = Start(nativeBrowserPath, "synthetic-app", "--seconds", "240", "--user-data-dir", Path.Combine(native, "profile")))
            await using (var first = Start(Path.Combine(native, "Velmren.exe"), "monitor", "--root", native, "--browser-pid", browser.Process.Id.ToString()))
            {
                await Until(() => OwnedBy(native, first.Process.Id), "First native monitor did not acquire updater ownership");
                await using var standby = Start(Path.Combine(native, "Velmren.exe"), "monitor", "--root", native, "--browser-pid", browser.Process.Id.ToString());
                await Until(() => ActionEvents(native, "native-monitor-started").Length == 2, "Standby monitor did not start");
                await Until(() => Current(native, "pending.json")?.Version == versionB, "Native update did not stage B");
                Check(ActionEvents(native, "update-monitor-acquired").Length == 1 && !standby.Process.HasExited,
                    "Two native monitors have one updater owner and a live standby");
                Check(!ExclusiveAvailable(native, "run.lock") && !ExclusiveAvailable(native, UpdateMonitorFile)
                    && Current(native)?.Version == versionA && !browser.Process.HasExited,
                    "Direct browser and native monitor defer activation with shared lifetime protection");
                evidence["killedMonitorPid"] = first.Process.Id;
                await first.Stop();
                await Until(() => OwnedBy(native, standby.Process.Id), "Standby did not take over the killed owned monitor", 15);
                Check(ActionEvents(native, "update-monitor-acquired").Length == 2 && !standby.Process.HasExited,
                    "Standby takes updater ownership after the exact test-owned monitor is killed");
                Check(Current(native)?.Version == versionA && !ExclusiveAvailable(native, "run.lock"),
                    "Owner termination does not activate over the still-running browser");
                await browser.Stop();
                Check(await standby.Exit() == 0, "Native standby exits successfully after browser termination");
            }
            Activated(native, "native-takeover");

            feed.PackageDelayMs = 0;
            var pairRoot = await InstallFixture("native-pair-exit");
            await using (var browser = Start(Path.Combine(pairRoot, "versions", versionA, "app", "synthetic.exe"),
                "synthetic-app", "--seconds", "240", "--user-data-dir", Path.Combine(pairRoot, "profile")))
            await using (var first = Start(Path.Combine(pairRoot, "Velmren.exe"), "monitor", "--root", pairRoot, "--browser-pid", browser.Process.Id.ToString()))
            await using (var second = Start(Path.Combine(pairRoot, "Velmren.exe"), "monitor", "--root", pairRoot, "--browser-pid", browser.Process.Id.ToString()))
            {
                await Until(() => ActionEvents(pairRoot, "native-monitor-started").Length == 2
                    && Current(pairRoot, "pending.json")?.Version == versionB, "Concurrent native monitors did not stage B");
                Check(ActionEvents(pairRoot, "update-monitor-acquired").Length == 1,
                    "Concurrent native monitors elect exactly one owner");
                await browser.Stop();
                Check(await first.Exit() == 0 && await second.Exit() == 0,
                    "Both concurrent monitors release their leases and exit after the same browser");
            }
            Activated(pairRoot, "native-pair-exit");

            var abandoned = await InstallFixture("abandoned-pending");
            using (var lease = new FileStream(Path.Combine(abandoned, "run.lock"), FileMode.Open, FileAccess.Read, FileShare.Read))
                await Run(engine, "install-bundle", "--root", abandoned, "--feed", feed.Url,
                    "--poll-seconds", "120", "--bundle-directory", bundleB);
            Check(Current(abandoned)?.Version == versionA && Current(abandoned, "pending.json")?.Version == versionB
                && !File.Exists(Path.Combine(abandoned, LauncherJournal)) && ExclusiveAvailable(abandoned, UpdateMonitorFile),
                "Abandoned pending fixture has no launcher journal or live updater");
            await using (var launcher = Start(Path.Combine(abandoned, "Velmren.exe"), "launch", "--root", abandoned))
            {
                await Until(() => File.Exists(Path.Combine(abandoned, "profile", "synthetic-running.txt")), "Pending-release launch did not start");
                using var browser = Process.GetProcessById(int.Parse(File.ReadAllText(Path.Combine(abandoned, "profile", "synthetic-running.txt"))));
                try
                {
                    Check(browser.MainModule?.FileName == Path.Combine(abandoned, "versions", versionB, "app", "synthetic.exe")
                        && ActionEvents(abandoned, "browser-started").Single().GetProperty("version").GetString() == versionB,
                        "Next launch activates abandoned pending release before starting its browser");
                }
                finally { if (!browser.HasExited) { browser.Kill(); await browser.WaitForExitAsync(); } }
                Check(await launcher.Exit() == 0, "Recovered pending-release launcher exits successfully");
            }
            Activated(abandoned, "abandoned-pending");

            foreach (var damage in new[] { "changed-file", "missing-browser" })
            {
                var name = "rejected-pending-" + damage;
                var damaged = await InstallFixture(name);
                using (var lease = new FileStream(Path.Combine(damaged, "run.lock"), FileMode.Open, FileAccess.Read, FileShare.Read))
                    await Run(engine, "install-bundle", "--root", damaged, "--feed", feed.Url,
                        "--poll-seconds", "120", "--bundle-directory", bundleB);
                var pendingApp = Path.Combine(damaged, "versions", versionB, "app");
                if (damage == "changed-file") File.WriteAllText(Path.Combine(pendingApp, "release.txt"), "modified after staging");
                else File.Delete(Path.Combine(pendingApp, "synthetic.exe"));
                var activationCount = ActionEvents(damaged, "activated").Length;
                Check(Current(damaged)?.Version == versionA && Current(damaged, "pending.json")?.Version == versionB
                    && !File.Exists(Path.Combine(damaged, LauncherJournal)),
                    name + ": rejected pending fixture retains a committed current release without a journal");
                await using (var launcher = Start(Path.Combine(damaged, "Velmren.exe"), "launch", "--root", damaged))
                {
                    await Until(() => File.Exists(Path.Combine(damaged, "profile", "synthetic-running.txt"))
                        && ActionEvents(damaged, "browser-started").Length == 1, name + ": healthy browser did not start");
                    using var browser = Process.GetProcessById(int.Parse(File.ReadAllText(Path.Combine(damaged, "profile", "synthetic-running.txt"))));
                    try
                    {
                        Check(browser.MainModule?.FileName == Path.Combine(damaged, "versions", versionA, "app", "synthetic.exe")
                            && ActionEvents(damaged, "browser-started").Single().GetProperty("version").GetString() == versionA
                            && !browser.HasExited,
                            name + ": healthy committed browser starts despite the damaged pending payload");
                        Check(ActionEvents(damaged, "activation-rejected").Length == 1
                            && Current(damaged)?.Version == versionA && Current(damaged, "pending.json")?.Version == versionB
                            && ActionEvents(damaged, "activated").Length == activationCount,
                            name + ": rejection is reported and pending B is never activated");
                        Check(!ExclusiveAvailable(damaged, "run.lock"),
                            name + ": fallback browser still holds its lifetime lease");
                    }
                    finally { if (!browser.HasExited) { browser.Kill(); await browser.WaitForExitAsync(); } }
                    var exitCode = await launcher.Exit();
                    evidence[name + "ExitCode"] = exitCode;
                    Check(exitCode == 1, name + ": final activation still reports the invalid pending payload");
                }
                Check(Current(damaged)?.Version == versionA && Current(damaged, "pending.json")?.Version == versionB
                    && ActionEvents(damaged, "activated").Length == activationCount
                    && !File.Exists(Path.Combine(damaged, LauncherJournal)),
                    name + ": browser exit leaves committed A and rejected pending B intact");
                Check(File.ReadAllText(Path.Combine(damaged, "profile", "preserved.txt")) == "profile sentinel " + name,
                    name + ": fallback and rejected activation preserve profile bytes");
                Check(ExclusiveAvailable(damaged, "run.lock") && ExclusiveAvailable(damaged, UpdateMonitorFile)
                    && ReadOwnership(damaged).Registration is null,
                    name + ": rejected activation releases leases without shell registration");
            }

            var rejectedRoot = await InstallFixture("rejection");
            async Task RejectedPid(string pid, string name)
            {
                await using var monitor = Start(Path.Combine(rejectedRoot, "Velmren.exe"), "monitor", "--root", rejectedRoot, "--browser-pid", pid);
                Check(await monitor.Exit() == 1, name);
            }
            foreach (var pid in new[] { "0", "-1", "not-a-pid", "2147483648" })
                await RejectedPid(pid, "Invalid browser PID is rejected: " + pid);
            await using (var foreign = Start(engine, "synthetic-app", "--seconds", "240", "--user-data-dir", Path.Combine(work, "foreign profile")))
                await RejectedPid(foreign.Process.Id.ToString(), "A live foreign executable PID is rejected");
            var alternate = Path.Combine(rejectedRoot, "versions", versionA, "app", "alternate.exe");
            File.Copy(engine, alternate);
            await using (var foreign = Start(alternate, "synthetic-app", "--seconds", "240", "--user-data-dir", Path.Combine(work, "alternate profile")))
                await RejectedPid(foreign.Process.Id.ToString(), "An executable under the release with the wrong configured path is rejected");
            Check(ActionEvents(rejectedRoot, "native-monitor-started").Length == 0
                && !File.Exists(Path.Combine(rejectedRoot, UpdateMonitorFile)),
                "Rejected PIDs acquire no browser or update-monitor session");

            var owner = ReadOwnership(rejectedRoot);
            WriteOwnership(rejectedRoot, owner with { Files = owner.Files.Where(file => file != UpdateMonitorFile).ToArray() });
            var lockPath = Path.Combine(rejectedRoot, UpdateMonitorFile);
            File.WriteAllText(lockPath, "unowned lock sentinel");
            await using (var browser = Start(Path.Combine(rejectedRoot, "versions", versionA, "app", "synthetic.exe"),
                "synthetic-app", "--seconds", "240", "--user-data-dir", Path.Combine(rejectedRoot, "profile")))
            await using (var monitor = Start(Path.Combine(rejectedRoot, "Velmren.exe"), "monitor", "--root", rejectedRoot, "--browser-pid", browser.Process.Id.ToString()))
            {
                await Until(() => ActionEvents(rejectedRoot, "update-check-failed").Length > 0, "Unowned monitor lock was not rejected", 15);
                Check(ActionEvents(rejectedRoot, "update-monitor-acquired").Length == 0
                    && File.ReadAllText(lockPath) == "unowned lock sentinel"
                    && !ReadOwnership(rejectedRoot).Files.Contains(UpdateMonitorFile),
                    "Existing unowned monitor lock is neither adopted nor overwritten");
                await browser.Stop();
                Check(await monitor.Exit() == 0, "Monitor releases browser lifetime after unowned-lock rejection");
            }

            var linkedRoot = Path.Combine(work, "reparse install root");
            var junctionCommand = "New-Item -ItemType Junction -Path '" + linkedRoot.Replace("'", "''")
                + "' -Target '" + rejectedRoot.Replace("'", "''") + "' | Out-Null";
            await Run("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", junctionCommand);
            Check((File.GetAttributes(linkedRoot) & FileAttributes.ReparsePoint) != 0, "Reparse-root fixture is a real junction");
            await using (var monitor = Start(engine, "monitor", "--root", linkedRoot, "--browser-pid", Environment.ProcessId.ToString()))
                Check(await monitor.Exit() == 1, "Monitor rejects a reparse installation root before session acquisition");
            Reject(() => BrowserProfile(rejectedRoot, linkedRoot), "Profile helpers reject a reparse target");
            Check(BrowserProfile(rejectedRoot, custom) == custom, "Custom absolute user-data-dir with spaces remains exact");
            Check(BrowserProfile(rejectedRoot, null) == Path.Combine(rejectedRoot, "profile"), "Default user-data-dir remains the installation profile");
            Check(BrowserProfileDirectory("Profile 7") == "Profile 7" && BrowserProfileDirectory("Рабочий профиль") == "Рабочий профиль"
                && BrowserProfileDirectory(null) is null, "Valid profile basenames including spaces and Unicode remain exact");
            foreach (var path in new[] { "relative profile", "..", "C:relative" })
                Reject(() => BrowserProfile(rejectedRoot, path), "Relative user-data-dir is rejected: " + path);
            foreach (var name in new[] { "", ".", "..", "../other", "nested/profile", "nested\\profile", "C:profile", "CON", "NUL.txt", "trailing.", "trailing ", "bad*name" })
                Reject(() => BrowserProfileDirectory(name), "Invalid profile basename is rejected: " + name);
            evidence["requests"] = feed.Requests.ToArray();
            File.WriteAllBytes(Path.Combine(work, "result.json"), Bytes(new { passed = true, liveRegistry = false, realBrowser = false, count = checks.Count, checks, evidence }));
            Console.WriteLine($"PASS {checks.Count} file-only monitor checks");
            return 0;
        }
        catch (Exception exception)
        {
            File.WriteAllBytes(Path.Combine(work, "result.json"), Bytes(new { passed = false, liveRegistry = false, realBrowser = false, count = checks.Count, checks, evidence, error = exception.ToString() }));
            Console.Error.WriteLine(exception);
            return 1;
        }
    }
}
