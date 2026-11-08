using System.Diagnostics;
using System.Text.Json;

namespace Velmren.Delivery;

internal sealed record UpdateUiStatus(int Schema, string Phase,
    string? InstalledVersion, string? AvailableVersion, DateTimeOffset UpdatedAt,
    DateTimeOffset? LastCheckedAt, string? ErrorCode);

internal static partial class Program
{
    const string UpdateUiStatusFile = "update-status.json";
    static readonly TimeSpan UpdateUiWriteTimeout = TimeSpan.FromMilliseconds(250);

    static void WriteUpdateUiSnapshot(string path, byte[] value, CancellationToken cancellationToken)
    {
        var timer = Stopwatch.StartNew();
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try { Atomic(path, value); return; }
            catch (Exception error) when ((error is IOException or UnauthorizedAccessException) &&
                (error.HResult & 0xffff) is 5 or 32 or 33 && timer.Elapsed < UpdateUiWriteTimeout)
            {
                // Windows CRT readers deny delete sharing. Move(overwrite)
                // reports access denied as well as sharing/lock violations.
                var remaining = UpdateUiWriteTimeout - timer.Elapsed;
                if (remaining <= TimeSpan.Zero) throw;
                var interval = TimeSpan.FromMilliseconds(20);
                cancellationToken.WaitHandle.WaitOne(remaining < interval ? remaining : interval);
            }
        }
    }

    // Rejected metadata may still need an error snapshot. This tolerant read is
    // display-only; launch and activation continue to use Current directly.
    static Pointer? ReadUpdateUiPointer(string root, string name, out bool invalid)
    {
        invalid = false;
        try { return Current(root, name); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or InvalidDataException or JsonException)
        {
            invalid = true;
            return null;
        }
    }

    // This is a UI snapshot, never authority to install or launch a payload.
    // Activation continues to validate the signed manifest and owned paths.
    // Callers hold operation.lock so migration precedes creation atomically.
    static void WriteUpdateUiStatus(string root, string phase,
        string? availableVersion = null, string? errorCode = null,
        bool checkedFeed = false, CancellationToken cancellationToken = default)
    {
        try
        {
            var path = SafePath(root, UpdateUiStatusFile);
            if (File.Exists(SafePath(root, OwnershipFile)) &&
                !ReadOwnership(root, validateInventory: false).Files.Contains(UpdateUiStatusFile, StringComparer.OrdinalIgnoreCase))
                TrackOwned(root, [UpdateUiStatusFile]);
            DateTimeOffset? lastChecked = null;
            UpdateUiStatus? previous = null;
            if (File.Exists(path) && new FileInfo(path).Length <= 16384)
            {
                try { previous = Read<UpdateUiStatus>(path); lastChecked = previous.LastCheckedAt; }
                catch (JsonException) { }
            }
            var now = DateTimeOffset.UtcNow;
            var current = ReadUpdateUiPointer(root, "current.json", out var currentInvalid);
            var pending = ReadUpdateUiPointer(root, "pending.json", out var pendingInvalid);
            if (currentInvalid || pendingInvalid)
            {
                phase = "error";
                errorCode = "activation-failed";
                availableVersion = pending?.Version;
            }
            if (errorCode == "activation-failed" && pending is not null)
                availableVersion = pending.Version;
            if (previous?.ErrorCode == "activation-failed" && pending is not null &&
                previous.AvailableVersion == pending.Version &&
                previous.InstalledVersion == current?.Version &&
                (availableVersion is null || availableVersion == pending.Version))
            {
                // A subsequent feed check does not re-verify staged payload
                // bytes. Never turn a rejected payload back into a ready badge.
                phase = "error";
                errorCode = "activation-failed";
                availableVersion = pending.Version;
            }
            if (phase == "ready" && (pending is null ||
                pending.Version != availableVersion ||
                (current is not null && VersionOf(pending.Version) <= VersionOf(current.Version))))
            {
                phase = "unknown";
                availableVersion = null;
            }
            // A feed check must not hide an already verified staged update.
            if (pending is not null &&
                (current is null || VersionOf(pending.Version) > VersionOf(current.Version)) &&
                ((phase is "checking" or "error" or "up-to-date") ||
                    (phase == "available" && availableVersion == pending.Version)) &&
                errorCode != "activation-failed")
            {
                phase = "ready";
                availableVersion = pending.Version;
            }
            var state = new UpdateUiStatus(1, phase, current?.Version,
                availableVersion, now, checkedFeed ? now : lastChecked, errorCode);
            WriteUpdateUiSnapshot(path, Bytes(state), cancellationToken);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or
            InvalidDataException or JsonException)
        {
            // A display-only snapshot must not prevent a valid update.
            Console.Error.WriteLine("Could not write update display status.");
        }
    }
}
