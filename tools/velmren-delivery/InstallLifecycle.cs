using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using Microsoft.Win32;

namespace Velmren.Delivery;

internal sealed record OwnedLink(string Path, string Sha256, string? PreviousSha256 = null);
internal sealed record RegistryWritePlan(string Version, bool Gui);
internal sealed record ShellRegistration(string Key, string? TestId, string? TestRoot, OwnedLink[] Links,
    string[]? TemporaryLinks = null, string? RegistryStage = null,
    RegistryWritePlan? RegistryPlan = null, bool RegistryPending = false);
internal sealed record InstallOwnership(int Schema, string Root, string OwnerSid, string Product,
    string? Channel, string? Platform, string Mode, string Id, string State, string[] Files,
    string? HighestEnvelope = null, ShellRegistration? Registration = null);

internal sealed class CancellationSignal : IDisposable
{
    readonly CancellationTokenSource source = new();
    readonly Timer? timer;
    internal CancellationToken Token => source.Token;

    internal CancellationSignal(string? path)
    {
        if (path is null) return;
        path = Path.GetFullPath(path);
        if (File.Exists(path)) source.Cancel();
        timer = new Timer(_ => { if (File.Exists(path)) source.Cancel(); }, null, 100, 100);
    }

    public void Dispose() { timer?.DisposeAsync().AsTask().GetAwaiter().GetResult(); source.Dispose(); }
}

internal static partial class Program
{
    const string OwnershipFile = ".velmren-owner.json";
    static readonly string[] RegistrationValues = ["VelmrenOwner", "InstallLocation", "DisplayName", "DisplayVersion", "Publisher", "DisplayIcon", "UninstallString", "NoModify", "NoRepair"];
    static readonly string[] CoreFiles = ["Velmren.exe", "Velmren.exe.installing", "installation.json", "current.json", "pending.json", "events.jsonl", "operation.lock", "run.lock"];
    static string CanonicalRoot(string root) => Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
    static string OwnerSid()
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Per-user Windows installation is required.");
        using var identity = WindowsIdentity.GetCurrent();
        return identity.User?.Value ?? throw new InvalidOperationException("Windows owner SID is unavailable.");
    }

    static InstallOwnership ReadOwnership(string root, bool validateInventory = true)
    {
        root = CanonicalRoot(root);
        var path = SafePath(root, OwnershipFile);
        if (!File.Exists(path) || new FileInfo(path).Length > 64 * 1024 * 1024) throw new InvalidDataException("Installation ownership marker missing or invalid; unrelated directories are never adopted.");
        var owner = Read<InstallOwnership>(path);
        if (owner.Schema != 1 || !string.Equals(owner.Root, root, StringComparison.OrdinalIgnoreCase)
            || owner.OwnerSid != OwnerSid() || owner.Product != Policy.Product || owner.Channel != Policy.Channel
            || owner.Platform != Policy.Platform || owner.Mode != Policy.Mode || !Guid.TryParseExact(owner.Id, "N", out _)
            || owner.State is not ("installing" or "installed" or "retained") || owner.Files is null)
            throw new InvalidDataException("Installation root, owner, or product identity does not match this installer.");
        if (validateInventory) foreach (var file in owner.Files)
        {
            ValidateRelativePath(file);
            if (file.Equals(OwnershipFile, StringComparison.OrdinalIgnoreCase) || file.Split('/')[0].Equals("profile", StringComparison.OrdinalIgnoreCase)
                || file.Split('/')[0].Equals("agent-state", StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Ownership inventory includes a protected path.");
        }
        return owner;
    }

    static void WriteOwnership(string root, InstallOwnership owner) => Atomic(SafePath(root, OwnershipFile), Bytes(owner));
    static InstallOwnership ClaimRoot(string root)
    {
        NoLinks(root);
        if (File.Exists(SafePath(root, OwnershipFile))) return ReadOwnership(root);
        if (Directory.Exists(root) && Directory.EnumerateFileSystemEntries(root).Any())
            throw new InvalidOperationException("Install destination must be empty or a matching owned installation.");
        DirectorySafe(root);
        var owner = new InstallOwnership(1, root, OwnerSid(), Policy.Product, Policy.Channel, Policy.Platform,
            Policy.Mode, Guid.NewGuid().ToString("N"), "installing", CoreFiles);
        // CreateNew wins the claim before any settings, lock, executable or profile writes.
        using var marker = new FileStream(SafePath(root, OwnershipFile), FileMode.CreateNew, FileAccess.Write, FileShare.None);
        marker.Write(Bytes(owner)); marker.Flush(true);
        return owner;
    }

    static void TrackOwned(string root, IEnumerable<string> files)
    {
        if (!File.Exists(SafePath(root, OwnershipFile))) return; // Legacy development update compatibility.
        var owner = ReadOwnership(root);
        var combined = owner.Files.ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var item in files)
        {
            var relative = item.Replace('\\', '/');
            _ = SafePath(root, relative);
            if (!combined.Contains(relative) && File.Exists(SafePath(root, relative)))
                throw new InvalidDataException("Refusing to overwrite a file outside the installation ownership inventory.");
            combined.Add(relative);
        }
        if (combined.Count != owner.Files.Length) WriteOwnership(root, owner with { Files = combined.Order(StringComparer.Ordinal).ToArray() });
    }

    static void TrackReleaseFiles(string root, string directory, Manifest manifest)
    {
        var prefix = Path.GetRelativePath(root, directory).Replace('\\', '/');
        TrackOwned(root, manifest.Files.Select(file => prefix + "/app/" + file.Path).Append(prefix + "/manifest.json"));
    }

    static void ValidateHighWater(string root, Manifest manifest)
    {
        if (!File.Exists(SafePath(root, OwnershipFile))) return;
        var owner = ReadOwnership(root);
        if (owner.HighestEnvelope is null) return;
        var highest = Verify(Convert.FromBase64String(owner.HighestEnvelope)).Manifest;
        if (VersionOf(manifest.Version) < VersionOf(highest.Version)) throw new InvalidDataException("Downgrade/replayed older release rejected, including after uninstall.");
        if (manifest.Version == highest.Version) SameRelease(highest, manifest);
    }

    static void RememberHighWater(string root, Verified verified)
    {
        if (!File.Exists(SafePath(root, OwnershipFile))) return;
        var owner = ReadOwnership(root);
        WriteOwnership(root, owner with { HighestEnvelope = Convert.ToBase64String(verified.Envelope) });
    }

    static async Task Install(string root, string feed, int pollSeconds, CancellationToken cancellationToken, string? bundleDirectory = null)
    {
        root = CanonicalRoot(root); _ = FeedUri(feed);
        if (pollSeconds is < 1 or > 86400) throw new InvalidDataException("Poll interval outside 1..86400 seconds.");
        var self = Environment.ProcessPath ?? throw new InvalidOperationException("Cannot locate installer executable.");
        if (!self.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) || Path.GetFileName(self).Equals("dotnet.exe", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Install using the published self-contained EXE.");
        Verified? bundle = null;
        if (bundleDirectory is not null)
        {
            bundleDirectory = Path.GetFullPath(bundleDirectory);
            var manifestPath = SafePath(bundleDirectory, "manifest.json");
            if (new FileInfo(manifestPath).Length > MaxManifest) throw new InvalidDataException("Bundle manifest too large.");
            bundle = Verify(await File.ReadAllBytesAsync(manifestPath, cancellationToken));
        }
        cancellationToken.ThrowIfCancellationRequested();
        _ = ClaimRoot(root);
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        budget.CancelAfter(TimeSpan.FromMinutes(20)); cancellationToken = budget.Token;
        using (var operation = await Lock(root, cancellationToken))
        {
            var owner = ReadOwnership(root);
            if (owner.State == "retained")
            {
                using var retainedLease = OpenUninstallLease(root);
                if (InstalledRuntimeRunning(root)) throw new InvalidOperationException("Close the installed browser and agent before reinstalling retained program files.");
                PreflightOwned(root, owner, cancellationToken);
                var remaining = CleanupOwnedProgramFiles(root, owner, cancellationToken);
                if (remaining.Any(path => path.Contains('/')))
                    throw new InvalidOperationException("Some retained program files are busy; close maintenance and retry installation.");
            }
            foreach (var name in new[] { "versions", "staging", "downloads", "profile", "agent-state" }) DirectorySafe(SafePath(root, name));
            var settingsPath = SafePath(root, "installation.json");
            if (File.Exists(settingsPath))
            {
                var settings = GetSettings(root);
                if (settings.Feed != feed) throw new InvalidDataException("Resume must use the installation's original feed.");
            }
            else Atomic(settingsPath, Bytes(new Settings(1, feed, pollSeconds)));
            var runLock = SafePath(root, "run.lock");
            if (!File.Exists(runLock)) { using var lease = new FileStream(runLock, FileMode.CreateNew); }
            var launcher = SafePath(root, "Velmren.exe");
            if (!File.Exists(launcher))
            {
                var temporary = SafePath(root, "Velmren.exe.installing");
                if (File.Exists(temporary)) File.Delete(temporary);
                await CopyProgramFile(self, temporary, cancellationToken);
                if (Hash(self, cancellationToken) != Hash(temporary, cancellationToken)) throw new CryptographicException("Launcher copy hash rejected.");
                File.Move(temporary, launcher);
            }
            WriteOwnership(root, ReadOwnership(root) with { State = "installing" });
            if (bundle is null)
            {
                var offered = await Latest(FeedUri(feed), cancellationToken);
                await ApplyRelease(root, offered, ct => Download(root, FeedUri(feed), SelectArchive(offered.Manifest), ct), cancellationToken);
            }
            else
            {
                var selected = SelectArchive(bundle.Manifest, bundleDirectory!);
                var source = SafePath(bundleDirectory!, selected.Package);
                await ApplyRelease(root, bundle, ct => CopyBundle(root, source, selected, ct), cancellationToken);
            }
            var current = Current(root) ?? throw new InvalidOperationException("Initial installation did not activate.");
            VerifyInstalled(root, current.Version, cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            WriteOwnership(root, ReadOwnership(root) with { State = "installed" });
            Event(root, "installed", current.Version);
        }
    }

    static async Task CopyProgramFile(string source, string destination, CancellationToken cancellationToken)
    {
        NoLinks(source); NoLinks(destination);
        using var input = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.Read);
        using var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None);
        await input.CopyToAsync(output, cancellationToken);
        output.Flush(true);
    }

    static async Task<string> CopyBundle(string root, string source, Manifest manifest, CancellationToken cancellationToken)
    {
        DirectorySafe(SafePath(root, "downloads"));
        Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(new { action = "bundle-verifying" }));
        NoLinks(source);
        if (new FileInfo(source).Length != manifest.Size || !Hash(source, cancellationToken).Equals(manifest.Sha256, StringComparison.OrdinalIgnoreCase))
            throw new CryptographicException("Bundle package size or SHA-256 rejected.");
        var complete = ArchiveCachePath(root, manifest);
        var partial = complete + ".part";
        TrackOwned(root, [Path.GetRelativePath(root, complete), Path.GetRelativePath(root, partial)]);
        if (File.Exists(complete) && new FileInfo(complete).Length == manifest.Size && Hash(complete, cancellationToken).Equals(manifest.Sha256, StringComparison.OrdinalIgnoreCase)) return complete;
        NoLinks(partial);
        // An interrupted local copy restarts; only HTTP downloads use byte ranges.
        if (File.Exists(partial)) File.Delete(partial);
        await CopyProgramFile(source, partial, cancellationToken);
        if (new FileInfo(partial).Length != manifest.Size || !Hash(partial, cancellationToken).Equals(manifest.Sha256, StringComparison.OrdinalIgnoreCase))
            throw new CryptographicException("Copied bundle SHA-256 rejected.");
        File.Move(partial, complete, true);
        Event(root, "downloaded", manifest.Version, "Verified offline bundle.");
        return complete;
    }

    static (string Key, string Start, string Desktop) ShellLocations(string? testId, string? testRoot)
    {
        var identity = Policy.IsRelease ? "Velmren-" + Policy.Channel + "-" + Policy.Platform : "Velmren-Development";
        string start, desktop;
        if (testId is not null || testRoot is not null)
        {
            if (Policy.IsRelease || !Guid.TryParseExact(testId, "N", out _) || testRoot is null || !Path.IsPathFullyQualified(testRoot))
                throw new InvalidDataException("Isolated shell QA requires a development build, GUID test identity and absolute test root.");
            identity += "-Test-" + testId;
            start = SafePath(testRoot, "StartMenu"); desktop = SafePath(testRoot, "Desktop");
        }
        else
        {
            start = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
            desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
        }
        var name = Policy.IsRelease ? "Velmren.lnk" : "Velmren Development.lnk";
        return (@"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + identity, SafePath(start, name), SafePath(desktop, name));
    }

    static async Task Register(string root, bool desktop, CancellationToken cancellationToken)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        root = CanonicalRoot(root);
        _ = ReadOwnership(root); _ = GetSettings(root);
        using var operation = await Lock(root, cancellationToken);
        var owner = ReadOwnership(root);
        if (owner.State != "installed") throw new InvalidOperationException("Complete the installation before registration.");
        var pointer = Current(root) ?? throw new InvalidOperationException("No verified installation.");
        var verified = VerifyInstalled(root, pointer.Version, cancellationToken);
        var appRoot = Path.Combine(VersionDirectory(root, pointer.Version), "app");
        var app = Read<AppConfig>(SafePath(appRoot, "delivery-app.json"));
        var maintenance = await EnsureMaintenance(root, appRoot, verified, app, cancellationToken);
        owner = ReadOwnership(root);
        var testId = Environment.GetEnvironmentVariable("VELMREN_DELIVERY_TEST_ID");
        var testRoot = Environment.GetEnvironmentVariable("VELMREN_DELIVERY_TEST_SHELL_ROOT");
        var locations = ShellLocations(testId, testRoot);
        if (owner.Registration is not null) ValidateShellRegistration(owner);
        if (owner.Registration is not null && (owner.Registration.Key != locations.Key || owner.Registration.TestRoot != testRoot))
            throw new InvalidOperationException("This installation is already registered in another shell scope.");
        using (var existing = Registry.CurrentUser.OpenSubKey(locations.Key))
            if (existing is not null) CheckRegistrationOwner(existing, owner);
        var links = owner.Registration?.Links.ToList() ?? [];
        foreach (var path in desktop ? new[] { locations.Start, locations.Desktop } : new[] { locations.Start })
        {
            cancellationToken.ThrowIfCancellationRequested(); NoLinks(path);
            var previous = links.FirstOrDefault(link => link.Path == path);
            if (File.Exists(path) && (previous is null || !MatchesOwnedLink(path, previous, cancellationToken)))
                throw new InvalidOperationException("A shortcut at the destination is not owned by this installation.");
        }
        var temporaryLinks = owner.Registration?.TemporaryLinks?.ToList() ?? [];
        var registryStage = owner.Registration?.RegistryStage;
        var registryPlan = owner.Registration?.RegistryPlan;
        var registryPending = owner.Registration?.RegistryPending ?? false;
        foreach (var path in desktop ? new[] { locations.Start, locations.Desktop } : new[] { locations.Start })
        {
            cancellationToken.ThrowIfCancellationRequested();
            DirectorySafe(Path.GetDirectoryName(path)!);
            var temporary = path + "." + owner.Id + ".installing.lnk";
            NoLinks(temporary);
            if (File.Exists(temporary) && !temporaryLinks.Contains(temporary)) throw new InvalidOperationException("Unowned shortcut staging file already exists.");
            if (!temporaryLinks.Contains(temporary)) temporaryLinks.Add(temporary);
            WriteOwnership(root, ReadOwnership(root) with { Registration = new ShellRegistration(locations.Key, testId, testRoot, links.ToArray(), temporaryLinks.ToArray(), registryStage, registryPlan, registryPending) });
            if (File.Exists(temporary)) File.Delete(temporary);
            CreateShortcut(temporary, SafePath(root, "Velmren.exe"), root);
            var next = new OwnedLink(path, Hash(temporary, cancellationToken), File.Exists(path) ? Hash(path, cancellationToken) : null);
            links.RemoveAll(link => link.Path == path); links.Add(next);
            WriteOwnership(root, ReadOwnership(root) with { Registration = new ShellRegistration(locations.Key, testId, testRoot, links.ToArray(), temporaryLinks.ToArray(), registryStage, registryPlan, registryPending) });
            File.Move(temporary, path, true);
            links.Remove(next); links.Add(next with { PreviousSha256 = null }); temporaryLinks.Remove(temporary);
            WriteOwnership(root, ReadOwnership(root) with { Registration = new ShellRegistration(locations.Key, testId, testRoot, links.ToArray(), temporaryLinks.ToArray(), registryStage, registryPlan, registryPending) });
        }
        if (!desktop && links.FirstOrDefault(link => link.Path == locations.Desktop) is { } previousDesktop)
        {
            NoLinks(previousDesktop.Path);
            if (File.Exists(previousDesktop.Path) && MatchesOwnedLink(previousDesktop.Path, previousDesktop, cancellationToken)) DeleteShellFile(previousDesktop.Path, cancellationToken);
            links.Remove(previousDesktop);
            WriteOwnership(root, ReadOwnership(root) with { Registration = new ShellRegistration(locations.Key, testId, testRoot, links.ToArray(), temporaryLinks.ToArray(), registryStage, registryPlan, registryPending) });
        }
        PublishRegistration(root, pointer.Version, maintenance, app.Setup is not null, cancellationToken);
        Event(root, "registered", pointer.Version);
    }

    static Dictionary<string, RegistrationValue> RegistrationPlanValues(InstallOwnership owner, RegistryWritePlan plan)
    {
        _ = VersionOf(plan.Version);
        var root = owner.Root;
        var maintenance = SafePath(root, plan.Gui ? "VelmrenMaintenance.exe" : "Velmren.exe");
        return new(StringComparer.OrdinalIgnoreCase) {
            ["VelmrenOwner"] = RegistrationValue.String(owner.Id),
            ["InstallLocation"] = RegistrationValue.String(root),
            ["DisplayName"] = RegistrationValue.String(Policy.IsRelease ? "Velmren" : "Velmren Development"),
            ["DisplayVersion"] = RegistrationValue.String(plan.Version),
            ["Publisher"] = RegistrationValue.String("Velmren"),
            ["DisplayIcon"] = RegistrationValue.String(SafePath(root, "Velmren.exe")),
            ["UninstallString"] = RegistrationValue.String(UninstallCommand(root, maintenance, plan.Gui)),
            ["NoModify"] = RegistrationValue.Dword(1), ["NoRepair"] = RegistrationValue.Dword(1)
        };
    }

    static void CheckRegistrationOwner(RegistryKey key, InstallOwnership owner)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        var plan = owner.Registration?.RegistryPlan;
        RegistrationWriter.AssertWritable(WindowsRegistrationKey.Read(key), owner.Id, owner.Root,
            plan is null ? null : RegistrationPlanValues(owner, plan));
    }

    static void PublishRegistration(string root, string version, string maintenance, bool gui, CancellationToken token)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        var owner = ReadOwnership(root);
        ValidateShellRegistration(owner);
        var registration = owner.Registration ?? throw new InvalidDataException("Missing shell ownership journal.");
        if (registration.RegistryStage is string stage)
        {
            using var existingStage = Registry.CurrentUser.OpenSubKey(stage);
            if (existingStage is not null) ValidateRegistryStage(existingStage, root, owner);
        }
        var plan = new RegistryWritePlan(version, gui);
        if (!maintenance.Equals(SafePath(owner.Root, gui ? "VelmrenMaintenance.exe" : "Velmren.exe"), StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Unexpected maintenance path.");
        RegistrationWriter.Publish(new WindowsRegistrationStore(), registration.Key, owner.Id, owner.Root,
            RegistrationPlanValues(owner, plan), registration.RegistryPlan is null ? null : RegistrationPlanValues(owner, registration.RegistryPlan),
            () => WriteOwnership(root, ReadOwnership(root) with { Registration = registration with { RegistryPlan = plan, RegistryPending = true } }),
            () => {
                CleanupRegistryStage(root, owner);
                WriteOwnership(root, ReadOwnership(root) with { Registration = registration with { RegistryPlan = plan, RegistryPending = false, RegistryStage = null } });
            },
            () => WriteOwnership(root, ReadOwnership(root) with { Registration = registration }), token);
    }

    static void ValidateRegistryStage(RegistryKey key, string root, InstallOwnership owner)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        if (key.SubKeyCount != 0 || key.GetValueNames().Except(RegistrationValues, StringComparer.OrdinalIgnoreCase).Any()
            || key.GetValue("VelmrenOwner") is object id && !Equals(id, owner.Id)
            || key.GetValue("InstallLocation") is object location && !Equals(location, root))
            throw new InvalidDataException("Uninstall staging key contains unrelated values or subkeys.");
    }

    static void CleanupRegistryStage(string root, InstallOwnership owner)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        if (owner.Registration?.RegistryStage is not string stage) return;
        using (var key = Registry.CurrentUser.OpenSubKey(stage))
        {
            if (key is null) return;
            ValidateRegistryStage(key, root, owner);
        }
        Registry.CurrentUser.DeleteSubKey(stage);
    }

    static string UninstallCommand(string root, string maintenance, bool gui) => "\"" + maintenance + "\" " + (gui ? "--uninstall" : "uninstall") + " --root \"" + root + "\"";

    static async Task<string> EnsureMaintenance(string root, string appRoot, Verified verified, AppConfig app, CancellationToken token)
    {
        if (app.Setup is null) return SafePath(root, "Velmren.exe");
        if (app.Setup != "delivery/VelmrenMaintenance.exe") throw new InvalidDataException("Unexpected signed maintenance path.");
        var signed = verified.Manifest.Files.Single(file => file.Path == app.Setup);
        var source = SafePath(appRoot, app.Setup);
        if (new FileInfo(source).Length != signed.Size || !Hash(source, token).Equals(signed.Sha256, StringComparison.OrdinalIgnoreCase))
            throw new CryptographicException("Signed maintenance UI hash rejected.");
        var maintenance = SafePath(root, "VelmrenMaintenance.exe");
        TrackOwned(root, ["VelmrenMaintenance.exe", "VelmrenMaintenance.exe.installing"]);
        if (File.Exists(maintenance) && Hash(maintenance, token).Equals(signed.Sha256, StringComparison.OrdinalIgnoreCase)) return maintenance;
        var temporary = maintenance + ".installing";
        if (File.Exists(temporary)) File.Delete(temporary);
        await CopyProgramFile(source, temporary, token);
        if (!Hash(temporary, token).Equals(signed.Sha256, StringComparison.OrdinalIgnoreCase)) throw new CryptographicException("Maintenance UI copy hash rejected.");
        token.ThrowIfCancellationRequested();
        if (File.Exists(maintenance))
        {
            var backup = SafePath(root, "VelmrenMaintenance.previous-" + Guid.NewGuid().ToString("N") + ".exe");
            TrackOwned(root, [Path.GetRelativePath(root, backup)]);
            File.Replace(temporary, maintenance, backup);
            try { File.Delete(backup); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
        else File.Move(temporary, maintenance);
        return maintenance;
    }

    // Caller owns operation.lock and run.lock. Updating a release never creates shell entries.
    static void RefreshInstalledRegistration(string root, CancellationToken token = default)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        root = CanonicalRoot(root);
        if (!File.Exists(SafePath(root, OwnershipFile))) return;
        var owner = ReadOwnership(root);
        if (owner.Registration is null) return;
        ValidateShellRegistration(owner);
        using (var key = Registry.CurrentUser.OpenSubKey(owner.Registration.Key))
        {
            if (key is null) throw new InvalidOperationException("The owned uninstall entry is missing; registration refresh remains pending.");
            CheckRegistrationOwner(key, owner);
        }
        var current = Current(root) ?? throw new InvalidOperationException("No active version for shell registration.");
        var verified = ReadInstalledManifest(root, current.Version);
        var appRoot = SafePath(root, "versions/" + current.Version + "/app");
        var configFile = verified.Manifest.Files.Single(file => file.Path == "delivery-app.json");
        var configPath = SafePath(appRoot, configFile.Path);
        if (new FileInfo(configPath).Length != configFile.Size || !Hash(configPath, token).Equals(configFile.Sha256, StringComparison.OrdinalIgnoreCase))
            throw new CryptographicException("Signed maintenance configuration hash rejected.");
        var app = Read<AppConfig>(configPath);
        var maintenance = EnsureMaintenance(root, appRoot, verified, app, token).GetAwaiter().GetResult();
        token.ThrowIfCancellationRequested();
        PublishRegistration(root, current.Version, maintenance, app.Setup is not null, token);
        Event(root, "registration-refreshed", current.Version);
    }

    static bool MatchesOwnedLink(string path, OwnedLink link, CancellationToken token)
    {
        for (var attempt = 0; ; attempt++)
        {
            token.ThrowIfCancellationRequested(); NoLinks(path);
            try
            {
                var hash = Hash(path, token);
                return hash.Equals(link.Sha256, StringComparison.OrdinalIgnoreCase) || hash.Equals(link.PreviousSha256, StringComparison.OrdinalIgnoreCase);
            }
            catch (IOException error) when (attempt < 30 && (error.HResult & 0xffff) is 32 or 33)
            { token.WaitHandle.WaitOne(100); }
        }
    }

    static void ValidateShellRegistration(InstallOwnership owner)
    {
        if (owner.Registration is not { } registration) return;
        if (registration.RegistryPlan is not null) _ = VersionOf(registration.RegistryPlan.Version);
        var expected = ShellLocations(registration.TestId, registration.TestRoot);
        if (registration.Key != expected.Key || registration.Links.Any(link => link.Path != expected.Start && link.Path != expected.Desktop)
            || (registration.TemporaryLinks ?? []).Any(path => path != expected.Start + "." + owner.Id + ".installing.lnk" && path != expected.Desktop + "." + owner.Id + ".installing.lnk")
            || registration.RegistryStage is not null && registration.RegistryStage != expected.Key + ".installing-" + owner.Id)
            throw new InvalidDataException("Shell ownership record has an unexpected destination.");
    }

    static void CreateShortcut(string path, string target, string root)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        var type = Type.GetTypeFromProgID("WScript.Shell") ?? throw new InvalidOperationException("Windows Shell shortcut support unavailable.");
        dynamic shell = Activator.CreateInstance(type)!;
        dynamic? shortcut = null;
        try
        {
            shortcut = shell.CreateShortcut(path);
            shortcut.TargetPath = target; shortcut.Arguments = ""; shortcut.WorkingDirectory = root;
            shortcut.IconLocation = target + ",0"; shortcut.Description = "Velmren"; shortcut.Save();
        }
        finally
        {
            if (shortcut is not null) Marshal.FinalReleaseComObject(shortcut);
            Marshal.FinalReleaseComObject(shell);
        }
    }

    static bool InstalledRuntimeRunning(string root)
    {
        var owner = ReadOwnership(root);
        var executables = owner.Files.Where(file => file.StartsWith("versions/", StringComparison.OrdinalIgnoreCase)
            && file.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)
            && !file.EndsWith("/app/delivery/VelmrenMaintenance.exe", StringComparison.OrdinalIgnoreCase))
            .Select(file => SafePath(root, file)).GroupBy(Path.GetFileNameWithoutExtension, StringComparer.OrdinalIgnoreCase);
        foreach (var group in executables)
        {
            var paths = group.ToHashSet(StringComparer.OrdinalIgnoreCase);
            foreach (var process in Process.GetProcessesByName(group.Key))
            using (process)
            {
                if (process.Id == Environment.ProcessId) continue;
                try { if (process.MainModule?.FileName is not string running || paths.Contains(running)) return true; }
                catch (InvalidOperationException) { }
                catch (System.ComponentModel.Win32Exception) { return true; }
            }
        }
        return false;
    }

    static void RemoveRegistration(string root, InstallOwnership owner, CancellationToken cancellationToken)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        if (owner.Registration is not { } registration) return;
        ValidateShellRegistration(owner);
        using (var existing = Registry.CurrentUser.OpenSubKey(registration.Key))
            if (existing is not null) CheckRegistrationOwner(existing, owner);
        CleanupRegistryStage(root, owner);
        foreach (var temporary in registration.TemporaryLinks ?? [])
        {
            cancellationToken.ThrowIfCancellationRequested(); NoLinks(temporary);
            if (File.Exists(temporary)) DeleteShellFile(temporary, cancellationToken);
        }
        foreach (var link in registration.Links)
        {
            cancellationToken.ThrowIfCancellationRequested();
            NoLinks(link.Path);
            if (File.Exists(link.Path) && MatchesOwnedLink(link.Path, link, cancellationToken)) DeleteShellFile(link.Path, cancellationToken);
        }
        RegistrationWriter.Remove(new WindowsRegistrationStore(), registration.Key, owner.Id, owner.Root,
            registration.RegistryPlan is null ? null : RegistrationPlanValues(owner, registration.RegistryPlan),
            RegistrationValues, cancellationToken);
    }

    static void DeleteShellFile(string path, CancellationToken token)
    {
        for (var attempt = 0; ; attempt++)
        {
            token.ThrowIfCancellationRequested(); NoLinks(path);
            try { File.Delete(path); return; }
            catch (IOException error) when (attempt < 30 && (error.HResult & 0xffff) is 32 or 33)
            { token.WaitHandle.WaitOne(100); }
        }
    }

    static async Task Uninstall(string root, CancellationToken cancellationToken)
    {
        root = CanonicalRoot(root);
        _ = ReadOwnership(root);
        using var operation = await Lock(root, cancellationToken);
        var owner = ReadOwnership(root);
        List<string> retained;
        using (var lease = OpenUninstallLease(root))
        {
            if (InstalledRuntimeRunning(root)) throw new InvalidOperationException("Installed browser or agent runtime is running; close it before uninstalling.");
            PreflightOwned(root, owner, cancellationToken);
            RemoveRegistration(root, owner, cancellationToken);
            // Keep the registration tombstone for interrupted/lazy hive deletes;
            // it does not recreate entries while the installation is retained.
            WriteOwnership(root, owner with { State = "retained" });
            retained = CleanupOwnedProgramFiles(root, owner, cancellationToken);
        }
        // Keep ownership and high-water trust alongside saved data so a reinstall is safe.
        foreach (var file in new[] { "run.lock" }) { var path = SafePath(root, file); if (File.Exists(path)) File.Delete(path); }
        var remaining = Directory.EnumerateFileSystemEntries(root).Select(Path.GetFileName)
            .Where(name => name is not ("profile" or "agent-state" or OwnershipFile or "operation.lock")).ToArray();
        Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(new { action = "uninstalled", detail = "Saved profile and agent state preserved.", retainedFiles = retained, remainingEntries = remaining }));
    }

    static FileStream? OpenUninstallLease(string root)
    {
        var run = SafePath(root, "run.lock");
        if (!File.Exists(run)) return null;
        try { return new FileStream(run, FileMode.Open, FileAccess.ReadWrite, FileShare.None); }
        catch (IOException) { throw new InvalidOperationException("Close Velmren and its agent session before uninstalling; no processes were stopped."); }
    }

    static void PreflightOwned(string root, InstallOwnership owner, CancellationToken cancellationToken)
    {
        // Resolve every owned file before deleting any, rejecting junctions at any depth.
        foreach (var file in owner.Files) { cancellationToken.ThrowIfCancellationRequested(); _ = SafePath(root, file); }
    }

    static List<string> CleanupOwnedProgramFiles(string root, InstallOwnership owner, CancellationToken cancellationToken)
    {
        var retained = new List<string>();
        foreach (var file in owner.Files.Where(file => file is not ("operation.lock" or "run.lock")))
        {
            cancellationToken.ThrowIfCancellationRequested();
            var path = SafePath(root, file);
            try { if (File.Exists(path)) File.Delete(path); }
            catch (IOException) { retained.Add(file); }
            catch (UnauthorizedAccessException) { retained.Add(file); }
        }
        var directories = owner.Files.SelectMany(file => ParentDirectories(file)).Distinct(StringComparer.OrdinalIgnoreCase).OrderByDescending(path => path.Length);
        foreach (var directory in directories)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var path = SafePath(root, directory);
            if (Directory.Exists(path) && !Directory.EnumerateFileSystemEntries(path).Any()) Directory.Delete(path);
        }
        return retained;
    }

    static IEnumerable<string> ParentDirectories(string relative)
    {
        for (var index = relative.LastIndexOf('/'); index > 0; index = relative.LastIndexOf('/'))
        { relative = relative[..index]; yield return relative; }
    }
}
