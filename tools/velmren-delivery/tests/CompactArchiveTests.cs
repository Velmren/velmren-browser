using System.Buffers.Binary;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using SharpCompress.Common;
using SharpCompress.Writers.SevenZip;

namespace Velmren.Delivery;

internal static class CompactArchiveTests
{
    public static int Main(string[] args) => Program.RunCompactArchiveTests(args);
}

internal static partial class Program
{
    sealed record CompactFixtureEntry(string Name, byte[] Data, bool Directory = false, uint Attributes = 0x20, bool Anti = false);

    internal static int RunCompactArchiveTests(string[] args)
    {
        if (args.Length is not (1 or 3)) throw new ArgumentException("Expected fresh work directory, optionally real .7z and signed manifest.");
        var work = Path.GetFullPath(args[0]);
        if (Directory.Exists(work)) throw new InvalidOperationException("Choose a fresh evidence directory.");
        Directory.CreateDirectory(work);
        var checks = new List<string>();
        void Check(bool result, string name) { if (!result) throw new InvalidOperationException(name); checks.Add(name); }
        var data = new byte[256 * 1024];
        new Random(71203).NextBytes(data);
        CompactFixtureEntry[] files = [new("delivery-app.json", "{}"u8.ToArray()), new("bin/browser.bin", data), new("empty", [])];
        var inventory = files.Select(f => new PayloadFile(f.Name, f.Data.LongLength, Convert.ToHexStringLower(SHA256.HashData(f.Data)))).ToArray();
        var manifest = new Manifest(Policy.Schema, Policy.Product, "0.0.0.1", "velmren-0.0.0.1.zip", 1, new string('a', 64), inventory.Sum(f => f.Size), inventory, Policy.Channel, Policy.Platform);
        // Fixture signing uses an ephemeral test key; the real release below uses Verify's pinned key.
        using (var key = RSA.Create(3072))
        {
            var payload = Bytes(manifest);
            var signature = key.SignData(payload, HashAlgorithmName.SHA256, RSASignaturePadding.Pss);
            Check(key.VerifyData(payload, signature, HashAlgorithmName.SHA256, RSASignaturePadding.Pss), "Fixture inventory signature verifies");
            manifest = JsonSerializer.Deserialize<Manifest>(payload, Json)!;
            payload[0] ^= 1;
            Check(!key.VerifyData(payload, signature, HashAlgorithmName.SHA256, RSASignaturePadding.Pss), "Tampered fixture inventory signature is rejected");
        }
        Validate(manifest);
        CompactFixtureEntry[] valid = [new("bin", [], true, 0x10), .. files];
        var validPath = Path.Combine(work, "valid.7z");
        WriteCompactFixture(validPath, valid);
        var output = Path.Combine(work, "valid-output");
        ExtractCompactArchive(validPath, output, manifest, CancellationToken.None);
        Check(inventory.All(f => Hash(SafePath(output, f.Path)) == f.Sha256), "Copy archive extracts exact signed inventory, directories and zero-byte files");

        void Reject(string name, CompactFixtureEntry[] content, Manifest? expected = null, bool beforeWriting = true)
        {
            var path = Path.Combine(work, name + ".7z");
            var target = Path.Combine(work, name + "-output");
            WriteCompactFixture(path, content);
            Exception? rejected = null;
            try { ExtractCompactArchive(path, target, expected ?? manifest, CancellationToken.None); }
            catch (Exception ex) when (ex is InvalidDataException or System.Security.Cryptography.CryptographicException or SharpCompress.Common.SharpCompressException) { rejected = ex; }
            Check(rejected is not null, name + " rejected");
            if (beforeWriting) Check(!Directory.Exists(target) || !Directory.EnumerateFileSystemEntries(target).Any(), name + " rejected before output");
        }
        var unsafeNames = new[] { "../escape", "/absolute", "C:/absolute", "bin\\escape", "bin/a:b", "CON", "COM¹.txt", "a/./b", "a//b", "a/../b", "file.", "file ", "bad\u0001name", "file/", "" };
        for (var i = 0; i < unsafeNames.Length; i++) Reject("unsafe-path-" + i, [.. valid, new(unsafeNames[i], [])]);
        Reject("extra-file", [.. valid, new("extra", [])]);
        Reject("extra-directory", [.. valid, new("unlisted", [], true, 0x10)]);
        Reject("duplicate-file", [.. valid, files[0]]);
        Reject("duplicate-directory", [.. valid, valid[0]]);
        Reject("case-collision", [.. valid, new("BIN", [], true, 0x10)]);
        Reject("wrong-case", [valid[0], files[0], files[1] with { Name = "bin/Browser.bin" }, files[2]]);
        Reject("missing-file", [valid[0], files[0], files[1]]);
        Reject("wrong-size", [valid[0], files[0], files[1] with { Data = data[..10] }, files[2]]);
        Reject("reparse-file", [valid[0], files[0] with { Attributes = 0x420 }, files[1], files[2]]);
        Reject("reparse-directory", [valid[0] with { Attributes = 0x410 }, .. files]);
        Reject("device", [valid[0], files[0] with { Attributes = 0x40 }, files[1], files[2]]);
        Reject("unix-symlink", [valid[0], files[0] with { Attributes = 0xA1FF8020 }, files[1], files[2]]);
        Reject("unix-fifo", [valid[0], files[0] with { Attributes = 0x11FF8020 }, files[1], files[2]]);
        Reject("unix-device", [valid[0], files[0] with { Attributes = 0x21FF8020 }, files[1], files[2]]);
        Reject("file-directory-type-mismatch", [valid[0], files[0] with { Attributes = 0x10 }, files[1], files[2]]);
        Reject("directory-file-type-mismatch", [valid[0] with { Attributes = 0x20 }, .. files]);
        Reject("anti-item", [valid[0], files[0], files[1], files[2] with { Anti = true }]);
        Reject("hash-mismatch", [valid[0], files[0] with { Data = "[]"u8.ToArray() }, files[1], files[2]], beforeWriting: false);
        var conflictingInventory = inventory.Append(new PayloadFile("BIN/other", 0, Convert.ToHexStringLower(SHA256.HashData([])))).ToArray();
        Reject("manifest-directory-casing", valid, manifest with { Files = conflictingInventory });
        Reject("manifest-expanded-limit", valid, manifest with { ExpandedSize = MaxPackage + 1 });
        Reject("manifest-file-count-limit", valid, manifest with { Files = Enumerable.Repeat(inventory[0], 30001).ToArray() });

        foreach (var mutation in new[] { "not-7z", "trailing-data", "oversized-header", "header-outside-file", "corrupt-crc" })
        {
            var bytes = File.ReadAllBytes(validPath);
            if (mutation == "not-7z") bytes[0] = (byte)'P';
            if (mutation == "trailing-data") bytes = [.. bytes, 0xFF];
            if (mutation == "oversized-header") BinaryPrimitives.WriteUInt64LittleEndian(bytes.AsSpan(20), (ulong)MaxManifest + 1);
            if (mutation == "header-outside-file") BinaryPrimitives.WriteUInt64LittleEndian(bytes.AsSpan(12), ulong.MaxValue);
            if (mutation == "corrupt-crc") bytes[8] ^= 1;
            var path = Path.Combine(work, mutation + ".7z");
            File.WriteAllBytes(path, bytes);
            Exception? rejected = null;
            try { ExtractCompactArchive(path, Path.Combine(work, mutation + "-output"), manifest, CancellationToken.None); }
            catch (Exception ex) when (ex is InvalidDataException or SharpCompress.Common.SharpCompressException) { rejected = ex; }
            Check(rejected is not null, mutation + " rejected");
        }
        using (var cancelled = new CancellationTokenSource())
        {
            cancelled.Cancel();
            try { ExtractCompactArchive(validPath, Path.Combine(work, "cancelled-output"), manifest, cancelled.Token); throw new InvalidOperationException("Cancellation ignored"); }
            catch (OperationCanceledException) { Check(!Directory.Exists(Path.Combine(work, "cancelled-output")), "Pre-cancellation creates no output"); }
        }
        var existing = Path.Combine(work, "existing-output");
        Directory.CreateDirectory(existing);
        File.WriteAllText(Path.Combine(existing, "delivery-app.json"), "preserved");
        try { ExtractCompactArchive(validPath, existing, manifest, CancellationToken.None); throw new InvalidOperationException("Existing file overwritten"); }
        catch (IOException) { Check(File.ReadAllText(Path.Combine(existing, "delivery-app.json")) == "preserved", "Existing destination file is never overwritten"); }

        // Library-produced LZMA2 exercises a different encoder, compressed headers and decoder.
        var compressed = Path.Combine(work, "lzma2.7z");
        using (var writer = SevenZipWriter.OpenWriter(compressed, new SevenZipWriterOptions(CompressionType.LZMA2)))
        {
            writer.WriteDirectory("bin", null);
            foreach (var entry in files) { using var input = new MemoryStream(entry.Data); writer.Write(entry.Name, input, null); }
        }
        ExtractCompactArchive(compressed, Path.Combine(work, "lzma2-output"), manifest, CancellationToken.None);
        Check(inventory.All(f => Hash(SafePath(Path.Combine(work, "lzma2-output"), f.Path)) == f.Sha256), "LZMA2 and compressed header extracts exact files");

        var sevenZip = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "7-Zip", "7z.exe");
        if (!File.Exists(sevenZip)) throw new FileNotFoundException("Encrypted fixture generation requires 7-Zip", sevenZip);
        foreach (var encryptedHeader in new[] { false, true })
        {
            var path = Path.Combine(work, encryptedHeader ? "encrypted-header.7z" : "encrypted-data.7z");
            using var process = new Process { StartInfo = new ProcessStartInfo(sevenZip) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, WorkingDirectory = output } };
            foreach (var argument in new[] { "a", "-t7z", "-pfixture-only", encryptedHeader ? "-mhe=on" : "-mhe=off", path, ".\\*" }) process.StartInfo.ArgumentList.Add(argument);
            process.Start();
            var stdout = process.StandardOutput.ReadToEndAsync(); var stderr = process.StandardError.ReadToEndAsync();
            if (!process.WaitForExit(30000)) { process.Kill(true); throw new TimeoutException("Fixture generation timed out"); }
            File.WriteAllText(path + ".log", stdout.GetAwaiter().GetResult() + stderr.GetAwaiter().GetResult());
            Check(process.ExitCode == 0, "Encrypted fixture generated (header=" + encryptedHeader + ")");
            Exception? rejected = null;
            try { ExtractCompactArchive(path, path + "-output", manifest, CancellationToken.None); }
            catch (Exception ex) when (ex is InvalidDataException or SharpCompress.Common.SharpCompressException) { rejected = ex; }
            Check(rejected is not null && !Directory.Exists(path + "-output"), "Encryption rejected before output (header=" + encryptedHeader + ")");
        }

        if (args.Length == 3)
        {
            var verified = Verify(File.ReadAllBytes(args[2]));
            var realOutput = Path.Combine(work, "real-output");
            var timer = Stopwatch.StartNew();
            ExtractCompactArchive(args[1], realOutput, verified.Manifest, CancellationToken.None);
            timer.Stop();
            Check(verified.Manifest.Files.All(f => new FileInfo(SafePath(realOutput, f.Path)).Length == f.Size && Hash(SafePath(realOutput, f.Path)) == f.Sha256), "Real solid LZMA2 archive matches every RSA-verified published inventory hash");
            Check(Directory.EnumerateFiles(realOutput, "*", SearchOption.AllDirectories).Count() == verified.Manifest.Files.Length, "Real archive has exact file count");
            File.WriteAllBytes(Path.Combine(work, "real-result.json"), Bytes(new { archive = Path.GetFullPath(args[1]), archiveSha256 = Hash(args[1]), files = verified.Manifest.Files.Length, verified.Manifest.ExpandedSize, extractionSeconds = timer.Elapsed.TotalSeconds }));
            using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            var cancelOutput = Path.Combine(work, "real-cancel-output");
            var cancellationLatency = new Stopwatch();
            var canceller = Task.Run(async () =>
            {
                while (!cancellation.IsCancellationRequested)
                {
                    if (Directory.Exists(cancelOutput) && Directory.EnumerateFiles(cancelOutput, "*", SearchOption.AllDirectories).Any(f => new FileInfo(f).Length > 0))
                    {
                        cancellationLatency.Start();
                        cancellation.Cancel();
                        return;
                    }
                    await Task.Delay(10);
                }
            });
            try { ExtractCompactArchive(args[1], cancelOutput, verified.Manifest, cancellation.Token); throw new InvalidOperationException("Mid-stream cancellation ignored"); }
            catch (OperationCanceledException)
            {
                cancellationLatency.Stop();
                Check(cancellationLatency.Elapsed > TimeSpan.Zero && cancellationLatency.Elapsed < TimeSpan.FromSeconds(5), "Solid extraction cancels within five seconds after output starts, without draining the archive");
                File.WriteAllBytes(Path.Combine(work, "cancellation-result.json"), Bytes(new { seconds = cancellationLatency.Elapsed.TotalSeconds, filesWritten = Directory.EnumerateFiles(cancelOutput, "*", SearchOption.AllDirectories).Count() }));
            }
            finally { cancellation.Cancel(); canceller.GetAwaiter().GetResult(); }
        }
        File.WriteAllBytes(Path.Combine(work, "results.json"), Bytes(new { passed = checks.Count, checks }));
        Console.WriteLine($"Passed {checks.Count} compact archive checks; evidence: {work}");
        return 0;
    }

    // Minimal standard 7z Copy encoder permits unsafe metadata without an encoder sanitizing it.
    static void WriteCompactFixture(string path, CompactFixtureEntry[] entries)
    {
        using var header = new MemoryStream();
        void Number(ulong value)
        {
            for (var count = 0; count < 8; count++)
            {
                if (value < (1UL << (7 * (count + 1))))
                {
                    header.WriteByte((byte)((0xFF << (8 - count)) | (byte)(value >> (8 * count))));
                    for (var i = 0; i < count; i++) header.WriteByte((byte)(value >> (8 * i)));
                    return;
                }
            }
            header.WriteByte(0xFF);
            for (var i = 0; i < 8; i++) header.WriteByte((byte)(value >> (8 * i)));
        }
        void Bits(bool[] values)
        {
            for (var offset = 0; offset < values.Length; offset += 8)
            {
                byte value = 0;
                for (var i = 0; i < 8 && offset + i < values.Length; i++) if (values[offset + i]) value |= (byte)(0x80 >> i);
                header.WriteByte(value);
            }
        }
        var streams = entries.Where(e => e.Data.Length > 0).ToArray();
        header.WriteByte(0x01);
        if (streams.Length > 0)
        {
            header.WriteByte(0x04); header.WriteByte(0x06); Number(0); Number((ulong)streams.Length); header.WriteByte(0x09);
            foreach (var entry in streams) Number((ulong)entry.Data.Length);
            header.WriteByte(0); header.WriteByte(0x07); header.WriteByte(0x0B); Number((ulong)streams.Length); header.WriteByte(0);
            foreach (var entry in streams) header.Write([0x01, 0x01, 0x00]);
            header.WriteByte(0x0C); foreach (var entry in streams) Number((ulong)entry.Data.Length);
            header.WriteByte(0); header.WriteByte(0x08); header.WriteByte(0); header.WriteByte(0);
        }
        header.WriteByte(0x05); Number((ulong)entries.Length);
        var names = Encoding.Unicode.GetBytes(string.Join('\0', entries.Select(e => e.Name)) + '\0');
        header.WriteByte(0x11); Number((ulong)names.Length + 1); header.WriteByte(0); header.Write(names);
        var empty = entries.Where(e => e.Data.Length == 0).ToArray();
        if (empty.Length > 0)
        {
            header.WriteByte(0x0E); Number((ulong)(entries.Length + 7) / 8); Bits(entries.Select(e => e.Data.Length == 0).ToArray());
            header.WriteByte(0x0F); Number((ulong)(empty.Length + 7) / 8); Bits(empty.Select(e => !e.Directory).ToArray());
            if (empty.Any(e => e.Anti)) { header.WriteByte(0x10); Number((ulong)(empty.Length + 7) / 8); Bits(empty.Select(e => e.Anti).ToArray()); }
        }
        header.WriteByte(0x15); Number((ulong)entries.Length * 4 + 2); header.Write([1, 0]);
        foreach (var entry in entries) { var attr = new byte[4]; BinaryPrimitives.WriteUInt32LittleEndian(attr, entry.Attributes); header.Write(attr); }
        header.Write([0, 0]);
        var next = header.ToArray();
        var signature = new byte[32];
        new byte[] { 0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C, 0, 4 }.CopyTo(signature, 0);
        BinaryPrimitives.WriteUInt64LittleEndian(signature.AsSpan(12), (ulong)streams.Sum(e => e.Data.LongLength));
        BinaryPrimitives.WriteUInt64LittleEndian(signature.AsSpan(20), (ulong)next.Length);
        BinaryPrimitives.WriteUInt32LittleEndian(signature.AsSpan(28), CompactFixtureCrc(next));
        BinaryPrimitives.WriteUInt32LittleEndian(signature.AsSpan(8), CompactFixtureCrc(signature.AsSpan(12)));
        using var output = new FileStream(path, FileMode.CreateNew);
        output.Write(signature); foreach (var entry in streams) output.Write(entry.Data); output.Write(next);
    }

    static uint CompactFixtureCrc(ReadOnlySpan<byte> bytes)
    {
        var crc = uint.MaxValue;
        foreach (var value in bytes) { crc ^= value; for (var bit = 0; bit < 8; bit++) crc = (crc >> 1) ^ ((crc & 1) != 0 ? 0xEDB88320U : 0); }
        return ~crc;
    }
}
