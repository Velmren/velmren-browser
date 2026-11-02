# Compact archive decoder

`7zr-26.05-win-x64.exe` is the unmodified `bin/x64/7zr.exe` from the official
LZMA SDK 26.05 archive, released by Igor Pavlov on 2026-10-21. The SDK is public
domain, including these binaries; see `LZMA-SDK-26.05.txt` (the original
`DOC/lzma-sdk.txt`). This is the SDK's 7zr, not the LGPL 7za distribution.

Source and binary provenance:

- Official SDK page: https://www.7-zip.org/sdk.html
- Official release: https://github.com/ip7z/7zip/releases/tag/26.05
- Source archive: https://github.com/ip7z/7zip/releases/download/26.05/lzma2605.7z
- Mirror: https://www.7-zip.org/a/lzma2605.7z
- `lzma2605.7z`: 1,786,350 bytes, SHA-256 `668fda469b7f584f246008cf28359c66ef98d65fafb3b22a52672eebe6970c28`
- `7zr-26.05-win-x64.exe`: 936,448 bytes, SHA-256 `ae23615622947262021cba6f4ae40c84702a9a55fef8e0b1bfab8b828748d63a`

Both sizes and SHA-256 values were verified after downloading the official
release. The original SDK source archive is retained here for reproducibility;
it is not embedded in the delivery runtime. The helper, license and provenance
are embedded by `DeliveryArchiveDependencies.props`.

The helper supports the package encoder's Copy, LZMA, LZMA2, BCJ and BCJ2 methods.
Its only installation command is `x -t7z -so`: managed code validates the signed
archive and complete metadata first, writes each file itself, verifies signed
lengths and SHA-256, and calls `Flush(true)`. No archive entry becomes a native
filesystem output path. The archive remains open without write/delete sharing.
The helper is verified and held open without write/delete sharing while running
from a unique directory whose ACL permits only the current user and SYSTEM.
No helper is extracted by ordinary browser launch.

The stdout framing uses 7z header file-index order, checked against these pinned
implementations and solid/multiblock/empty-file regressions:

- SharpCompress 0.50.7 `SevenZipArchive.LoadEntries`:
  https://github.com/adamhathcock/sharpcompress/blob/0.50.7/src/SharpCompress/Archives/SevenZip/SevenZipArchive.cs
- SDK `CPP/7zip/Archive/7z/7zExtract.cpp` (`CHandler::Extract`, `CFolderOutStream`)
  and `CPP/7zip/UI/Common/ArchiveExtractCallback.cpp` (stdout mode).

When updating either decoder, re-run the compact-archive and native-decoder
regressions, including the real signed package. Update both pinned size and hash
constants in `NativeArchiveDecoder.cs`; never silently fall back after a native
integrity or decoding failure.
