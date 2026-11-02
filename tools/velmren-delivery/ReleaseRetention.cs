namespace Velmren.Delivery;

internal static partial class Program
{
    sealed record RetentionRelease(Manifest Manifest, string Metadata, string[] Payload, HashSet<string> StagePayload);

    // Caller holds operation.lock, but no run.lock. Preparation only reads files;
    // cleanup obtains its own short exclusive lease after verification finishes.
    // Never call from preparation for browser launch.
    // Cleanup is best effort: an interrupted pass must not undo an activation.
    static void CleanupRetiredArtifacts(string root, CancellationToken token)
    {
        using var retentionPhase = StartPhase(root, "retention");
        InstallOwnership? owner = null;
        FileStream? deletionLease = null;
        var removed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var failures = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var deleted = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        void PersistRemoved()
        {
            if (owner is null || !owner.Files.Any(removed.Contains)) return;
            var updated = owner with { Files = owner.Files.Where(file => !removed.Contains(file)).ToArray() };
            WriteOwnership(root, updated);
            owner = updated;
        }
        try
        {
            root = CanonicalRoot(root);
            NoLinks(root);
            token.ThrowIfCancellationRequested();
            owner = ReadOwnership(root);
            if (owner.State != "installed") throw new InvalidDataException("Retention requires a completed installation.");
            // Polling an in-use installation must not hash the rollback payload.
            // Release this probe before preparation so a new browser can start.
            using (var probe = OpenRetentionLease(root)) { if (probe is null) { retentionPhase.Complete(); return; } }
            var owned = owner.Files.ToHashSet(StringComparer.OrdinalIgnoreCase);
            var current = RetentionPointer(root, "current.json")
                ?? throw new InvalidDataException("Retention requires an active release.");
            var currentVersion = VersionOf(current.Version);
            var pending = RetentionPointer(root, "pending.json");
            if (pending is not null && VersionOf(pending.Version) < currentVersion)
                throw new InvalidDataException("Retention rejected a pending downgrade.");

            var releases = new Dictionary<string, RetentionRelease>(StringComparer.Ordinal);
            long metadataBytes = 0;
            RetentionRelease Load(string version)
            {
                if (releases.TryGetValue(version, out var release)) return release;
                token.ThrowIfCancellationRequested();
                var metadata = "versions/" + version + "/manifest.json";
                if (!owned.Contains(metadata)) throw new InvalidDataException("Release metadata is not owned.");
                metadataBytes += new FileInfo(SafePath(root, metadata)).Length;
                if (releases.Count >= 64 || metadataBytes > 64L * 1024 * 1024)
                    throw new InvalidDataException("Retention metadata exceeds its per-pass limit.");
                var manifest = ReadInstalledManifest(root, version).Manifest;
                release = new(manifest, metadata,
                    manifest.Files.Select(file => "versions/" + version + "/app/" + file.Path).ToArray(),
                    manifest.Files.Select(file => "app/" + file.Path).ToHashSet(StringComparer.Ordinal));
                releases.Add(version, release);
                return release;
            }
            _ = Load(current.Version);
            var protectedVersions = new HashSet<string>(StringComparer.Ordinal) { current.Version };
            if (pending is not null) { _ = Load(pending.Version); protectedVersions.Add(pending.Version); }
            if (owner.HighestEnvelope is not null)
            {
                var highest = Verify(Convert.FromBase64String(owner.HighestEnvelope)).Manifest;
                if (VersionOf(highest.Version) < currentVersion)
                    throw new InvalidDataException("Active release exceeds its signed high-water record.");
            }

            var journalPath = SafePath(root, LauncherJournal);
            var hasJournal = File.Exists(journalPath);
            if (hasJournal)
            {
                if (new FileInfo(journalPath).Length > 65536) throw new InvalidDataException("Launcher transaction is too large.");
                var transaction = Read<LauncherTransaction>(journalPath);
                if (transaction.Schema != 1 || !Guid.TryParseExact(transaction.Id, "N", out _)
                    || VersionOf(transaction.Version) <= VersionOf(transaction.PreviousVersion)
                    || current.Version != transaction.Version && current.Version != transaction.PreviousVersion)
                    throw new InvalidDataException("Unrecognized launcher transaction during retention.");
                foreach (var version in new[] { transaction.PreviousVersion, transaction.Version })
                { _ = Load(version); protectedVersions.Add(version); }
            }

            // Only owned manifests make a directory a known installed release.
            // Unknown names, unsigned directories and future releases stay untouched.
            foreach (var relative in owner.Files)
            {
                token.ThrowIfCancellationRequested();
                var parts = relative.Split('/');
                if (parts.Length != 3 || parts[0] != "versions" || parts[2] != "manifest.json"
                    || !RetentionVersion(parts[1], out var version) || version! >= currentVersion) continue;
                try { _ = Load(parts[1]); }
                catch (Exception error) when (error is not OperationCanceledException)
                { Event(root, "retention-preserved-release", parts[1], SafeError(error)); }
            }
            var previous = releases.Values.Where(release => VersionOf(release.Manifest.Version) < currentVersion)
                .OrderByDescending(release => VersionOf(release.Manifest.Version))
                .FirstOrDefault(release => RetentionComplete(root, release, token));
            if (previous is not null) protectedVersions.Add(previous.Manifest.Version);
            var retired = releases.Values.Where(release => previous is not null
                && VersionOf(release.Manifest.Version) < currentVersion && !protectedVersions.Contains(release.Manifest.Version)).ToArray();

            var protectedArchives = pending is null ? new HashSet<string>(StringComparer.OrdinalIgnoreCase)
                : RetentionArchives(releases[pending.Version].Manifest).ToHashSet(StringComparer.OrdinalIgnoreCase);
            var archives = releases.Values.Where(release => VersionOf(release.Manifest.Version) <= currentVersion)
                .SelectMany(release => RetentionArchives(release.Manifest)).Where(path => owned.Contains(path) && !protectedArchives.Contains(path))
                .Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
            var launcherFiles = releases.Values.SelectMany(release => release.Manifest.Files)
                .Where(file => file.Path == "delivery/Velmren.exe").DistinctBy(file => file.Sha256, StringComparer.OrdinalIgnoreCase).ToArray();
            var backups = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (!hasJournal)
            {
                foreach (var relative in owner.Files.Where(RetentionLauncherBackup))
                {
                    token.ThrowIfCancellationRequested();
                    var path = SafePath(root, relative);
                    if (!File.Exists(path)) { backups[relative] = ""; continue; }
                    var size = new FileInfo(path).Length;
                    if (!launcherFiles.Any(file => file.Size == size)) continue;
                    var hash = Hash(path, token);
                    if (launcherFiles.Any(file => file.Sha256.Equals(hash, StringComparison.OrdinalIgnoreCase))) backups[relative] = hash;
                }
            }
            // A moved staging tree leaves inventory entries, not files. Forget only
            // absent entries whose exact paths are corroborated by a signed release.
            var absentStages = owner.Files.Where(relative => { token.ThrowIfCancellationRequested(); return RetentionAbsentStage(root, relative, releases); }).ToArray();
            // An interrupted final inventory write can leave an absent metadata
            // entry after all payload entries were already durably removed.
            var absentMetadata = owner.Files.Where(relative => {
                token.ThrowIfCancellationRequested();
                var parts = relative.Split('/');
                if (parts.Length != 3 || parts[0] != "versions" || parts[2] != "manifest.json"
                    || !RetentionVersion(parts[1], out var version) || version! >= currentVersion || protectedVersions.Contains(parts[1])) return false;
                var prefix = "versions/" + parts[1] + "/";
                if (owner.Files.Any(file => !file.Equals(relative, StringComparison.OrdinalIgnoreCase) && file.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))) return false;
                var path = SafePath(root, relative);
                return !File.Exists(path) && !Directory.Exists(path);
            }).ToArray();
            var payload = retired.SelectMany(release => release.Payload).Where(owned.Contains).ToArray();
            var planned = archives.Concat(backups.Keys).Concat(payload).Concat(retired.Select(release => release.Metadata)).Concat(absentStages).Concat(absentMetadata)
                .Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
            var directories = retired.SelectMany(release => release.Payload).Concat(planned).SelectMany(ParentDirectories)
                .Distinct(StringComparer.OrdinalIgnoreCase).Where(path => path is not ("downloads" or "versions" or "staging"))
                .OrderByDescending(path => path.Length).ToArray();
            foreach (var relative in planned.Concat(directories)) { token.ThrowIfCancellationRequested(); _ = SafePath(root, relative); }

            // operation.lock kept pointers and updater-owned files stable while
            // hashing. A launch may have acquired a shared lease in the meantime.
            deletionLease = OpenRetentionLease(root);
            if (deletionLease is null) { retentionPhase.Complete(); return; }
            var deletionTimer = System.Diagnostics.Stopwatch.StartNew();
            var cleanupTimer = System.Diagnostics.Stopwatch.StartNew();
            var attempts = 0;
            var budgetExpired = false;
            bool ContinueDeletion()
            {
                token.ThrowIfCancellationRequested();
                if (budgetExpired) return false;
                if (cleanupTimer.ElapsedMilliseconds >= 30000) { budgetExpired = true; return false; }
                if (attempts < 512 && deletionTimer.ElapsedMilliseconds < 200) return true;
                PersistRemoved();
                deletionLease!.Dispose();
                deletionLease = null;
                // Launch waiters poll every 25 ms. Let them claim a shared lease
                // between deletion batches without repeating rollback hashing.
                Thread.Sleep(25);
                token.ThrowIfCancellationRequested();
                deletionLease = OpenRetentionLease(root);
                if (deletionLease is null) { budgetExpired = true; return false; }
                attempts = 0;
                deletionTimer.Restart();
                return true;
            }

            bool Delete(string relative)
            {
                attempts++;
                token.ThrowIfCancellationRequested();
                var path = SafePath(root, relative);
                try
                {
                    if (Directory.Exists(path)) throw new IOException("Owned file path has become a directory.");
                    if (File.Exists(path))
                    {
                        if (path.Equals(Environment.ProcessPath, StringComparison.OrdinalIgnoreCase))
                            throw new IOException("The cleanup caller's image is still running.");
                        // A mapped executable or an open file must be retried later.
                        // Closing this probe before File.Delete is safe: Windows also
                        // rejects deletion if another process maps the image meanwhile.
                        using (new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { }
                        NoLinks(path);
                        File.Delete(path);
                        deleted.Add(relative);
                    }
                    else File.Delete(path); // Idempotent successful absence after a partial pass.
                    removed.Add(relative);
                    return true;
                }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException)
                { failures.Add(relative); Event(root, "retention-deferred-file", detail: relative + ": " + SafeError(error)); return false; }
            }
            foreach (var relative in archives.Concat(backups.Keys).Concat(payload))
            {
                if (!ContinueDeletion()) break;
                Delete(relative);
            }
            foreach (var relative in absentStages.Concat(absentMetadata))
            {
                if (!ContinueDeletion()) break;
                attempts++;
                var path = SafePath(root, relative);
                if (!File.Exists(path) && !Directory.Exists(path)) removed.Add(relative);
            }
            // Do not discard signed retry authorization until the payload removals
            // have reached the ownership marker durably.
            PersistRemoved();
            void DeleteEmptyDirectory(string relative)
            {
                attempts++;
                var path = SafePath(root, relative);
                try { if (Directory.Exists(path) && !Directory.EnumerateFileSystemEntries(path).Any()) Directory.Delete(path); }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException)
                { failures.Add(relative + "/"); Event(root, "retention-deferred-directory", detail: relative + ": " + SafeError(error)); }
            }
            foreach (var relative in directories)
            {
                if (!ContinueDeletion()) break;
                DeleteEmptyDirectory(relative);
            }
            // Keep the manifest while an interrupted pass still has directory work;
            // its complete inventory authorizes retry of earlier emptied folders.
            if (!budgetExpired) foreach (var release in retired)
            {
                if (!ContinueDeletion()) break;
                if (release.Payload.Where(owned.Contains).Any(relative => !removed.Contains(relative))
                    || RetentionArchives(release.Manifest).Where(owned.Contains).Any(relative => !removed.Contains(relative))
                    || failures.Any(path => path.StartsWith("versions/" + release.Manifest.Version + "/", StringComparison.OrdinalIgnoreCase))
                    || backups.Any(backup => failures.Contains(backup.Key) && release.Manifest.Files.Any(file => file.Path == "delivery/Velmren.exe"
                        && file.Sha256.Equals(backup.Value, StringComparison.OrdinalIgnoreCase)))) continue;
                if (Delete(release.Metadata)) DeleteEmptyDirectory("versions/" + release.Manifest.Version);
            }
            Event(root, budgetExpired ? "retention-deferred" : "retention-cleaned", current.Version,
                $"Deleted {deleted.Count} files; retired {removed.Count} inventory entries; deferred {failures.Count} files." + (budgetExpired ? " Cleanup yielded to a launch or its time limit; a later pass retries the remainder." : ""));
            retentionPhase.Complete();
        }
        catch (OperationCanceledException) { Event(root, "retention-cancelled", detail: "Completed deletions are retained; a later pass retries the remainder."); }
        catch (Exception error) { Event(root, "retention-skipped", detail: SafeError(error)); }
        finally
        {
            if (owner is not null && removed.Count != 0)
            {
                try { PersistRemoved(); }
                catch (Exception error) { Event(root, "retention-inventory-deferred", detail: SafeError(error)); }
            }
            deletionLease?.Dispose();
        }
    }

    static FileStream? OpenRetentionLease(string root)
    {
        FileStream lease;
        try { lease = new FileStream(SafePath(root, "run.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None); }
        catch (IOException) { Event(root, "retention-deferred", detail: "A launcher session is running; cleanup will retry later."); return null; }
        try
        {
            if (!BrowserRunning(root)) return lease;
            Event(root, "retention-deferred", detail: "An installed browser process is running; cleanup will retry later.");
            lease.Dispose();
            return null;
        }
        catch { lease.Dispose(); throw; }
    }

    static Pointer? RetentionPointer(string root, string name)
    {
        var path = SafePath(root, name);
        if (File.Exists(path) && new FileInfo(path).Length > 65536) throw new InvalidDataException("Retention pointer is too large.");
        return Current(root, name);
    }

    static bool RetentionVersion(string text, out Version? version)
        => Version.TryParse(text, out version) && version.Revision >= 0 && version.ToString() == text;

    static bool RetentionComplete(string root, RetentionRelease release, CancellationToken token)
    {
        foreach (var file in release.Manifest.Files)
        {
            token.ThrowIfCancellationRequested();
            var path = SafePath(root, "versions/" + release.Manifest.Version + "/app/" + file.Path);
            if (!File.Exists(path) || new FileInfo(path).Length != file.Size
                || !Hash(path, token).Equals(file.Sha256, StringComparison.OrdinalIgnoreCase)) return false;
        }
        return true;
    }

    static IEnumerable<string> RetentionArchives(Manifest manifest)
    {
        yield return "downloads/" + manifest.Sha256 + ".zip";
        if (manifest.CompactArchive is not null) yield return "downloads/" + manifest.CompactArchive.Sha256 + ".7z";
    }

    static bool RetentionLauncherBackup(string relative)
    {
        if (!relative.StartsWith("launcher-", StringComparison.Ordinal) || relative.Length < 45
            || !Guid.TryParseExact(relative.Substring(9, 32), "N", out _)) return false;
        return relative[41..] is ".previous.exe" or ".rolled-back.exe" or ".next.exe"
            or ".bootstrap-previous.exe" or ".bootstrap-rejected.exe" or ".bootstrap-next.exe";
    }

    static bool RetentionAbsentStage(string root, string relative, Dictionary<string, RetentionRelease> releases)
    {
        var parts = relative.Split('/', 3);
        if (parts.Length != 3 || parts[0] != "staging") return false;
        var separator = parts[1].LastIndexOf('-');
        if (separator <= 0 || !Guid.TryParseExact(parts[1][(separator + 1)..], "N", out _)
            || !releases.TryGetValue(parts[1][..separator], out var release)
            || parts[2] != "manifest.json" && !release.StagePayload.Contains(parts[2])) return false;
        var path = SafePath(root, relative);
        return !File.Exists(path) && !Directory.Exists(path);
    }
}
