# Release optimization profiles

Run with PowerShell 7 from this directory:

```powershell
# Verify existing files; no network requests or file writes.
./Fetch-ReleaseProfiles.ps1 -Offline

# Also verify official GCS metadata; do not download or write files.
./Fetch-ReleaseProfiles.ps1 -ValidateOnly

# Fetch only missing files after validating existing files and GCS metadata.
./Fetch-ReleaseProfiles.ps1 -BuildRoot D:/work/velmren
```

The default build root is inferred from this script's location at
`<build-root>/src/brave/tools/velmren-delivery`; an explicit `-BuildRoot` overrides
it. The Chromium checkout must be its `src` child. The script checks
`chrome/build/win64.pgo.txt`, the V8
version header, and Chromium's `DEPS` against its embedded release manifest.
This manifest is intentionally fixed: a checkout update requires an explicit
review of the new official object generations, checksums, and V8 revision.

The manifest records official GCS generations and MD5 checksums, plus SHA-256
checksums for the stored and decoded bytes. Chromium's gzip source is retained
beside its decoded profile as `.verified-source.gz`. V8 15.6.75.19's official
`meta.json` declares x86, x64, x86-rl, and x64-rl profiles; the script verifies all
four and their revision `392e44423f46d75904da712fadea4c7d5d97967f`.

Downloads select the pinned [GCS object generation](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/get)
and disable [gzip transcoding](https://docs.cloud.google.com/storage/docs/transcoding)
so the downloaded MD5 can be checked before decompression. New files are written
to unique sibling staging paths, checked, and moved without overwrite. Existing
files, older profiles, build outputs, and caches are never removed or replaced.
Any conflict fails explicitly. Failed downloads and racing duplicate staging
files are retained for inspection; the script performs no cleanup.

The helper does not invoke upstream profile downloaders because their normal
download flows remove older files. It does not run or restart a build.
