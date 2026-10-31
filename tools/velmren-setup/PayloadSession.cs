using System.Reflection;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;

namespace Velmren.Setup;

internal sealed record SetupPayload(string? Feed, string? Package);

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
        return JsonSerializer.Deserialize<SetupPayload>(stream) ?? throw new InvalidDataException("Invalid setup payload.");
    }

    internal static async Task<PayloadSession> ExtractAsync(CancellationToken cancellationToken, string? cacheDirectory = null)
    {
        var directory = CreatePrivateDirectory(cacheDirectory);
        var session = new PayloadSession(directory);
        try
        {
            var assembly = Assembly.GetExecutingAssembly();
            using var config = assembly.GetManifestResourceStream("Setup.Payload.Config") ?? throw new InvalidDataException("Missing setup payload.");
            var payload = await JsonSerializer.DeserializeAsync<SetupPayload>(config, cancellationToken: cancellationToken)
                ?? throw new InvalidDataException("Invalid setup payload.");
            if (payload.Feed is not null && (!Uri.TryCreate(payload.Feed, UriKind.Absolute, out var feed) ||
                feed.Scheme != Uri.UriSchemeHttps || !string.IsNullOrEmpty(feed.UserInfo) || !string.IsNullOrEmpty(feed.Fragment)))
                throw new InvalidDataException("Invalid embedded feed.");
            session.Feed = payload.Feed;
            await session.CopyResourceAsync(assembly, "Setup.Payload.Engine", session.EnginePath, cancellationToken);
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
        await using var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1024 * 1024, true);
        files.Add(destination);
        await input.CopyToAsync(output, cancellationToken);
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
