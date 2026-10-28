# Public Shields resources

Velmren does not have Brave's private component-service credentials. It bundles
the Windows default filter sources and scriptlet/redirect resources, then uses
the existing subscription service for HTTPS text-list updates.

`PROVENANCE.json` records the 26 source URLs, hashes, sizes, engine selection and
permission masks. `scriptlet-provenance.json` records the pinned resource build.
The upstream license texts are in `licenses/`.

The bundled lists cover first launch without a network connection. A downloaded
subscription replaces its snapshot; disabled/deleted entries stay disabled or
deleted after restart. The one-time `velmren.ad_block.public_lists_seeded` pref
prevents defaults from being reintroduced. Only exact curated URLs receive the
upstream engine selection and permission mask. Arbitrary subscriptions keep the
ordinary additional-engine, unprivileged behavior.

Conditional directives are processed before parsing downloaded public lists.
Scriptlet/redirect resources update with Velmren builds; list text updates through
the subscription service. Additional public lists can be added by URL in Shields
settings. This does not provide Brave's private regional-component catalog.

Acceptance covers fresh offline startup, control-off/Standard/Aggressive modes,
scriptlet execution, noopjs redirection, public downloads, persisted opt-outs,
and cached protection after an offline restart. Test fixtures and artifacts are
under `test/velmren` and the isolated build workspace respectively.
