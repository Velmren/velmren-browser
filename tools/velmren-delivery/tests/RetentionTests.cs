using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;

namespace Velmren.Delivery;

internal static class RetentionTests
{
    public static async Task<int> Main(string[] args)
    {
        if (args is ["--hold-image"])
        {
            Console.WriteLine("holding-image");
            _ = Console.ReadLine();
            return 0;
        }
        return await Program.RunRetentionTests(args);
    }
}

internal static partial class Program
{
    internal static async Task<int> RunRetentionTests(string[] args)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        if (args.Length != 2) throw new ArgumentException("Expected a fresh fixture directory and a disposable test private key.");
        var work = Path.GetFullPath(args[0]);
        if (Directory.Exists(work)) throw new InvalidOperationException("Choose a fresh fixture directory.");
        Directory.CreateDirectory(work);
        using var signer = RSA.Create(); signer.ImportFromPem(File.ReadAllText(args[1]));
        var checks = new List<string>();
        void Check(bool condition, string name)
        {
            if (!condition) throw new InvalidOperationException(name);
            checks.Add(name);
        }
        var host = Environment.ProcessPath ?? throw new InvalidOperationException("Run the test apphost directly.");
        if (Path.GetFileNameWithoutExtension(host).Equals("dotnet", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Run the built test EXE directly to validate running-image retention.");
        var launcher = File.ReadAllBytes(host);
        string V(int index) => "1.0.0." + index;
        string Browser(string root, int index) => Path.Combine(root, "versions", V(index), "app", "browser.exe");
        string Metadata(string root, int index) => Path.Combine(root, "versions", V(index), "manifest.json");
        string Backup(string root, string suffix = ".previous.exe")
        {
            var relative = "launcher-" + Guid.NewGuid().ToString("N") + suffix;
            TrackOwned(root, [relative]);
            File.WriteAllBytes(SafePath(root, relative), launcher);
            return relative;
        }
        (string Root, Dictionary<int, Manifest> Manifests) Fixture(string name, bool pending = true, int extraFiles = 0, bool largeRollback = false)
        {
            var root = Path.Combine(work, name);
            _ = ClaimRoot(root);
            foreach (var directory in new[] { "profile", "agent-state", "downloads", "versions", "staging" }) DirectorySafe(SafePath(root, directory));
            File.WriteAllText(SafePath(root, "run.lock"), "");
            File.WriteAllText(SafePath(root, "Velmren.exe"), "stable-launcher-sentinel");
            File.WriteAllText(SafePath(root, "VelmrenMaintenance.exe"), "maintenance-sentinel");
            File.WriteAllText(SafePath(root, "profile/sentinel"), "profile-data");
            File.WriteAllText(SafePath(root, "agent-state/sentinel"), "agent-data");
            File.WriteAllText(SafePath(root, "installation.json"), "settings-sentinel");
            var manifests = new Dictionary<int, Manifest>();
            byte[]? highestEnvelope = null;
            foreach (var index in new[] { 1, 2, 3, 4, 5, 6, 9 })
            {
                var payload = new Dictionary<string, byte[]> {
                    ["browser.exe"] = Encoding.UTF8.GetBytes("browser-" + V(index)),
                    ["delivery-app.json"] = Bytes(new AppConfig("browser.exe", Launcher: "delivery/Velmren.exe")),
                    ["delivery/Velmren.exe"] = launcher,
                    ["assets/content.bin"] = Encoding.UTF8.GetBytes("assets-" + V(index))
                };
                var package = Encoding.UTF8.GetBytes("zip-package-" + V(index));
                var compact = Encoding.UTF8.GetBytes("compact-package-" + V(index));
                if (index == 1) for (var file = 0; file < extraFiles; file++) payload["extra/" + file + ".bin"] = [(byte)(file % 256)];
                if (index == 4 && largeRollback) payload["assets/large-rollback.bin"] = new byte[128 * 1024 * 1024];
                var files = payload.Select(pair => new PayloadFile(pair.Key, pair.Value.Length, Convert.ToHexStringLower(SHA256.HashData(pair.Value)))).ToArray();
                var manifest = new Manifest(Policy.Schema, Policy.Product, V(index), "velmren-" + V(index) + ".zip", package.Length,
                    Convert.ToHexStringLower(SHA256.HashData(package)), files.Sum(file => file.Size), files, Policy.Channel, Policy.Platform,
                    CompactArchive: new ArchiveVariant("7z", "velmren-" + V(index) + ".7z", compact.Length, Convert.ToHexStringLower(SHA256.HashData(compact))));
                var bytes = Bytes(manifest);
                var envelope = Bytes(new Envelope(Convert.ToBase64String(bytes), Convert.ToBase64String(signer.SignData(bytes, HashAlgorithmName.SHA256, RSASignaturePadding.Pss))));
                _ = Verify(envelope);
                var directory = VersionDirectory(root, V(index));
                TrackReleaseFiles(root, directory, manifest);
                foreach (var pair in payload)
                {
                    var destination = SafePath(directory, "app/" + pair.Key);
                    DirectorySafe(Path.GetDirectoryName(destination)!); File.WriteAllBytes(destination, pair.Value);
                }
                File.WriteAllBytes(Path.Combine(directory, "manifest.json"), envelope);
                var zip = "downloads/" + manifest.Sha256 + ".zip";
                var seven = "downloads/" + manifest.CompactArchive!.Sha256 + ".7z";
                TrackOwned(root, [zip, seven]);
                File.WriteAllBytes(SafePath(root, zip), package); File.WriteAllBytes(SafePath(root, seven), compact);
                manifests[index] = manifest;
                if (index == (pending ? 6 : 5)) highestEnvelope = envelope;
            }
            Atomic(SafePath(root, "current.json"), Bytes(new Pointer(V(5))));
            if (pending) Atomic(SafePath(root, "pending.json"), Bytes(new Pointer(V(6))));
            WriteOwnership(root, ReadOwnership(root) with { State = "installed", HighestEnvelope = Convert.ToBase64String(highestEnvelope!) });
            return (root, manifests);
        }
        async Task Run(string root, CancellationToken token = default)
        {
            using var operation = await Lock(root);
            CleanupRetiredArtifacts(root, token);
        }
        void Sentinels(string root, string label)
        {
            Check(File.ReadAllText(SafePath(root, "profile/sentinel")) == "profile-data"
                && File.ReadAllText(SafePath(root, "agent-state/sentinel")) == "agent-data"
                && File.ReadAllText(SafePath(root, "Velmren.exe")) == "stable-launcher-sentinel"
                && File.ReadAllText(SafePath(root, "VelmrenMaintenance.exe")) == "maintenance-sentinel"
                && File.ReadAllText(SafePath(root, "installation.json")) == "settings-sentinel", label);
        }

        var basic = Fixture("retention");
        var unowned = SafePath(basic.Root, "versions/" + V(1) + "/app/personal.txt"); File.WriteAllText(unowned, "unowned");
        var unknownOwned = "versions/" + V(1) + "/app/unknown-owned.txt"; TrackOwned(basic.Root, [unknownOwned]);
        File.WriteAllText(SafePath(basic.Root, unknownOwned), "unknown-owned");
        DirectorySafe(SafePath(basic.Root, "versions/unknown")); File.WriteAllText(SafePath(basic.Root, "versions/unknown/sentinel"), "unknown-version");
        var oldStage = "staging/" + V(1) + "-" + Guid.NewGuid().ToString("N");
        TrackReleaseFiles(basic.Root, SafePath(basic.Root, oldStage), basic.Manifests[1]);
        var liveStage = "staging/" + V(2) + "-" + Guid.NewGuid().ToString("N");
        TrackReleaseFiles(basic.Root, SafePath(basic.Root, liveStage), basic.Manifests[2]);
        DirectorySafe(SafePath(basic.Root, liveStage + "/app")); File.WriteAllText(SafePath(basic.Root, liveStage + "/app/browser.exe"), "incomplete-stage");
        var partial = "downloads/" + basic.Manifests[1].Sha256 + ".zip.part";
        var unknownArchive = "downloads/" + new string('a', 64) + ".zip";
        TrackOwned(basic.Root, [partial, unknownArchive]);
        File.WriteAllText(SafePath(basic.Root, partial), "partial"); File.WriteAllText(SafePath(basic.Root, unknownArchive), "unknown-archive");
        var retiredBackup = Backup(basic.Root);
        var unknownBackup = "launcher-" + Guid.NewGuid().ToString("N") + ".unknown.exe";
        TrackOwned(basic.Root, [unknownBackup]); File.WriteAllBytes(SafePath(basic.Root, unknownBackup), launcher);
        var oldOwner = ReadOwnership(basic.Root);
        await Run(basic.Root);
        Check(new[] { 1, 2, 3 }.All(index => !File.Exists(Browser(basic.Root, index))) && new[] { 4, 5, 6, 9 }.All(index => File.Exists(Browser(basic.Root, index))),
            "Current, newest complete predecessor, pending and future releases are retained");
        Check(new[] { 1, 2, 3, 4, 5 }.All(index => RetentionArchives(basic.Manifests[index]).All(path => !File.Exists(SafePath(basic.Root, path))))
            && new[] { 6, 9 }.All(index => RetentionArchives(basic.Manifests[index]).All(path => File.Exists(SafePath(basic.Root, path)))),
            "Both completed archive formats are reclaimed while pending and future archives survive");
        Check(File.ReadAllText(unowned) == "unowned" && File.Exists(SafePath(basic.Root, unknownOwned))
            && File.Exists(SafePath(basic.Root, "versions/unknown/sentinel")) && File.Exists(SafePath(basic.Root, unknownArchive))
            && File.Exists(SafePath(basic.Root, partial)) && File.Exists(SafePath(basic.Root, unknownBackup)), "Unowned files and unknown owned names are preserved");
        Check(!File.Exists(SafePath(basic.Root, retiredBackup)), "Authentic retired launcher backup is reclaimed");
        var newOwner = ReadOwnership(basic.Root);
        Check(newOwner.Files.Length < oldOwner.Files.Length && !newOwner.Files.Any(path => path.StartsWith(oldStage + "/", StringComparison.Ordinal))
            && newOwner.Files.Contains(liveStage + "/app/browser.exe") && File.Exists(SafePath(basic.Root, liveStage + "/app/browser.exe")),
            "Successful deletion and absent signed staging entries shrink ownership without deleting incomplete staging");
        Check(newOwner with { Files = oldOwner.Files } == oldOwner, "Ownership identity, registration and signed high-water are unchanged");
        Sentinels(basic.Root, "Profile, agent state, stable launchers and settings survive retention");

        var corruptedPrevious = Fixture("corrupted-predecessor");
        var corruptedBytes = File.ReadAllBytes(Browser(corruptedPrevious.Root, 4));
        corruptedBytes[0] ^= 1;
        File.WriteAllBytes(Browser(corruptedPrevious.Root, 4), corruptedBytes);
        await Run(corruptedPrevious.Root);
        Check(File.Exists(Browser(corruptedPrevious.Root, 3)) && !File.Exists(Browser(corruptedPrevious.Root, 2)),
            "Same-size corrupted predecessor does not displace the newest hash-verified rollback");
        Check(Directory.Exists(SafePath(corruptedPrevious.Root, "downloads")) && Directory.Exists(SafePath(corruptedPrevious.Root, "versions"))
            && Directory.Exists(SafePath(corruptedPrevious.Root, "staging")), "Required installation directories survive cleanup");

        var journal = Fixture("journal");
        var journalBackup = Backup(journal.Root);
        Atomic(SafePath(journal.Root, LauncherJournal), Bytes(new LauncherTransaction(1, Guid.NewGuid().ToString("N"), V(2), V(5))));
        await Run(journal.Root);
        Check(File.Exists(Browser(journal.Root, 2)) && File.Exists(Browser(journal.Root, 4)) && File.Exists(Browser(journal.Root, 5))
            && File.Exists(Browser(journal.Root, 6)) && File.Exists(SafePath(journal.Root, journalBackup)) && !File.Exists(Browser(journal.Root, 1)),
            "Journal source and target plus their launcher artifacts survive alongside current, rollback and pending");

        var retry = Fixture("partial-retry");
        using (var locked = new FileStream(Browser(retry.Root, 1), FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            await Run(retry.Root);
            Check(File.Exists(Browser(retry.Root, 1)) && File.Exists(Metadata(retry.Root, 1))
                && !File.Exists(SafePath(retry.Root, "versions/" + V(1) + "/app/assets/content.bin")), "A locked file leaves signed metadata for partial cleanup retry");
            Check(ReadOwnership(retry.Root).Files.Contains("versions/" + V(1) + "/app/browser.exe")
                && !ReadOwnership(retry.Root).Files.Contains("versions/" + V(1) + "/app/assets/content.bin"), "Only completed deletions leave ownership inventory");
        }
        await Run(retry.Root);
        Check(!Directory.Exists(VersionDirectory(retry.Root, V(1))), "Retry removes the remaining owned payload, manifest and empty directories");

        var cancelled = Fixture("cancelled");
        using (var cancellation = new CancellationTokenSource())
        {
            cancellation.Cancel(); await Run(cancelled.Root, cancellation.Token);
            Check(File.Exists(Browser(cancelled.Root, 1)) && File.ReadAllText(SafePath(cancelled.Root, "events.jsonl")).Contains("retention-cancelled", StringComparison.Ordinal),
                "Cancellation preserves the installation and emits a retryable cleanup event");
        }
        await Run(cancelled.Root);
        Check(!File.Exists(Browser(cancelled.Root, 1)), "A later uncancelled pass completes cleanup");

        var interrupted = Fixture("mid-pass-cancellation", extraFiles: 2000);
        using (var cancellation = new CancellationTokenSource())
        using (var watcher = new FileSystemWatcher(interrupted.Root) { IncludeSubdirectories = true, NotifyFilter = NotifyFilters.FileName })
        {
            watcher.Deleted += (_, _) => cancellation.Cancel(); watcher.EnableRaisingEvents = true;
            await Run(interrupted.Root, cancellation.Token);
            watcher.EnableRaisingEvents = false;
            var ownership = ReadOwnership(interrupted.Root);
            Check(cancellation.IsCancellationRequested && File.Exists(Metadata(interrupted.Root, 1))
                && ownership.Files.Any(path => path.StartsWith("versions/" + V(1) + "/app/", StringComparison.Ordinal)),
                "Mid-pass cancellation leaves signed retry metadata and unfinished owned payload");
            Check(interrupted.Manifests.Values.SelectMany(RetentionArchives).Any(path => !File.Exists(SafePath(interrupted.Root, path)) && !ownership.Files.Contains(path)),
                "Mid-pass cancellation durably removes successfully deleted entries from ownership");
        }
        await Run(interrupted.Root);
        Check(!Directory.Exists(VersionDirectory(interrupted.Root, V(1))), "Cancelled partial cleanup retries to completion across successive idle batches");

        var inventoryFailure = Fixture("inventory-write-failure");
        var beforeInventoryFailure = ReadOwnership(inventoryFailure.Root).Files.Length;
        using (var lockedOwner = new FileStream(SafePath(inventoryFailure.Root, OwnershipFile), FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            await Run(inventoryFailure.Root);
            Check(File.Exists(Metadata(inventoryFailure.Root, 1)) && !File.Exists(Browser(inventoryFailure.Root, 1))
                && ReadOwnership(inventoryFailure.Root).Files.Length == beforeInventoryFailure,
                "An ownership write failure retains signed manifests after successful payload deletion");
        }
        await Run(inventoryFailure.Root);
        Check(!File.Exists(Metadata(inventoryFailure.Root, 1)) && ReadOwnership(inventoryFailure.Root).Files.Length < beforeInventoryFailure,
            "Ownership write failure retries without losing deletion authorization");
        WriteOwnership(inventoryFailure.Root, ReadOwnership(inventoryFailure.Root) with {
            Files = ReadOwnership(inventoryFailure.Root).Files.Append("versions/" + V(1) + "/manifest.json").ToArray()
        });
        await Run(inventoryFailure.Root);
        Check(!ReadOwnership(inventoryFailure.Root).Files.Contains("versions/" + V(1) + "/manifest.json"),
            "A crash after final manifest deletion repairs its absent inventory entry");

        var leased = Fixture("running-lease");
        using (var lease = new FileStream(SafePath(leased.Root, "run.lock"), FileMode.Open, FileAccess.Read, FileShare.Read))
        using (var unreadableRollback = new FileStream(Browser(leased.Root, 4), FileMode.Open, FileAccess.Read, FileShare.None))
        {
            await Run(leased.Root);
            var events = File.ReadAllText(SafePath(leased.Root, "events.jsonl"));
            Check(File.Exists(Browser(leased.Root, 1)) && events.Contains("retention-deferred", StringComparison.Ordinal)
                && !events.Contains("retention-skipped", StringComparison.Ordinal), "A shared launcher lease skips cleanup before reading any rollback payload");
            using var additionalLaunch = new FileStream(SafePath(leased.Root, "run.lock"), FileMode.Open, FileAccess.Read, FileShare.Read);
            Check(additionalLaunch.CanRead, "A deferred cleanup leaves the shared launch lease available");
        }

        var concurrent = Fixture("launch-during-preparation", pending: false, largeRollback: true);
        Atomic(SafePath(concurrent.Root, "installation.json"), Bytes(new Settings(1, "http://127.0.0.1:19879/", 300)));
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var preparing = Task.Run(async () => {
            using var operation = await Lock(concurrent.Root);
            entered.SetResult();
            CleanupRetiredArtifacts(concurrent.Root, default);
        });
        await entered.Task;
        await Task.Delay(10);
        using (var startupBudget = new CancellationTokenSource(TimeSpan.FromSeconds(2)))
        {
            var startup = await PrepareBrowserLaunch(concurrent.Root, startupBudget.Token);
            using (startup.Lease)
            {
                Check(!preparing.IsCompleted && startup.Current.Version == V(5), "Normal launch preparation can finish while retention preparation is running");
                await preparing.WaitAsync(TimeSpan.FromSeconds(15));
                Check(File.Exists(Browser(concurrent.Root, 1))
                    && File.ReadAllText(SafePath(concurrent.Root, "events.jsonl")).Contains("retention-deferred", StringComparison.Ordinal),
                    "A launch acquired during hashing causes the deletion phase to skip without removing artifacts");
            }
        }

        var yielding = Fixture("launch-between-deletion-batches", pending: false, extraFiles: 2000);
        Atomic(SafePath(yielding.Root, "installation.json"), Bytes(new Settings(1, "http://127.0.0.1:19879/", 300)));
        var firstDeletion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using (var watcher = new FileSystemWatcher(yielding.Root) { IncludeSubdirectories = true, NotifyFilter = NotifyFilters.FileName })
        {
            watcher.Deleted += (_, _) => firstDeletion.TrySetResult(); watcher.EnableRaisingEvents = true;
            var deleting = Task.Run(() => Run(yielding.Root));
            await firstDeletion.Task.WaitAsync(TimeSpan.FromSeconds(15));
            using var startupBudget = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            var startup = await PrepareBrowserLaunch(yielding.Root, startupBudget.Token);
            using (startup.Lease)
            {
                await deleting.WaitAsync(TimeSpan.FromSeconds(15));
                Check(File.Exists(Metadata(yielding.Root, 1)) && Directory.EnumerateFiles(SafePath(yielding.Root, "versions/" + V(1) + "/app/extra")).Any(),
                    "A launch waiter acquires a shared lease between deletion batches and stops further deletion");
                Check(startup.Current.Version == V(5) && File.Exists(Browser(yielding.Root, 5)) && File.Exists(Browser(yielding.Root, 4)),
                    "Launching between batches preserves active and verified rollback payloads");
            }
        }
        await Run(yielding.Root);
        Check(!Directory.Exists(VersionDirectory(yielding.Root, V(1))), "Deferred batch cleanup finishes in one subsequent idle pass without repeated launches");

        foreach (var kind in new[] { "current", "pending", "journal", "high-water", "owner", "manifest" })
        {
            var corrupt = Fixture("corrupt-" + kind);
            if (kind is "current" or "pending") File.WriteAllText(SafePath(corrupt.Root, kind + ".json"), "{broken");
            if (kind == "journal") Atomic(SafePath(corrupt.Root, LauncherJournal), Bytes(new LauncherTransaction(99, Guid.NewGuid().ToString("N"), V(2), V(5))));
            if (kind == "high-water") WriteOwnership(corrupt.Root, ReadOwnership(corrupt.Root) with { HighestEnvelope = "corrupt" });
            if (kind == "owner") WriteOwnership(corrupt.Root, ReadOwnership(corrupt.Root) with { State = "unknown" });
            if (kind == "manifest") File.WriteAllText(Metadata(corrupt.Root, 5), "{broken");
            await Run(corrupt.Root);
            Check(File.Exists(Browser(corrupt.Root, 1)) && File.Exists(Metadata(corrupt.Root, 1))
                && File.ReadAllText(SafePath(corrupt.Root, "events.jsonl")).Contains("retention-skipped", StringComparison.Ordinal), "Corrupt " + kind + " state fails closed without throwing");
            Sentinels(corrupt.Root, "Protected data survives corrupt " + kind + " state");
        }
        var incomplete = Fixture("incomplete-previous");
        File.WriteAllText(Browser(incomplete.Root, 4), "truncated");
        await Run(incomplete.Root);
        Check(File.Exists(Browser(incomplete.Root, 3)) && !File.Exists(Browser(incomplete.Root, 2)), "A partial predecessor is not selected as the usable rollback release");
        var unauthenticated = Fixture("unauthenticated-old-release");
        File.WriteAllText(Metadata(unauthenticated.Root, 2), "{broken");
        await Run(unauthenticated.Root);
        Check(File.Exists(Browser(unauthenticated.Root, 2)) && !File.Exists(Browser(unauthenticated.Root, 1)),
            "An unauthenticated obsolete release is preserved while corroborated obsolete releases can be removed");

        var junction = Fixture("junction");
        var external = Path.Combine(work, "junction-target"); Directory.CreateDirectory(external);
        File.WriteAllText(Path.Combine(external, "content.bin"), "outside-sentinel");
        var assets = SafePath(junction.Root, "versions/" + V(1) + "/app/assets");
        Directory.Move(assets, Path.Combine(work, "moved-fixture-assets"));
        using (var create = Process.Start(new ProcessStartInfo {
            FileName = "powershell.exe", UseShellExecute = false, CreateNoWindow = true,
            ArgumentList = { "-NoProfile", "-NonInteractive", "-Command", "New-Item -ItemType Junction -Path '" + assets.Replace("'", "''") + "' -Target '" + external.Replace("'", "''") + "' | Out-Null" }
        }) ?? throw new InvalidOperationException("Cannot create fixture junction."))
        { await create.WaitForExitAsync(); Check(create.ExitCode == 0, "Fresh fixture junction was created"); }
        await Run(junction.Root);
        Check(File.ReadAllText(Path.Combine(external, "content.bin")) == "outside-sentinel" && File.Exists(Browser(junction.Root, 1)) && File.Exists(Browser(junction.Root, 3)),
            "Nested junction preflight aborts before deleting any planned artifact");
        Sentinels(junction.Root, "Profile and agent state survive junction rejection");

        var running = Fixture("running-image", pending: false);
        var runningBackup = Backup(running.Root);
        foreach (var dependency in Directory.EnumerateFiles(Path.GetDirectoryName(host)!))
            if (dependency.EndsWith(".dll", StringComparison.OrdinalIgnoreCase) || dependency.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
                File.Copy(dependency, Path.Combine(running.Root, Path.GetFileName(dependency)));
        using (var child = new Process { StartInfo = new ProcessStartInfo {
            FileName = SafePath(running.Root, runningBackup), UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            ArgumentList = { "--hold-image" }
        } })
        {
            child.Start();
            try
            {
                Check(await child.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(15)) == "holding-image", "Retired test launcher is running");
                await Run(running.Root);
                Check(File.Exists(SafePath(running.Root, runningBackup)) && !child.HasExited, "Running launcher images are never deleted or terminated by cleanup");
                Check(File.Exists(Metadata(running.Root, 1)), "Running backup retains its signed corroboration for retry");
            }
            finally
            {
                await child.StandardInput.WriteLineAsync("exit"); await child.StandardInput.FlushAsync();
                await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(15));
            }
        }
        await Run(running.Root);
        Check(!File.Exists(SafePath(running.Root, runningBackup)) && !File.Exists(Metadata(running.Root, 1)), "Exited launcher backup and deferred metadata are reclaimed on retry");
        Sentinels(running.Root, "Running-image retry preserves profile, agent state and stable launchers");
        File.WriteAllLines(Path.Combine(work, "passed-checks.txt"), checks);
        Console.WriteLine($"PASS: {checks.Count} retention checks. Evidence: {work}");
        return 0;
    }
}
