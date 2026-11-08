# Public Shields resources

Velmren does not have Brave's private component-service credentials. It bundles
the Windows default filter sources and scriptlet/redirect resources, then uses
the existing subscription service for HTTPS text-list updates.

`PROVENANCE.json` records the 28 source URLs, hashes, sizes, engine selection and
permission masks. `scriptlet-provenance.json` records the pinned resource build.
The upstream license texts are in `licenses/`.
Text snapshots use LF line endings. When CRLF is normalized, provenance retains
the original download's `source_sha256` separately from the bundled file hash.

The catalog includes AdGuard Other Annoyances and uBlock Other Annoyances to
block browser-install promotions, including Yandex search overlays and header
promotions. These are additional-engine lists, so their cosmetic rules apply in
Standard mode on search engines. The other Shields modes and site exceptions
keep their existing behavior.

The bundled lists cover first launch without a network connection. A downloaded
subscription replaces its snapshot; disabled/deleted entries stay disabled or
deleted after restart. The versioned catalog migration adds only newly introduced
lists to existing profiles. The legacy `velmren.ad_block.public_lists_seeded`
boolean represents catalog version 1; catalog version 2 does not restore deleted
version-1 lists or enable disabled entries. Completed migrations do not restore
later opt-outs. Only exact curated URLs receive the
upstream engine selection and permission mask. Arbitrary subscriptions keep the
ordinary additional-engine, unprivileged behavior.

The additional AdGuard list is GPL-3.0 licensed; its license is bundled in
`licenses/AdGuardFilters-GPL-3.0.txt`. The uBlock list uses the existing GPL-3.0
license notice in `licenses/uBlock-GPL-3.0.txt`.

Conditional directives are processed before parsing downloaded public lists.
Scriptlet/redirect resources update with Velmren builds; list text updates through
the subscription service. Additional public lists can be added by URL in Shields
settings. This does not provide Brave's private regional-component catalog.

Acceptance covers fresh offline startup, control-off/Standard/Aggressive modes,
scriptlet execution, noopjs redirection, public downloads, persisted opt-outs,
and cached protection after an offline restart. Test fixtures and artifacts are
under `test/velmren` and the isolated build workspace respectively.
