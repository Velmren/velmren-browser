namespace Velmren.Setup;

internal sealed record SetupOptions(bool Uninstall, string Root, bool RootSpecified = false, string? MaintenanceSession = null)
{
    internal static SetupOptions Parse(string[] args)
    {
        var uninstall = false;
        var rootSpecified = false;
        string? session = null;
        var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Velmren");
        for (var i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--uninstall": uninstall = true; break;
                case "--root" when i + 1 < args.Length: root = args[++i]; rootSpecified = true; break;
                case "--maintenance-session" when i + 1 < args.Length: session = args[++i]; break;
                default: throw new ArgumentException("Unknown setup option.");
            }
        }
        if ((uninstall && !rootSpecified) || (session is not null && (!uninstall || !rootSpecified)))
            throw new ArgumentException("Maintenance requires an explicit root.");
        return new SetupOptions(uninstall, ValidateRoot(root), rootSpecified, session);
    }

    internal static string ValidateRoot(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || !FrameworkCompatibility.IsFullyQualified(value))
            throw new ArgumentException("Choose an absolute destination.");
        var full = Path.GetFullPath(value.Trim());
        if (Path.GetPathRoot(full)!.Equals(full, StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("A drive root is not an install directory.");
        return full.TrimEnd(Path.DirectorySeparatorChar);
    }
}
