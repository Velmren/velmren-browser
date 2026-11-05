# Managed MCP connection

The MCP catalog has 24 tools, including `velmren_sensitive` and `velmren_captcha`. Begin a protected
phase before credential or activation work; use a locally staged `secretRef`
for secret input. All response paths use the same output projection, including
errors and task/page lists. URLs disclose only origins, and protected phases
block screenshots and free page content. See the [input and phase contract](README.md#sensitive-inputs-and-outputs).
The private staging callback is intentionally absent from the tool catalog and
CLI; it does not require writing credentials to a file.
Managed startup requires broker `agentProtocol: 4` before registration. A newer
adapter cannot reuse an older broker without the protected-output and scoped
recovery contracts.
`BROKER_INCOMPATIBLE` preserves existing clients and tasks; reconnect after those
clients finish and the old broker exits normally.
Direct MCP, CLI and `createClient` connections also perform an authenticated
`agent_protocol` handshake using only their scoped credential before operations.
The direct adapter cannot fall back to an older broker's unprotected output.

`Start-VelmrenMcp.ps1 -InstallRoot <installation>` is the stable Windows entry
point. It asks the installed `Velmren.exe resolve` for the current signed payload,
then relays stdin/stdout/stderr to its Node runtime and `agent/managed-mcp.mjs`.
The resolved browser and state paths are passed to the module so the signed
payload does not need to be verified twice for one connection.
The configured launcher path and installation root do not contain a version.
Optional `-StateDir`, `-Policy`, and `-Label` arguments are forwarded. Native
children use `CreateNoWindow`; Node children use `windowsHide`.
Signed installation verification has a separate 90-second deadline. Configure
the MCP host startup timeout to include that deadline plus broker startup time.

For Codex, include `supports_parallel_tool_calls = true` under
`[mcp_servers.velmren]`. Its default is false, which serializes independent task
calls in the host before they reach this server. `required = true` waits for the
configured server to be ready before building the initial tool catalog. Keep
the caller's chosen approval settings; parallel dispatch does not grant new
permissions.

For development, run:

```powershell
node managed-mcp.mjs --browser C:\path\Velmren.exe --state-dir C:\path\agent-state --policy C:\path\policy.json
```

The default policy is the broker's loopback-only policy. Supply an explicit
policy when authorized tasks require external origins. State must be private to
the local account; the installer owns Windows directory ACLs. The modules create
new files with mode 0600 and directories with mode 0700 on platforms that honor
those modes.

The requested policy is read before any broker probe, including reuse. Its
SHA-256 identity covers all policy fields with recursively sorted object keys,
defaults of eight tasks and five simultaneous actions, and `false` for
`webCompatibility` and `allowWeb`. Explicit `allowedOrigins` are sorted and
deduplicated, and override `allowWeb`. Missing policy files, changed identities,
and brokers without policy/health metadata fail before client registration.
Changes to a policy file do not change an already running broker's policy.
Set `profileMode: "persistent"` for a dedicated agent profile whose cookies and
site storage survive completed tasks and clean restarts. Tasks then share
origin storage but retain separate ownership of their pages and control APIs.
The profile's effective policy is bound before launch and incompatible reuse
is rejected. The default `"isolated"` mode creates disposable task contexts.

Each MCP startup registers `{label, policyIdentity, leaseMs: 30000}` with
authenticated admin RPC `client_register`, expecting `{clientId, token,
recoverySecret, leaseMs: 30000}`. Only that scoped token is passed
to `createClient` and MCP tools. There is no tool exposing the admin token,
connection descriptor, process launch, or broker shutdown. The connection sends
scoped `client_heartbeat` every ten seconds. EOF or server close sends scoped
`client_release` with a bounded two-second deadline. Explicit release
cancels only that client's unfinished tasks and revokes its credentials; other
connections and their tasks remain active. Cancellation does not undo actions
already performed. After the normal thirty-second lease expires, mutations are
blocked while heartbeat recovery has an additional sixty-second grace period.
A transient heartbeat failure retries the same scoped identity for up to sixty
seconds. It does not cancel a handoff or replay a browser operation. Exhaustion
reports `LEASE_RECOVERY_NEEDED` with a safe phase and cause; the MCP transport
stays available. `connection.reconnect()` can explicitly repair it later. At
the end of the server grace period, unfinished tasks are cancelled.
The broker retires after thirty seconds with no
managed leases or unfinished tasks, allowing installed updates to activate after
the personal browser is also closed.

The daemon imports `startBroker({executable, stateDir, policy, port: 0})` and
expects `{descriptor, close}`. The broker must atomically publish
`connection.json` containing `{endpoint, pid, adminToken}` and maintain a numeric
PID in `broker.lock`. RPC uses `{method,args}` and `{ok:true,result}`. The
bootstrap requires `broker_status` to return its `policyIdentity` and
`browserHealthy: true`, then registers once. Recovery uses `client_recover`
with the original UUID and opaque secret; it never registers a replacement
owner or replays task actions. Reauthentication rotates the bearer credential
and retains the owner's in-flight work when the original broker is still alive.
An exited browser closes its broker; a still-live unhealthy broker is rejected
without terminating another process.

Concurrent daemons serialize startup with an exclusive loopback TCP listener
whose port is derived from the canonical state path. The kernel releases this
lock when its process ends. A rare unrelated port collision causes a bounded
startup failure, never termination of the other process. Startup defaults to
60 seconds; allow additional time in the MCP host for installation verification
and cold module imports.
Each spawning client waits for its own helper to exit after reuse or complete
an IPC handshake after registration. A healthy peer descriptor alone cannot
leave a late startup helper behind. EOF during startup and the startup deadline
cancel cooperatively: an in-progress owned launch is closed after it settles,
while existing peer brokers remain running. Graceful cleanup can outlast the
startup deadline. Protocol bytes received before readiness are bounded and
buffered until the MCP transport takes over.

A dead broker is recovered only if `managed-owner.json`, `broker.lock`, and any
connection descriptor identify the same process and a PID probe confirms that
process no longer exists. Those files are moved into a unique `recovery/` backup
before starting a replacement. Invalid, unowned, mismatched, or live state is
preserved and startup fails. A reused PID is treated as live. Browser profiles
and existing user processes are never deleted or killed.

The recovery secret remains in the local connection closure and never enters
tool output or logs. `client-recovery.json` stores only its hash, policy binding,
revocation flag, and owned task IDs/states. A fresh client cannot recover a peer
by label or task ID. After broker death, recovered tasks have
`state: "recovery-needed"` and `domRestored: false`: DOM, popups, private-input
capabilities, and manual forms are not restored. Read the durable CAPTCHA job
status before deciding further work. Recovery never dispatches another solve,
private input, or submit request.

`lifecycle.jsonl` records safe startup/shutdown phases, observed browser/daemon
exit codes or signals, and heartbeat causes without arguments, URLs, or secrets.
A surviving launcher observes forced daemon termination. If no observer survives,
the next startup records the previous process as unavailable with unknown cause;
it does not invent an exit code. Manual handoff `shown` acknowledges target
visibility only; `visibility` separately reports activation requests and keeps
native-window/foreground verification false until independently established.

An intentional `profileLogin` phase keeps the controller available while its
automated browser is stopped. New clients reuse that controller; they never start
a replacement. Heartbeats and scoped release remain available. Ordinary manual
login is profile-wide and starts only after all tasks and downloads end. See
[the manual sign-in workflow](README.md#ordinary-manual-profile-sign-in).

A `manual-profile.json` receipt blocks ordinary cold startup and stale-owner recovery,
including when the receipt is malformed. A live controller accepts an explicit
finish from the initiating client or administrator only after its ordinary browser
has exited. If the controller crashed, preserve the receipt and profile and obtain
explicit administrative recovery; an unattended reconnect must not delete the
guard or reuse a profile which may still be open. Managed EOF never kills the
ordinary sign-in window, and its closure never implies user confirmation.

`profile-recovery.mjs` is the explicit administrator entrypoint after a controller
exit. It requires the recorded login ID, `--user-confirmed true`, and the original
browser, state directory and policy. Under the existing startup gate it validates
the receipt and dead managed owner, preserves stale ownership files, and restores
the manual gate. Only successful close verification and a fresh CDP initialization
complete the receipt. A failed recovery keeps the receipt and can be retried after
the underlying condition is resolved. This option is not accepted by the ordinary
managed MCP client.

`managed-broker.log` contains sanitized daemon diagnostics. MCP stdout contains
protocol messages only; help and startup errors go to stderr.

The private broker state also holds bounded `requests.jsonl` request metadata
and one rotated copy. These records exclude form contents, URLs, local file
paths, credentials and screenshots. See the [task contracts](README.md#task-protocol)
for delivery uncertainty and retry rules; reconnecting never retries a mutation.

Tests use hidden fake-broker processes and leave their evidence below
`test-results/`:

```powershell
node --test test/managed.test.mjs
```
