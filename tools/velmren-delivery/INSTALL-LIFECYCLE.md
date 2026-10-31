# Per-user installation lifecycle

`install --root ROOT [--feed URI]` and
`install-bundle --root ROOT --bundle-directory DIR [--feed URI]` install into a
new, empty directory or resume a matching owned installation. Release builds
use their embedded HTTPS feed by default. Development builds require an explicit
loopback HTTP feed. A bundle contains `manifest.json` and the ZIP named by its
signed manifest; it does not turn the feed into a `file://` source.

Before writing program files, the engine creates `.velmren-owner.json` with the
canonical root, current Windows SID, product, channel, platform, build mode and
unique installation identity. An unrelated nonempty directory is never adopted.
Development and Release markers cannot be used interchangeably. Existing legacy
unmarked development installations can still launch and update, but are not
eligible for registration or managed uninstall.

The marker journals program-file destinations before extraction or copying.
Both bundle and network installation use the same signed manifest, archive and
file hash checks, ZIP inventory validation, sandbox ACLs and activation rules.
Re-running a failed network install resumes its `.part` through HTTP Range.
Interrupted local copies restart; incomplete extraction is retained and the next
attempt uses fresh staging. Saved data remains in `profile/` and `agent-state/`.

Every command accepts `--cancel-file PATH`. Creating that file cancels a running
install, update, verification, extraction or lock wait; cancellation returns exit
code 2 with a JSON `cancelled` event. The caller owns the signal file: the engine
never removes it. No cancellation path stops an existing browser or agent.

## Windows registration

After a verified installation, run `register --root ROOT --desktop true|false`.
The Start menu and optional Desktop shortcuts target the stable
`ROOT/Velmren.exe`. Registration also creates an HKCU uninstall entry, separately
named for Development versus Release. Existing entries and shortcuts owned by
another installation are refused.
Shortcut writes are journaled before an atomic rename from a temporary link in
the same directory, so repeating registration can recover an interrupted write.
The HKCU entry is written directly at its final name. Before creating or changing
it, the filesystem ownership journal records a typed registration plan. Owner
and install location are written first; `DisplayName` is written last. A new key
may therefore exist briefly without a visible Apps entry; publication of all
values is no longer atomic. Repeating registration repairs a partial entry only
when its values agree with the recorded plan, or its full owner identity matches.
An existing unowned key (including an empty one) is refused before a plan is
created. A concurrent foreign create is detected from the creation disposition
and does not gain recovery authorization. This is not protection against a
malicious process running as the same Windows user and changing the journal.

The plan remains after completion because Windows may persist registry values
after the filesystem journal. Recovery does not depend on forcing a hive flush.
When a partial entry still follows an older plan, recovery completes its owner
identity under that plan before recording a newer one. An interruption cannot
strand old partial metadata behind a newly written plan.
Registration uses neither registry key renaming nor `RegistryKey.Flush()`.
The old rename path triggered the 2026-10-31 host BSOD; it must not be restored.
Legacy journaled staging keys can be validated and cleaned after the final entry
has been written, without renaming them. Diagnostic evidence from the crash is
not automatically cleaned by the source change. Short sharing
violations on owned shortcuts get a bounded, cancellable retry.

The signed `delivery-app.json` may contain
`"setup": "delivery/VelmrenMaintenance.exe"`. That file must be present in the
signed inventory. Registration copies and rechecks it at
`ROOT/VelmrenMaintenance.exe` and uses it for the uninstall UI. Without `setup`,
the verified installation uses the stable engine's `uninstall` command.
`--setup-path` is rejected. The optional signed launcher path is
`"launcher": "delivery/Velmren.exe"`.
Activating a newer release refreshes signed maintenance and the version in an
existing matching uninstall entry. This does not create or modify shortcuts.

## Uninstall and reinstall

`uninstall --root ROOT` requires a matching ownership marker. It refuses a busy
launcher lease, installed browser or installed agent runtime and never kills
them. Process checks use the owned executable inventory even if the app config
is missing. It preflights every owned path for reparse points before removing shell
registration or files, deletes only journaled program files, and removes only
empty program directories. Unknown files and all saved profile/agent data stay.
There is no saved-data deletion switch.
An interrupted uninstall marks the root as retained before removing files.
Launch refuses this state; reinstall reconciles tracked program leftovers
before extracting a complete signed release again.

The ownership marker, signed version high-water record and operation lock stay
with retained data. Reinstall into that root is supported, including replay and
same-version package-rebinding protection. Busy program files (for example the
maintenance UI that initiated uninstall) are listed in the JSON `retainedFiles`
field; `remainingEntries` reports remaining top-level entries. Uninstall does
not claim the directory was completely removed. A later uninstall retries the
tracked files after they close.
The registration journal also remains as a removal tombstone for interrupted or
delayed hive writes. A wholly owned key is deleted as a unit, keeping identity
until that operation. If unrelated values or subkeys exist, only application
metadata is removed; owner/location markers stay with the unrelated data, and
`DisplayName` is removed first. A later attempt can resume without erasing the
evidence needed to recognize ownership. Retained installations do not recreate
registry entries until an explicit installation/registration attempt.

## Isolated acceptance tests

For validation without accessing the Windows registry, run:

```powershell
dotnet run --project tests/Velmren.Delivery.RegistrationTests.csproj -c Release
```

This project compiles only the platform-independent state machine and an
in-memory registry. It injects interruption/cancellation at write boundaries,
checks recovery and conflicting ownership, and verifies publication order.
It does not compile or load the Windows adapter or installer entry point.

`Test-InstallLifecycle.ps1` requires a fresh QA directory, a published Development
engine and its matching private signing key. It records `result.json` and command
logs, and cleans up only its own child processes and temporary registry identity.
Development-only `VELMREN_DELIVERY_TEST_ID` (a GUID in N format) plus
`VELMREN_DELIVERY_TEST_SHELL_ROOT` route shortcuts into QA and use a unique HKCU
uninstall name. Release builds reject this override. The tests never change real
Start menu or Desktop shortcuts.
It still changes the real Windows registry, so it is now gated by
`-AllowLiveRegistryTests` and should run in disposable Windows. The launcher
integration suite likewise requires `VELMREN_ALLOW_LIVE_REGISTRY_TESTS=1`.
These live suites were not rerun on the affected workstation after the workaround.
The separate `tests/Velmren.Delivery.LauncherFileTests.csproj` excludes the live
registry section at compile time. It validates executable replacement and
recovery in fresh file-only installation roots, without registering applications.

Run `Test-Delivery.ps1` separately to retain the full existing delivery regression
coverage, including hostile signed archives, interrupted download recovery,
startup budgets, sandbox ACLs, deferred activation and saved-data preservation.
