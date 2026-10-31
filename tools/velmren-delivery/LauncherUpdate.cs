using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Velmren.Delivery;

internal sealed record LauncherIdentity(int Protocol, string PolicySha256, string PublicKeySha256);
internal sealed record LauncherTransaction(int Schema, string Id, string PreviousVersion, string Version);

internal static partial class Program
{
    const string LauncherJournal = "launcher-transaction.json";

    static LauncherIdentity Identity()
    {
        using var key = PinnedKey();
        return new(1, Convert.ToHexStringLower(SHA256.HashData(Bytes(Policy))),
            Convert.ToHexStringLower(SHA256.HashData(key.ExportSubjectPublicKeyInfo())));
    }

    static void LauncherProbe() => Console.WriteLine(JsonSerializer.Serialize(Identity(), Json));

    static async Task<string> ReadProbeOutput(StreamReader reader, CancellationToken token)
    {
        var result = new StringBuilder();
        var buffer = new char[1024];
        int count;
        while ((count = await reader.ReadAsync(buffer, token)) != 0)
        {
            if (result.Length + count > 65536) throw new InvalidDataException("Launcher probe output exceeds its limit.");
            result.Append(buffer, 0, count);
        }
        return result.ToString();
    }

    static async Task ProbeLauncher(string path, CancellationToken token)
    {
        NoLinks(path);
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(token);
        budget.CancelAfter(TimeSpan.FromSeconds(15));
        using var process = new Process { StartInfo = new ProcessStartInfo {
            FileName = path, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true
        }};
        process.StartInfo.ArgumentList.Add("launcher-probe");
        if (!process.Start()) throw new InvalidOperationException("New launcher probe did not start.");
        try
        {
            var output = ReadProbeOutput(process.StandardOutput, budget.Token);
            var error = ReadProbeOutput(process.StandardError, budget.Token);
            await Task.WhenAll(output, error, process.WaitForExitAsync(budget.Token)).WaitAsync(budget.Token);
            if (process.ExitCode != 0 || (await error).Length != 0
                || JsonSerializer.Deserialize<LauncherIdentity>(await output, Json) != Identity())
                throw new InvalidDataException("New launcher failed its protocol, policy or signing-key probe.");
        }
        finally
        {
            if (!process.HasExited) { process.Kill(entireProcessTree: true); await process.WaitForExitAsync(); }
        }
    }

    static (string Path, PayloadFile File)? SignedLauncher(string root, string version)
    {
        var verified = ReadInstalledManifest(root, version);
        var appRoot = SafePath(root, $"versions/{version}/app");
        var configFile = verified.Manifest.Files.Single(f => f.Path == "delivery-app.json");
        var configPath = SafePath(appRoot, configFile.Path);
        VerifySingleFile(configPath, configFile);
        var config = Read<AppConfig>(configPath);
        if (config.Launcher is null) return null;
        if (config.Launcher != "delivery/Velmren.exe") throw new InvalidDataException("Invalid signed launcher path.");
        var file = verified.Manifest.Files.Single(f => f.Path == config.Launcher);
        var path = SafePath(appRoot, file.Path);
        VerifySingleFile(path, file);
        return (path, file);
    }

    static void VerifySingleFile(string path, PayloadFile file)
    {
        NoLinks(path);
        if (new FileInfo(path).Length != file.Size || !Hash(path).Equals(file.Sha256, StringComparison.OrdinalIgnoreCase))
            throw new CryptographicException("Signed launcher transaction file hash rejected.");
    }

    static string TransactionPath(string root, LauncherTransaction transaction, string suffix)
        => SafePath(root, "launcher-" + transaction.Id + suffix);

    // Called with both operation.lock and an exclusive run.lock held. ReplaceFile
    // keeps the stable executable present even when the calling image is in use.
    static LauncherTransaction? PrepareLauncher(string root, Pointer? current, Pointer pending, CancellationToken token)
    {
        var candidate = SignedLauncher(root, pending.Version);
        if (candidate is null) return null; // Older development packages do not update the launcher.
        _ = ReadOwnership(root);
        ProbeLauncher(candidate.Value.Path, token).GetAwaiter().GetResult();
        var stable = SafePath(root, "Velmren.exe");
        var stableHash = Hash(stable, token);
        if (stableHash.Equals(candidate.Value.File.Sha256, StringComparison.OrdinalIgnoreCase)) return null;
        if (current is null)
        {
            // An older online installer may fetch a newer launcher on its first
            // install. No active release exists to roll back: the durable pending
            // pointer lets either complete image retry activation after a crash.
            var bootstrapId = Guid.NewGuid().ToString("N");
            var nextBootstrap = SafePath(root, "launcher-" + bootstrapId + ".bootstrap-next.exe");
            var backupBootstrap = SafePath(root, "launcher-" + bootstrapId + ".bootstrap-previous.exe");
            var rejectedBootstrap = SafePath(root, "launcher-" + bootstrapId + ".bootstrap-rejected.exe");
            TrackOwned(root, new[] { nextBootstrap, backupBootstrap, rejectedBootstrap }.Select(path => Path.GetRelativePath(root, path)));
            CopyProgramFile(candidate.Value.Path, nextBootstrap, token).GetAwaiter().GetResult();
            VerifySingleFile(nextBootstrap, candidate.Value.File);
            token.ThrowIfCancellationRequested();
            File.Replace(nextBootstrap, stable, backupBootstrap);
            try
            {
                VerifySingleFile(stable, candidate.Value.File);
                ProbeLauncher(stable, token).GetAwaiter().GetResult();
            }
            catch
            {
                if (Hash(backupBootstrap) != stableHash) throw new CryptographicException("Bootstrap rollback copy changed.");
                File.Replace(backupBootstrap, stable, rejectedBootstrap);
                throw;
            }
            Event(root, "launcher-bootstrap-updated", pending.Version);
            return null;
        }
        var previous = SignedLauncher(root, current.Version)
            ?? throw new InvalidDataException("This legacy installation requires a new installer before launcher self-update.");
        VerifySingleFile(stable, previous.File);
        var transaction = new LauncherTransaction(1, Guid.NewGuid().ToString("N"), current.Version, pending.Version);
        var next = TransactionPath(root, transaction, ".next.exe");
        var backup = TransactionPath(root, transaction, ".previous.exe");
        TrackOwned(root, [LauncherJournal, Path.GetRelativePath(root, next), Path.GetRelativePath(root, backup)]);
        CopyProgramFile(candidate.Value.Path, next, token).GetAwaiter().GetResult();
        VerifySingleFile(next, candidate.Value.File);
        Atomic(SafePath(root, LauncherJournal), Bytes(transaction));
        token.ThrowIfCancellationRequested();
        try
        {
            File.Replace(next, stable, backup);
            VerifySingleFile(stable, candidate.Value.File);
            ProbeLauncher(stable, token).GetAwaiter().GetResult();
            Event(root, "launcher-replaced", pending.Version);
            return transaction;
        }
        catch
        {
            RecoverLauncher(root);
            throw;
        }
    }

    static void CompleteLauncher(string root, LauncherTransaction? transaction)
    {
        if (transaction is null) return;
        if (Current(root)?.Version != transaction.Version) throw new InvalidDataException("Cannot commit launcher without its active release.");
        File.Delete(SafePath(root, LauncherJournal));
        Event(root, "launcher-update-complete", transaction.Version);
    }

    static void RecoverLauncher(string root)
    {
        var journal = SafePath(root, LauncherJournal);
        if (!File.Exists(journal)) return;
        _ = ReadOwnership(root);
        if (new FileInfo(journal).Length > 65536) throw new InvalidDataException("Launcher transaction is too large.");
        var transaction = Read<LauncherTransaction>(journal);
        if (transaction.Schema != 1 || !Guid.TryParseExact(transaction.Id, "N", out _)
            || VersionOf(transaction.Version) <= VersionOf(transaction.PreviousVersion))
            throw new InvalidDataException("Invalid launcher transaction.");
        var current = Current(root)?.Version;
        if (current != transaction.PreviousVersion && current != transaction.Version)
            throw new InvalidDataException("Launcher transaction does not match the active version.");
        var candidate = SignedLauncher(root, transaction.Version)
            ?? throw new InvalidDataException("Transaction target lacks a signed launcher.");
        var previous = SignedLauncher(root, transaction.PreviousVersion)
            ?? throw new InvalidDataException("Transaction source lacks a signed launcher.");
        var stable = SafePath(root, "Velmren.exe");
        var hash = Hash(stable);
        if (current == transaction.Version)
        {
            VerifySingleFile(stable, candidate.File);
            File.Delete(journal);
            Event(root, "launcher-recovered-committed", current);
            return;
        }
        if (hash.Equals(candidate.File.Sha256, StringComparison.OrdinalIgnoreCase))
        {
            var backup = TransactionPath(root, transaction, ".previous.exe");
            VerifySingleFile(backup, previous.File);
            var rejected = TransactionPath(root, transaction, ".rolled-back.exe");
            TrackOwned(root, [Path.GetRelativePath(root, rejected)]);
            File.Replace(backup, stable, rejected);
        }
        VerifySingleFile(stable, previous.File);
        File.Delete(journal);
        Event(root, "launcher-update-rolled-back", transaction.PreviousVersion);
    }
}
