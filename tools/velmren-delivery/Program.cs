using System.Buffers;
using System.Diagnostics;
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Velmren.Delivery;

internal sealed record PayloadFile(string Path, long Size, string Sha256);
internal sealed record ArchiveVariant(string Format, string Package, long Size, string Sha256, string? PackageUrl = null);
internal sealed record Manifest(int Schema, string Product, string Version, string Package,
    long Size, string Sha256, long ExpandedSize, PayloadFile[] Files,
    string? Channel = null, string? Platform = null, string? PackageUrl = null, ArchiveVariant? CompactArchive = null);
internal sealed record Envelope(string Payload, string Signature);
internal sealed record Pointer(string Version);
internal sealed record Settings(int Schema, string Feed, int PollSeconds);
internal sealed record AppConfig(string Browser, string[]? BrowserArguments = null,
    string? Agent = null, string[]? AgentArguments = null,
    Dictionary<string, string>? AgentEnvironment = null, string? Setup = null, string? Launcher = null);
internal sealed record Verified(Manifest Manifest, byte[] Envelope);

internal static partial class Program
{
    const long MaxPackage = 16L * 1024 * 1024 * 1024;
    const int MaxManifest = 16 * 1024 * 1024;
    static readonly TimeSpan NetworkIdleTimeout = TimeSpan.FromSeconds(10);
    static readonly TimeSpan StartupUpdateTimeout = TimeSpan.FromSeconds(5);
    // Keep in sync with chrome/installer/setup/configure_app_container_sandbox.cc.
    static readonly string[] SandboxInstallCapabilities = [
        "S-1-15-3-1024-3424233489-972189580-2057154623-747635277-1604371224-316187997-3786583170-1043257646",
        "S-1-15-3-1024-2302894289-466761758-1166120688-1039016420-2430351297-4240214049-4028510897-3317428798"
    ];
    static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, WriteIndented = true };
    static readonly Lazy<DeliveryPolicy> EmbeddedPolicy = new(DeliveryPolicy.LoadEmbedded);
    static DeliveryPolicy Policy => EmbeddedPolicy.Value;
    static readonly DeliveryTransport Transport = new();

    public static async Task<int> Main(string[] args)
    {
        try
        {
            _ = Policy;
            if (Policy.IsRelease) { using var key = PinnedKey(); }
            var command = args.Length == 0 ? "launch" : args[0];
            var options = Options(args.Skip(1).ToArray());
            if (options.ContainsKey("setup-path")) throw new InvalidDataException("Maintenance UI must come from the signed package, never --setup-path.");
            using var cancellation = new CancellationSignal(options.GetValueOrDefault("cancel-file"));
            var token = cancellation.Token;
            token.ThrowIfCancellationRequested();
            switch (command)
            {
                case "keygen": Keygen(Required(options, "directory")); break;
                case "package": Package(Required(options, "payload"), Required(options, "version"), Required(options, "feed-directory"), Required(options, "private-key"), options.GetValueOrDefault("package-url"), options.GetValueOrDefault("compact-archive"), options.GetValueOrDefault("compact-package-url")); break;
                case "install": await Install(Required(options, "root"), options.GetValueOrDefault("feed") ?? Policy.FeedUri ?? Required(options, "feed"), Number(options, "poll-seconds", 120), token); break;
                case "install-bundle": await Install(Required(options, "root"), options.GetValueOrDefault("feed") ?? Policy.FeedUri ?? Required(options, "feed"), Number(options, "poll-seconds", 120), token, Required(options, "bundle-directory")); break;
                case "register": await Register(Root(options), Boolean(options, "desktop", false), token); break;
                case "uninstall": await Uninstall(Root(options), token); break;
                case "policy": Console.WriteLine(JsonSerializer.Serialize(Policy, Json)); break;
                case "launcher-probe": LauncherProbe(); break;
                case "update": await Update(Root(options), token); break;
                case "launch": await Launch(Root(options), false, options, token); break;
                case "agents": await Launch(Root(options), true, options, token); break;
                case "resolve": case "verify": Resolve(Root(options), token); break;
                case "status": Status(Root(options)); break;
                case "serve": await Serve(Required(options, "directory"), Number(options, "port", 18773), Number(options, "truncate-first-package", 0), options.GetValueOrDefault("stall-first")); break;
                case "synthetic-app": await Synthetic(options); break;
                default: throw new InvalidDataException("Commands: keygen, package, install, install-bundle, register, uninstall, update, launch, agents, resolve, status, serve.");
            }
            return 0;
        }
        catch (OperationCanceledException)
        {
            Console.WriteLine(JsonSerializer.Serialize(new { action = "cancelled" }));
            return 2;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"{ex.GetType().Name}: {SafeError(ex)}");
            return 1;
        }
    }

    static Dictionary<string, string> Options(string[] args)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        for (var i = 0; i < args.Length; i++)
        {
            if (!args[i].StartsWith("--", StringComparison.Ordinal)) throw new InvalidDataException($"Expected option, got {args[i]}");
            var parts = args[i][2..].Split('=', 2);
            result[parts[0]] = parts.Length == 2 ? parts[1] : i + 1 < args.Length && !args[i + 1].StartsWith("--", StringComparison.Ordinal) ? args[++i] : "true";
        }
        return result;
    }
    static string Required(Dictionary<string, string> options, string name) => options.TryGetValue(name, out var value) ? value : throw new InvalidDataException($"Missing --{name}");
    static int Number(Dictionary<string, string> options, string name, int fallback) => options.TryGetValue(name, out var value) ? int.Parse(value) : fallback;
    static bool Boolean(Dictionary<string, string> options, string name, bool fallback) => options.TryGetValue(name, out var value) ? bool.TryParse(value, out var parsed) ? parsed : throw new InvalidDataException($"--{name} must be true or false.") : fallback;
    static string Root(Dictionary<string, string> options) => Path.GetFullPath(options.GetValueOrDefault("root") ?? AppContext.BaseDirectory);
    static T Read<T>(string file) => JsonSerializer.Deserialize<T>(File.ReadAllBytes(file), Json) ?? throw new InvalidDataException($"Invalid {Path.GetFileName(file)}");
    static byte[] Bytes<T>(T value) => JsonSerializer.SerializeToUtf8Bytes(value, Json);
    static string Hash(string path, CancellationToken cancellationToken = default)
    {
        using var file = File.OpenRead(path);
        using var hasher = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = ArrayPool<byte>.Shared.Rent(1024 * 1024);
        try
        {
            int count;
            while ((count = file.Read(buffer)) != 0) { cancellationToken.ThrowIfCancellationRequested(); hasher.AppendData(buffer, 0, count); }
            cancellationToken.ThrowIfCancellationRequested();
            return Convert.ToHexStringLower(hasher.GetHashAndReset());
        }
        finally { ArrayPool<byte>.Shared.Return(buffer); }
    }
    static Version VersionOf(string text) => Version.TryParse(text, out var version) && version.Revision >= 0 && version.ToString() == text ? version : throw new InvalidDataException("Version must have four canonical numeric parts.");

    static void NoLinks(string path)
    {
        var current = Path.GetFullPath(path);
        while (current is not null)
        {
            try
            {
                if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                    throw new InvalidDataException($"Reparse point is forbidden: {current}");
            }
            catch (FileNotFoundException) { }
            catch (DirectoryNotFoundException) { }
            current = Path.GetDirectoryName(current);
        }
    }
    static void ValidateRelativePath(string relative)
    {
        if (string.IsNullOrEmpty(relative) || relative.Contains('\\') || relative.Contains(':') || relative.StartsWith('/') || relative.Any(c => c < 32)) throw new InvalidDataException("Unsafe archive path.");
        foreach (var segment in relative.Split('/'))
        {
            if (segment is "" or "." or ".." || segment.EndsWith('.') || segment.EndsWith(' ') || segment.IndexOfAny(['<', '>', '"', '|', '?', '*']) >= 0 || ReservedName().IsMatch(segment.Split('.')[0]))
                throw new InvalidDataException($"Unsafe path component: {segment}");
        }
    }
    static string SafePath(string root, string relative)
    {
        ValidateRelativePath(relative);
        var prefix = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var full = Path.GetFullPath(Path.Combine(prefix, relative.Replace('/', Path.DirectorySeparatorChar)));
        if (!full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Path escapes destination.");
        NoLinks(full);
        return full;
    }
    [GeneratedRegex("^(CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex ReservedName();
    static void DirectorySafe(string path) { NoLinks(path); Directory.CreateDirectory(path); NoLinks(path); }
    static void Atomic(string destination, byte[] value)
    {
        NoLinks(destination);
        var temp = destination + ".new-" + Guid.NewGuid().ToString("N");
        try
        {
            using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { stream.Write(value); stream.Flush(true); }
            File.Move(temp, destination, true);
        }
        finally { if (File.Exists(temp)) File.Delete(temp); }
    }
    static async Task<FileStream> Lock(string root, CancellationToken cancellationToken = default)
    {
        var path = Path.Combine(root, "operation.lock");
        NoLinks(path);
        for (var i = 0; ; i++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try { return new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
            catch (IOException) when (i < 1200) { await Task.Delay(250, cancellationToken); }
        }
    }
    static void Event(string root, string action, string? version = null, string? detail = null)
    {
        var entry = new { time = DateTimeOffset.UtcNow, action, version, detail };
        var line = JsonSerializer.Serialize(entry);
        try { Console.WriteLine(line); } catch (IOException) { }
        var path = Path.Combine(root, "events.jsonl");
        // Launch no longer owns operation.lock. Diagnostic contention must not
        // abandon an already started browser or release its activation lease.
        for (var attempt = 0; attempt < 3; attempt++)
        {
            try { NoLinks(path); File.AppendAllText(path, line + Environment.NewLine); return; }
            catch (IOException) when (attempt < 2) { Thread.Sleep(5); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or InvalidDataException) { return; }
        }
    }
    static int TransferProgress(string action, long completed, long total, int previous)
    {
        var percent = total == 0 ? 100 : (int)Math.Clamp(completed * 100 / total, 0, 100);
        if (percent != previous) Console.WriteLine(JsonSerializer.Serialize(new { action, percent }));
        return percent;
    }

    static void Keygen(string directory)
    {
        if (Policy.IsRelease) throw new InvalidOperationException("Release builds cannot generate development signing keys.");
        directory = Path.GetFullPath(directory);
        DirectorySafe(directory);
        using var rsa = RSA.Create(3072);
        using (var output = new FileStream(Path.Combine(directory, "private.pem"), FileMode.CreateNew)) output.Write(Encoding.UTF8.GetBytes(rsa.ExportPkcs8PrivateKeyPem()));
        using (var output = new FileStream(Path.Combine(directory, "public.pem"), FileMode.CreateNew)) output.Write(Encoding.UTF8.GetBytes(rsa.ExportSubjectPublicKeyInfoPem()));
        Console.WriteLine("Created development signing key pair. Keep private.pem outside source and distribution.");
    }
    static RSA PinnedKey()
    {
        using var resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("Velmren.UpdatePublicKey") ?? throw new InvalidOperationException("Installer must be built with a pinned public key.");
        using var reader = new StreamReader(resource);
        var pem = reader.ReadToEnd();
        if (pem.Contains("PRIVATE KEY", StringComparison.Ordinal)) throw new CryptographicException("Embedded trust must contain only a public key.");
        var rsa = RSA.Create();
        try
        {
            rsa.ImportFromPem(pem);
            if (Policy.IsRelease && rsa.KeySize < 3072) throw new CryptographicException("Release requires RSA-3072 or stronger.");
            return rsa;
        }
        catch { rsa.Dispose(); throw; }
    }
    static Verified Verify(byte[] envelopeBytes)
    {
        if (envelopeBytes.Length > MaxManifest) throw new InvalidDataException("Manifest too large.");
        var envelope = JsonSerializer.Deserialize<Envelope>(envelopeBytes, Json) ?? throw new InvalidDataException("Invalid envelope.");
        var payload = Convert.FromBase64String(envelope.Payload);
        using var key = PinnedKey();
        if (!key.VerifyData(payload, Convert.FromBase64String(envelope.Signature), HashAlgorithmName.SHA256, RSASignaturePadding.Pss)) throw new CryptographicException("Update manifest signature rejected.");
        var manifest = JsonSerializer.Deserialize<Manifest>(payload, Json) ?? throw new InvalidDataException("Invalid manifest.");
        Validate(manifest);
        return new Verified(manifest, envelopeBytes);
    }
    static void Validate(Manifest manifest)
    {
        Policy.ValidateIdentity(manifest);
        _ = VersionOf(manifest.Version);
        if (manifest.Package != $"velmren-{manifest.Version}.zip" || manifest.Size <= 0 || manifest.Size > MaxPackage || manifest.ExpandedSize < 0 || manifest.ExpandedSize > MaxPackage || manifest.Files is null || manifest.Files.Length is < 1 or > 30000)
            throw new InvalidDataException("Invalid package limits.");
        CheckHash(manifest.Sha256);
        ValidateCompactArchive(manifest);
        var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        long total = 0;
        foreach (var file in manifest.Files)
        {
            // A manifest path has no filesystem destination until extraction.
            ValidateRelativePath(file.Path);
            if (!paths.Add(file.Path) || file.Size < 0 || file.Size > MaxPackage) throw new InvalidDataException("Duplicate path or invalid length.");
            CheckHash(file.Sha256);
            total = checked(total + file.Size);
        }
        if (total != manifest.ExpandedSize || !paths.Contains("delivery-app.json")) throw new InvalidDataException("Invalid manifest inventory.");
        foreach (var path in paths)
        {
            var index = path.IndexOf('/');
            while (index >= 0) { if (paths.Contains(path[..index])) throw new InvalidDataException("File/directory collision."); index = path.IndexOf('/', index + 1); }
        }
    }
    static void CheckHash(string value) { if (value is null || value.Length != 64 || value.Any(c => !char.IsAsciiHexDigit(c))) throw new InvalidDataException("Invalid SHA-256."); }
    static void Package(string payload, string version, string feed, string privateKey, string? packageUrl = null,
        string? compactArchivePath = null, string? compactPackageUrl = null)
    {
        _ = VersionOf(version);
        payload = Path.GetFullPath(payload); feed = Path.GetFullPath(feed);
        privateKey = Path.GetFullPath(privateKey);
        if (Policy.IsRelease) ValidateReleasePrivateKey(privateKey, payload, feed);
        Policy.ValidatePackageUrl(packageUrl);
        using var rsa = RSA.Create(); rsa.ImportFromPem(File.ReadAllText(privateKey));
        if (Policy.IsRelease)
        {
            using var pinned = PinnedKey();
            if (rsa.KeySize < 3072 || !rsa.ExportSubjectPublicKeyInfo().AsSpan().SequenceEqual(pinned.ExportSubjectPublicKeyInfo()))
                throw new CryptographicException("Release signing key does not match the embedded public key.");
        }
        NoLinks(payload); DirectorySafe(feed);
        if (feed.StartsWith(payload.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Feed must be outside payload.");
        var inventory = new List<PayloadFile>();
        var allFiles = Walk(payload).Order(StringComparer.Ordinal).ToArray();
        var archiveName = $"velmren-{version}.zip";
        var zipPath = Path.Combine(feed, archiveName);
        if (File.Exists(zipPath)) throw new InvalidOperationException("Release already exists; choose a new version.");
        var temp = zipPath + ".building-" + Guid.NewGuid().ToString("N");
        using (var output = new FileStream(temp, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None))
        using (var archive = new ZipArchive(output, ZipArchiveMode.Create))
        {
            foreach (var source in allFiles)
            {
                NoLinks(source);
                var relative = Path.GetRelativePath(payload, source).Replace('\\', '/');
                SafePath(payload, relative);
                using var input = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.Read);
                var entry = archive.CreateEntry(relative, CompressionLevel.SmallestSize);
                entry.ExternalAttributes = 0;
                using var destination = entry.Open();
                using var hasher = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                var buffer = new byte[1024 * 1024]; int count; long length = 0;
                while ((count = input.Read(buffer)) > 0) { destination.Write(buffer, 0, count); hasher.AppendData(buffer, 0, count); length += count; }
                inventory.Add(new PayloadFile(relative, length, Convert.ToHexStringLower(hasher.GetHashAndReset())));
            }
        }
        var manifest = new Manifest(Policy.Schema, Policy.Product, version, archiveName, new FileInfo(temp).Length, Hash(temp), inventory.Sum(f => f.Size), inventory.ToArray(), Policy.Channel, Policy.Platform, packageUrl);
        if (compactArchivePath is not null)
        {
            compactArchivePath = Path.GetFullPath(compactArchivePath);
            NoLinks(compactArchivePath);
            if (Path.GetFileName(compactArchivePath) != $"velmren-{version}.7z") throw new InvalidDataException("Unexpected compact archive filename.");
            manifest = manifest with { CompactArchive = new("7z", Path.GetFileName(compactArchivePath), new FileInfo(compactArchivePath).Length, Hash(compactArchivePath), compactPackageUrl) };
        }
        else if (compactPackageUrl is not null) throw new InvalidDataException("Compact package URL requires a compact archive.");
        Validate(manifest);
        if (compactArchivePath is not null)
            ExtractCompactArchive(compactArchivePath, SafePath(feed, ".compact-verification-" + Guid.NewGuid().ToString("N")), manifest, CancellationToken.None);
        var app = Read<AppConfig>(Path.Combine(payload, "delivery-app.json")); ValidateApp(payload, app);
        var signed = Bytes(manifest);
        var envelope = Bytes(new Envelope(Convert.ToBase64String(signed), Convert.ToBase64String(rsa.SignData(signed, HashAlgorithmName.SHA256, RSASignaturePadding.Pss))));
        File.Move(temp, zipPath);
        Atomic(Path.Combine(feed, $"manifest-{version}.json"), envelope);
        Atomic(Path.Combine(feed, "latest.json"), envelope);
        Console.WriteLine(JsonSerializer.Serialize(new { version, package = zipPath, files = inventory.Count, manifest.Size, manifest.ExpandedSize }));
    }
    static IEnumerable<string> Walk(string root, CancellationToken cancellationToken = default)
    {
        NoLinks(root);
        foreach (var path in Directory.EnumerateFileSystemEntries(root))
        {
            cancellationToken.ThrowIfCancellationRequested();
            NoLinks(path);
            if (Directory.Exists(path)) { foreach (var child in Walk(path, cancellationToken)) yield return child; }
            else yield return path;
        }
    }

    static Uri FeedUri(string feed) => Policy.ValidateFeed(feed);
    static async Task<Verified> Latest(Uri feed, CancellationToken cancellationToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(NetworkIdleTimeout);
        using var response = await Transport.GetAsync(new Uri(feed, "latest.json"), Policy, null, timeout.Token);
        DeliveryTransport.EnsureSuccess(response);
        if (response.Content.Headers.ContentLength > MaxManifest) throw new InvalidDataException("Manifest too large.");
        using var input = await response.Content.ReadAsStreamAsync(timeout.Token); using var output = new MemoryStream();
        var buffer = new byte[8192]; int count;
        while ((count = await input.ReadAsync(buffer, timeout.Token)) != 0) { if (output.Length + count > MaxManifest) throw new InvalidDataException("Manifest too large."); output.Write(buffer, 0, count); }
        return Verify(output.ToArray());
    }
    static Settings GetSettings(string root)
    {
        NoLinks(root); NoLinks(Path.Combine(root, "installation.json"));
        if (File.Exists(Path.Combine(root, OwnershipFile)) || Policy.IsRelease)
        {
            if (ReadOwnership(root, validateInventory: false).State == "retained") throw new InvalidOperationException("This installation was uninstalled; run install again to restore its program files.");
        }
        var settings = Read<Settings>(Path.Combine(root, "installation.json"));
        if (settings.Schema != 1 || settings.PollSeconds is < 1 or > 86400) throw new InvalidDataException("Invalid installation settings.");
        _ = FeedUri(settings.Feed); return settings;
    }
    static Pointer? Current(string root, string name = "current.json")
    {
        var path = Path.Combine(root, name); NoLinks(path);
        if (!File.Exists(path)) return null;
        var pointer = Read<Pointer>(path); _ = VersionOf(pointer.Version); return pointer;
    }
    static string VersionDirectory(string root, string version) { _ = VersionOf(version); return SafePath(root, "versions/" + version); }
    static async Task Update(string root, CancellationToken cancellationToken = default)
    {
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        budget.CancelAfter(TimeSpan.FromMinutes(20));
        cancellationToken = budget.Token;
        var settings = GetSettings(root);
        using var operation = await Lock(root, cancellationToken);
        var verified = await Latest(FeedUri(settings.Feed), cancellationToken);
        await ApplyRelease(root, verified, ct => Download(root, FeedUri(settings.Feed), SelectArchive(verified.Manifest), ct), cancellationToken);
    }
    static async Task ApplyRelease(string root, Verified verified, Func<CancellationToken, Task<string>> archiveSource, CancellationToken cancellationToken)
    {
        var manifest = verified.Manifest;
        ValidateHighWater(root, manifest);
        var current = Current(root); var pending = Current(root, "pending.json");
        var newest = new[] { current?.Version, pending?.Version }.Where(v => v is not null).Select(v => VersionOf(v!)).DefaultIfEmpty(new Version(0, 0, 0, 0)).Max()!;
        if (VersionOf(manifest.Version) < newest) throw new InvalidDataException("Downgrade/replayed older release rejected.");
        if (current?.Version == manifest.Version)
        {
            SameRelease(ReadInstalledManifest(root, manifest.Version).Manifest, manifest);
            TryActivate(root, cancellationToken, cleanupRetired: true);
            Event(root, "up-to-date", manifest.Version); return;
        }
        var versionPath = VersionDirectory(root, manifest.Version);
        if (!Directory.Exists(versionPath))
        {
            var archive = await archiveSource(cancellationToken);
            var stage = SafePath(root, "staging/" + manifest.Version + "-" + Guid.NewGuid().ToString("N"));
            TrackReleaseFiles(root, stage, verified.Manifest);
            TrackReleaseFiles(root, versionPath, verified.Manifest);
            DirectorySafe(stage);
            Extract(archive, Path.Combine(stage, "app"), manifest, cancellationToken);
            Atomic(Path.Combine(stage, "manifest.json"), verified.Envelope);
            ValidateApp(Path.Combine(stage, "app"), Read<AppConfig>(Path.Combine(stage, "app", "delivery-app.json")));
            Directory.Move(stage, versionPath);
            Event(root, "staged", manifest.Version);
        }
        else SameRelease(ReadInstalledManifest(root, manifest.Version).Manifest, manifest);
        cancellationToken.ThrowIfCancellationRequested();
        EnsureSandboxReadAccess(Path.Combine(versionPath, "app"));
        RememberHighWater(root, verified);
        Atomic(Path.Combine(root, "pending.json"), Bytes(new Pointer(manifest.Version)));
        TryActivate(root, cancellationToken, cleanupRetired: true);
    }
    static async Task<string> Download(string root, Uri feed, Manifest manifest, CancellationToken cancellationToken,
        DeliveryTransport? transport = null, DeliveryPolicy? policy = null)
    {
        var complete = ArchiveCachePath(root, manifest);
        DirectorySafe(SafePath(root, "downloads"));
        var partial = complete + ".part"; NoLinks(partial);
        TrackOwned(root, [Path.GetRelativePath(root, complete), Path.GetRelativePath(root, partial)]);
        if (File.Exists(complete) && new FileInfo(complete).Length == manifest.Size && Hash(complete, cancellationToken).Equals(manifest.Sha256, StringComparison.OrdinalIgnoreCase)) return complete;
        var offset = File.Exists(partial) ? new FileInfo(partial).Length : 0;
        if (offset >= manifest.Size) { using var reset = new FileStream(partial, FileMode.Create); offset = 0; }
        using var idleTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        idleTimeout.CancelAfter(NetworkIdleTimeout);
        policy ??= Policy;
        using var response = await (transport ?? Transport).GetAsync(policy.PackageUri(feed, manifest), policy, offset > 0 ? offset : null, idleTimeout.Token);
        DeliveryTransport.EnsureSuccess(response);
        if (offset > 0 && response.StatusCode == HttpStatusCode.PartialContent)
        {
            var range = response.Content.Headers.ContentRange;
            if (range?.Unit != "bytes" || range.From != offset || range.Length != manifest.Size || range.To != manifest.Size - 1) throw new InvalidDataException("Invalid resume response.");
            Event(root, "download-resumed", manifest.Version, offset.ToString());
        }
        else if (response.StatusCode == HttpStatusCode.OK) offset = 0;
        else throw new InvalidDataException("Unexpected package HTTP status.");
        if (response.Content.Headers.ContentLength is long contentLength && contentLength != manifest.Size - offset) throw new InvalidDataException("Package response length mismatch.");
        using (var output = new FileStream(partial, offset > 0 ? FileMode.Append : FileMode.Create, FileAccess.Write, FileShare.None))
        using (var input = await response.Content.ReadAsStreamAsync(idleTimeout.Token))
        {
            var buffer = new byte[1024 * 1024]; int count; long total = offset;
            var progress = TransferProgress("downloading", total, manifest.Size, -1);
            while (true)
            {
                idleTimeout.CancelAfter(NetworkIdleTimeout);
                count = await input.ReadAsync(buffer, idleTimeout.Token);
                if (count == 0) break;
                total += count; if (total > manifest.Size) throw new InvalidDataException("Package exceeds signed length.");
                await output.WriteAsync(buffer.AsMemory(0, count), cancellationToken);
                progress = TransferProgress("downloading", total, manifest.Size, progress);
            }
            output.Flush(true);
            if (total != manifest.Size) throw new InvalidDataException("Package download incomplete; retry resumes it.");
        }
        Console.WriteLine(JsonSerializer.Serialize(new { action = "bundle-verifying" }));
        if (!Hash(partial, cancellationToken).Equals(manifest.Sha256, StringComparison.OrdinalIgnoreCase))
        {
            var rejected = partial + ".rejected-" + Guid.NewGuid().ToString("N");
            TrackOwned(root, [Path.GetRelativePath(root, rejected)]);
            File.Move(partial, rejected);
            throw new CryptographicException("Package SHA-256 rejected.");
        }
        File.Move(partial, complete, true);
        Event(root, "downloaded", manifest.Version);
        return complete;
    }
    static void Extract(string archivePath, string destination, Manifest manifest, CancellationToken cancellationToken)
    {
        if (Path.GetExtension(archivePath) == ".7z")
        {
            if (manifest.CompactArchive is null) throw new InvalidDataException("Unsigned compact archive representation.");
            ExtractCompactArchive(archivePath, destination, manifest, cancellationToken);
            return;
        }
        DirectorySafe(destination);
        using var archive = ZipFile.OpenRead(archivePath);
        if (archive.Entries.Count != manifest.Files.Length) throw new InvalidDataException("Archive inventory count mismatch.");
        var inventory = manifest.Files.ToDictionary(f => f.Path, StringComparer.Ordinal);
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        // Validate the whole central directory before writing any package file.
        foreach (var entry in archive.Entries)
        {
            cancellationToken.ThrowIfCancellationRequested();
            SafePath(destination, entry.FullName);
            var unixType = (entry.ExternalAttributes >> 16) & 0xF000;
            if (!seen.Add(entry.FullName) || !inventory.TryGetValue(entry.FullName, out var file) || entry.Length != file.Size || (unixType != 0 && unixType != 0x8000) || (entry.ExternalAttributes & (int)FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException("Archive entry is unlisted, duplicate, linked, or has the wrong size.");
        }
        long expanded = 0;
        var progress = TransferProgress("extracting", 0, manifest.ExpandedSize, -1);
        foreach (var entry in archive.Entries)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var destinationFile = SafePath(destination, entry.FullName);
            DirectorySafe(Path.GetDirectoryName(destinationFile)!);
            using var input = entry.Open(); using var output = new FileStream(destinationFile, FileMode.CreateNew, FileAccess.Write, FileShare.None);
            using var hasher = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            var buffer = new byte[1024 * 1024]; int count; long total = 0;
            while ((count = input.Read(buffer)) > 0)
            {
                cancellationToken.ThrowIfCancellationRequested();
                total += count; if (total > entry.Length) throw new InvalidDataException("Expanded file exceeds signed length.");
                output.Write(buffer, 0, count); hasher.AppendData(buffer, 0, count);
            }
            output.Flush(true);
            if (total != entry.Length || !Convert.ToHexStringLower(hasher.GetHashAndReset()).Equals(inventory[entry.FullName].Sha256, StringComparison.OrdinalIgnoreCase)) throw new CryptographicException("Extracted file SHA-256 rejected.");
            expanded += total;
            progress = TransferProgress("extracting", expanded, manifest.ExpandedSize, progress);
        }
    }
    static void SameRelease(Manifest installed, Manifest offered)
    {
        if (installed.Size != offered.Size || !installed.Sha256.Equals(offered.Sha256, StringComparison.OrdinalIgnoreCase)
            || installed.PackageUrl != offered.PackageUrl || installed.CompactArchive != offered.CompactArchive)
            throw new InvalidDataException("An immutable release version was rebound to another package.");
    }
    static Verified ReadInstalledManifest(string root, string version)
    {
        var directory = VersionDirectory(root, version);
        var metadata = Path.Combine(directory, "manifest.json"); NoLinks(metadata);
        if (new FileInfo(metadata).Length > MaxManifest) throw new InvalidDataException("Installed manifest too large.");
        var verified = Verify(File.ReadAllBytes(metadata));
        if (verified.Manifest.Version != version) throw new InvalidDataException("Installed version metadata mismatch.");
        return verified;
    }
    static Verified VerifyInstalled(string root, string version, CancellationToken cancellationToken = default)
    {
        var verified = ReadInstalledManifest(root, version);
        var directory = VersionDirectory(root, version);
        var app = Path.Combine(directory, "app");
        var all = Walk(app, cancellationToken).Select(path => Path.GetRelativePath(app, path).Replace('\\', '/')).ToHashSet(StringComparer.Ordinal);
        if (!all.SetEquals(verified.Manifest.Files.Select(f => f.Path))) throw new InvalidDataException("Installed payload inventory mismatch.");
        foreach (var file in verified.Manifest.Files)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var path = SafePath(app, file.Path);
            if (new FileInfo(path).Length != file.Size || !Hash(path, cancellationToken).Equals(file.Sha256, StringComparison.OrdinalIgnoreCase)) throw new CryptographicException($"Installed file hash rejected: {file.Path}");
        }
        ValidateApp(app, Read<AppConfig>(Path.Combine(app, "delivery-app.json")));
        EnsureSandboxReadAccess(app);
        return verified;
    }
    static void EnsureSandboxReadAccess(string appDirectory)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Windows sandbox ACLs are required.");
        NoLinks(appDirectory);
        var directory = new DirectoryInfo(appDirectory);
        var security = directory.GetAccessControl(AccessControlSections.Access);
        const FileSystemRights rights = FileSystemRights.ReadAndExecute | FileSystemRights.Synchronize;
        const InheritanceFlags inheritance = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
        var changed = false;
        foreach (var capability in SandboxInstallCapabilities)
        {
            var sid = new SecurityIdentifier(capability);
            var present = false;
            foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier)))
            {
                if (rule.IdentityReference.Equals(sid) && rule.AccessControlType == AccessControlType.Allow &&
                    (rule.FileSystemRights & rights) == rights && (rule.InheritanceFlags & inheritance) == inheritance &&
                    rule.PropagationFlags == PropagationFlags.None) { present = true; break; }
            }
            if (present) continue;
            security.AddAccessRule(new FileSystemAccessRule(sid, rights, inheritance, PropagationFlags.None, AccessControlType.Allow));
            changed = true;
        }
        // Applying the inheritable DACL propagates to existing unprotected children.
        // Never reset inheritance or replace the ACL on profile/state/ancestor paths.
        if (changed) directory.SetAccessControl(security);
    }
    static void ValidateApp(string root, AppConfig config)
    {
        if (!File.Exists(SafePath(root, config.Browser)) || !config.Browser.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Browser EXE missing from payload.");
        if (config.Agent is not null && (!config.Agent.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) || !File.Exists(SafePath(root, config.Agent)))) throw new InvalidDataException("Agent runtime EXE missing.");
        if (config.Setup is not null && (config.Setup != "delivery/VelmrenMaintenance.exe" || !File.Exists(SafePath(root, config.Setup)))) throw new InvalidDataException("Signed maintenance UI must be delivery/VelmrenMaintenance.exe.");
        if (config.Launcher is not null && (config.Launcher != "delivery/Velmren.exe" || !File.Exists(SafePath(root, config.Launcher)))) throw new InvalidDataException("Signed launcher must be delivery/Velmren.exe.");
        if ((config.BrowserArguments ?? []).Any(a => a.StartsWith("--user-data-dir", StringComparison.OrdinalIgnoreCase))) throw new InvalidDataException("Browser profile must be managed by launcher.");
    }
    static bool BrowserRunning(string root)
    {
        var versions = SafePath(root, "versions");
        foreach (var directory in Directory.EnumerateDirectories(versions))
        {
            var configPath = Path.Combine(directory, "app", "delivery-app.json"); NoLinks(configPath);
            if (!File.Exists(configPath)) continue;
            var app = Read<AppConfig>(configPath);
            var browser = SafePath(Path.Combine(directory, "app"), app.Browser);
            foreach (var process in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(browser)))
            {
                using (process)
                {
                    try
                    {
                        var executable = process.MainModule?.FileName;
                        if (executable is null || executable.Equals(browser, StringComparison.OrdinalIgnoreCase)) return true;
                    }
                    catch (InvalidOperationException) { }
                    catch (System.ComponentModel.Win32Exception) { return true; }
                }
            }
        }
        return false;
    }
    static bool TryActivate(string root, CancellationToken cancellationToken = default, bool cleanupRetired = false)
    {
        var activated = TryActivateCore(root, cancellationToken);
        if (cleanupRetired) CleanupRetiredArtifacts(root, cancellationToken);
        return activated;
    }
    static bool TryActivateCore(string root, CancellationToken cancellationToken)
    {
        var pending = Current(root, "pending.json");
        if (pending is null && !File.Exists(SafePath(root, LauncherJournal))
            && !File.Exists(SafePath(root, RegistrationRefreshFile))) return false;
        FileStream lease;
        try { lease = new FileStream(SafePath(root, "run.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None); }
        catch (IOException) { Event(root, "activation-deferred", pending?.Version, "Launcher session is running."); return false; }
        using (lease)
        {
            if (BrowserRunning(root)) { Event(root, "activation-deferred", pending?.Version, "Installed browser process is running."); return false; }
            RecoverLauncher(root);
            RetryRegistrationRefresh(root, cancellationToken);
            if (pending is null) return false;
            var current = Current(root);
            if (current is not null && VersionOf(pending.Version) < VersionOf(current.Version)) throw new InvalidDataException("Pending downgrade rejected.");
            VerifyInstalled(root, pending.Version, cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            LauncherTransaction? transaction;
            try { transaction = PrepareLauncher(root, current, pending, cancellationToken); }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                RecoverLauncher(root);
                Event(root, "launcher-update-rejected", pending.Version, SafeError(ex));
                return false;
            }
            try
            {
                ScheduleRegistrationRefresh(root, pending);
                Atomic(Path.Combine(root, "current.json"), Bytes(pending));
                File.Delete(SafePath(root, "pending.json"));
                CompleteLauncher(root, transaction);
                if (File.Exists(SafePath(root, OwnershipFile)))
                {
                    WriteOwnership(root, ReadOwnership(root) with { State = "installed" });
                    RetryRegistrationRefresh(root, cancellationToken);
                }
            }
            catch { RecoverLauncher(root); throw; }
            Event(root, "activated", pending.Version);
            return true;
        }
    }
    static async Task Launch(string root, bool agents, Dictionary<string, string> options, CancellationToken cancellationToken = default)
    {
        var launchTimer = Stopwatch.StartNew();
        var url = options.TryGetValue("url", out var requestedUrl) ? LaunchUrl(requestedUrl) : null;
        var prepared = await PrepareBrowserLaunch(root, cancellationToken);
        var settings = prepared.Settings;
        var pointer = prepared.Current;
        var lease = prepared.Lease;
        Process process;
        try
        {
            var phase = Stopwatch.StartNew();
            if (agents) VerifyInstalled(root, pointer.Version, cancellationToken);
            var appRoot = Path.Combine(VersionDirectory(root, pointer.Version), "app");
            var app = ReadBrowserLaunchConfiguration(root, pointer.Version);
            var validationMs = phase.Elapsed.TotalMilliseconds;
            var browser = SafePath(appRoot, app.Browser);
            var start = new ProcessStartInfo { FileName = agents ? SafePath(appRoot, app.Agent ?? throw new InvalidOperationException("No agent runtime in package.")) : browser, WorkingDirectory = appRoot, UseShellExecute = false, CreateNoWindow = agents };
            string Expand(string arg) => arg.Replace("{browser}", browser, StringComparison.Ordinal).Replace("{agentStateDir}", SafePath(root, "agent-state"), StringComparison.Ordinal).Replace("{profile}", SafePath(root, "profile"), StringComparison.Ordinal);
            foreach (var argument in (agents ? app.AgentArguments : app.BrowserArguments) ?? []) start.ArgumentList.Add(Expand(argument));
            if (agents)
            {
                foreach (var pair in app.AgentEnvironment ?? []) start.Environment[pair.Key] = Expand(pair.Value);
            }
            else
            {
                start.ArgumentList.Add("--user-data-dir=" + SafePath(root, "profile"));
                start.ArgumentList.Add("--no-first-run"); start.ArgumentList.Add("--no-default-browser-check");
                if (url is not null) start.ArgumentList.Add(url);
            }
            start.Environment["VELMREN_PROFILE_DIR"] = SafePath(root, "profile");
            phase.Restart();
            process = Process.Start(start) ?? throw new InvalidOperationException("Application failed to start.");
            var processStartMs = phase.Elapsed.TotalMilliseconds;
            Event(root, agents ? "agents-started" : "browser-started", pointer.Version, process.Id.ToString());
            Event(root, "launch-timing", pointer.Version, JsonSerializer.Serialize(new { preparationMs = launchTimer.Elapsed.TotalMilliseconds,
                settingsMs = prepared.SettingsMs, lockWaitMs = prepared.LockWaitMs, validationMs, processStartMs }));
        }
        catch { lease.Dispose(); throw; }
        var interval = Number(options, "poll-seconds", settings.PollSeconds);
        if (interval is < 1 or > 86400) interval = settings.PollSeconds;
        using (process)
        using (lease)
        {
            await InitialUpdateCheck(root, cancellationToken);
            var next = DateTime.UtcNow.AddSeconds(interval);
            while (!process.HasExited || BrowserRunning(root))
            {
                await Task.Delay(250, cancellationToken);
                if (DateTime.UtcNow < next) continue;
                try { await Update(root, cancellationToken); }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
                catch (Exception ex) { Event(root, "update-check-failed", detail: SafeError(ex)); }
                next = DateTime.UtcNow.AddSeconds(interval);
            }
        }
        using (var operation = await Lock(root, cancellationToken)) TryActivate(root, cancellationToken, cleanupRetired: true);
        Event(root, agents ? "agents-exited" : "browser-exited", Current(root)?.Version);
    }
    static async Task InitialUpdateCheck(string root, CancellationToken cancellationToken = default)
    {
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        budget.CancelAfter(StartupUpdateTimeout);
        try { await Update(root, budget.Token); }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
        catch (OperationCanceledException) { Event(root, "update-check-failed", detail: "Initial update check exceeded its 5-second budget; a later background check resumes it."); }
        catch (Exception ex) { Event(root, "update-check-failed", detail: SafeError(ex)); }
    }
    static string LaunchUrl(string value)
    {
        if (value != value.Trim() || value.Any(char.IsControl) || !Uri.TryCreate(value, UriKind.Absolute, out var uri)
            || uri.Scheme is not ("http" or "https") || string.IsNullOrEmpty(uri.Host))
            throw new InvalidDataException("--url must be an absolute http:// or https:// URL, never a browser switch.");
        return uri.AbsoluteUri;
    }
    static void Resolve(string root, CancellationToken cancellationToken = default)
    {
        _ = GetSettings(root);
        var current = Current(root) ?? throw new InvalidOperationException("No active version.");
        VerifyInstalled(root, current.Version, cancellationToken);
        var appRoot = Path.Combine(VersionDirectory(root, current.Version), "app");
        var config = Read<AppConfig>(Path.Combine(appRoot, "delivery-app.json"));
        Console.WriteLine(JsonSerializer.Serialize(new { version = current.Version, appRoot, browser = SafePath(appRoot, config.Browser), agentRuntime = config.Agent is null ? null : SafePath(appRoot, config.Agent), agentStateDir = SafePath(root, "agent-state"), profile = SafePath(root, "profile") }, Json));
    }
    static void Status(string root)
    {
        var settings = GetSettings(root);
        Console.WriteLine(JsonSerializer.Serialize(new { current = Current(root), pending = Current(root, "pending.json"), settings.Feed, settings.PollSeconds, browserRunning = BrowserRunning(root), trust = Policy.Mode + " RSA-PSS manifest verification; executable is not Authenticode signed" }, Json));
    }

    static async Task Serve(string directory, int port, int truncateFirst, string? stallFirst)
    {
        directory = Path.GetFullPath(directory); NoLinks(directory);
        if (port is < 1024 or > 65535) throw new InvalidDataException("Use a local unprivileged port.");
        if (stallFirst is not (null or "manifest" or "package")) throw new InvalidDataException("--stall-first must be manifest or package.");
        using var listener = new HttpListener(); listener.Prefixes.Add($"http://127.0.0.1:{port}/"); listener.Start();
        Console.WriteLine($"Development feed listening at http://127.0.0.1:{port}/");
        var interrupted = false;
        var stalled = false;
        while (true)
        {
            var context = await listener.GetContextAsync();
            try
            {
                if (context.Request.HttpMethod != "GET") { context.Response.StatusCode = 405; continue; }
                var name = Uri.UnescapeDataString(context.Request.Url!.AbsolutePath.TrimStart('/'));
                if (name.Contains('/') || name is not "latest.json" && !name.StartsWith("manifest-", StringComparison.Ordinal) && !name.StartsWith("velmren-", StringComparison.Ordinal)) { context.Response.StatusCode = 404; continue; }
                var file = SafePath(directory, name);
                if (!File.Exists(file)) { context.Response.StatusCode = 404; continue; }
                using var input = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete);
                long offset = 0;
                if (context.Request.Headers["Range"] is string range)
                {
                    if (!range.StartsWith("bytes=", StringComparison.Ordinal) || !range.EndsWith('-') || !long.TryParse(range[6..^1], out offset) || offset < 0 || offset >= input.Length) { context.Response.StatusCode = 416; continue; }
                    context.Response.StatusCode = 206; context.Response.Headers["Content-Range"] = $"bytes {offset}-{input.Length - 1}/{input.Length}";
                }
                context.Response.ContentLength64 = input.Length - offset; context.Response.Headers["Accept-Ranges"] = "bytes"; context.Response.Headers["Cache-Control"] = "no-store";
                input.Position = offset;
                if (!stalled && (stallFirst == "manifest" && name == "latest.json" || stallFirst == "package" && name.EndsWith(".zip", StringComparison.Ordinal)))
                {
                    stalled = true;
                    var firstByte = new byte[1];
                    var count = await input.ReadAsync(firstByte);
                    await context.Response.OutputStream.WriteAsync(firstByte.AsMemory(0, count));
                    await context.Response.OutputStream.FlushAsync();
                    Console.WriteLine($"Stalling {stallFirst} body after headers and {count} byte.");
                    await Task.Delay(TimeSpan.FromSeconds(30));
                    context.Response.Abort();
                }
                else if (truncateFirst > 0 && !interrupted && name.EndsWith(".zip", StringComparison.Ordinal))
                {
                    interrupted = true; var buffer = new byte[Math.Min(truncateFirst, 1024 * 1024)]; var count = await input.ReadAsync(buffer); await context.Response.OutputStream.WriteAsync(buffer.AsMemory(0, count)); context.Response.Abort();
                }
                else await input.CopyToAsync(context.Response.OutputStream);
            }
            catch (Exception ex) when (ex is IOException or HttpListenerException or InvalidDataException) { Console.Error.WriteLine(ex.Message); }
            finally { context.Response.Close(); }
        }
    }
    static async Task Synthetic(Dictionary<string, string> options)
    {
        var profile = Required(options, "user-data-dir"); DirectorySafe(profile);
        File.WriteAllText(Path.Combine(profile, "synthetic-running.txt"), Environment.ProcessId.ToString());
        await Task.Delay(TimeSpan.FromSeconds(Number(options, "seconds", 8)));
    }
}
