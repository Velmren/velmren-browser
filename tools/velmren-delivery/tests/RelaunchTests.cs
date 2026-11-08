using System.Diagnostics;
using System.Text.Json;

namespace Velmren.Delivery;

internal static class RelaunchTests
{
    public static async Task<int> Main(string[] args)
    {
        if (args.FirstOrDefault() != "browser-fixture") return await Program.RunRelaunchTests(args);
        var profile = args.Single(argument => argument.StartsWith("--user-data-dir=", StringComparison.Ordinal))[16..];
        Directory.CreateDirectory(profile);
        var record = new { pid = Environment.ProcessId, executable = Environment.ProcessPath, arguments = args,
            environmentProfile = Environment.GetEnvironmentVariable("VELMREN_PROFILE_DIR") };
        await File.AppendAllTextAsync(Path.Combine(profile, "browser-starts.jsonl"),
            JsonSerializer.Serialize(record) + Environment.NewLine);
        await Task.Delay(TimeSpan.FromMinutes(4));
        return 0;
    }
}

internal static partial class Program
{
    internal static async Task<int> RunRelaunchTests(string[] args)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        if (args.Length != 3) throw new ArgumentException("Expected fresh evidence directory, freshly built engine EXE and private key. Publish this test runner as a self-contained single file.");
        var work = Path.GetFullPath(args[0]);
        var engine = Path.GetFullPath(args[1]);
        var key = Path.GetFullPath(args[2]);
        if (Directory.Exists(work)) throw new InvalidOperationException("Choose a fresh evidence directory.");
        Directory.CreateDirectory(work);
        var checks = new List<string>();
        var evidence = new Dictionary<string, object>();
        var processes = new List<MonitorTestProcess>();
        var browsers = new List<Process>();
        void Check(bool condition, string name)
        {
            if (!condition) throw new InvalidOperationException(name);
            checks.Add(name);
            Console.WriteLine("PASS " + name);
        }
        var sequence = 0;
        MonitorTestProcess Start(string executable, params string[] arguments)
        {
            var process = new MonitorTestProcess(executable, Path.Combine(work, $"process-{++sequence:D2}.log"), arguments);
            processes.Add(process);
            return process;
        }
        async Task Run(string executable, params string[] arguments)
        {
            if (await Start(executable, arguments).Exit(TimeSpan.FromMinutes(2)) != 0)
                throw new InvalidOperationException("Fixture command failed: " + arguments[0]);
        }
        async Task Until(Func<bool> condition, string name, int seconds = 45)
        {
            var timer = Stopwatch.StartNew();
            while (true)
            {
                try { if (condition()) return; }
                catch (Exception error) when (error is IOException or JsonException) { }
                if (timer.Elapsed.TotalSeconds >= seconds) throw new TimeoutException(name);
                await Task.Delay(50);
            }
        }
        UpdateUiStatus ReadStatus(string root)
        {
            using var file = new FileStream(Path.Combine(root, "update-status.json"), FileMode.Open,
                FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            return JsonSerializer.Deserialize<UpdateUiStatus>(file, Json) ?? throw new InvalidDataException("Missing update snapshot.");
        }
        async Task WriteStatus(string root, string phase, string? availableVersion = null,
            string? errorCode = null, bool checkedFeed = false)
        {
            using var operation = await Lock(root);
            WriteUpdateUiStatus(root, phase, availableVersion, errorCode, checkedFeed);
        }
        JsonElement[] Records(string path)
        {
            try { return File.ReadAllLines(path).Where(line => line.Length > 0).Select(line => JsonSerializer.Deserialize<JsonElement>(line)).ToArray(); }
            catch (Exception error) when (error is IOException or JsonException) { return []; }
        }
        JsonElement[] Starts(string profile) => Records(Path.Combine(profile, "browser-starts.jsonl"));
        JsonElement[] Events(string root, string action) => Records(Path.Combine(root, "events.jsonl"))
            .Where(entry => entry.GetProperty("action").GetString() == action).ToArray();
        async Task<Process> LaunchedBrowser(string root, string profile, string version)
        {
            await Until(() => Starts(profile).Length > 0, "Relaunched fixture did not record a window");
            var record = Starts(profile).Last();
            var process = Process.GetProcessById(record.GetProperty("pid").GetInt32());
            browsers.Add(process);
            Check(record.GetProperty("executable").GetString() == Path.Combine(root, "versions", version, "app", "browser.exe"),
                "Relaunched browser uses expected committed release " + version);
            return process;
        }
        async Task StopBrowser(Process process)
        {
            if (!process.HasExited) process.Kill();
            await process.WaitForExitAsync();
        }
        const string versionA = "1.0.0.1", versionB = "1.0.0.2";
        try
        {
            var inspection = JsonSerializer.Deserialize<JsonElement>(File.ReadAllText(Path.Combine(Path.GetDirectoryName(engine)!, "registry-inspection.json")));
            Check(!inspection.GetProperty("registryRenamePresent").GetBoolean() && !inspection.GetProperty("registryFlushPresent").GetBoolean()
                && inspection.GetProperty("engineSha256").GetString() == Hash(engine)
                && inspection.GetProperty("sha256").GetString() == Hash(inspection.GetProperty("assembly").GetString()!),
                "Fresh development engine passes bundled registry-operation inspection");
            evidence["engine"] = engine;
            evidence["engineSha256"] = Hash(engine);
            var feedPath = Path.Combine(work, "feed");
            Directory.CreateDirectory(feedPath);
            string Bundle(string version, string[]? browserArguments = null)
            {
                var payload = Path.Combine(work, "payload-" + version);
                Directory.CreateDirectory(payload);
                File.Copy(Environment.ProcessPath!, Path.Combine(payload, "browser.exe"));
                File.WriteAllBytes(Path.Combine(payload, "delivery-app.json"), Bytes(new AppConfig("browser.exe", browserArguments ?? ["browser-fixture"])));
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
            await using var feed = new MonitorTestFeed(feedPath) { PackageDelayMs = 0 };
            async Task<string> InstallFixture(string name, bool pending = true)
            {
                var root = Path.Combine(work, name);
                await Run(engine, "install-bundle", "--root", root, "--feed", feed.Url,
                    "--poll-seconds", "120", "--bundle-directory", bundleA);
                Check(Current(root)?.Version == versionA && ReadOwnership(root).Registration is null,
                    name + ": file-only installation has no shell registration");
                File.WriteAllText(Path.Combine(root, "profile", "preserved.txt"), name);
                if (pending)
                {
                    using var lease = new FileStream(Path.Combine(root, "run.lock"), FileMode.Open, FileAccess.Read, FileShare.Read);
                    await Run(engine, "install-bundle", "--root", root, "--feed", feed.Url,
                        "--poll-seconds", "120", "--bundle-directory", bundleB);
                    Check(Current(root)?.Version == versionA && Current(root, "pending.json")?.Version == versionB,
                        name + ": signed B is staged while A stays committed");
                }
                return root;
            }
            MonitorTestProcess Parent(string root, string profile) => Start(Path.Combine(root, "versions", versionA, "app", "browser.exe"),
                "browser-fixture", "--user-data-dir=" + profile);
            MonitorTestProcess Relaunch(string root, int pid, string profile, params string[] extra) =>
                Start(Path.Combine(root, "Velmren.exe"), ["relaunch", "--root=" + root, "--browser-pid=" + pid,
                    "--user-data-dir=" + profile, "--restore-session=true", .. extra]);
            void Preserved(string root, string name)
            {
                Check(File.ReadAllText(Path.Combine(root, "profile", "preserved.txt")) == name && ReadOwnership(root).Registration is null,
                    name + ": profile sentinel and absence of shell registration survive");
            }

            var sharingRoot = await InstallFixture("status-reader-sharing", pending: false);
            var sharingPath = Path.Combine(sharingRoot, UpdateUiStatusFile);
            foreach (var terminalPhase in new[] { "up-to-date", "error" })
            {
                await WriteStatus(sharingRoot, "checking", checkedFeed: true);
                var checking = ReadStatus(sharingRoot);
                // Chromium's CRT reader shares reads/writes but denies deletion.
                using var reader = new FileStream(sharingPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                var writing = Task.Run(async () =>
                {
                    started.SetResult();
                    await WriteStatus(sharingRoot, terminalPhase, errorCode: terminalPhase == "error" ? "check-failed" : null);
                });
                try
                {
                    await started.Task.WaitAsync(TimeSpan.FromSeconds(3));
                    await Task.Delay(75);
                    Check(!writing.IsCompleted && ReadStatus(sharingRoot) == checking,
                        "Terminal " + terminalPhase + " snapshot retries a deny-delete reader while retaining complete prior JSON");
                }
                finally
                {
                    reader.Dispose();
                    await writing.WaitAsync(TimeSpan.FromSeconds(3));
                }
                var terminal = ReadStatus(sharingRoot);
                Check(terminal.Phase == terminalPhase && terminal.InstalledVersion == versionA
                    && terminal.LastCheckedAt == checking.LastCheckedAt
                    && terminal.ErrorCode == (terminalPhase == "error" ? "check-failed" : null)
                    && Directory.GetFiles(sharingRoot, UpdateUiStatusFile + ".new-*").Length == 0,
                    "Terminal " + terminalPhase + " snapshot publishes atomically after the transient reader closes");
            }
            await WriteStatus(sharingRoot, "checking", checkedFeed: true);
            var blockedStatus = ReadStatus(sharingRoot);
            using (var reader = new FileStream(sharingPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            {
                var timer = Stopwatch.StartNew();
                await WriteStatus(sharingRoot, "up-to-date");
                evidence["permanentStatusReaderSeconds"] = timer.Elapsed.TotalSeconds;
                Check(timer.Elapsed < TimeSpan.FromSeconds(2) && ReadStatus(sharingRoot) == blockedStatus
                    && Directory.GetFiles(sharingRoot, UpdateUiStatusFile + ".new-*").Length == 0,
                    "Permanent deny-delete reader bounds display retries and leaves valid prior bytes without temporary debris");
                using (var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(75)))
                {
                    timer.Restart();
                    var cancelled = false;
                    try
                    {
                        await ReportUpdateRelaunchStatus(sharingRoot, "error", "activation-failed",
                            "update-relaunch-failed", "cancelled sharing diagnostic", cancellation.Token);
                    }
                    catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { cancelled = true; }
                    evidence["statusReaderCancellationSeconds"] = timer.Elapsed.TotalSeconds;
                    Check(cancelled && timer.Elapsed < TimeSpan.FromSeconds(1) && ReadStatus(sharingRoot) == blockedStatus,
                        "External relaunch diagnostic cancellation interrupts display replacement retries");
                }
                using var lease = new FileStream(Path.Combine(sharingRoot, "run.lock"), FileMode.Open, FileAccess.Read, FileShare.Read);
                var update = Start(Path.Combine(sharingRoot, "Velmren.exe"), "install-bundle", "--root", sharingRoot,
                    "--feed", feed.Url, "--poll-seconds", "120", "--bundle-directory", bundleB);
                var updateExit = await update.Exit(TimeSpan.FromSeconds(15));
                evidence["permanentStatusUpdate"] = new { command = "install-bundle", exitCode = updateExit,
                    pending = Current(sharingRoot, "pending.json"), current = Current(sharingRoot), status = ReadStatus(sharingRoot) };
                Check(updateExit == 0 && Current(sharingRoot, "pending.json")?.Version == versionB
                    && Current(sharingRoot)?.Version == versionA && ReadStatus(sharingRoot) == blockedStatus
                    && Directory.GetFiles(sharingRoot, UpdateUiStatusFile + ".new-*").Length == 0,
                    "Permanent display reader never prevents an actual signed update from committing pending B");
            }

            var statusRoot = await InstallFixture("status-producer", pending: false);
            foreach (var phase in new[] { "checking", "available", "downloading", "installing" })
            {
                await WriteStatus(statusRoot, phase, phase == "checking" ? null : versionB, checkedFeed: phase == "available");
                var status = ReadStatus(statusRoot);
                Check(status.Schema == 1 && status.Phase == phase && status.InstalledVersion == versionA
                    && Current(statusRoot, "pending.json") is null, "Status producer records precommit phase " + phase);
            }
            await WriteStatus(statusRoot, "ready", versionB);
            Check(ReadStatus(statusRoot).Phase != "ready",
                "Status producer refuses readiness before a committed pending pointer");
            feed.PackageDelayMs = 60;
            using (var lease = new FileStream(Path.Combine(statusRoot, "run.lock"), FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                var update = Start(Path.Combine(statusRoot, "Velmren.exe"), "update", "--root", statusRoot);
                await Until(() => ReadStatus(statusRoot).Phase == "downloading",
                    "Actual signed update did not report its download");
                Check(Current(statusRoot, "pending.json") is null && !Directory.Exists(Path.Combine(statusRoot, "versions", versionB)),
                    "Actual update reports downloading before extracted payload and pending pointer commit");
                Check(await update.Exit() == 0 && Current(statusRoot, "pending.json")?.Version == versionB,
                    "Actual update commits verified B before reporting ready");
            }
            feed.PackageDelayMs = 0;
            await WriteStatus(statusRoot, "ready", versionB);
            var ready = ReadStatus(statusRoot);
            Check(ready.Phase == "ready" && ready.AvailableVersion == versionB && ready.InstalledVersion == versionA,
                "Committed verified pending release produces ready status");
            await WriteStatus(statusRoot, "available", versionB);
            Check(ReadStatus(statusRoot).Phase == "ready" && ReadStatus(statusRoot).AvailableVersion == versionB,
                "A repeated feed offer for verified pending B keeps the restart offer visible");
            await WriteStatus(statusRoot, "available", "1.0.0.3");
            Check(ReadStatus(statusRoot).Phase == "available" && ReadStatus(statusRoot).AvailableVersion == "1.0.0.3"
                && Current(statusRoot, "pending.json")?.Version == versionB,
                "A newer feed candidate C retains its available phase while verified pending B is preserved");
            await WriteStatus(statusRoot, "error", errorCode: "check-failed");
            var offline = ReadStatus(statusRoot);
            Check(offline.Phase == "ready" && offline.AvailableVersion == versionB && offline.ErrorCode == "check-failed"
                && offline.LastCheckedAt == ready.LastCheckedAt, "Offline failure preserves ready pending release and last successful check time");
            using (var operation = await Lock(statusRoot)) TryActivate(statusRoot);
            var activatedStatus = ReadStatus(statusRoot);
            Check(activatedStatus.Phase == "up-to-date" && activatedStatus.InstalledVersion == versionB
                && activatedStatus.AvailableVersion is null && activatedStatus.ErrorCode is null,
                "Successful activation clears the restart offer and previous error");

            var normal = await InstallFixture("normal-relaunch");
            var custom = Path.Combine(work, "Внешний профиль with spaces");
            Directory.CreateDirectory(Path.Combine(custom, "Рабочий профиль 7"));
            File.WriteAllText(Path.Combine(custom, "Рабочий профиль 7", "Preferences"), "preserved preferences");
            var parentProfile = Path.Combine(work, "old-parent-record");
            var parent = Parent(normal, parentProfile);
            await Until(() => Starts(parentProfile).Length == 1, "Original fixture did not start");
            using var oldLease = new FileStream(Path.Combine(normal, "run.lock"), FileMode.Open, FileAccess.Read, FileShare.Read);
            var relaunch = Relaunch(normal, parent.Process.Id, custom, "--profile-directory=Рабочий профиль 7", "--incognito=true");
            await Until(() => Events(normal, "update-relaunch-waiting").Length > 0, "Relaunch did not capture the parent");
            Check(!relaunch.Process.HasExited && Starts(custom).Length == 0 && Current(normal)?.Version == versionA,
                "Captured live parent prevents activation and duplicate browser launch");
            await parent.Stop();
            await Until(() => Events(normal, "update-relaunch-parent-exited").Length > 0, "Relaunch did not observe captured parent exit");
            Check(Starts(custom).Length == 0 && Current(normal)?.Version == versionA,
                "Relaunch waits for the old supervisor lifetime lease to drain");
            oldLease.Dispose();
            var newBrowser = await LaunchedBrowser(normal, custom, versionB);
            var routing = Starts(custom).Single();
            var routedArguments = routing.GetProperty("arguments").EnumerateArray().Select(value => value.GetString()).ToArray();
            Check(routedArguments.Contains("--user-data-dir=" + custom) && routedArguments.Contains("--profile-directory=Рабочий профиль 7")
                && routedArguments.Contains("--incognito") && routedArguments.Contains("--restart")
                && routedArguments.Contains("--restore-last-session") && routing.GetProperty("environmentProfile").GetString() == custom,
                "Relaunch preserves actual external profile, Unicode basename, incognito and session restoration switches");
            Check(routedArguments.Count(argument => argument?.StartsWith("--disable-features=", StringComparison.Ordinal) == true) == 1
                && routedArguments.Contains("--disable-features=BraveCleanupSessionCookiesOnSessionRestore"),
                "Update relaunch disables Brave normal-close cookie cleanup for the restored process");
            Check(File.ReadAllText(Path.Combine(custom, "Рабочий профиль 7", "Preferences")) == "preserved preferences",
                "Relaunch preserves actual external profile bytes");
            await StopBrowser(newBrowser);
            Check(await relaunch.Exit() == 0, "Successful relaunch supervisor exits cleanly");
            Preserved(normal, "normal-relaunch");

            var deferred = await InstallFixture("deferred-relaunch");
            var deferredProfile = Path.Combine(work, "deferred external profile");
            var deferredParent = Parent(deferred, Path.Combine(work, "deferred parent"));
            var deferredRelaunch = Relaunch(deferred, deferredParent.Process.Id, deferredProfile);
            await Until(() => Events(deferred, "update-relaunch-waiting").Length > 0, "Deferred relaunch did not capture parent");
            using (var otherSession = new FileStream(Path.Combine(deferred, "run.lock"), FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                var timer = Stopwatch.StartNew();
                await deferredParent.Stop();
                var fallback = await LaunchedBrowser(deferred, deferredProfile, versionA);
                evidence["deferredLaunchSeconds"] = timer.Elapsed.TotalSeconds;
                var status = ReadStatus(deferred);
                evidence["deferredRestartStatus"] = status;
                Check(timer.Elapsed < TimeSpan.FromSeconds(15) && !fallback.HasExited && Current(deferred, "pending.json")?.Version == versionB
                    && Events(deferred, "update-relaunch-deferred").Length > 0,
                    "Contending lifetime lease reopens committed A after bounded activation retries and retains pending B");
                Check(status.Phase == "ready" && status.AvailableVersion == versionB,
                    "Deferred restart keeps the pending update offer visible");
                await StopBrowser(fallback);
            }
            Check(await deferredRelaunch.Exit() == 0 && Current(deferred)?.Version == versionB,
                "Deferred restart eventually activates B only after the other session lease drains");
            Preserved(deferred, "deferred-relaunch");

            var damaged = await InstallFixture("damaged-pending-relaunch");
            File.WriteAllText(Path.Combine(damaged, "versions", versionB, "app", "release.txt"), "corrupted pending payload");
            var damagedProfile = Path.Combine(work, "damaged fallback profile");
            var damagedParent = Parent(damaged, Path.Combine(work, "damaged parent"));
            var damagedRelaunch = Relaunch(damaged, damagedParent.Process.Id, damagedProfile);
            await Until(() => Events(damaged, "update-relaunch-waiting").Length > 0, "Damaged-pending relaunch did not capture parent");
            await damagedParent.Stop();
            var healthyFallback = await LaunchedBrowser(damaged, damagedProfile, versionA);
            await Until(() => Events(damaged, "update-check-started").Length > 0
                && Events(damaged, "activation-deferred").Length > 0,
                "Fallback supervisor did not recheck the rejected pending release under its lifetime lease");
            var damagedStatus = ReadStatus(damaged);
            Check(!healthyFallback.HasExited && Current(damaged)?.Version == versionA && Current(damaged, "pending.json")?.Version == versionB
                && damagedStatus.Phase == "error" && damagedStatus.ErrorCode == "activation-failed"
                && Events(damaged, "update-relaunch-failed").Length > 0,
                "Rejected pending bytes restore healthy A and retain a truthful activation error through background recheck");
            await StopBrowser(healthyFallback);
            Check(await damagedRelaunch.Exit() == 1 && Current(damaged)?.Version == versionA,
                "Corrupted pending payload never activates, including after fallback browser exit");
            Preserved(damaged, "damaged-pending-relaunch");

            foreach (var (name, pendingText) in new[]
            {
                ("malformed-pending-json", "{broken"),
                ("invalid-pending-version", "{\"version\":\"1.0.0\"}")
            })
            {
                var pointerRoot = await InstallFixture(name);
                var pointerProfile = Path.Combine(work, name + " Внешний профиль");
                var profileBasename = "Рабочий профиль 9";
                Directory.CreateDirectory(Path.Combine(pointerProfile, profileBasename));
                var preferences = Path.Combine(pointerProfile, profileBasename, "Preferences");
                File.WriteAllText(preferences, "preserved " + name);
                var pointerParent = Parent(pointerRoot, Path.Combine(work, name + " parent"));
                var pointerRelaunch = Relaunch(pointerRoot, pointerParent.Process.Id, pointerProfile,
                    "--profile-directory=" + profileBasename, "--incognito=true");
                await Until(() => Events(pointerRoot, "update-relaunch-waiting").Length > 0,
                    name + ": relaunch did not capture parent");
                using (var operation = await Lock(pointerRoot))
                    File.WriteAllText(Path.Combine(pointerRoot, "pending.json"), pendingText);
                await pointerParent.Stop();
                var pointerFallback = await LaunchedBrowser(pointerRoot, pointerProfile, versionA);
                await Until(() => Events(pointerRoot, "update-check-failed").Length > 0,
                    name + ": fallback supervisor did not reject the invalid pending metadata");
                var pointerStatus = ReadStatus(pointerRoot);
                var pointerRecord = Starts(pointerProfile).Single();
                var pointerArguments = pointerRecord.GetProperty("arguments").EnumerateArray().Select(value => value.GetString()).ToArray();
                Check(pointerArguments.Contains("--user-data-dir=" + pointerProfile)
                    && pointerArguments.Contains("--profile-directory=" + profileBasename)
                    && pointerArguments.Contains("--incognito") && pointerArguments.Contains("--restart")
                    && pointerArguments.Contains("--restore-last-session")
                    && pointerRecord.GetProperty("environmentProfile").GetString() == pointerProfile
                    && File.ReadAllText(preferences) == "preserved " + name,
                    name + ": committed fallback preserves actual profile, preferences and restoration routing");
                Check(pointerStatus.Phase == "error" && pointerStatus.ErrorCode == "activation-failed"
                    && pointerStatus.InstalledVersion == versionA && pointerStatus.AvailableVersion is null
                    && Events(pointerRoot, "update-relaunch-failed").Length > 0
                    && Current(pointerRoot)?.Version == versionA
                    && File.ReadAllText(Path.Combine(pointerRoot, "pending.json")) == pendingText,
                    name + ": tolerant diagnostics record an activation error without changing rejected metadata");
                var strictRejection = false;
                try { _ = Current(pointerRoot, "pending.json"); }
                catch (Exception error) when (error is IOException or InvalidDataException or JsonException) { strictRejection = true; }
                Check(strictRejection, name + ": authoritative pending validation remains strict");
                await StopBrowser(pointerFallback);
                Check(await pointerRelaunch.Exit() == 1 && Current(pointerRoot)?.Version == versionA,
                    name + ": rejected pointer never activates after fallback browser exit");
                Preserved(pointerRoot, name);
            }

            var journalRoot = await InstallFixture("invalid-pointer-with-journal");
            var journalProfile = Path.Combine(work, "journal blocked profile");
            var journalParent = Parent(journalRoot, Path.Combine(work, "journal parent"));
            var journalRelaunch = Relaunch(journalRoot, journalParent.Process.Id, journalProfile);
            await Until(() => Events(journalRoot, "update-relaunch-waiting").Length > 0,
                "Journal-gate relaunch did not capture parent");
            const string journalSentinel = "unfinished launcher transaction";
            using (var operation = await Lock(journalRoot))
            {
                File.WriteAllText(Path.Combine(journalRoot, "pending.json"), "{broken");
                TrackOwned(journalRoot, [LauncherJournal]);
                File.WriteAllText(Path.Combine(journalRoot, LauncherJournal), journalSentinel);
            }
            await journalParent.Stop();
            Check(await journalRelaunch.Exit() == 1 && Starts(journalProfile).Length == 0
                && Events(journalRoot, "update-relaunch-starting").Length == 0
                && Current(journalRoot)?.Version == versionA
                && File.ReadAllText(Path.Combine(journalRoot, LauncherJournal)) == journalSentinel,
                "Malformed pending diagnostics never bypass an unfinished launcher transaction");

            var legacy = await InstallFixture("legacy-status-ownership");
            var legacyProfile = Path.Combine(work, "legacy status fallback profile");
            var legacyParent = Parent(legacy, Path.Combine(work, "legacy status parent"));
            MonitorTestProcess legacyRelaunch;
            Process legacyFallback;
            using (var operation = await Lock(legacy))
            {
                var owner = ReadOwnership(legacy);
                File.Delete(Path.Combine(legacy, UpdateUiStatusFile));
                WriteOwnership(legacy, owner with { Files = owner.Files.Where(file => file != UpdateUiStatusFile).ToArray() });
                using (var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(150)))
                {
                    var cancelled = false;
                    try
                    {
                        await ReportUpdateRelaunchStatus(legacy, "error", "activation-failed",
                            "update-relaunch-failed", "cancelled test diagnostic", cancellation.Token);
                    }
                    catch (OperationCanceledException) { cancelled = true; }
                    Check(cancelled && !File.Exists(Path.Combine(legacy, UpdateUiStatusFile)),
                        "Bounded diagnostic lock handling preserves external cancellation without creating status");
                }
                legacyRelaunch = Relaunch(legacy, legacyParent.Process.Id, legacyProfile);
                await Until(() => Events(legacy, "update-relaunch-waiting").Length > 0,
                    "Legacy-status relaunch did not capture parent");
                var timer = Stopwatch.StartNew();
                await legacyParent.Stop();
                legacyFallback = await LaunchedBrowser(legacy, legacyProfile, versionA);
                evidence["operationBusyFallbackSeconds"] = timer.Elapsed.TotalSeconds;
                Check(timer.Elapsed < TimeSpan.FromSeconds(15) && !legacyFallback.HasExited
                    && Events(legacy, "update-relaunch-status-deferred").Length > 0
                    && Events(legacy, "update-relaunch-deferred").Length > 0,
                    "Busy operation lock bounds diagnostic waiting and still reopens committed A");
                Check(!File.Exists(Path.Combine(legacy, UpdateUiStatusFile))
                    && !ReadOwnership(legacy).Files.Contains(UpdateUiStatusFile),
                    "Relaunch never creates or adopts the new status file while another operation owns the lock");
            }
            await Until(() => File.Exists(Path.Combine(legacy, UpdateUiStatusFile)),
                "Legacy-status background update did not create its owned snapshot");
            Check(ReadOwnership(legacy).Files.Contains(UpdateUiStatusFile)
                && ReadStatus(legacy).InstalledVersion == versionA,
                "Legacy installation inventories the new status file before publishing a background snapshot");
            await StopBrowser(legacyFallback);
            Check(await legacyRelaunch.Exit() == 0 && Current(legacy)?.Version == versionB,
                "Legacy-status migration preserves normal activation after all session leases drain");
            Check(ReadOwnership(legacy).Registration is null, "Legacy-status uninstall fixture has no shell registration");
            await Run(engine, "uninstall", "--root", legacy);
            Check(!File.Exists(Path.Combine(legacy, UpdateUiStatusFile))
                && ReadOwnership(legacy).State == "retained"
                && File.ReadAllText(Path.Combine(legacy, "profile", "preserved.txt")) == "legacy-status-ownership",
                "File-only uninstall removes the migrated owned status while retaining profile data");

            var unownedStatus = await InstallFixture("unowned-status-sentinel", pending: false);
            const string statusSentinel = "unrelated user-owned status sentinel";
            using (var operation = await Lock(unownedStatus))
            {
                var owner = ReadOwnership(unownedStatus);
                File.Delete(Path.Combine(unownedStatus, UpdateUiStatusFile));
                WriteOwnership(unownedStatus, owner with { Files = owner.Files.Where(file => file != UpdateUiStatusFile).ToArray() });
                File.WriteAllText(Path.Combine(unownedStatus, UpdateUiStatusFile), statusSentinel);
            }
            var originalOwnershipHash = Hash(Path.Combine(unownedStatus, OwnershipFile));
            await WriteStatus(unownedStatus, "checking");
            Check(File.ReadAllText(Path.Combine(unownedStatus, UpdateUiStatusFile)) == statusSentinel
                && !ReadOwnership(unownedStatus).Files.Contains(UpdateUiStatusFile)
                && Hash(Path.Combine(unownedStatus, OwnershipFile)) == originalOwnershipHash,
                "Preexisting unowned status bytes are neither overwritten nor adopted by migration");
            Check(ReadOwnership(unownedStatus).Registration is null, "Unowned-status uninstall fixture has no shell registration");
            await Run(engine, "uninstall", "--root", unownedStatus);
            Check(File.ReadAllText(Path.Combine(unownedStatus, UpdateUiStatusFile)) == statusSentinel
                && !ReadOwnership(unownedStatus).Files.Contains(UpdateUiStatusFile),
                "File-only uninstall preserves an unowned status sentinel");

            var rejected = await InstallFixture("rejected-relaunch");
            var rejectedProfile = Path.Combine(work, "rejected profile");
            foreach (var pid in new[] { "0", "-1", "not-a-pid", "2147483648" })
            {
                var invalid = Start(Path.Combine(rejected, "Velmren.exe"), "relaunch", "--root", rejected,
                    "--browser-pid", pid, "--user-data-dir", rejectedProfile);
                Check(await invalid.Exit() == 1, "Invalid relaunch parent PID is rejected: " + pid);
            }
            var foreign = Start(Environment.ProcessPath!, "browser-fixture", "--user-data-dir=" + Path.Combine(work, "foreign profile"));
            Check(await Relaunch(rejected, foreign.Process.Id, rejectedProfile).Exit() == 1 && !foreign.Process.HasExited,
                "A live foreign or reused PID is rejected without killing that process");
            var alternate = Path.Combine(rejected, "versions", versionA, "app", "alternate.exe");
            File.Copy(Environment.ProcessPath!, alternate);
            var wrongBrowser = Start(alternate, "browser-fixture", "--user-data-dir=" + Path.Combine(work, "alternate profile"));
            Check(await Relaunch(rejected, wrongBrowser.Process.Id, rejectedProfile).Exit() == 1 && !wrongBrowser.Process.HasExited,
                "An executable inside the release with the wrong signed browser path is rejected");
            var validParent = Parent(rejected, Path.Combine(work, "valid parent"));
            foreach (var extra in new[] { "--user-data-dir=relative", "--profile-directory=../other", "--incognito=invalid" })
            {
                Check(await Relaunch(rejected, validParent.Process.Id, rejectedProfile, extra).Exit() == 1,
                    "Invalid relaunch profile routing is rejected before waiting: " + extra);
            }
            Check(!validParent.Process.HasExited && Current(rejected)?.Version == versionA && Starts(rejectedProfile).Length == 0
                && Events(rejected, "update-relaunch-waiting").Length == 0,
                "Rejected parent and routing requests neither activate nor start a browser");
            using (var cancel = new CancellationTokenSource(TimeSpan.FromMilliseconds(150)))
            {
                var cancelled = false;
                try { await RelaunchForUpdate(rejected, validParent.Process.Id,
                    new() { ["user-data-dir"] = rejectedProfile }, cancel.Token); }
                catch (OperationCanceledException) { cancelled = true; }
                Check(cancelled && !validParent.Process.HasExited && Starts(rejectedProfile).Length == 0,
                    "Cancellation interrupts the parent wait without killing or duplicating its browser");
            }

            var timeoutRoot = await InstallFixture("parent-exit-timeout");
            var timeoutProfile = Path.Combine(work, "timeout profile");
            var timeoutParent = Parent(timeoutRoot, Path.Combine(work, "timeout parent"));
            var timeoutRelaunch = Relaunch(timeoutRoot, timeoutParent.Process.Id, timeoutProfile);
            var timeoutTimer = Stopwatch.StartNew();
            Check(await timeoutRelaunch.Exit(TimeSpan.FromSeconds(40)) == 0 && !timeoutParent.Process.HasExited
                && Starts(timeoutProfile).Length == 0 && Current(timeoutRoot)?.Version == versionA,
                "Bounded parent-exit timeout leaves the original browser alive without opening a duplicate");
            var timeoutStatus = ReadStatus(timeoutRoot);
            Check(timeoutTimer.Elapsed < TimeSpan.FromSeconds(38) && timeoutStatus.Phase == "ready"
                && timeoutStatus.ErrorCode == "restart-deferred" && timeoutStatus.AvailableVersion == versionB,
                "Parent-exit timeout reports a truthful deferred restart while retaining the pending offer");
            evidence["parentExitTimeoutSeconds"] = timeoutTimer.Elapsed.TotalSeconds;

            var exitedRoot = await InstallFixture("already-exited-parent");
            var exitedParent = Parent(exitedRoot, Path.Combine(work, "exited parent"));
            var exitedPid = exitedParent.Process.Id;
            await exitedParent.Stop();
            var exitedProfile = Path.Combine(exitedRoot, "profile");
            var exitedRelaunch = Relaunch(exitedRoot, exitedPid, exitedProfile);
            var exitedBrowser = await LaunchedBrowser(exitedRoot, exitedProfile, versionB);
            Check(!Starts(exitedProfile).Single().GetProperty("arguments").EnumerateArray()
                .Any(value => value.GetString()!.StartsWith("--profile-directory=", StringComparison.Ordinal)),
                "Already-exited parent still restores the actual data directory without inventing a profile basename");
            await StopBrowser(exitedBrowser);
            Check(await exitedRelaunch.Exit() == 0, "Already-exited parent shutdown race completes relaunch");
            Preserved(exitedRoot, "already-exited-parent");

            var invalidRoot = Path.Combine(work, "unowned-root");
            Directory.CreateDirectory(invalidRoot);
            Check(await Start(engine, "relaunch", "--root", invalidRoot, "--browser-pid", exitedPid.ToString(),
                "--user-data-dir", Path.Combine(work, "unowned profile")).Exit() == 1 && !Directory.EnumerateFileSystemEntries(invalidRoot).Any(),
                "Unowned root is rejected before lock, status or browser writes");

            const string cleanupFeature = "BraveCleanupSessionCookiesOnSessionRestore";
            var restoreArguments = new List<string> { "browser-fixture", "--enable-features=UnrelatedEnabled", "https://example.invalid/" };
            PreserveSessionCookiesOnRestore(restoreArguments);
            Check(restoreArguments.SequenceEqual(["browser-fixture", "--enable-features=UnrelatedEnabled", "https://example.invalid/",
                "--disable-features=" + cleanupFeature]),
                "Explicit restoration adds cookie protection while preserving unrelated arguments");
            var mergedArguments = new List<string> { "--disable-features=First,Second", "--incognito", "--disable-features=Second,Third" };
            PreserveSessionCookiesOnRestore(mergedArguments);
            Check(mergedArguments.SequenceEqual(["--incognito", "--disable-features=" + cleanupFeature + ",First,Second,Third"]),
                "Explicit restoration merges all existing disabled features into one effective switch");
            var deduplicatedArguments = new List<string> { "--disable-features= First, ," + cleanupFeature,
                "--DISABLE-FEATURES=" + cleanupFeature + ",Second,First", "-disable-features=Third", "/disable-features=Fourth" };
            PreserveSessionCookiesOnRestore(deduplicatedArguments);
            Check(deduplicatedArguments.SequenceEqual(["--disable-features=" + cleanupFeature + ",First,Second,Third,Fourth"]),
                "Restoration deduplicates disabled features and Windows switch aliases without last-wins loss");
            var mergedOnce = deduplicatedArguments.ToArray();
            PreserveSessionCookiesOnRestore(deduplicatedArguments);
            Check(deduplicatedArguments.SequenceEqual(mergedOnce), "Repeated restoration feature merging is idempotent");
            var emptyArguments = new List<string> { "--disable-features", "--disable-features=", "--new-window" };
            PreserveSessionCookiesOnRestore(emptyArguments);
            Check(emptyArguments.SequenceEqual(["--new-window", "--disable-features=" + cleanupFeature]),
                "Empty disabled-feature switches produce one restoration switch without consuming adjacent flags");
            var distinctArguments = new List<string> { "--disable-features=Feature<Trial,Feature:parameter/value," + cleanupFeature + "Extra" };
            PreserveSessionCookiesOnRestore(distinctArguments);
            Check(distinctArguments.Single() == "--disable-features=" + cleanupFeature + ",Feature<Trial,Feature:parameter/value," + cleanupFeature + "Extra",
                "Restoration preserves unrelated feature parameters and exact feature-name boundaries");
            foreach (var directive in new[] { "*" + cleanupFeature, "*" + cleanupFeature + "<Trial" })
            {
                var defaultArguments = new List<string> { "--disable-features=" + directive + ",*UnrelatedDefault<OtherTrial,OtherDisabled" };
                PreserveSessionCookiesOnRestore(defaultArguments);
                Check(defaultArguments.SequenceEqual(["--disable-features=" + cleanupFeature + "," + directive + ",*UnrelatedDefault<OtherTrial,OtherDisabled"]),
                    "Restoration forces the first cleanup override to disabled before default-state directive " + directive);
            }

            const string manualVersion = "1.0.0.3";
            string[] configuredArguments = ["browser-fixture", "--disable-features=First,Second", "--new-window",
                "--disable-features=Second,Third,*" + cleanupFeature + "<Trial", "--enable-features=UnrelatedEnabled"];
            var manualBundle = Bundle(manualVersion, configuredArguments);
            var manualRoot = Path.Combine(work, "manual-cli-session-restore");
            await Run(engine, "install-bundle", "--root", manualRoot, "--feed", feed.Url,
                "--poll-seconds", "120", "--bundle-directory", manualBundle);
            Check(Current(manualRoot)?.Version == manualVersion && ReadOwnership(manualRoot).Registration is null,
                "Manual CLI restoration fixture has a verified release and no shell registration");
            var manualDefaultProfile = Path.Combine(manualRoot, "profile");
            File.WriteAllText(Path.Combine(manualDefaultProfile, "preserved.txt"), "manual restore sentinel");
            foreach (var mode in new[] { "omitted", "false", "true" })
            {
                var manualProfile = Path.Combine(work, "manual " + mode + " Внешний профиль");
                const string basename = "Рабочий профиль 11";
                Directory.CreateDirectory(Path.Combine(manualProfile, basename));
                var preferences = Path.Combine(manualProfile, basename, "Preferences");
                var localState = Path.Combine(manualProfile, "Local State");
                const string preferenceBytes = "{\"profile\":{\"exit_type\":\"Normal\"},\"session\":{\"restore_on_startup\":1},\"privacy_sentinel\":true}";
                const string localStateBytes = "{\"was_restarted\":false,\"local_state_sentinel\":true}";
                File.WriteAllText(preferences, preferenceBytes);
                File.WriteAllText(localState, localStateBytes);
                string[] routingOptions = ["launch", "--root=" + manualRoot, "--user-data-dir=" + manualProfile,
                    "--profile-directory=" + basename, "--incognito=true", "--url=https://example.invalid/restored"];
                var manualLaunch = Start(Path.Combine(manualRoot, "Velmren.exe"), mode == "omitted"
                    ? routingOptions : [.. routingOptions, "--restore-session=" + mode]);
                var manualBrowser = await LaunchedBrowser(manualRoot, manualProfile, manualVersion);
                var record = Starts(manualProfile).Single();
                var arguments = record.GetProperty("arguments").EnumerateArray().Select(value => value.GetString()!).ToArray();
                var disabled = arguments.Where(argument => argument.StartsWith("--disable-features=", StringComparison.Ordinal)).ToArray();
                if (mode == "true")
                {
                    Check(disabled.SequenceEqual(["--disable-features=" + cleanupFeature + ",First,Second,Third,*" + cleanupFeature + "<Trial"])
                        && arguments.Contains("--restart") && arguments.Contains("--restore-last-session"),
                        "Manual launch --restore-session=true merges cookie protection and existing tab-restoration switches");
                }
                else
                {
                    Check(arguments.Take(configuredArguments.Length).SequenceEqual(configuredArguments)
                        && disabled.SequenceEqual(["--disable-features=First,Second", "--disable-features=Second,Third,*" + cleanupFeature + "<Trial"])
                        && !arguments.Contains("--restart") && !arguments.Contains("--restore-last-session"),
                        "Manual launch with restore-session " + mode + " keeps cold-launch feature and restoration policy unchanged");
                }
                Check(arguments.Contains("--user-data-dir=" + manualProfile) && arguments.Contains("--profile-directory=" + basename)
                    && arguments.Contains("--incognito") && arguments.Contains("--new-window")
                    && arguments.Contains("--enable-features=UnrelatedEnabled") && arguments.Contains("https://example.invalid/restored")
                    && record.GetProperty("environmentProfile").GetString() == manualProfile,
                    "Manual " + mode + " launch preserves external profile, incognito, URL and unrelated flags");
                Check(File.ReadAllText(preferences) == preferenceBytes && File.ReadAllText(localState) == localStateBytes
                    && File.ReadAllText(Path.Combine(manualDefaultProfile, "preserved.txt")) == "manual restore sentinel",
                    "Manual " + mode + " launch preserves preferences, privacy settings and Local State restart marker bytes");
                await StopBrowser(manualBrowser);
                Check(await manualLaunch.Exit() == 0 && ReadOwnership(manualRoot).Registration is null,
                    "Manual " + mode + " launch supervisor exits without shell registration");
            }

            using (var exclusive = new FileStream(Path.Combine(manualRoot, "run.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None))
            using (var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(12)))
            {
                var timer = Stopwatch.StartNew();
                var timedOut = false;
                try { (await PrepareBrowserLaunch(manualRoot, deadline.Token)).Lease.Dispose(); }
                catch (OperationCanceledException) when (!deadline.IsCancellationRequested) { timedOut = true; }
                Check(timedOut && timer.Elapsed >= TimeSpan.FromSeconds(4) && timer.Elapsed < TimeSpan.FromSeconds(10),
                    "Ordinary cold launch retains its bounded five-second exclusive-run-lease wait");
                evidence["coldLaunchLeaseTimeoutSeconds"] = timer.Elapsed.TotalSeconds;
            }

            var busyProfile = Path.Combine(work, "restore after exclusive activation");
            Directory.CreateDirectory(busyProfile);
            var busyState = Path.Combine(busyProfile, "Local State");
            File.WriteAllText(busyState, "{\"was_restarted\":false,\"preserved\":true}");
            using (var exclusive = new FileStream(Path.Combine(manualRoot, "run.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None))
            using (var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(25)))
            {
                var timer = Stopwatch.StartNew();
                var preparation = PrepareBrowserLaunch(manualRoot, deadline.Token, restoreSession: true);
                try
                {
                    var delayedLaunch = Start(Path.Combine(manualRoot, "Velmren.exe"), "launch", "--root=" + manualRoot,
                        "--user-data-dir=" + busyProfile, "--restore-session=true");
                    await Task.Delay(TimeSpan.FromSeconds(7), deadline.Token);
                    Check(!preparation.IsCompleted && !delayedLaunch.Process.HasExited && Starts(busyProfile).Length == 0
                        && Current(manualRoot)?.Version == manualVersion,
                        "Explicit restoration waits beyond five seconds for an exclusive activation lease without launching early");
                    exclusive.Dispose();
                    var prepared = await preparation;
                    using (prepared.Lease)
                        Check(prepared.Current.Version == manualVersion && !File.Exists(Path.Combine(manualRoot, LauncherJournal))
                            && timer.Elapsed >= TimeSpan.FromSeconds(7),
                            "Restoration acquires a shared lease and validates the committed release after exclusive activation releases it");
                    var delayedBrowser = await LaunchedBrowser(manualRoot, busyProfile, manualVersion);
                    var arguments = Starts(busyProfile).Single().GetProperty("arguments").EnumerateArray().Select(value => value.GetString()).ToArray();
                    Check(arguments.Contains("--disable-features=" + cleanupFeature + ",First,Second,Third,*" + cleanupFeature + "<Trial")
                        && arguments.Contains("--restart") && arguments.Contains("--restore-last-session")
                        && File.ReadAllText(busyState) == "{\"was_restarted\":false,\"preserved\":true}",
                        "Delayed explicit CLI restoration starts the signed committed browser with cookie and tab restoration intact");
                    await StopBrowser(delayedBrowser);
                    Check(await delayedLaunch.Exit() == 0 && ReadOwnership(manualRoot).Registration is null,
                        "Delayed restoration supervisor exits cleanly without shell registration");
                    evidence["restoreLaunchExclusiveLeaseSeconds"] = timer.Elapsed.TotalSeconds;
                }
                finally
                {
                    deadline.Cancel();
                    try { (await preparation).Lease.Dispose(); }
                    catch (OperationCanceledException) { }
                }
            }

            var cancelledProfile = Path.Combine(work, "cancelled exclusive restoration");
            Directory.CreateDirectory(cancelledProfile);
            var cancelledState = Path.Combine(cancelledProfile, "Local State");
            File.WriteAllText(cancelledState, "cancelled restoration sentinel");
            var cancelFile = Path.Combine(work, "cancel-exclusive-restoration.signal");
            using (var exclusive = new FileStream(Path.Combine(manualRoot, "run.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None))
            using (var cancellation = new CancellationTokenSource())
            {
                var preparation = PrepareBrowserLaunch(manualRoot, cancellation.Token, restoreSession: true);
                var cancelledLaunch = Start(Path.Combine(manualRoot, "Velmren.exe"), "launch", "--root=" + manualRoot,
                    "--user-data-dir=" + cancelledProfile, "--restore-session=true", "--cancel-file=" + cancelFile);
                await Task.Delay(250);
                var timer = Stopwatch.StartNew();
                cancellation.Cancel();
                File.WriteAllText(cancelFile, "cancel");
                var cancelled = false;
                try { (await preparation).Lease.Dispose(); }
                catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { cancelled = true; }
                Check(cancelled && await cancelledLaunch.Exit(TimeSpan.FromSeconds(5)) == 2
                    && timer.Elapsed < TimeSpan.FromSeconds(4) && Starts(cancelledProfile).Length == 0
                    && Current(manualRoot)?.Version == manualVersion && !File.Exists(Path.Combine(manualRoot, LauncherJournal))
                    && File.ReadAllText(cancelledState) == "cancelled restoration sentinel",
                    "External cancellation promptly interrupts the longer restoration lease wait without browser or profile writes");
                evidence["restoreLeaseCancellationSeconds"] = timer.Elapsed.TotalSeconds;
            }

            using (var otherSession = new FileStream(Path.Combine(manualRoot, "run.lock"), FileMode.Open, FileAccess.Read, FileShare.Read))
            using (var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(3)))
            {
                var prepared = await PrepareBrowserLaunch(manualRoot, deadline.Token, restoreSession: true);
                using (prepared.Lease)
                    Check(prepared.Current.Version == manualVersion && Starts(cancelledProfile).Length == 0,
                        "Restoration shares ordinary browser leases and a cancelled request never resumes after the exclusive lease drains");
            }
            evidence["registryTestsExecuted"] = false;
            File.WriteAllBytes(Path.Combine(work, "result.json"), Bytes(new { passed = true, liveRegistry = false, realBrowser = false,
                count = checks.Count, checks, evidence }));
            Console.WriteLine($"PASS {checks.Count} file-only relaunch checks");
            return 0;
        }
        catch (Exception error)
        {
            File.WriteAllBytes(Path.Combine(work, "result.json"), Bytes(new { passed = false, liveRegistry = false, realBrowser = false,
                count = checks.Count, checks, evidence, error = error.ToString() }));
            Console.Error.WriteLine(error);
            return 1;
        }
        finally
        {
            foreach (var browser in browsers)
            {
                try { await StopBrowser(browser); } finally { browser.Dispose(); }
            }
            foreach (var process in processes) await process.DisposeAsync();
        }
    }
}
