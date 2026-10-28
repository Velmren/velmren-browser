# Velmren Browser identity

The supported target is Windows x64 with `is_brave_origin_branded=false` and
`enable_updater=false`. The first build is the Development channel. Its executable
is `velmren.exe`; its profile and install namespace is
`Velmren\Velmren-Browser-Development`. Stable, Beta, Dev and Nightly have independent
Velmren registrations for future packaging. Origin is explicitly unsupported.

## Artwork

`logo.svg` is an original geometric V on dark teal. Colors are dark teal `#092C35`,
mint `#40D9BC`, and pale mint `#D4FFF3`. The small monochrome V inherits the native
control color. No Brave lion artwork is used on the supported browser surfaces.

The welcome hero and password manager use `logo.svg` directly. Shared WebUI
resources package `velmren-icon-color` and `velmren-icon-monochrome` from this
directory; use these names for browser UI. Nala's Brave icons remain available
for actual external services, search engines, publishers, and import sources.
Native location and Shields icons use the local `leo_brave_icon_*` V paths in
`components/vector_icons`, not Nala's generated lion paths.
The native new-tab favicon uses the same V through the `TabData` override;
`IDR_FAVICON_NTP_DARK/LIGHT` are upstream artwork and must not be used by Velmren.
The shared `IDR_NTP_FAVICON` used by bookmarks is copied from the 16px product
logo at both supported scale factors by the asset generator and branding step.

Run `python script/velmren/generate_brand_assets.py --font <segoeuib.ttf>` from the
repository to regenerate the Windows ICOs and PNG resources with Pillow. The
Windows font is used only for the Velmren wordmark; the mark is geometric. Existing
resource paths and IDs remain stable to preserve build integration and icon order.

## Text and attribution

`script/velmren_branding.py` changes browser display names after GRIT translates a
message, preserving source IDs, translation fingerprints and placeholders. Legal
notices, upstream authors, actual external services and import-source labels keep
their attribution. Internal pages display and copy `velmren://` URLs while
`brave://` and `chrome://` remain compatible inputs. Committed and stored WebUI
origins stay `chrome://`; internal source names remain implementation details.
About shows the local browser and Chromium
versions without sending its release link to Brave's website.

## Windows identity and validation

`windows_identity.json` records the GUID migration. The browser application,
Active Setup, toast activator, elevator interfaces/class, type library and sandbox
namespace are independent from Brave. The registered elevator IID is paired with
the corresponding IDL interface. Preserve these identifiers across releases.

Run `python script/velmren_branding_test.py` and
`python script/velmren/verify_identity.py --check-midl` before compiling. After IDL
changes, regenerate the checked-in outputs under
`win_build_output/midl/chrome/elevation_service` with Chromium's SDK/MIDL workflow;
never edit binary type libraries by hand. Source-only checks can omit
`--check-midl` while the SDK and Chromium checkout are being prepared.

A future updater requires its own server, signing and COM identities. The inherited
Brave updater branding must remain disabled. Component updates are independent and
remain enabled. Native build, browser launch, About/settings/New Tab visual QA and
installer side-by-side testing are required before distributing a release.
