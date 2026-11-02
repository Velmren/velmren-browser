using System.Buffers.Binary;
using System.Diagnostics;
using System.Reflection;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text.Json;

namespace Velmren.Delivery;

internal static class NativeDecoderTests
{
    public static int Main(string[] args) => Program.RunNativeDecoderTests(args);
}

internal static partial class Program
{
    internal static int RunNativeDecoderTests(string[] args)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        if (args.Length is < 1 or > 2) throw new ArgumentException("Expected fresh work directory and optional absent/corrupt resource mode.");
        var work = Path.GetFullPath(args[0]);
        if (Directory.Exists(work)) throw new IOException("Choose a fresh evidence directory.");
        Directory.CreateDirectory(work);
        var checks = new List<string>();
        void Check(bool result, string name) { if (!result) throw new InvalidOperationException(name); checks.Add(name); }
        var input = Path.Combine(work, "input");
        Directory.CreateDirectory(input);
        CompactFixtureEntry[] emptyAndDirectories = [new("a", [], true, 0x10), new("z", [], true, 0x10), new("empty", []), new("a/empty", []), new("delivery-app.json", "{}"u8.ToArray())];
        var fixtures = new List<CompactFixtureEntry>(emptyAndDirectories);
        var random = new Random(963112);
        foreach (var name in new[] { "z/00.txt", "a/99.bin", "z/01.dll", "a/98.txt", "z/02.bin", "a/97.dll", "plain", "first.txt", "middle.bin", "last.dll" })
        {
            var bytes = new byte[49152 + fixtures.Count * 17]; random.NextBytes(bytes);
            fixtures.Add(new(name, bytes));
        }
        var inventory = fixtures.Where(f => !f.Directory).Select(f => new PayloadFile(f.Name, f.Data.Length, Convert.ToHexStringLower(SHA256.HashData(f.Data)))).ToArray();
        var manifest = new Manifest(Policy.Schema, Policy.Product, "0.0.0.1", "velmren-0.0.0.1.zip", 1, new string('a', 64), inventory.Sum(f => f.Size), inventory, Policy.Channel, Policy.Platform);
        var copy = Path.Combine(work, "copy.7z");
        WriteCompactFixture(copy, fixtures.ToArray());
        var privateParent = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Velmren", "NativeDecoder");
        string[] PrivateDirectories() => Directory.Exists(privateParent) ? Directory.GetDirectories(privateParent) : [];
        var before = PrivateDirectories();
        using var resource = Assembly.GetExecutingAssembly().GetManifestResourceStream(NativeArchiveDecoder.ResourceName);
        if (args.Length == 2)
        {
            var output = Path.Combine(work, "variant-output");
            if (args[1] == "absent")
            {
                Check(resource is null, "Resource is absent in legacy variant");
                ExtractCompactArchive(copy, output, manifest, CancellationToken.None);
                Check(inventory.All(f => Hash(SafePath(output, f.Path)) == f.Sha256), "Missing native resource uses managed decoder");
            }
            else if (args[1] == "corrupt")
            {
                Check(resource is not null, "Corrupt resource is present");
                try { ExtractCompactArchive(copy, output, manifest, CancellationToken.None); throw new InvalidOperationException("Corrupt native image accepted"); }
                catch (CryptographicException) { Check(!Directory.EnumerateFiles(output, "*", SearchOption.AllDirectories).Any(), "Corrupt native image fails closed without managed fallback or payload writes"); }
            }
            else throw new ArgumentException("Unknown resource mode.");
            Check(!PrivateDirectories().Except(before).Any(), "Resource variant leaves no helper directories");
            File.WriteAllText(Path.Combine(work, "results.json"), JsonSerializer.Serialize(checks));
            Console.WriteLine($"Passed {checks.Count} native decoder {args[1]} resource checks; evidence: {work}");
            return 0;
        }
        Check(resource is not null && resource.Length == NativeArchiveDecoder.ImageSize, "Pinned SDK resource is embedded");
        Check(Convert.ToHexStringLower(SHA256.HashData(resource!)) == NativeArchiveDecoder.ImageSha256, "Embedded SDK resource SHA-256 verifies");
        Check(!PrivateDirectories().Except(before).Any(), "Inspecting embedded resource does not materialize a helper");
        resource!.Position = 0;
        var helper = Path.Combine(work, "fixture-7zr.exe");
        using (var file = File.Create(helper)) resource.CopyTo(file);
        foreach (var fixture in fixtures)
        {
            var path = Path.Combine(input, fixture.Name);
            if (fixture.Directory) Directory.CreateDirectory(path); else File.WriteAllBytes(path, fixture.Data);
        }
        foreach (var (name, solid, sort, methods) in new[]
        {
            ("multiblock-name", "128k", "off", new[] { "-m0=LZMA2" }),
            ("multiblock-type", "128k", "on", new[] { "-m0=LZMA2" }),
            ("solid", "on", "on", new[] { "-m0=LZMA2" }),
            ("non-solid", "off", "off", new[] { "-m0=LZMA2" }),
            ("bcj2", "128k", "on", new[] { "-m0=BCJ2", "-m1=LZMA2", "-m2=LZMA2", "-m3=LZMA2", "-mb0:1", "-mb0s1:2", "-mb0s2:3" })
        })
        {
            var archive = Path.Combine(work, name + ".7z");
            RunNativeFixture(helper, input, ["a", "-t7z", .. methods, "-ms=" + solid, "-mqs=" + sort, archive, ".\\*"]);
            var listing = RunNativeFixture(helper, work, "l", "-slt", archive);
            File.WriteAllText(Path.Combine(work, name + ".listing.txt"), listing);
            if (name.StartsWith("multiblock", StringComparison.Ordinal)) Check(listing.Contains("Solid = +") && listing.Contains("Blocks = 5"), name + " contains five solid blocks");
            var output = Path.Combine(work, name + "-output");
            ExtractCompactArchive(archive, output, manifest, CancellationToken.None);
            Check(inventory.All(f => Hash(SafePath(output, f.Path)) == f.Sha256), name + " stdout follows metadata order with subdirectories and empty files");
        }
        using (var decoder = NativeArchiveDecoder.TryStart(copy, CancellationToken.None)!)
        {
            var directory = (string)typeof(NativeArchiveDecoder).GetField("directory", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(decoder)!;
            var imagePath = Path.Combine(directory, "7zr.exe");
            var security = new DirectoryInfo(directory).GetAccessControl();
            using var identity = WindowsIdentity.GetCurrent();
            var allowed = new[] { identity.User!.Value, new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null).Value };
            Check(security.AreAccessRulesProtected && security.GetAccessRules(true, true, typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>()
                .All(rule => OperatingSystem.IsWindows() && rule.AccessControlType == AccessControlType.Allow && allowed.Contains(rule.IdentityReference.Value)), "Helper directory has protected current-user/SYSTEM ACL");
            try { using var ignored = new FileStream(imagePath, FileMode.Open, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete); throw new InvalidOperationException("Helper was writable"); }
            catch (IOException) { checks.Add("Pinned helper denies writes while running"); }
            try { File.Move(imagePath, imagePath + ".moved"); throw new InvalidOperationException("Helper was replaceable"); }
            catch (IOException) { checks.Add("Pinned helper denies replacement while running"); }
            try { Directory.Move(directory, directory + ".moved"); throw new InvalidOperationException("Directory was replaceable"); }
            catch (IOException) { checks.Add("Private helper directory denies replacement while running"); }
            try { decoder.Complete(); throw new InvalidOperationException("Trailing bytes accepted"); }
            catch (InvalidDataException) { checks.Add("Unconsumed stdout bytes are rejected"); }
        }
        using (var decoder = NativeArchiveDecoder.TryStart(copy, CancellationToken.None)!)
        {
            try { decoder.ReadExactly(new byte[checked((int)manifest.ExpandedSize + 1)]); throw new InvalidOperationException("Early EOF accepted"); }
            catch (InvalidDataException) { checks.Add("Early stdout EOF is rejected"); }
        }
        var badCrc = Path.Combine(work, "bad-data-crc.7z");
        RunNativeFixture(helper, input, "a", "-t7z", "-m0=Copy", "-ms=off", "-mhc=off", badCrc, ".\\*");
        var badBytes = File.ReadAllBytes(badCrc);
        var headerStart = checked(32 + (int)BinaryPrimitives.ReadUInt64LittleEndian(badBytes.AsSpan(12)));
        var crc = CompactFixtureCrc("{}"u8);
        var matches = new List<int>();
        for (var i = headerStart; i <= badBytes.Length - 4; i++) if (BinaryPrimitives.ReadUInt32LittleEndian(badBytes.AsSpan(i)) == crc) matches.Add(i);
        Check(matches.Count == 1, "CRC fixture has one identifiable data CRC");
        badBytes[matches[0]] ^= 1;
        BinaryPrimitives.WriteUInt32LittleEndian(badBytes.AsSpan(28), CompactFixtureCrc(badBytes.AsSpan(headerStart)));
        BinaryPrimitives.WriteUInt32LittleEndian(badBytes.AsSpan(8), CompactFixtureCrc(badBytes.AsSpan(12, 20)));
        File.WriteAllBytes(badCrc, badBytes);
        var crcOutput = Path.Combine(work, "bad-data-crc-output");
        try { ExtractCompactArchive(badCrc, crcOutput, manifest, CancellationToken.None); throw new InvalidOperationException("Native CRC error accepted"); }
        catch (InvalidDataException ex)
        {
            Check(ex.Message.Contains("Native archive decoder failed"), "Native nonzero exit is rejected after all signed bytes arrive");
            Check(inventory.All(f => Hash(SafePath(crcOutput, f.Path)) == f.Sha256), "Native exit status remains mandatory even when all per-file hashes match");
        }
        var cancellationTimer = Stopwatch.StartNew();
        using (var cancellation = new CancellationTokenSource())
        using (var decoder = NativeArchiveDecoder.TryStart(copy, cancellation.Token)!)
        {
            cancellationTimer.Restart(); cancellation.Cancel();
            try { decoder.ReadExactly(new byte[1]); throw new InvalidOperationException("Cancellation ignored"); }
            catch (OperationCanceledException) { checks.Add("Cancellation interrupts a blocked native stdout producer"); }
        }
        Check(cancellationTimer.Elapsed < TimeSpan.FromSeconds(5), "Cancelled decoder stops within five seconds");
        using (var noisy = new StringReader(new string('x', 65536)))
        using (var bytes = new MemoryStream(System.Text.Encoding.UTF8.GetBytes(noisy.ReadToEnd())))
        using (var reader = new StreamReader(bytes))
        {
            var drain = (Task<string>)typeof(NativeArchiveDecoder).GetMethod("DrainErrors", BindingFlags.Static | BindingFlags.NonPublic)!.Invoke(null, [reader])!;
            Check(drain.GetAwaiter().GetResult().Length == 16384 && bytes.Position == bytes.Length, "Stderr is fully drained with bounded retained text");
        }
        Check(!PrivateDirectories().Except(before).Any(), "Success, decode failure and cancellation remove only their helper directories");
        File.WriteAllText(Path.Combine(work, "results.json"), JsonSerializer.Serialize(new { checks, cancellationSeconds = cancellationTimer.Elapsed.TotalSeconds }, new JsonSerializerOptions { WriteIndented = true }));
        Console.WriteLine($"Passed {checks.Count} native decoder checks; evidence: {work}");
        return 0;
    }

    static string RunNativeFixture(string helper, string directory, params string[] arguments)
    {
        using var process = new Process { StartInfo = new ProcessStartInfo(helper) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, WorkingDirectory = directory } };
        foreach (var argument in arguments) process.StartInfo.ArgumentList.Add(argument);
        process.Start(); var stdout = process.StandardOutput.ReadToEndAsync(); var stderr = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(30000)) { process.Kill(); process.WaitForExit(); throw new TimeoutException("Native fixture generation timed out."); }
        var output = stdout.GetAwaiter().GetResult(); var error = stderr.GetAwaiter().GetResult();
        if (process.ExitCode != 0) throw new IOException("Native fixture generation failed: " + error);
        return output;
    }
}
