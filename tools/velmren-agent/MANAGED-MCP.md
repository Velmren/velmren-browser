# Managed MCP connection

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

Each MCP startup registers `{label, policyIdentity, leaseMs: 30000}` with
authenticated admin RPC `client_register`, expecting `{clientId, token,
leaseMs: 30000}`. Only that scoped token is passed
to `createClient` and MCP tools. There is no tool exposing the admin token,
connection descriptor, process launch, or broker shutdown. The connection sends
scoped `client_heartbeat` every ten seconds. EOF or server close sends scoped
`client_release` with a bounded two-second deadline. Release or lease expiry
cancels only that client's unfinished tasks and revokes its credential; other
connections and their tasks remain active. Cancellation does not undo actions
already performed. Heartbeat failure closes that MCP connection without
reconnecting or replaying work. The broker retires after thirty seconds with no
managed leases or unfinished tasks, allowing installed updates to activate after
the personal browser is also closed.

The daemon imports `startBroker({executable, stateDir, policy, port: 0})` and
expects `{descriptor, close}`. The broker must atomically publish
`connection.json` containing `{endpoint, pid, adminToken}` and maintain a numeric
PID in `broker.lock`. RPC uses `{method,args}` and `{ok:true,result}`. The
bootstrap requires `broker_status` to return its `policyIdentity` and
`browserHealthy: true`, then registers once; it never replays task
actions or silently reconnects a task client after a broker restart.
An exited browser closes its broker; a still-live unhealthy broker is rejected
without terminating another process.

Concurrent daemons serialize startup with an exclusive loopback TCP listener
whose port is derived from the canonical state path. The kernel releases this
lock when its process ends. A rare unrelated port collision causes a bounded
startup failure, never termination of the other process. Startup defaults to
60 seconds; allow additional time in the MCP host for installation verification
and cold module imports.

A dead broker is recovered only if `managed-owner.json`, `broker.lock`, and any
connection descriptor identify the same process and a PID probe confirms that
process no longer exists. Those files are moved into a unique `recovery/` backup
before starting a replacement. Invalid, unowned, mismatched, or live state is
preserved and startup fails. A reused PID is treated as live. Browser profiles
and existing user processes are never deleted or killed.

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
