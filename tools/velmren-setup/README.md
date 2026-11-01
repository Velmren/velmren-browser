# Velmren Windows setup

Native, per-user WinForms frontend for the delivery engine. Requires the .NET 10 SDK to build. Published output contains its own runtime and engine. It does not request elevation, make itself the default browser, or expose delivery configuration in the install window.

The release's main `setup/VelmrenSetup.exe` is the online installer and downloads the browser from its embedded HTTPS feed. `offline-setup/VelmrenSetup.exe` is the optional full package for installation without a download. Both use the same UI and signed-package verification contract.

```powershell
# First build maintenance, then place it in the signed payload inventory.
.\Build-Setup.ps1 -EnginePath C:\build\Velmren.exe -OutputDirectory C:\build\maintenance

# After packaging the signed payload, create an offline setup.
.\Build-Setup.ps1 -EnginePath C:\build\Velmren.exe -BundleDirectory C:\build\bundle -OutputDirectory C:\build\setup

# Online installer; an offline bundle remains available for installation without a download.
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
- Open Velmren: starts installed `ROOT/Velmren.exe launch --root ROOT`, detached from setup; Close exits without launching

Arguments use `ProcessStartInfo.ArgumentList`, never a shell. The engine streams one JSON object per line on stdout: `{"action":"extracting","percent":40}`. `action` is required; integer `percent` is optional (0–100). Missing percentages use the native indeterminate progress indicator. Known action names map to Russian text; unrecognized output is ignored. stderr is captured with an 8 KiB limit and mapped to concise user-facing recovery guidance. The engine's own journal is authoritative for diagnostic details. The UI does not display raw feed URLs, certificates, keys, exceptions, or signed-manifest internals.

The maintenance command is `VelmrenMaintenance.exe --uninstall --root ROOT`. Its initial window asks the user to confirm removal and explains that saved data remains. There is no delete-profile option. With no package/feed, an explicit `--root`, and an installed `ROOT/Velmren.exe`, the same file opens maintenance/removal. Without an installed root it explains that the full installer is needed.

When invoked for removal from inside the installation tree, maintenance first copies its own executable into an ACL-private cache and restarts that exact copy. The original exits before the copy shows a window, releasing the installed maintenance file for deletion. The internal marker accepts only a canonical GUID, the exact expected copy path, and the matching root record; there is no arbitrary executable-path option. The running maintenance copy is retained in its private cache after exit because it cannot delete its own image. No shell deletion command or global cleanup registration is created. The separate extracted engine/bundle session is cleaned with a bounded asynchronous retry. A cache outside the chosen install root is required.

## Interface

The audience is someone installing or removing a browser in their Windows account. The main path is review the folder → download and install → open Velmren. Offline builds use the same screen with an install action and no download promise. The selected folder is always shown; “Изменить” expands folder editing, the native folder picker, and the optional desktop shortcut. There is no Next/Back wizard. The default folder is `%LOCALAPPDATA%/Programs/Velmren`. Completion has a direct “Открыть Velmren” action and a secondary Close that does not launch anything. The recovery path is cancel/error → retry; removal is confirm → remove → close, with profile preservation stated before and after removal.

The 600×380 initial window uses the existing Velmren V artwork, Segoe UI typography, a neutral surface, and dark teal `#092C35`. Expanded settings increase its height to 460. The primary button and folder field have rounded surfaces; secondary actions are quiet. Button and TextBox subclasses retain Windows keyboard/accessibility semantics instead of reimplementing text entry or button activation. System colors replace branded colors in high contrast. Access keys, Enter/Escape, focus indicators and per-monitor DPI scaling remain available. The layout can resize and scroll; there is no decorative animation or additional UI runtime dependency.

`SetupControls.cs` replaces the classic caption with a minimal drag area and an accessible Close button. Native hit testing supplies dragging and edge/corner resizing, including negative monitor coordinates. Alt+F4 and the Close button use the same form-close lifecycle: a running operation is cancelled and awaited before the window exits. Windows 11 receives the [DWM rounded-corner hint](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/ui/apply-rounded-corners); corner clipping and shadows remain OS-managed, with a rectangular fallback on older Windows. The [custom-frame pattern](https://learn.microsoft.com/en-us/windows/win32/dwm/customframe) keeps native sizing/system-menu styles without drawing a classic caption. No transparency layers, window regions, or separate shadow windows are used.

Progress stays on the UI thread via `Progress<T>`; extraction and engine IO are asynchronous. The stage and its actual engine percentage are shown together; an absent percentage uses native indeterminate progress. Inputs become unavailable while work is running and recover after cancellation/failure. Unknown engine actions do not change the displayed progress.

The structure follows the simplified consumer paths documented by [Chrome](https://support.google.com/chrome/answer/95346?hl=en) and [Firefox](https://support.mozilla.org/en-US/kb/how-install-firefox-windows), reviewed 2026-11-02. Firefox explicitly distinguishes its [full offline custom wizard](https://support.mozilla.org/en-US/kb/custom-installation-firefox-on-windows) from the online installer, which has no folder choice. Velmren keeps the requested folder choice through progressive disclosure; that is our product decision, not a claim that all browser installers offer it. [Brave's official download page](https://brave.com/download/) likewise prioritizes one Get Brave action. These references inform flow and hierarchy; no third-party artwork or installer code is copied.

## Verification

`tests/Run-Smoke.ps1 -OutputDirectory C:\qa\setup` builds a fake engine, runs process/argument/cancellation/error tests, and renders the native initial/install and removal forms using offscreen windows with `WS_EX_NOACTIVATE`. These renders are layout evidence, not a claim of completed screen-reader, real desktop, or cross-monitor testing. The test engine never installs or registers software. Root-level acceptance must also exercise the final signed-bundle engine and actual maintenance registration.

For UI-only verification, `dotnet run --project tests/Setup.Smoke.csproj -c Release -- C:\qa\setup-ui --render-only` skips all engine/process tests. It renders offline, online, expanded settings, download, retry, success, removal, and simulated 150% layout with larger body text. It checks real disclosure controls, preserved folder edits, stage percentages, action availability, fit, Enter/Escape contracts, Alt+F4, caption-close cancellation, keyboard reachability, native drag/resize hit tests at negative screen coordinates, and unchanged foreground window. The native progress bar's animated fill and DWM corners/shadow are not captured reliably by offscreen `DrawToBitmap`; percentage text and control value are checked separately. Actual pointer dragging, monitor DPI changes, high-contrast switching, and screen-reader output still require desktop acceptance. Do not treat UI-only renders as evidence of installation or registration success.
