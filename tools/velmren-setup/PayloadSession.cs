using System.Reflection;
using System.IO.Compression;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;

namespace Velmren.Setup;

internal sealed record SetupPayload(string? Feed, string? Package, string? EngineSha256 = null,
    long EngineSize = 0, string EngineSource = "gzip")
{
    public SetupPayload() : this(null, null) { }
}

internal sealed class PayloadSession : IDisposable
{
    private readonly List<string> files = [];
    internal string DirectoryPath { get; }
    internal string EnginePath => Path.Combine(DirectoryPath, "VelmrenDelivery.exe");
    internal string? BundleDirectory { get; private set; }
    internal string? Feed { get; private set; }
    internal string CancelPath => Path.Combine(DirectoryPath, "cancel.request");

    private PayloadSession(string directory) => DirectoryPath = directory;

    internal static SetupPayload ReadConfiguration()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("Setup.Payload.Config")
            ?? throw new InvalidDataException("Missing setup payload.");
        using var reader = new StreamReader(stream);
        var payload = JsonCodec.Deserialize<SetupPayload>(reader.ReadToEnd()) ?? throw new InvalidDataException("Invalid setup payload.");
        if (payload.EngineSha256 is not { Length: 64 } || payload.EngineSha256.Any(c => !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f')) ||
            payload.EngineSize <= 0 || payload.EngineSize > 512L * 1024 * 1024 ||
            payload.EngineSource is not ("installed" or "gzip" or "package"))
            throw new InvalidDataException("Invalid engine identity.");
        return payload;
    }

    internal static async Task<PayloadSession> ExtractAsync(CancellationToken cancellationToken, string? cacheDirectory = null, string? installRoot = null)
    {
        var directory = CreatePrivateDirectory(cacheDirectory);
        var session = new PayloadSession(directory);
        try
        {
            var assembly = Assembly.GetExecutingAssembly();
            var payload = ReadConfiguration();
            if (payload.Feed is not null && (!Uri.TryCreate(payload.Feed, UriKind.Absolute, out var feed) ||
                feed.Scheme != Uri.UriSchemeHttps || !string.IsNullOrEmpty(feed.UserInfo) || !string.IsNullOrEmpty(feed.Fragment)))
                throw new InvalidDataException("Invalid embedded feed.");
            session.Feed = payload.Feed;
            if (payload.Package is not null)
            {
                if (payload.Package != Path.GetFileName(payload.Package) || !payload.Package.EndsWith(".zip", StringComparison.OrdinalIgnoreCase) ||
                    payload.Package.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
                    throw new InvalidDataException("Invalid embedded package name.");
                session.BundleDirectory = Path.Combine(directory, "bundle");
                Directory.CreateDirectory(session.BundleDirectory);
                await session.CopyResourceAsync(assembly, "Setup.Payload.Manifest", Path.Combine(session.BundleDirectory, "manifest.json"), cancellationToken);
                await session.CopyResourceAsync(assembly, "Setup.Payload.Package", Path.Combine(session.BundleDirectory, payload.Package), cancellationToken);
            }
            if (payload.EngineSource == "installed")
            {
                if (installRoot is null || payload.Feed is not null || payload.Package is not null)
                    throw new InvalidDataException("Maintenance requires an installed root.");
                await session.CopyInstalledEngineAsync(installRoot, payload, cancellationToken);
            }
            else if (payload.EngineSource == "package")
            {
                if (session.BundleDirectory is null) throw new InvalidDataException("Missing engine package.");
                using var package = File.OpenRead(Path.Combine(session.BundleDirectory, payload.Package!));
                using var archive = new ZipArchive(package, ZipArchiveMode.Read);
                var entries = archive.Entries.Where(entry => entry.FullName == "delivery/Velmren.exe").ToArray();
                if (entries.Length != 1 || entries[0].Length != payload.EngineSize) throw new InvalidDataException("Invalid package engine.");
                using var input = entries[0].Open();
                await session.CopyVerifiedEngineAsync(input, payload, cancellationToken);
            }
            else
            {
                using var resource = assembly.GetManifestResourceStream("Setup.Payload.Engine") ?? throw new InvalidDataException("Missing embedded engine.");
                using var input = new GZipStream(resource, CompressionMode.Decompress);
                await session.CopyVerifiedEngineAsync(input, payload, cancellationToken);
            }
            return session;
        }
        catch { session.Dispose(); throw; }
    }

    internal static string CreatePrivateDirectory(string? cacheDirectory = null)
    {
        var cache = cacheDirectory ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Velmren", "SetupCache");
        EnsureNoLinks(cache);
        Directory.CreateDirectory(cache);
        var directory = Path.Combine(cache, Guid.NewGuid().ToString("N"));
        var security = new DirectorySecurity();
        security.SetAccessRuleProtection(true, false);
        var user = WindowsIdentity.GetCurrent().User ?? throw new IOException("Missing current user.");
        security.AddAccessRule(new FileSystemAccessRule(user, FileSystemRights.FullControl,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
            FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
            PropagationFlags.None, AccessControlType.Allow));
        new DirectoryInfo(directory).Create(security);
        return directory;
    }

    private async Task CopyResourceAsync(Assembly assembly, string resource, string destination, CancellationToken cancellationToken)
    {
        using var input = assembly.GetManifestResourceStream(resource) ?? throw new InvalidDataException("Missing embedded file.");
        using var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1024 * 1024, true);
        files.Add(destination);
        await input.CopyToAsync(output, 1024 * 1024, cancellationToken);
    }

    internal async Task CopyInstalledEngineAsync(string installRoot, SetupPayload payload, CancellationToken cancellationToken)
    {
        var root = SetupOptions.ValidateRoot(installRoot);
        if (await TryCopyInstalledEngineAsync(Path.Combine(root, "Velmren.exe"), payload, cancellationToken)) return;

        // An update may replace the root launcher after this maintenance window opens.
        // Only the exact pinned engine in a canonical retained version is eligible.
        var versions = Path.Combine(root, "versions");
        EnsureNoLinks(versions);
        cancellationToken.ThrowIfCancellationRequested();
        string[] entries;
        try { entries = Directory.EnumerateFileSystemEntries(versions).Take(65).ToArray(); }
        catch (DirectoryNotFoundException) { entries = Array.Empty<string>(); }
        if (entries.Length > 64) throw new InvalidDataException("Too many retained version entries.");
        foreach (var entry in entries)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var name = Path.GetFileName(entry);
            if (!Version.TryParse(name, out var version) || version.Revision < 0 || version.ToString() != name) continue;
            EnsureNoLinks(entry);
            var candidate = Path.Combine(entry, "app", "delivery", "Velmren.exe");
            if (await TryCopyInstalledEngineAsync(candidate, payload, cancellationToken)) return;
        }
        throw new InvalidDataException("No installed engine matches this maintenance version.");
    }

    private async Task<bool> TryCopyInstalledEngineAsync(string source, SetupPayload payload, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        EnsureNoLinks(source);
        // Deny writes/deletes until the exact engine has reached the invocation's private cache.
        FileStream input;
        try { input = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.Read, 1024 * 1024, true); }
        catch (FileNotFoundException) { return false; }
        catch (DirectoryNotFoundException) { return false; }
        using (input)
        {
            if (input.Length != payload.EngineSize) return false;
            try
            {
                await CopyVerifiedEngineAsync(input, payload, cancellationToken);
                return true;
            }
            catch (InvalidDataException)
            {
                EnsureNoLinks(EnginePath);
                File.Delete(EnginePath);
                files.Remove(EnginePath);
                return false;
            }
        }
    }

    private async Task CopyVerifiedEngineAsync(Stream input, SetupPayload payload, CancellationToken cancellationToken)
    {
        using var output = new FileStream(EnginePath, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1024 * 1024, true);
        files.Add(EnginePath);
        using var hash = SHA256.Create();
        var buffer = new byte[1024 * 1024];
        long length = 0;
        int count;
        while ((count = await input.ReadAsync(buffer, 0, buffer.Length, cancellationToken)) > 0)
        {
            length += count;
            if (length > payload.EngineSize) throw new InvalidDataException("Engine exceeds expected size.");
            hash.TransformBlock(buffer, 0, count, buffer, 0);
            await output.WriteAsync(buffer, 0, count, cancellationToken);
        }
        hash.TransformFinalBlock(Array.Empty<byte>(), 0, 0);
        var actual = BitConverter.ToString(hash.Hash!).Replace("-", "").ToLowerInvariant();
        if (length != payload.EngineSize || actual != payload.EngineSha256) throw new InvalidDataException("Engine identity mismatch.");
    }

    internal void ResetCancellation()
    {
        EnsureNoLinks(CancelPath);
        File.Delete(CancelPath);
    }

    internal static void EnsureNoLinks(string path)
    {
        for (string? current = Path.GetFullPath(path); current is not null; current = Path.GetDirectoryName(current))
        {
            try
            {
                if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                    throw new IOException("Linked setup path is not supported.");
            }
            catch (FileNotFoundException) { }
            catch (DirectoryNotFoundException) { }
        }
    }

    public void Dispose()
    {
        // Delete only files created by this invocation, never recursively follow a cache directory.
        TryCleanup();
    }

    internal async Task CleanupAsync()
    {
        for (var attempt = 0; attempt < 10 && !TryCleanup(); attempt++) await Task.Delay(100);
    }

    internal bool TryCleanup()
    {
        try
        {
            EnsureNoLinks(DirectoryPath);
            foreach (var path in files.Append(CancelPath))
            {
                EnsureNoLinks(path);
                try { File.Delete(path); }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
            if (BundleDirectory is not null && Directory.Exists(BundleDirectory)) Directory.Delete(BundleDirectory);
            if (Directory.Exists(DirectoryPath)) Directory.Delete(DirectoryPath);
            return true;
        }
        catch (IOException) { return !Directory.Exists(DirectoryPath); }
        catch (UnauthorizedAccessException) { return false; }
    }
}
