# Build the Windows x64 release browser

`Build-ReleaseBrowser.ps1` builds the prepared Velmren checkout into
`<build-root>/src/out/Release`. Both it and `Fetch-ReleaseProfiles.ps1` infer
`<build-root>` from their location at `src/brave/tools/velmren-delivery`.
Use `-BuildRoot` to select another checkout with the same layout and release pins.

This is a recipe for a prepared, pinned Windows checkout. The wrapper's path
handling has syntax and structural checks; a clean-checkout bootstrap and a
complete release build on another machine have not been verified end to end.

## Prepared checkout

- Windows x64, PowerShell 7, Git, and the prerequisites in the pinned Chromium
  [Windows build instructions](https://chromium.googlesource.com/chromium/src/+/156.0.8078.48/docs/windows_build_instructions.md).
  This checkout calls for Visual Studio 2026 with Desktop development with C++
  and MFC/ATL, Windows SDK 10.0.28000.2270, and the SDK debugging tools.
- Node and pnpm matching [package.json](../../package.json): currently Node
  `>=24.16.0 <25.0.0` and pnpm `>=11.11.0`. The shell must find `node` and `pnpm`.
- Windows Developer Mode already enabled and a physical checkout path without
  symlink or junction ancestors, as required by
  [checkEnvironment.js](../../build/commands/lib/checkEnvironment.js).
- The exact Velmren source changes, Chromium dependencies, and applied patches
  belonging to this release. An upstream Brave clone alone lacks the Velmren
  customizations. The current [package.json](../../package.json) identifies
  Brave 1.98.60 and Chromium 156.0.8078.48; the profile manifest additionally
  pins V8 15.6.75.19 and its revision. Keep the complete source revision set
  together rather than mixing moving branch tips.
- pnpm dependencies installed with the lockfile, gclient dependencies synced,
  hooks completed, and the checkout's pinned compiler, GN, Siso, and other build
  tools available. Provide adequate disk space and memory for an official
  non-component PGO/ThinLTO build.

The source dependency entry points are defined in
[package.json](../../package.json) and
[sync.ts](../../build/commands/scripts/sync.ts). On an idle checkout whose
Velmren source and release pins have already been selected:

```powershell
Set-Location D:/work/velmren/src/brave
# First initialization only, in a new dedicated checkout:
pnpm run init --target_os=win --target_arch=x64

# For an already initialized checkout, use sync instead of init:
pnpm run sync --target_os=win --target_arch=x64
```

These are alternative dependency-preparation commands, not steps run by the
release wrapper. Both install pnpm dependencies with the frozen lockfile and
invoke the source sync script. Sync obtains depot_tools, syncs dependencies,
applies patches, runs gclient hooks, and writes the Siso configuration. `init`
also requests forced dependency initialization, so reserve it for a new
checkout. Do not run either while a native build is active. Review upstream
sync and hook effects before using them on a customized checkout; this recipe
does not call for cache or output cleanup.

## Environment and profiles

Use a shell configured for the pinned local Windows toolchain. For a local
Visual Studio installation, Chromium uses `DEPOT_TOOLS_WIN_TOOLCHAIN=0` and
can use `vs2026_install` for a nonstandard installation path; see the pinned
[toolchain script](https://chromium.googlesource.com/chromium/src/+/156.0.8078.48/build/vs_toolchain.py). Any local PATH, temporary
directory, cache, or toolchain choices belong to that machine's environment.
`BUILD_ID` and `TEAMCITY_VERSION` must be absent for this local wrapper.

The wrapper accepts an optional `-EnvironmentScript <path>` and dot-sources it.
Without that parameter, it loads `<build-root>/Enter-VelmrenEnvironment.ps1`
only when the file exists, preserving compatibility with prepared local
workstations. Otherwise it uses the calling shell's environment. An explicit
`-EnvironmentScript ''` skips automatic loading. The environment helper is
machine-local and is not required to be present in the repository. If used,
configure the environment before dependency preparation too.

Fetch the pinned release profiles before building, then verify them offline:

```powershell
$delivery = 'D:/work/velmren/src/brave/tools/velmren-delivery'
& "$delivery/Fetch-ReleaseProfiles.ps1"
& "$delivery/Fetch-ReleaseProfiles.ps1" -Offline
```

The [profile manifest and verification rules](ReleaseProfiles.md) are fixed
to this release. A mismatched checkout, checksum, or existing profile fails
explicitly; review the pins instead of replacing conflicting files. Fetching
retains the verified compressed Chromium profile alongside the decoded file.

## Release build

Run from PowerShell 7 once no native build is using this build root:

```powershell
# Uses this checkout's inferred root and the current/automatic environment.
& "$delivery/Build-ReleaseBrowser.ps1" -Jobs 4

# Alternative: explicit matching checkout and machine-local environment helper.
& "$delivery/Build-ReleaseBrowser.ps1" `
  -BuildRoot D:/work/velmren `
  -EnvironmentScript D:/work/velmren/Enter-LocalBuildEnvironment.ps1 `
  -Jobs 4
```

Choose one invocation. The default target is `brave`; `-Target` overrides it.
The wrapper rejects a detected Siso process whose executable or command line
references the selected root. This is a preflight check, not a cross-process
lock; do not start simultaneous build launchers for the same checkout.

The wrapper verifies profiles offline, creates missing output and log
directories, and creates `args.gn` from the generated-arguments import plus
[release.gni](release.gni). If existing `args.gn` differs, it stops for explicit
reconciliation. It invokes the repository's
[build.ts](../../build/commands/scripts/build.ts) with `Release`, the selected
target, signing disabled, and remote execution disabled. The release settings
retain the non-component official build, Chromium PGO phase 2, V8 profiles,
ThinLTO, and the existing feature and symbol configuration. `-Jobs` controls
local build parallelism; the separate link limits remain in `release.gni`.

Logs and a JSON status record are written under `<build-root>/logs` with a UTC
timestamp. The JSON records the output directory, target, jobs, profile name,
launcher PID, and build exit code. A successful invocation returns exit code
zero. Existing output and caches are retained; no cleanup is part of this
wrapper. Packaging the resulting browser is a separate step documented in
the [delivery README](README.md#optimized-browser-and-release-bundle).
