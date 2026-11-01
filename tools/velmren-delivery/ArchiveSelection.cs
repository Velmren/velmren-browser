namespace Velmren.Delivery;

internal static partial class Program
{
    static void ValidateCompactArchive(Manifest manifest)
    {
        if (manifest.CompactArchive is not { } compact) return;
        if (compact.Format != "7z" || compact.Package != $"velmren-{manifest.Version}.7z"
            || compact.Size <= 0 || compact.Size > MaxPackage)
            throw new InvalidDataException("Invalid compact archive descriptor.");
        CheckHash(compact.Sha256);
        Policy.ValidatePackageUrl(compact.PackageUrl);
    }

    // Canonical ZIP identity remains in the signed manifest for older launchers.
    // Only transfer metadata changes; both archives must contain identical files.
    static Manifest SelectArchive(Manifest manifest, string? bundleDirectory = null)
    {
        if (manifest.CompactArchive is not { } compact) return manifest;
        if (bundleDirectory is not null && !File.Exists(SafePath(bundleDirectory, compact.Package))) return manifest;
        return manifest with { Package = compact.Package, Size = compact.Size, Sha256 = compact.Sha256,
            PackageUrl = compact.PackageUrl, CompactArchive = null };
    }

    static string ArchiveCachePath(string root, Manifest selected)
    {
        var extension = Path.GetExtension(selected.Package);
        if (extension is not (".zip" or ".7z")) throw new InvalidDataException("Unsupported archive extension.");
        return SafePath(root, "downloads/" + selected.Sha256 + extension);
    }
}
