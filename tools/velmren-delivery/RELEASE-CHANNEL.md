# Velmren preview update channel

`ReleasePolicy.github.json` reserves the HTTPS feed for
`Velmren/velmren-browser`. Preparing that policy does not create a repository,
publish a release, or establish that the feed is available.

The checked-in `preview-public.pem` verifies RSA-PSS update manifests. Its
SHA-256 fingerprint over DER SubjectPublicKeyInfo is
`d010231fec58e38b3656071f7037c08879cf85d87428b4d44a82c627cedf99e5`.
The private key is kept outside the source repository and distribution folders
in an access-restricted directory. Preserve an independent private-key backup
before moving this release process to another computer. The key does not add a
Windows certificate or provide Authenticode publisher identity.

Build the optimized browser with `Build-ReleaseBrowser.ps1`, then use
`Build-ReleaseBundle.ps1` with this policy, the public key, the external private
key, and a canonical four-part package version. The final `setup/` directory
contains the installer, the Russian second-PC instructions, and an optional
local diagnostics collector. Development test keys must never be substituted.

For a version such as `0.1.0.0`, the immutable package URL is:

```text
https://github.com/Velmren/velmren-browser/releases/download/preview-0.1.0.0/velmren-0.1.0.0.zip
```

Pass that exact URL as `-PackageUrl` before signing. Publish the generated
`latest.json`, versioned manifest, ZIP, 7z, and installer together with the source
revision and hashes. The feed reads
`releases/latest/download/latest.json`; GitHub's latest-release pointer must
select the intended release. A GitHub prerelease is not automatically selected
by that pointer. Keep the preview status explicit in the release title and
notes. Each uploaded asset must be smaller than 2 GiB.

From 0.1.0.3, the optional signed `compactArchive` representation is the same
versioned URL with `.7z`. Keep the canonical ZIP asset: installed 0.1.0.2 clients
ignore the new descriptor, fetch that ZIP once, and upgrade their launcher.
New launchers and online Setup prefer 7z. Both representations authenticate the
same complete extracted inventory; the feed identity and pinned key are unchanged.

The downloader follows HTTPS redirects only to the original host and
`release-assets.githubusercontent.com`. A header-only check against an official
PowerShell release asset confirmed that redirect route on 2026-10-31; this is
provider compatibility evidence, not validation of the Velmren feed.

Before publishing, verify the complete bundle and the final engine's static
registry audit. After publishing, fetch the public feed without GitHub
credentials, verify its pinned signature and archive hash, and test an actual
automatic N-to-N+1 update with the same browser profile. Record clean-PC
installation separately from packaging, file-only update, and in-memory tests.
Neither a successful upload nor a compiled installer proves clean-PC acceptance.

References: [GitHub release links](https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases)
and [release asset limits](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases).
