using System.Diagnostics;
using System.Text.Json;

namespace Velmren.Setup;

internal sealed record MaintenanceSession(string Root, string Source, int ParentId, long ParentStartTime);

internal static class MaintenanceRelocation
{
    private const string FileName = "VelmrenMaintenance.exe";
    private const string SessionFile = "maintenance-session.json";
    internal static string CacheRootFor(string installRoot)
    {
        var preferred = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Velmren", "SetupCache");
        if (!IsWithin(preferred, installRoot) && !preferred.Equals(installRoot, StringComparison.OrdinalIgnoreCase)) return preferred;
        var alternate = Path.Combine(Path.GetTempPath(), "VelmrenSetupCache");
        if (IsWithin(alternate, installRoot) || alternate.Equals(installRoot, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("No independent maintenance cache is available.");
        return alternate;
    }

    internal static bool RelocateIfNeeded(SetupOptions options)
    {
        var executable = Environment.ProcessPath ?? throw new InvalidOperationException("Missing setup executable.");
        var cacheRoot = CacheRootFor(options.Root);
        if (options.MaintenanceSession is not null)
        {
            var session = ValidateSession(options, executable, cacheRoot);
            WaitForOriginalExit(session);
            return false;
        }
        if (!options.Uninstall || !options.RootSpecified || !IsWithin(executable, options.Root)) return false;
        using var parent = Process.GetCurrentProcess();
        var clone = PrepareClone(options.Root, executable, cacheRoot, parent.Id, parent.StartTime.ToUniversalTime().Ticks);
        var info = new ProcessStartInfo(clone.Executable) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = clone.Directory };
        foreach (var argument in new[] { "--uninstall", "--root", options.Root, "--maintenance-session", Path.GetFileName(clone.Directory) })
            info.ArgumentList.Add(argument);
        using var process = Process.Start(info) ?? throw new IOException("Could not start maintenance.");
        return true;
    }

    internal static (string Directory, string Executable) PrepareClone(string root, string executable, string cacheRoot, int parentId, long parentStartTime)
    {
        if (!IsWithin(executable, root)) throw new InvalidDataException("Maintenance source is outside its installation.");
        PayloadSession.EnsureNoLinks(executable);
        var directory = PayloadSession.CreatePrivateDirectory(cacheRoot);
        var clone = Path.Combine(directory, FileName);
        File.Copy(executable, clone, false);
        File.WriteAllText(Path.Combine(directory, SessionFile), JsonSerializer.Serialize(new MaintenanceSession(root, executable, parentId, parentStartTime)));
        return (directory, clone);
    }

    internal static MaintenanceSession ValidateSession(SetupOptions options, string executable, string cacheRoot)
    {
        if (!options.Uninstall || !options.RootSpecified || options.MaintenanceSession is not { } token ||
            !Guid.TryParseExact(token, "N", out var id) || id.ToString("N") != token)
            throw new InvalidDataException("Invalid maintenance session.");
        var directory = Path.Combine(cacheRoot, token);
        var expected = Path.Combine(directory, FileName);
        if (!Path.GetFullPath(executable).Equals(Path.GetFullPath(expected), StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Maintenance session executable mismatch.");
        PayloadSession.EnsureNoLinks(expected);
        var marker = Path.Combine(directory, SessionFile);
        PayloadSession.EnsureNoLinks(marker);
        if (new FileInfo(marker).Length > 16 * 1024) throw new InvalidDataException("Invalid maintenance marker.");
        var session = JsonSerializer.Deserialize<MaintenanceSession>(File.ReadAllText(marker)) ?? throw new InvalidDataException("Invalid maintenance marker.");
        if (!session.Root.Equals(options.Root, StringComparison.OrdinalIgnoreCase) || !IsWithin(session.Source, options.Root) ||
            session.ParentId <= 0 || session.ParentId == Environment.ProcessId)
            throw new InvalidDataException("Maintenance session root mismatch.");
        return session;
    }

    private static void WaitForOriginalExit(MaintenanceSession session)
    {
        try
        {
            using var parent = Process.GetProcessById(session.ParentId);
            if (parent.StartTime.ToUniversalTime().Ticks == session.ParentStartTime && !parent.WaitForExit(10000))
                throw new IOException("Original maintenance process did not exit.");
        }
        catch (ArgumentException) { }
    }

    internal static bool IsWithin(string path, string root) => Path.GetFullPath(path).StartsWith(
        Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
}
