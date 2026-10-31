# Second-PC support files

Include `SECOND-PC-RU.md` and optional `Collect-VelmrenDiagnostics.ps1` beside the final installer. The instruction describes normal per-user installation and a launch/close/reopen check. It does not certify the installer or replace testing on another PC.

The collector supports Windows PowerShell 5.1 and newer. It writes a new directory beneath the explicitly selected existing local output folder, containing `report.json` and a ZIP of that JSON only. It does not upload files. Output inside the installation, network drives, and reparse paths are rejected.

Collected data is restricted to OS/PowerShell versions and bitness, metadata of six fixed application files, a canonical four-number version from `current.json` (at most 4 KiB), and the last 200 candidate journal records within a 64 KiB tail of `events.jsonl`. Journal records over 4 KiB or with invalid time/version/action are omitted. Only normalized time, an allowlisted action, and version are exported; `detail` and other fields are discarded. Unknown future action codes require an allowlist update. Actual installation paths are replaced with a default-path token or a custom-folder label.

The collector does not read installation settings/ownership, browser profile, agent state, registry, Windows events, or process lists. It does not start executables or stop processes. Presence/size/timestamp checks do not establish executable integrity, and the bounded journal may omit older or incomplete events.

Run the synthetic regression with Windows PowerShell 5.1 and a new scratch folder:

```powershell
powershell.exe -NoProfile -File .\Test-CollectVelmrenDiagnostics.ps1 -OutputDirectory "E:\Astra\work\tmp\velmren-support-qa-new"
```

Tests retain their synthetic fixtures and reports. They do not install, register, launch, or uninstall Velmren. Do not distribute the test script or fixtures as part of the end-user support bundle.
