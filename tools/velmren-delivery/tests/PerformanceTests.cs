using System.Diagnostics;
using System.IO.Compression;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;

namespace Velmren.Delivery;

internal static class PerformanceTests
{
    public static int Main(string[] args) => Program.RunPerformanceTests(args);
}

internal static partial class Program
{
    sealed class BrokenDiagnosticWriter : TextWriter
    {
        public override Encoding Encoding => Encoding.UTF8;
        public override void WriteLine(string? value) => throw new IOException("Closed diagnostic pipe.");
    }

    internal static int RunPerformanceTests(string[] args)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        if (args.Length != 1) throw new ArgumentException("Expected a fresh file-only evidence directory.");
        var work = Path.GetFullPath(args[0]);
        if (Directory.Exists(work)) throw new InvalidOperationException("Choose a fresh evidence directory.");
        Directory.CreateDirectory(work);
        var checks = new List<string>();
        void Check(bool condition, string name)
        {
            if (!condition) throw new InvalidOperationException(name);
            checks.Add(name);
        }
        var parentSecurity = new DirectoryInfo(work).GetAccessControl(AccessControlSections.Access)
            .GetSecurityDescriptorSddlForm(AccessControlSections.Access);
        var ordinary = Path.Combine(work, "ordinary");
        Directory.CreateDirectory(ordinary);
        File.WriteAllText(Path.Combine(ordinary, "file"), "owned fixture");
        NoLinks(Path.Combine(ordinary, "file"));
        NoLinks(Path.Combine(ordinary, "missing", "child", "file"));
        Check(!Directory.Exists(Path.Combine(ordinary, "missing")), "Missing-path validation creates no directories");

        var target = Path.Combine(work, "junction-target");
        Directory.CreateDirectory(target);
        var junction = Path.Combine(work, "future");
        var future = Path.Combine(junction, "absent", "file");
        NoLinks(future);
        var info = new ProcessStartInfo("powershell.exe") {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true
        };
        foreach (var argument in new[] { "-NoProfile", "-NonInteractive", "-Command",
            "New-Item -ItemType Junction -Path '" + junction.Replace("'", "''") + "' -Target '" + target.Replace("'", "''") + "' | Out-Null" })
            info.ArgumentList.Add(argument);
        using (var process = Process.Start(info) ?? throw new IOException("Junction fixture did not start."))
        {
            var output = process.StandardOutput.ReadToEndAsync();
            var error = process.StandardError.ReadToEndAsync();
            if (!process.WaitForExit(30000)) { process.Kill(); throw new TimeoutException("Junction fixture timed out."); }
            _ = output.GetAwaiter().GetResult();
            if (process.ExitCode != 0) throw new IOException(error.GetAwaiter().GetResult());
        }
        var rejected = false;
        try { NoLinks(future); } catch (InvalidDataException) { rejected = true; }
        Check(rejected, "A newly introduced junction is rejected even when descendants are missing");
        rejected = false;
        try { SafePath(work, "future/absent/file"); } catch (InvalidDataException) { rejected = true; }
        Check(rejected, "SafePath rejects an existing linked ancestor before returning a missing destination");

        var app = Path.Combine(work, "app");
        DirectorySafe(app);
        EnsureSandboxReadAccess(app);
        DirectorySafe(Path.Combine(app, "nested"));
        var child = Path.Combine(app, "nested", "file");
        File.WriteAllText(child, "child inherits exact sandbox capabilities");
        var rules = new FileInfo(child).GetAccessControl(AccessControlSections.Access)
            .GetAccessRules(true, true, typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>().ToArray();
        const FileSystemRights required = FileSystemRights.ReadAndExecute | FileSystemRights.Synchronize;
        foreach (var capability in SandboxInstallCapabilities)
        {
            var count = 0;
            var exact = true;
            foreach (var rule in rules)
            {
                if (rule.IdentityReference.Value != capability) continue;
                count++;
                exact &= rule.IsInherited && rule.AccessControlType == AccessControlType.Allow
                    && rule.FileSystemRights == required;
            }
            Check(count != 0 && exact,
                "New descendants inherit only the exact read/execute capability rights: " + capability);
        }
        var appSecurity = new DirectoryInfo(app).GetAccessControl(AccessControlSections.Access)
            .GetSecurityDescriptorSddlForm(AccessControlSections.Access);
        EnsureSandboxReadAccess(app);
        Check(appSecurity == new DirectoryInfo(app).GetAccessControl(AccessControlSections.Access)
            .GetSecurityDescriptorSddlForm(AccessControlSections.Access), "Final sandbox check preserves an already prepared app DACL");
        Check(parentSecurity == new DirectoryInfo(work).GetAccessControl(AccessControlSections.Access)
            .GetSecurityDescriptorSddlForm(AccessControlSections.Access), "Preparing app permissions never changes the parent DACL");

        var contents = new Dictionary<string, byte[]> {
            ["delivery-app.json"] = "{}"u8.ToArray(), ["nested/content.bin"] = "verified ZIP fixture"u8.ToArray()
        };
        string ZipFixture(string name, Dictionary<string, byte[]> entries)
        {
            var path = Path.Combine(work, name + ".zip");
            using var archive = ZipFile.Open(path, ZipArchiveMode.Create);
            foreach (var entry in entries)
            {
                using var stream = archive.CreateEntry(entry.Key).Open();
                stream.Write(entry.Value);
            }
            return path;
        }
        var archivePath = ZipFixture("valid", contents);
        var inventory = contents.Select(entry => new PayloadFile(entry.Key, entry.Value.Length,
            Convert.ToHexStringLower(SHA256.HashData(entry.Value)))).ToArray();
        var manifest = new Manifest(Policy.Schema, Policy.Product, "0.0.0.1", "velmren-0.0.0.1.zip",
            new FileInfo(archivePath).Length, Hash(archivePath), inventory.Sum(file => file.Size), inventory,
            Policy.Channel, Policy.Platform);
        var zipOutput = Path.Combine(work, "zip-output");
        Extract(archivePath, zipOutput, manifest, CancellationToken.None);
        Check(inventory.All(file => Hash(SafePath(zipOutput, file.Path)) == file.Sha256), "Pooled ZIP extraction preserves every signed size and SHA-256");
        var zipRules = new FileInfo(Path.Combine(zipOutput, "nested", "content.bin")).GetAccessControl(AccessControlSections.Access)
            .GetAccessRules(true, true, typeof(SecurityIdentifier));
        foreach (var capability in SandboxInstallCapabilities)
        {
            var inherited = false;
            foreach (FileSystemAccessRule rule in zipRules)
                if (rule.IdentityReference.Value == capability && rule.IsInherited && rule.FileSystemRights == required) inherited = true;
            Check(inherited, "ZIP descendants inherit the prepared sandbox capability: " + capability);
        }
        var invalidContents = new Dictionary<string, byte[]>(contents) { ["extra"] = [] };
        var invalidZip = ZipFixture("extra-file", invalidContents);
        var invalidOutput = Path.Combine(work, "extra-file-output");
        rejected = false;
        try { Extract(invalidZip, invalidOutput, manifest, CancellationToken.None); } catch (InvalidDataException) { rejected = true; }
        Check(rejected && !Directory.EnumerateFileSystemEntries(invalidOutput).Any(), "ZIP extra inventory is rejected before payload writes");
        invalidContents.Remove("extra");
        invalidContents["nested/content.bin"] = new byte[contents["nested/content.bin"].Length];
        invalidZip = ZipFixture("bad-hash", invalidContents);
        rejected = false;
        try { Extract(invalidZip, Path.Combine(work, "bad-hash-output"), manifest, CancellationToken.None); }
        catch (CryptographicException) { rejected = true; }
        Check(rejected, "ZIP same-size content substitution still fails the signed SHA-256 check");

        var owned = Path.Combine(work, "owned");
        ClaimRoot(owned);
        TrackOwned(owned, ["nested/future-a", "nested/future-b"]);
        Check(ReadOwnership(owned).Files.Contains("nested/future-a"), "Future owned paths are tracked without creating them");
        File.WriteAllText(Path.Combine(owned, "unowned"), "preserve");
        rejected = false;
        try { TrackOwned(owned, ["unowned"]); } catch (InvalidDataException) { rejected = true; }
        Check(rejected && File.ReadAllText(Path.Combine(owned, "unowned")) == "preserve", "Ownership tracking still refuses an existing unowned file");

        var original = Console.Out;
        using var capture = new StringWriter();
        try
        {
            Console.SetOut(capture);
            using (var phase = StartPhase(null, "fixture", "1.0.0.0", 42, 2)) { phase.Complete(); }
            using (StartPhase(null, "interrupted")) { }
            Console.SetOut(new BrokenDiagnosticWriter());
            using (var phase = StartPhase(null, "closed-pipe")) { phase.Complete(); }
        }
        finally { Console.SetOut(original); }
        var lines = capture.ToString().Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries)
            .Select(line => JsonDocument.Parse(line)).ToArray();
        try
        {
            Check(lines.Length == 4 && lines[0].RootElement.GetProperty("action").GetString() == "phase-started"
                && lines[1].RootElement.GetProperty("action").GetString() == "phase-completed", "Phases report a start and a completion");
            Check(lines[1].RootElement.GetProperty("elapsedMs").TryGetInt64(out var elapsed) && elapsed >= 0
                && lines[1].RootElement.GetProperty("bytes").GetInt64() == 42
                && lines[1].RootElement.GetProperty("files").GetInt32() == 2, "Phase duration and work counts use numeric JSON fields");
            Check(lines[1].RootElement.GetProperty("succeeded").GetBoolean()
                && !lines[3].RootElement.GetProperty("succeeded").GetBoolean(), "Incomplete phases are distinguished from success");
            Check(lines.All(line => !line.RootElement.TryGetProperty("root", out _) && !line.RootElement.TryGetProperty("path", out _)), "Phase telemetry contains no filesystem paths");
            Check(true, "A closed stdout pipe cannot fail the operation");
        }
        finally { foreach (var line in lines) line.Dispose(); }
        File.WriteAllBytes(Path.Combine(work, "results.json"), Bytes(new { passed = checks.Count, checks }));
        Console.WriteLine($"Passed {checks.Count} file-only performance regressions; evidence: {work}");
        return 0;
    }
}
