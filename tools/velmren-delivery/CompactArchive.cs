using System.Buffers;
using System.Buffers.Binary;
using System.Security.Cryptography;
using SharpCompress.Archives.SevenZip;
using SharpCompress.Common.SevenZip;
using SharpCompress.Readers;

namespace Velmren.Delivery;

internal static partial class Program
{
    // The caller verifies the signed manifest and archive SHA-256 before opening it.
    static void ExtractCompactArchive(string archivePath, string destination, Manifest manifest, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Validate(manifest);
        var inventory = manifest.Files.ToDictionary(f => f.Path, StringComparer.Ordinal);
        var nodes = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var directories = new HashSet<string>(StringComparer.Ordinal);
        foreach (var file in manifest.Files)
        {
            AddCompactNode(nodes, file.Path);
            for (var index = file.Path.IndexOf('/'); index >= 0; index = file.Path.IndexOf('/', index + 1))
            {
                var directory = file.Path[..index];
                AddCompactNode(nodes, directory);
                directories.Add(directory);
            }
        }

        NoLinks(archivePath);
        using var fileStream = new FileStream(archivePath, FileMode.Open, FileAccess.Read, FileShare.Read);
        using var source = new CompactArchiveInput(fileStream, cancellationToken);
        ValidateCompactHeader(source);
        // A stream overload prevents discovery of unverified adjacent archive volumes.
        using var archive = SevenZipArchive.OpenArchive(source, new ReaderOptions { LeaveStreamOpen = true, LookForHeader = false });
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var entries = new Dictionary<string, bool>(StringComparer.Ordinal);
        var fileCount = 0;
        long expandedSize = 0;
        foreach (var entry in archive.Entries)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (entry is not SevenZipArchiveEntry sevenZip || !sevenZip.IsComplete || sevenZip.IsAnti)
                throw new InvalidDataException("Unsupported compact archive entry.");
            var path = CompactEntryPath(sevenZip);
            SafePath(destination, path);
            if (!seen.Add(path) || entries.Count >= nodes.Count)
                throw new InvalidDataException("Duplicate or excessive compact archive entries.");
            if (entry.IsDirectory)
            {
                if (!directories.Contains(path) || entry.Size != 0)
                    throw new InvalidDataException("Unlisted compact archive directory.");
            }
            else
            {
                if (!inventory.TryGetValue(path, out var expected) || entry.Size != expected.Size)
                    throw new InvalidDataException("Compact archive file is unlisted or has the wrong size.");
                fileCount++;
                expandedSize = checked(expandedSize + entry.Size);
                if (fileCount > 30000 || expandedSize > MaxPackage)
                    throw new InvalidDataException("Compact archive exceeds package limits.");
            }
            entries.Add(path, entry.IsDirectory);
        }
        if (fileCount != manifest.Files.Length || expandedSize != manifest.ExpandedSize)
            throw new InvalidDataException("Compact archive inventory mismatch.");

        // The complete directory is checked before creating any output. A single reader
        // preserves the decoder between files in a solid block (no repeated decompression).
        DirectorySafe(destination);
        using var reader = archive.ExtractAllEntries();
        var buffer = ArrayPool<byte>.Shared.Rent(1024 * 1024);
        var extracted = new HashSet<string>(StringComparer.Ordinal);
        long expanded = 0;
        var progress = TransferProgress("extracting", 0, manifest.ExpandedSize, -1);
        try
        {
            while (reader.MoveToNextEntry())
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (reader.Entry is not SevenZipEntry entry)
                    throw new InvalidDataException("Unexpected compact archive reader entry.");
                var path = CompactEntryPath(entry);
                if (!entries.TryGetValue(path, out var isDirectory) || isDirectory != entry.IsDirectory || !extracted.Add(path))
                    throw new InvalidDataException("Compact archive directory changed while reading.");
                if (isDirectory) continue;
                var expected = inventory[path];
                if (entry.Size != expected.Size) throw new InvalidDataException("Compact archive length changed while reading.");
                var destinationFile = SafePath(destination, path);
                DirectorySafe(Path.GetDirectoryName(destinationFile)!);
                using var output = new FileStream(destinationFile, FileMode.CreateNew, FileAccess.Write, FileShare.None);
                using var hasher = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                using (var input = reader.OpenEntryStream())
                {
                    try
                    {
                        long total = 0;
                        while (true)
                        {
                            cancellationToken.ThrowIfCancellationRequested();
                            var count = input.Read(buffer, 0, buffer.Length);
                            cancellationToken.ThrowIfCancellationRequested();
                            if (count == 0) break;
                            total = checked(total + count);
                            if (total > expected.Size || expanded + total > manifest.ExpandedSize)
                                throw new InvalidDataException("Expanded compact file exceeds signed length.");
                            output.Write(buffer, 0, count);
                            hasher.AppendData(buffer, 0, count);
                        }
                        if (total != expected.Size || !Convert.ToHexStringLower(hasher.GetHashAndReset()).Equals(expected.Sha256, StringComparison.OrdinalIgnoreCase))
                            throw new CryptographicException("Extracted compact file SHA-256 rejected.");
                        cancellationToken.ThrowIfCancellationRequested();
                        output.Flush(true);
                        expanded = checked(expanded + total);
                    }
                    catch
                    {
                        // EntryStream otherwise drains an unfinished solid stream on Dispose.
                        reader.Cancel();
                        throw;
                    }
                }
                progress = TransferProgress("extracting", expanded, manifest.ExpandedSize, progress);
            }
            cancellationToken.ThrowIfCancellationRequested();
            if (extracted.Count != entries.Count || expanded != manifest.ExpandedSize)
                throw new InvalidDataException("Compact archive extraction is incomplete.");
        }
        catch
        {
            reader.Cancel();
            throw;
        }
        finally { ArrayPool<byte>.Shared.Return(buffer); }
    }

    static void AddCompactNode(Dictionary<string, string> nodes, string path)
    {
        if (nodes.TryGetValue(path, out var previous) && previous != path)
            throw new InvalidDataException("Compact inventory contains inconsistent path casing.");
        nodes[path] = path;
    }

    static string CompactEntryPath(SevenZipEntry entry)
    {
        if (entry.IsEncrypted || entry.IsSplitAfter || entry.LinkTarget is not null)
            throw new InvalidDataException("Encrypted, split, or linked compact archive entries are forbidden.");
        var path = entry.Key ?? throw new InvalidDataException("Missing compact archive path.");
        if (entry.IsDirectory && path.EndsWith('/')) path = path[..^1];
        ValidateRelativePath(path);
        // Attrib discards POSIX mode bits; ExtendedAttrib retains the original 7z field.
        var attributes = entry.ExtendedAttrib ?? entry.Attrib;
        if (attributes is int raw)
        {
            var unixType = (raw >> 16) & 0xF000;
            if ((raw & ((int)FileAttributes.ReparsePoint | (int)FileAttributes.Device)) != 0
                || ((raw & (int)FileAttributes.Directory) != 0) != entry.IsDirectory
                || (unixType != 0 && unixType != (entry.IsDirectory ? 0x4000 : 0x8000)))
                throw new InvalidDataException("Linked, special, or inconsistent compact archive entry type.");
        }
        return path;
    }

    static void ValidateCompactHeader(Stream source)
    {
        Span<byte> header = stackalloc byte[32];
        if (source.Length < header.Length || source.Length > MaxPackage)
            throw new InvalidDataException("Invalid compact archive length.");
        source.ReadExactly(header);
        if (!header[..6].SequenceEqual(new byte[] { 0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C }) || header[6] != 0)
            throw new InvalidDataException("Unsupported compact archive format.");
        var offset = BinaryPrimitives.ReadUInt64LittleEndian(header[12..20]);
        var size = BinaryPrimitives.ReadUInt64LittleEndian(header[20..28]);
        if (size == 0 || size > MaxManifest || offset > (ulong)source.Length - 32
            || size != (ulong)source.Length - 32 - offset)
            throw new InvalidDataException("Invalid compact archive header bounds.");
        source.Position = 0;
    }

    sealed class CompactArchiveInput(Stream inner, CancellationToken cancellationToken) : Stream
    {
        public override bool CanRead => true;
        public override bool CanSeek => true;
        public override bool CanWrite => false;
        public override long Length => inner.Length;
        public override long Position { get => inner.Position; set { cancellationToken.ThrowIfCancellationRequested(); inner.Position = value; } }
        public override int Read(byte[] buffer, int offset, int count) { cancellationToken.ThrowIfCancellationRequested(); return inner.Read(buffer, offset, count); }
        public override int Read(Span<byte> buffer) { cancellationToken.ThrowIfCancellationRequested(); return inner.Read(buffer); }
        public override int ReadByte() { cancellationToken.ThrowIfCancellationRequested(); return inner.ReadByte(); }
        public override long Seek(long offset, SeekOrigin origin) { cancellationToken.ThrowIfCancellationRequested(); return inner.Seek(offset, origin); }
        public override void Flush() => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
