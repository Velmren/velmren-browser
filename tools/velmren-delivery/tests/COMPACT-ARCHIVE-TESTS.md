# Compact archive validation

Run the host-safe test executable with a **new** evidence directory:

```powershell
dotnet run --project tools/velmren-delivery/tests/Velmren.Delivery.CompactArchiveTests.csproj -- C:/qa/compact-new
```

Append the compact archive and its original signed manifest to verify a real
release, every extracted SHA-256, and cancellation after file output starts:

```powershell
dotnet run --project tools/velmren-delivery/tests/Velmren.Delivery.CompactArchiveTests.csproj -- C:/qa/compact-new C:/qa/payload.7z C:/qa/manifest.json
```

The real manifest is verified with the repository's pinned preview public key.
Generated fixture signatures use an ephemeral in-memory RSA key. The tests never
read production private keys, launch a browser, modify the registry, or publish.
An installed `Program Files/7-Zip/7z.exe` generates encrypted test fixtures;
production extraction uses only the pinned managed SharpCompress dependency.

The suite covers traversal, device names, ADS, control characters, path casing,
file/directory collisions, extra and missing entries, signed lengths/hashes,
POSIX special types, Windows reparse/device attributes, anti-items, encryption,
invalid headers, output overwrite prevention, compressed headers and LZMA2.
Results and generated fixtures remain in the evidence directory.

## Extraction contract

`Program.ExtractCompactArchive` accepts a previously authenticated manifest and
an archive whose complete SHA-256 was already checked against its signed
descriptor. It validates the full inventory before creating output. Directories
must be ancestors of signed files; explicit empty directories are not payload.
File content is written with `CreateNew` and verified against signed size/SHA-256.
Attributes, links, permissions and timestamps are never restored. Link and
special-file metadata is rejected; each output file is created independently.

The archive must be a standalone, single-stream 7z file without trailing data.
An outer next-header limit of 16 MiB supplements the existing 30,000-file and
16-GiB signed payload limits. SharpCompress's internal metadata and codec
allocations are not a sandbox: signature and full archive hash verification must
precede the parser. In particular, the outer header limit does not bound an
encoded header's expanded memory or a codec dictionary. The dependency is
pinned in `DeliveryArchiveDependencies.props`; its MIT notice ships alongside
the launcher output.

Solid extraction uses one sequential reader. On failure or cancellation,
`reader.Cancel()` is called before disposing the entry stream so SharpCompress
does not drain the remaining solid data. The caller owns removal of a rejected
staging directory and activation of a fully verified installation.
