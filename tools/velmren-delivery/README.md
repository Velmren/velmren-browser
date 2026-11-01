# Velmren Windows delivery

The 2026-10-31 registration workaround removes registry key renaming and forced
registry flushes after a host BSOD traced to that path. See
[registration and safe validation](INSTALL-LIFECYCLE.md#windows-registration).
Earlier QA executables still contain the old implementation; they are retained
as evidence and must not be reused for registry tests. The workaround has
memory-only fault-injection coverage and compile checks; validation of the
Windows adapter belongs in a disposable Windows environment before distribution.

This Windows x64 installer, launcher, package builder and automatic updater
installs the browser and optional Node agent
bridge into a dedicated directory. Normal browser launch starts no agent.

Development mode accepts only `http://127.0.0.1:<port>/` feeds and schema-1 test
manifests. Release mode embeds a separate RSA public key, an exact HTTPS feed,
allowed redirect hosts, and schema-2 product/channel/platform identity. There
is no runtime option to weaken this policy. Private keys stay outside source
and distribution. RSA manifest signing does not provide Windows Authenticode
signing or SmartScreen reputation. No certificate store is modified.

The native [setup frontend](../velmren-setup/README.md) supports a selected
per-user install folder, optional desktop shortcut, cancellation, retry and
removal while retaining browser data. [Installation lifecycle](INSTALL-LIFECYCLE.md)
documents ownership, Start-menu/HKCU registration and recovery. No administrator
rights, Windows service, scheduled task or default-browser change is required.
Public hosting and a provider-approved signing identity are deployment steps;
the `.invalid` example policy is only a test fixture, never a usable update service.

## Optimized browser and Release bundle

`Fetch-ReleaseProfiles.ps1` verifies or fetches the pinned official optimization
profiles without deleting existing data; see [profile verification](ReleaseProfiles.md).
`Build-ReleaseBrowser.ps1` builds a separate non-component `out/Release` browser
with PGO and ThinLTO. It does not replace the Component build. Both compilation
and link parallelism are bounded for the current workstation.
See [Windows release build](BUILD-WINDOWS.md) for prepared-checkout requirements,
portable paths, environment setup, and the build commands.

`Build-ReleaseBundle.ps1` takes `-BrowserDirectory`, `-AgentDirectory`,
`-NodeExecutable`, explicit `-PublicKey`, `-PrivateKey`, `-Policy`, four-part
`-Version`, and a fresh `-OutputDirectory`. It builds a Release engine, builds
maintenance around that exact engine, stages both into the signed browser
payload, creates the signed ZIP/manifest, and embeds the bundle into
`setup/VelmrenSetup.exe`. Optional `-PackageUrl` supports an immutable package
on an allowed HTTPS host. `release.json` records artifact hashes and public
policy; no private key is embedded. The script does not publish or upload.
The engine is always rebuilt into a fresh isolated build directory. Before
execution or packaging, its actual single-file bundle is inspected: the embedded
managed assembly must match that build's assembly and contain no registry rename
or flush imports/calls. `registry-inspection.json` binds this check to the final
engine hash. Maintenance and setup embed this same engine. The manifest, package,
maintenance, engine and setup hashes are recorded in `release.json`.

`tests/Test-ReleasePackaging.ps1 -WorkDirectory <new-directory>` exercises the
whole chain using non-executed browser/agent/runtime fixtures and an isolated
test key. It verifies the signature, every archived file, and the engine/bundle
bytes actually embedded in both frontends. Only the engine's `policy` and
`package` commands run; this check performs no installation or registration.

The host policy must name the actual chosen feed before distribution. HTTPS
redirects are bounded to five, remain HTTPS and stay on exact allowed hosts;
TLS errors are never ignored. Downloads send no cookies, authorization or
default Windows credentials. Query credentials are redacted from diagnostics.

## Build and package

Run in PowerShell 7 on Windows with the .NET 10 SDK. The published executable
includes the .NET runtime, so installed machines do not need the SDK or runtime.
The first publish may restore Microsoft's runtime package from NuGet.

```powershell
$delivery = 'E:/Astra/work/velmren-build/src/brave/tools/velmren-delivery'
$qa = 'E:/Astra/work/velmren-build/qa'
& "$delivery/Build-Installer.ps1" `
  -TrustDirectory "$qa/delivery-dev-trust" `
  -OutputDirectory "$qa/delivery-installer"
$installer = "$qa/delivery-installer/VelmrenDelivery.exe"

& "$delivery/Stage-Payload.ps1" `
  -ComponentDirectory 'E:/Astra/work/velmren-build/src/out/Component' `
  -AgentDirectory 'E:/Astra/work/velmren-build/src/brave/tools/velmren-agent' `
  -Destination "$qa/full-payload-N"
& "$delivery/Build-Release.ps1" -Installer $installer `
  -PayloadDirectory "$qa/full-payload-N" -Version '1.0.0.0' `
  -FeedDirectory "$qa/full-feed" `
  -PrivateKey "$qa/delivery-dev-trust/private.pem"
```

`Stage-Payload.ps1` accepts `-BrowserDirectory` (`-ComponentDirectory` remains an
alias) and copies runtime DLL/PAK/BIN/DAT and side-by-side manifest files, the Velmren executable,
selected browser helpers and resources/locales. It excludes build object files,
PDBs, test executables, build tools, and the separate `chrome.exe`. It copies agent
MJS/JSON/Markdown files, `public/` assets and `node_modules`, plus the explicit Node executable.
It includes Chromium, Brave and Node license files; the exact Node distribution's
LICENSE must be adjacent to `node.exe` or supplied with `-NodeLicense`.
Run `npm ci --omit=dev` in the agent project beforehand. Review the staged
payload before packaging; the full installed browser must be exercised to catch
missing runtime resources. The full-browser preflight found that the top-level
`156.1.98.0.manifest` is required: omitting it caused a Windows SideBySide launch
failure. Staging now includes `.manifest` files. Source and destination reparse
points are rejected. The destination must be outside both browser and agent
source trees; required runtime, license and agent inputs are checked before
staging starts.

A staging directory is packaging input, not an installation. It does not receive
the Chromium sandbox capability ACLs described below. Run sustained browser QA
from an installed version: directly launching a copied staging EXE can appear
to work, then fail when a delayed sandboxed subprocess starts.

Create a fresh payload directory after building N+1, then package it with
`-Version '1.0.0.1'`. Packaging writes an immutable ZIP, a versioned signed
manifest, and atomically publishes `latest.json` last. It refuses to overwrite
an existing release ZIP. Version strings have four numeric parts. They represent
delivery releases and need not equal the underlying Chromium product version.
The source tree is not compiled by these scripts.

The signed archive contains `delivery-app.json`:

```json
{
  "browser": "browser/velmren.exe",
  "browserArguments": [],
  "agent": "runtime/node.exe",
  "launcher": "delivery/Velmren.exe",
  "setup": "delivery/VelmrenMaintenance.exe",
  "agentArguments": [
    "agent/broker.mjs", "daemon", "--browser", "{browser}",
    "--state-dir", "{agentStateDir}", "--port", "0"
  ]
}
```

The launcher expands `{browser}`, `{agentStateDir}`, and `{profile}` in the
signed agent arguments and optional `agentEnvironment` dictionary. It sets
`VELMREN_PROFILE_DIR` for both launch modes. The agent's own broker/CLI contract
determines how an agent session starts and stops; `agents` runs that configured
broker in the foreground, monitored by the launcher. Browser arguments cannot
override the dedicated profile directory.

## Install and run

Start the local feed in one terminal. It listens only on IPv4 loopback and serves
GET requests for package/manifest files, including HTTP Range requests:

```powershell
& $installer serve --directory "$qa/full-feed" --port 18773
```

From another terminal:

```powershell
& $installer install --root "$qa/full-installed" `
  --feed 'http://127.0.0.1:18773/' --poll-seconds 120
& "$qa/full-installed/Velmren.exe" launch
```

The destination must be new/empty or a matching owned installation. The installer copies itself to
`<root>/Velmren.exe`. Running that EXE without arguments is equivalent to
`launch`. It verifies and starts the installed browser before checking the feed,
then checks every configured interval while the browser is running.
Publishing N+1 to `latest.json` is sufficient; no manual
copy or `update` invocation is needed. `--poll-seconds 2` can shorten checks for
QA. Feed errors are logged and do not prevent launching the verified installed
version. The initial background update has a five-second budget; a larger download
is resumed by a later background check. An incomplete initial installation with
no active release still checks the feed before launch. Closing the browser lets the launcher
activate the staged release and exit. Stop the feed terminal after QA; no
installed background helper remains.

Useful commands:

```powershell
# Manual diagnostic check; the normal launcher performs this automatically.
& "$qa/full-installed/Velmren.exe" update
& "$qa/full-installed/Velmren.exe" status

# Verified current version/browser/Node/app directory paths as JSON.
# Resolve at each new MCP session; do not hard-code versions/N paths.
& "$qa/full-installed/Velmren.exe" resolve

# Explicit opt-in agent broker; ordinary launch does not run Node.
& "$qa/full-installed/Velmren.exe" agents
```

All installed commands also accept `--root <directory>`. The launcher's
`--url <URL>` option accepts only an absolute HTTP or HTTPS URL in the dedicated
QA browser profile; switches, local files, script URLs, and browser-internal
routes are rejected before any update or launch action.
It always supplies `--user-data-dir=<root>/profile`, `--no-first-run`, and
`--no-default-browser-check`.

## Update and trust behavior

- RSA-3072/PSS-SHA256 verifies the exact manifest payload bytes before package
  selection. SHA-256 and signed sizes cover the complete ZIP and every file.
- Downloading uses streams. A truncated `.part` resumes with HTTP Range; its
  final full hash is always checked. Failed hash artifacts are retained under
  rejected names and never executed.
- Cancellation covers HTTP headers, response streams, package writes, hashes,
  extraction, and operation-lock waits. Manifest responses have a ten-second
  overall limit; archive requests and body reads have a ten-second inactivity
  limit, with a twenty-minute overall update budget. Startup imposes a shorter
  five-second budget for the initial check, after starting an existing verified
  release, and retains any partial archive for a later poll.
- Extraction checks the complete ZIP directory before writing files. It rejects
  traversal, absolute/ADS/Windows device paths, duplicate case-folded names,
  file/directory collisions, extra files, ZIP symlinks and reparse destinations.
  Signed inventory limits are 30,000 files and 16 GiB compressed/expanded.
- Successful extraction is moved into `versions/<version>/app`. The signed
  manifest is retained alongside it. Version directories are never overwritten
  or removed by the updater. Installation, activation, agent startup and explicit
  `resolve`/`verify` audits verify the complete inventory and file hashes.
  Ordinary browser startup verifies the signed manifest and the hash of the
  small signed launch configuration, validates executable paths/presence, and
  opens the committed installation without rereading the entire payload.
  Consequently ordinary launch does not detect arbitrary post-install changes
  to every local resource before execution; use `verify` for a full audit.
  This is an explicit installed-code trust boundary, not a size/mtime hash cache.
  Unchanged-release polling also avoids a full payload audit. Hashing reuses a pooled buffer;
  manifest path syntax validation does not probe unrelated temporary paths.
  Actual installed and extraction paths retain reparse-point checks. No file
  hashes are cached using size, timestamp, or a persisted verification marker.
- The installed `app` directory receives inheritable read/execute ACEs for
  Chromium's exact `chromeInstallFiles` and `lpacChromeInstallFiles` capability
  SIDs, matching `chrome/installer/setup/configure_app_container_sandbox.cc`.
  Windows propagates these ACEs to the extracted executable, DLLs, and resources.
  This is necessary for AppContainer/LPAC subprocesses to open the executable;
  missing permissions caused a delayed sandbox access-denied crash in the full
  browser QA installation. The updater grants no write permission and preserves
  all existing ACEs and inheritance settings. Only the version's `app` DACL is
  modified; profile, agent-state, installation root and parent directories are
  untouched. Launch/resolve idempotently repair older installations
  missing these capability entries. No broad ALL APPLICATION PACKAGES or
  ALL RESTRICTED APPLICATION PACKAGES grant is added, and sandboxing stays enabled.
- `current.json` is an atomically replaced pointer. Downloads and staging do
  not alter it. A shared launcher lease plus installed-browser process checks
  defer activation until the application exits. Concurrent installer/updater
  operations are serialized. Ordinary launch takes only the shared run lease,
  so a download holding operation.lock cannot delay a committed browser. It
  rereads ownership/current under that lease; unfinished launcher transactions
  release it before serialized recovery. Pending updates activate after exit.
  No running browser is terminated for an update.
- Older signed versions and same-version package rebinding are rejected.
  A pending newer release prevents replaying an older one. Interrupted staging
  leaves the current release intact; a later attempt uses a fresh staging path.
- `profile/` and `agent-state/` live outside version directories. Updates do
  not copy, rewrite, or delete them. The full-browser local acceptance run
  automatically updated `1.0.0.1` to `1.0.0.3`, then verified a real saved
  bookmark, the bookmark-bar preference, and actual username/password autofill
  from the same synthetic profile at the new executable path. This establishes
  persistence for this development build and Windows account; production
  signing or encryption-identity changes need their own migration validation.
- Local same-user malware, kernel compromise, key rotation, multi-user service
  hardening, power-loss durability certification, public
  hosting, release signing/SmartScreen reputation, and production Omaha4
  registration are outside this implementation. A development pinned key is test trust, not a
  substitute for Windows code signing. A holder of that key can authorize code.

`events.jsonl` records downloads, staging, activation/defer decisions and launcher
events. `launch-timing` records total preparation and numeric settings, lease-wait,
validation and process-creation timings. It excludes runtime initialization and
does not measure first paint or window readiness.
`current.json`, `pending.json`, `installation.json`, and the retained
version manifests make an interrupted operation inspectable. An interrupted
initial install can be resumed with `Velmren.exe update --root <root>` or by
rerunning the same installer against its matching owned destination.

## Launcher self-update

The optional signed `launcher` entry is fixed to `delivery/Velmren.exe`. Before
activation, the engine verifies the full package and probes the candidate's
protocol, embedded policy and RSA public-key fingerprint. A changed trust
identity requires a separate migration; an ordinary update cannot change it.

Under the operation lock and exclusive launch lease, a journal records the
old/new signed release versions. Windows `ReplaceFile` atomically swaps the
stable `Velmren.exe` with a verified copy and retains the old executable. This
works while the old launcher process itself is running. The browser version
pointer is changed only after the replacement probe succeeds. An interrupted
pre-commit swap restores the old launcher; an interrupted committed swap is
completed on the next activation attempt. Recovery validates both candidates
against their signed inventories, including the backup before restoration.
Failure leaves the existing browser release available and records the rejection.

Legacy development packages without `launcher` keep their old behavior. A
legacy root without a signed previous launcher cannot be silently converted
to this self-update chain; install a new bundle into a matching supported root.

`tests/Velmren.Delivery.LauncherFileTests.csproj` exercises real executable
replacement, commit-boundary recovery, damaged backups, incompatible candidates
and profile preservation in fresh QA directories. Its compile-time configuration
excludes the shell-registration test section; it never calls registration or
uninstallation. The full `LauncherTests` project adds live registry refresh and
requires `VELMREN_ALLOW_LIVE_REGISTRY_TESTS=1` in disposable Windows.
Both projects take five arguments: a new evidence directory, matching engines A
and B, an incompatible engine, and the test private key. Build with the matching
`PinnedPublicKey`; use freshly built engines for every fixture.
The native setup smoke tests use fixture engines; final acceptance
also needs the real Release engine/bundle and the actual browser build.

## Reproducible smoke tests

```powershell
& "$delivery/Test-Delivery.ps1" -Installer $installer `
  -PrivateKey "$qa/delivery-dev-trust/private.pem" `
  -WorkDirectory "$qa/delivery-smoke-unique" -Port 18773
```

The tests create actual signed N/N+1 release ZIPs and install the actual EXE.
Their synthetic app is a copy of the installer with a timed test entrypoint,
so the test does not require a browser build. It checks interrupted HTTP Range
recovery, automatic periodic update, activation deferral, synthetic settings /
bookmarks / password byte preservation, signature/hash/downgrade/same-version
rebind rejection, signed hostile ZIPs, Windows junction rejection, and installed
payload hash verification even when size and timestamp are unchanged, plus
missing/extra-file rejection. The suite also rejects URL switch injection and
serves both manifest and archive headers followed by one byte and a stalled
body, proving that the verified app starts before the initial background read
times out and releases the operation lock. `result.json` records
those startup durations. Command/feed/launcher logs and the installation are
retained as evidence. Test-owned processes are stopped in a
`finally` block. Tests never use a personal profile or modify certificate trust.

ACL checks verify both exact sandbox capabilities on initial and updated app
executables and nested resources, compare private-directory/ancestor DACLs
before and after updates, and remove/reapply only the test app's capability ACEs
to verify idempotent legacy repair while preserving unrelated entries.
