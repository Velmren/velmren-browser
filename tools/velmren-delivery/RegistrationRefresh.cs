namespace Velmren.Delivery;

internal static partial class Program
{
    const string RegistrationRefreshFile = "registration-refresh.json";

    static void ScheduleRegistrationRefresh(string root, Pointer release)
    {
        if (!File.Exists(SafePath(root, OwnershipFile)) || ReadOwnership(root).Registration is null) return;
        TrackOwned(root, [RegistrationRefreshFile]);
        Atomic(SafePath(root, RegistrationRefreshFile), Bytes(release));
    }

    static void RetryRegistrationRefresh(string root, CancellationToken token)
    {
        var path = SafePath(root, RegistrationRefreshFile);
        if (!File.Exists(path)) return;
        if (new FileInfo(path).Length > 65536) throw new InvalidDataException("Registration refresh record is too large.");
        var requested = Read<Pointer>(path);
        _ = VersionOf(requested.Version);
        if (Current(root)?.Version != requested.Version) return;
        try
        {
            RefreshInstalledRegistration(root, token);
            File.Delete(path);
        }
        catch (Exception ex)
        {
            Event(root, "registration-refresh-failed", requested.Version, SafeError(ex));
        }
    }
}
