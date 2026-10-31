# Velmren Windows setup

Native, per-user WinForms frontend for the delivery engine. Requires the .NET 10 SDK to build. Published output contains its own runtime and engine. It does not request elevation, make itself the default browser, or expose delivery configuration in the install window.

```powershell
# First build maintenance, then place it in the signed payload inventory.
.\Build-Setup.ps1 -EnginePath C:\build\Velmren.exe -OutputDirectory C:\build\maintenance

# After packaging the signed payload, create an offline setup.
.\Build-Setup.ps1 -EnginePath C:\build\Velmren.exe -BundleDirectory C:\build\bundle -OutputDirectory C:\build\setup

# Optional online installer or optional future update feed for an offline bundle.
.\Build-Setup.ps1 -EnginePath C:\build\Velmren.exe -Feed https://updates.example/velmren/preview/win-x64/ -OutputDirectory C:\build\setup
```

`BundleDirectory` must contain `manifest.json` (the delivery engine's signed envelope) and the ZIP named by its decoded payload. The build script reads the package name solely to locate the input file. It does not establish trust. Only those two files, the explicit engine EXE, and generated public configuration are embedded. There is no private-key input. The delivery engine must verify the pinned signature and complete package inventory before installation. Sign the final output with the real release Authenticode identity in the release pipeline; this script does not create a certificate or alter Windows trust settings.

The default output is `VelmrenSetup.exe` when a bundle/feed is supplied and `VelmrenMaintenance.exe` otherwise. `-Name`, `-Runtime` (`win-x64` or `win-arm64`), and `-Version` may be specified. The matching architecture engine must already be a self-contained single EXE. Intermediate build inputs and output are retained under `OutputDirectory/build-*` for inspection.

## Engine contract

Every awaited command receives `--cancel-file PATH`; the path belongs to this setup invocation. On cancellation, the frontend creates that file and waits up to eight seconds before terminating only its engine process. It never kills a process tree. The engine owns transactional installation, recovery, trust checks, path validation, running-process checks, and registration rollback.

- Offline: `install-bundle --root ROOT --bundle-directory DIR [--feed HTTPS]`
- Online: `install --root ROOT --feed HTTPS`
- After successful installation: `register --root ROOT --desktop true|false`
- Removal: `uninstall --root ROOT`, preserving browser profile and agent state
- Finish: starts installed `ROOT/Velmren.exe launch --root ROOT`, detached from setup

Arguments use `ProcessStartInfo.ArgumentList`, never a shell. The engine streams one JSON object per line on stdout: `{"action":"extracting","percent":40}`. `action` is required; integer `percent` is optional (0–100). Missing percentages use the native indeterminate progress indicator. Known action names map to Russian text; unrecognized output is ignored. stderr is captured with an 8 KiB limit and mapped to concise user-facing recovery guidance. The engine's own journal is authoritative for diagnostic details. The UI does not display raw feed URLs, certificates, keys, exceptions, or signed-manifest internals.

The maintenance command is `VelmrenMaintenance.exe --uninstall --root ROOT`. Its initial window asks the user to confirm removal and explains that saved data remains. There is no delete-profile option. With no package/feed, an explicit `--root`, and an installed `ROOT/Velmren.exe`, the same file opens maintenance/removal. Without an installed root it explains that the full installer is needed.

When invoked for removal from inside the installation tree, maintenance first copies its own executable into an ACL-private cache and restarts that exact copy. The original exits before the copy shows a window, releasing the installed maintenance file for deletion. The internal marker accepts only a canonical GUID, the exact expected copy path, and the matching root record; there is no arbitrary executable-path option. The running maintenance copy is retained in its private cache after exit because it cannot delete its own image. No shell deletion command or global cleanup registration is created. The separate extracted engine/bundle session is cleaned with a bounded asynchronous retry. A cache outside the chosen install root is required.

## Interface

The audience is someone installing or removing Velmren in their Windows account. The main path is choose folder → install → optionally launch. The recovery path is cancel/error → retry; removal is confirm → remove → finish. The default folder is `%LOCALAPPDATA%/Programs/Velmren`. Desktop shortcut and finish launch are optional checkboxes.

Uses Windows controls, system colors, Segoe UI, per-monitor DPI scaling, a resizable layout, access keys, Enter/Escape, and native accessibility names. No custom title bar, decorative animation, or fabricated release branding. Progress stays on the UI thread via `Progress<T>`; extraction and engine IO are asynchronous. Inputs become unavailable while work is running and recover after cancellation/failure.

## Verification

`tests/Run-Smoke.ps1 -OutputDirectory C:\qa\setup` builds a fake engine, runs process/argument/cancellation/error tests, and renders the native initial/install and removal forms using offscreen windows with `WS_EX_NOACTIVATE`. These renders are layout evidence, not a claim of completed screen-reader, real desktop, or cross-monitor testing. The test engine never installs or registers software. Root-level acceptance must also exercise the final signed-bundle engine and actual maintenance registration.
