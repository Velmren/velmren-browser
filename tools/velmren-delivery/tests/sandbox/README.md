# Disposable Windows delivery validation

This package runs the real install lifecycle and launcher transaction suites in
a clean Windows x64 Sandbox or VM. It exists because the earlier registry rename
and explicit registry flush combination caused a host BSOD. The fixed engine
must pass the static audit before any guest test starts. The package builder
never runs an engine or a live registry test.

The fixtures use Development mode and a freshly generated RSA-3072 test key.
All three engines are built from the same captured current source. A and B have
different file versions; the incompatible fixture pins a different fresh public
key. The bundled private key is deliberately test-only and has no release trust.
There is no release-key parameter and no certificate-store operation.

## Build on the development host

Use PowerShell 7.4+ and .NET SDK 10 with the Windows x64 runtime pack available
(restore may download dependencies on the build machine). Choose a new directory
outside the source repository:

```powershell
& 'tools/velmren-delivery/tests/sandbox/New-DisposableValidationPackage.ps1' `
  -OutputDirectory 'E:\Astra\work\tmp\velmren-validation-unique'
```

The output contains `package/`, a ZIP of that directory, build logs,
`host-static-audit.json`, `build-result.json`, an empty `results/` directory,
and `Run-In-WindowsSandbox.wsb`. No guest launch or Windows feature installation
is performed. `-SkipArchive` omits only the ZIP.

The package includes self-contained single-file executables and the installed
portable PowerShell runtime, so the guest needs no SDK, .NET install, package
restore, internet connection, or release credentials. Source snapshots, build
versions, payload hashes and a complete SHA-256 inventory travel with it. The
runtime copy retains its accompanying license files.

## Run inside a disposable guest

Use a new Windows 10/11 x64 VM snapshot or Windows Sandbox, with at least 4 GB
RAM and 15 GB free guest disk. Disconnect external networking; tests use only
IPv4 loopback servers. The guest account must permit ordinary HKCU writes,
shortcuts, NTFS junctions and process creation. Do not use a personal browser
profile or an existing Velmren installation. Discard the guest after validation.

For Windows Sandbox, open the generated `.wsb` only on a machine that already
supports Windows Sandbox. It maps the package read-only and the dedicated
results directory writable, disables networking/clipboard/vGPU, and starts the
runner in the Sandbox account. The configuration contains absolute host paths;
regenerate or update those mappings if the output directory moves. This workflow
does not enable Windows optional features or create a VM on the build host.

For an existing disposable VM, extract the ZIP to `C:\VelmrenValidationPackage`,
create a results folder on a separate export share or guest disk, and run there:

```powershell
& 'C:\VelmrenValidationPackage\runtime\pwsh.exe' `
  -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File 'C:\VelmrenValidationPackage\scripts\Run-GuestValidation.ps1' `
  -EnvironmentKind VirtualMachine -ResultDirectory 'C:\VelmrenValidationResults' `
  -DisposableWindowsConfirmed -AllowLiveRegistryTests
```

The runner requires both explicit switches, a Windows virtual-machine identity,
and a computer name different from the build host. These checks catch accidental
host execution; they do not create or prove isolation. The caller must supply an
actual disposable guest. The lifecycle script's switch and launcher executable's
environment gate remain enabled only for the guest child processes.

Before execution, every inventoried file is hashed and unrecorded files/reparse
points are rejected. PE metadata inspection rejects `RegRenameKey`, `NtRenameKey`,
`RegFlushKey`, and `RegistryKey.Flush` references in each delivery/test assembly.
Each audited DLL must occur exactly once, byte-for-byte, in its corresponding
uncompressed single-file EXE. This binds the metadata audit to the bytes that will
execute. The build also uses `Export-BundleAssembly.ps1`, the same final-bundle
gate as `Build-Installer.ps1`, to extract the actual named bundle entry, compare
it with the fresh compiler output and audit it without executing the engine.
Its EXE/assembly hash-bound evidence is checked again offline in the guest.
Framework runtime assemblies are not classified as application calls.

## Results and acceptance

The runner writes `results/run-*/result.json` before each test phase, stdout and
stderr logs, a transcript, the package manifest, the repeated static audit, both
suite results, and their JSON/log diagnostics. Lifecycle and launcher phases have
20-minute and 10-minute limits. Temporary installations stay on guest-local disk;
large payload copies are not exported. Export `run-*` before deleting a VM; the
Sandbox mapping exports automatically. A guest crash may leave `status: running`:
that is an incomplete run, never a pass.

Acceptance requires overall `status: passed`, both suite result files reporting
passed checks, and `preflight-audit.json` tied to the expected package manifest
hash in `build-result.json`. Nonzero exit or any failed/incomplete phase blocks
acceptance. Review the assertion names in the exported suite results.

This is synthetic Development-mode lifecycle/launcher verification. It does not
claim guest execution merely because packaging/static inspection passed, and
does not replace the separate native Release setup or actual browser acceptance.

Host-safe reinspection is available without launching a test executable:

```powershell
& '<output>\package\runtime\pwsh.exe' -NoProfile -File `
  '<output>\package\scripts\Inspect-ValidationPackage.ps1' `
  -PackageDirectory '<output>\package'
```

The runner's gate, subprocess pass/failure/timeout handling, result export and
inventory rejection can also be checked on the host with harmless PowerShell
children only:

```powershell
& 'tools/velmren-delivery/tests/sandbox/Test-PackageHarness.ps1' `
  -WorkDirectory 'E:\Astra\work\tmp\velmren-harness-unique'
```
