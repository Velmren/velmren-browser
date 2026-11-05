# Velmren agent prototype

A local companion process for testing task-scoped browser automation with Codex,
Claude Code, and scripts. Each client gets its own credential and task list. A
human can inspect, pause, show, resume, or cancel tasks in a local control panel.

The broker, browser control, and dashboard run on this machine. There is no
hosted Velmren service or cloud deployment in this prototype. Codex and Claude
retain their own model-provider connections; page observations and requested
screenshots returned to those clients may be sent to their model provider.

This is a development prototype. Running from source requires Node.js 24 or
newer and a built Velmren browser. The local delivery prototype packages the
broker, dashboard, MCP adapter, dependencies, and Node with the browser.

For an installed development copy, run `<installation>/Velmren.exe agents`.
Use `<installation>/Velmren.exe resolve` to obtain the verified current runtime
and app paths for a new MCP session. Its state directory is
`<installation>/agent-state`; it is separate from the ordinary browser profile.
See [local installation and updates](../velmren-delivery/README.md).

For Codex, prefer the [managed MCP connection](MANAGED-MCP.md). Its stable
PowerShell launcher resolves the installed version and starts a shared broker
without an extension or a visible startup window. Each MCP connection gets a
separate task owner. Disconnecting cancels that owner's remaining tasks; peers
continue. The broker retires after its managed clients and tasks are gone.
Set `profileMode: "persistent"` in the broker policy for a stable agent profile.
Its sign-ins and site storage survive task completion and browser restarts.
Tasks share that profile's origin storage while retaining separate page ownership.
The default `"isolated"` mode remains available for disposable, independent sessions.

### Optional CapSolver integration

Open **CAPTCHA service** in the local control panel to save your own CapSolver
key, set attempt limits, check its balance, and explicitly enable the service.
It is disabled by default. Windows DPAPI protects the saved key for the current
OS user; the service directory grants access only to that user and SYSTEM.
Repeated storage writes update only the directory DACL and preserve ownership;
they do not require elevation or Windows audit-security privileges.
Keys are sent through anonymous pipes for protection and directly to
`https://api.capsolver.com` for provider calls. They never appear in MCP, CLI,
process arguments, browser pages, or request traces. Removing the key disables
the service without resetting usage or outcome statistics.

`velmren_captcha` / `task_captcha` supports `inspect`, `solve`, `status`, and
`cancel`. Inspect the intended task/page/frame first, then pass its opaque
`challengeId` to solve. Solve returns a `jobId` promptly; poll status instead of
holding a tool call open. A repeated solve for that challenge returns the same
job. The adapter never automatically repeats `createTask` after a lost response.
Each attempt is reserved durably before sending it and counts toward the rolling
24-hour and per-task limits, even if the outcome becomes uncertain. The service
also limits simultaneous provider requests.

Supported variants are visible or invisible reCAPTCHA v2 and v2 Enterprise,
and standalone Turnstile widgets with an unambiguous response field or captured
completion callback. Open shadow roots and ordinary frames are supported.
hCaptcha, reCAPTCHA v3, Cloudflare interstitials, and closed-shadow-only
widgets are rejected. An hCaptcha compatibility facade is never sent as a
reCAPTCHA request. Missing callbacks or response fields remain explicit
unsupported reasons when no unambiguous delivery target is available.
Session, cookie-import and identity-changing modes are
outside this token-delivery contract and cannot be requested. Enabling
before navigation allows capture of explicit render callbacks. A same-document
element rendered before insertion is retained for at most 30 seconds, with a
64-element limit, and is usable only after attachment. Reset, removal, observed
document changes and expiry invalidate this pending capture. Turnstile's absent
global is left untouched during provider startup; existing API methods are armed
at script load, readiness and DOM changes. Callbacks registered before those
methods are armed may remain unavailable and are never guessed. Provider requests carry
only the site origin, site key, and supported widget metadata, never cookies or
page content. Origin-only requests may be insufficient on some sites.

The provider adapter returns only the validated token. Optional result metadata
such as `userAgent`, `secChUa` and cookies is discarded, never applied to the
live browser or included in public results. Its presence does not make an
otherwise valid token unsupported. This follows the documented token-only
examples for [reCAPTCHA v2](https://docs.capsolver.com/en/guide/captcha/ReCaptchaV2/)
and [Turnstile](https://docs.capsolver.com/en/guide/captcha/cloudflare_turnstile/).
Sites requiring additional cookies or a different browser identity may still
reject the delivered token; those flows are not implemented here.

Solutions remain inside the broker and are bound to the original page session,
document, widget, response field and callback. Changes invalidate delivery.
Applying a token enables the task's sensitive-output protection and does not
submit a form itself; a site's completion callback may navigate or submit.
Successful widget delivery is not proof that the website accepted it. Follow
the sensitive-phase transition below before revealing a safe destination.

The panel keeps separate totals for **delivered**, **failed**, **cancelled**, and
**uncertain** outcomes, plus the current task's totals. Failed includes rejected
or stale delivery. Cancelled attempts may still incur provider charges.
Interrupted dispatched jobs become uncertain after restart. A lost result or
callback exception is not counted as success. Paid-attempt usage remains
separate from these outcome counts. Global totals and owner-bound, token-free
job receipts persist locally. Older terminal receipts move to a local archive;
status lookup still returns their exact outcome. Recovered receipts omit task
totals because archived history may make a retained aggregate incomplete.
Actual provider billing is authoritative.

Managed connections recover their owner through a private recovery credential
and rotate their bearer token. A restart cannot restore browser documents:
old tasks report `recovery-needed`, and no click, submit, or paid solve is
replayed. A dispatched job interrupted before its terminal receipt is saved
reports `uncertain`. Lifecycle records preserve process exit and safe reason
codes for future diagnosis; they cannot establish the cause of a historical
exit that predates those records.

`velmren_diagnostics` returns bounded, task-owned network and console categories
for popup, CORS, FedCM, upload, and widget diagnosis. It records origins, HTTP
status, resource types, and fixed error categories only. Request paths,
headers, bodies, console text, exception strings, and stacks are discarded.
The diagnostic view remains available during protected input and after task
cancellation. A successful upload event does not prove site-side import.

Agent-active pages retain logical focus and visibility so background animation
frames and application initialization can finish. Native windows remain hidden.
Pause, human handoff, and task completion release this rendering state for every
owned page; resume restores it. Active pages may consequently use more CPU and
network than pages that previously stalled while hidden.

Control names include rendered slot content and unambiguous component labels.
An already focused, autosized autocomplete can receive keyboard input beneath
its own noninteractive placeholder; external overlays and modal blockers still
prevent delivery.

### Sensitive inputs and outputs

Public responses expose HTTP(S) origins only, including URLs inside text. They
never expose URL paths, queries, fragments or user information. Error responses
use fixed messages and bounded action receipts; renderer exception text is not
returned. Ordinary form values remain available outside a sensitive phase.

Call `task_sensitive` with `{taskId, action: "begin"}` before activation links,
credential navigation or manual sensitive input, or create a task with
`sensitive: true`. A password or `autocomplete="one-time-code"` fill enables the
same protection automatically. Other OTP controls require an explicit begin or
`sensitive: true` on the fill. Protection covers every page and frame in the task,
including delayed echoes, names, values, options, dialogs and downloads. Only
structural IDs, control types, booleans, counts and action receipts remain.
Screenshots are rejected before browser capture. Separate tasks are unaffected.

For secret input, a trusted local integration imports `stagePrivateInput` from
`private-input.mjs` and supplies a `readSecret` callback from its existing vault or
OTP flow. It validates the latest `taskId`, `pageId`, optional `frameId`,
`observationId`, `ref`, exact frame `origin` and `topOrigin` before reading the
value. Only the returned opaque `secretRef` goes to the agent:

```js
const staged = await stagePrivateInput({
  stateDir, taskId, pageId, frameId, observationId, ref, origin, topOrigin,
  readSecret: () => existingPrivateProvider.read()
})
// Agent tool arguments contain only this short-lived reference.
const action = { type: 'fill', ref, secretRef: staged.secretRef }
```

The callback runs locally; it is not an MCP tool or a CLI command. Do not put
secret values in tool arguments, shell commands, logs, or new files. References
expire after 60 seconds, bind the owning task and exact observed field/document,
and are consumed before delivery. Failed or uncertain delivery cannot be
replayed. A replacement node or changed origin requires new preparation.
Storage is memory-only; buffers are cleared on disposal, while transient
JavaScript strings remain garbage-collected. This protects the agent output
channel, not the destination website from receiving its authorized input.

Navigation, SPA changes and popup closure never end protection. Reach a known
safe **new document**, close other task pages and dialogs, then call
`task_sensitive` with `action: "end"`, the current `privacy.phaseId` and
`privacy.documentId`, exact `expectedOrigin`, and `safeToReveal: true`. This is an
explicit assertion about a safe destination, not a page-content classifier. The
result supplies fresh ordinary observation refs. History metadata and downloads
remain protected so ending a phase cannot reveal previously retained content.
The first protected observation establishes each new task page's document
baseline. Its initial document cannot be released; observe it while protected
before navigating to the safe destination.

### Ordinary manual profile sign-in

`request_human(showWindow: true)` shows the same task page but keeps the debugging
connection. Some identity providers, including Google, can reject sign-in in a
programmatically controlled browser. Showing that window does not establish
compatibility with a real account.

When the user requests initial sign-in, finish or cancel only your own completed
or abandoned tasks, then call `profile_login_start` with the authorized sign-in
URL and `userConfirmed: true`. The broker refuses while any client's task, action,
download or cleanup remains active. This mode requires a persistent profile with
`allowWeb: true` and no `allowedOrigins` restriction; ordinary manual browsing
cannot enforce the agent's request filter.

The automated browser exits, and an ordinary visible browser opens the same
dedicated agent profile without CDP, agent, headless or automation switches.
No personal profile is copied. The user controls this window; agents must not
inspect credentials or drive its login. `profile_login_status` reports only the
phase and whether the window is open. After the user closes it and explicitly
confirms completion, the initiating client calls `profile_login_finish` with its
current `loginId` and `userConfirmed: true`. Automation reconnects, and a new task
can use persistent sign-ins. Native window closure alone never resumes automation.
Keep the initiating MCP connection open; an administrator can recover its finish
operation if that client disconnects. Ordinary Show/Resume still supports manual
steps which need the exact existing page, transient form state or sessionStorage.

Profile sign-in restarts the browser and cannot preserve task pages or unfinished
forms. The broker keeps its endpoint, credentials and state lock during login;
client EOF or idle retirement cannot close the user's window. A private
`manual-profile.json` receipt blocks unattended startup after a crash. Ambiguous
process identity or an incomplete receipt requires explicit recovery; never delete
it merely to bypass the guard. This initial implementation verifies processes on
Windows. Do not claim Google or another provider accepted the account until the
user actually completes the real sign-in.

The Windows check keeps matching existing profile aliases across executables.
A missing directory belonging to a different browser is recorded as unresolved,
not mistaken for the manual Velmren window. Recovery still has to acquire the
native profile lock and initialize a fresh inherited CDP pipe before clearing the
receipt. If another browser owns that profile, startup fails and the receipt stays.
Missing Velmren paths, access failures and unknown process identities remain blocked.

If the original controller has stopped after the user closed the manual window,
an administrator can explicitly recover the recorded login using the same browser,
state directory and policy:

```sh
node profile-recovery.mjs --browser EXE --state-dir DIR --policy JSON --login-id ID --user-confirmed true
```

Use the current receipt's login ID and the user's actual confirmation. Recovery
refuses a live original controller, a changed profile/policy or incomplete process
identity. It preserves previous managed ownership files, checks closure again, and
reconnects automation before completing the receipt. Ordinary MCP startup never
performs this recovery automatically. Do not remove the receipt to make startup pass.

## Start locally

Run the following from this directory in PowerShell 7. `npm ci` installs the
pinned MCP SDK and its dependencies; it does not build Chromium.

```powershell
Set-Location E:/Astra/work/velmren-build/src/brave/tools/velmren-agent
npm ci
node broker.mjs --browser E:/Astra/work/velmren-build/src/out/Component/velmren.exe --state-dir .runtime --port 0
```

Keep the broker running. It writes `.runtime/connection.json` with the loopback
endpoint and credentials. A different `--state-dir` creates a separate local
prototype environment. The default policy permits only HTTP(S) loopback sites
(`localhost`, `127.0.0.1`, and `::1`).

For a disposable local page, run this in another terminal:

```powershell
node -e "require('node:http').createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(req.url.startsWith('/done')?'<h1>Completed</h1>':'<h1>Local agent test</h1><form action=/done><label>Name <input name=name></label><button>Continue</button></form>')}).listen(8787,'127.0.0.1')"
```

Then, in another terminal in this directory:

```powershell
node cli.mjs --state-dir .runtime --client scripts task_create '{"url":"http://127.0.0.1:8787/","label":"Local form check"}'
node cli.mjs --state-dir .runtime --client scripts task_list '{}'
node cli.mjs --state-dir .runtime dashboard
```

The last command prints a private dashboard URL. Open it yourself in a browser;
the CLI does not focus or launch a window. The admin credential is carried only
in the URL fragment, then removed from the address bar and held in page memory.
Reloading therefore requires reopening the original private link. Do not paste
the link or `connection.json` into reports, source control, or shared logs.

To allow a specific external test origin, save a policy file such as
`.runtime/policy.json`:

```json
{
  "allowedOrigins": ["https://example.com"],
  "maxTasks": 8,
  "maxActiveActions": 5
}
```

Pass it when starting the broker:

```powershell
node broker.mjs --browser E:/Astra/work/velmren-build/src/out/Component/velmren.exe --state-dir .runtime --policy .runtime/policy.json --port 0
```

Include the local test origin in that list if you also need the local fixture.
Use the origins needed for the actual task, including required redirect origins.
For ordinary authorized web tasks, `allowWeb: true` permits HTTP(S) origins and
`webCompatibility: true` enables popups, workers and JavaScript dialogs. An
explicit `allowedOrigins` list always takes precedence over `allowWeb`. A
running managed broker is reused only with the same effective policy.
WebSockets require the separate `webSocketPolicy: "csp-secure-upgrades"`
opt-in; the default is `"disabled"`. With an origin list, this permits the
corresponding `ws:`/`wss:` hosts and Chromium CSP's secure scheme/default-port
upgrades (`ws:80` to `wss:443`). It does not promise exact WebSocket scheme/port
matching. HTTP(S) navigation and requests still use the exact origin list.

## Connect an agent without changing global settings

Both clients launch the same stdio MCP server with their own `--client` value.
The server reads the running broker's descriptor; no credential belongs in the
MCP configuration. Start the broker before starting the agent client. MCP stdout
contains protocol messages only; startup failures go to stderr.

### Codex

The equivalent TOML entry is:

```toml
[mcp_servers.velmren]
command = "node"
args = ["E:/Astra/work/velmren-build/src/brave/tools/velmren-agent/mcp.mjs", "--state-dir", "E:/Astra/work/velmren-build/src/brave/tools/velmren-agent/.runtime", "--client", "codex"]
supports_parallel_tool_calls = true
required = true
```

For a test session, pass the entry on the command line instead of editing
`~/.codex/config.toml`:

```powershell
codex -c 'mcp_servers.velmren.command="node"' -c 'mcp_servers.velmren.args=["E:/Astra/work/velmren-build/src/brave/tools/velmren-agent/mcp.mjs","--state-dir","E:/Astra/work/velmren-build/src/brave/tools/velmren-agent/.runtime","--client","codex"]' -c 'mcp_servers.velmren.supports_parallel_tool_calls=true'
```

This adds the Velmren entry only for that process. Other pre-existing Codex MCP
entries are unaffected. Use `/mcp` to inspect the connection. The stdio
`command`/`args` format is documented in the
[official MCP configuration guide](https://learn.chatgpt.com/docs/extend/mcp#stdio-servers).
The installed CLI's `codex --help` describes process-only `-c` overrides.
Codex defaults `supports_parallel_tool_calls` to false. Without the explicit
setting it queues calls before they reach Velmren, even for independent tasks.
Velmren accepts concurrent calls through one connection, orders operations inside
each task, and limits simultaneous actions across tasks. See the
[Codex configuration reference](https://developers.openai.com/codex/config-reference/).

For a noninteractive test whose local form actions the user has authorized,
add `-c 'mcp_servers.velmren.default_tools_approval_mode="approve"'` to that
process. Without a scoped tool approval, `approval_policy="never"` can reject
an MCP write before it reaches the broker. This test setting does not authorize
unrelated websites or actions, and should not be added to global configuration.

### Claude Code

Save this JSON as `.runtime/claude-mcp.json`:

```json
{
  "mcpServers": {
    "velmren": {
      "type": "stdio",
      "command": "node",
      "args": [
        "E:/Astra/work/velmren-build/src/brave/tools/velmren-agent/mcp.mjs",
        "--state-dir",
        "E:/Astra/work/velmren-build/src/brave/tools/velmren-agent/.runtime",
        "--client",
        "claude"
      ]
    }
  }
}
```

```powershell
claude --strict-mcp-config --mcp-config .runtime/claude-mcp.json
```

This loads the test file without registering a global server; the strict flag
selects only its MCP configuration, subject to any managed policy. See the
[Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference) and
[MCP configuration documentation](https://code.claude.com/docs/en/mcp).

For either agent, a small test request is:

> Use only the Velmren tools for this browser task. Create a task at
> http://127.0.0.1:8787/ called Local form check. Observe the page, fill Name with
> Test User, and click Continue. Observe again, verify Completed, and finish the
> task. If human input is needed, request it and stop acting until resumed.

Keep each agent's normal permission controls. The adapter does not configure
model selection, approvals, or other tools.

## Task protocol

| MCP tool | CLI / RPC method | Arguments |
|---|---|---|
| `velmren_profile_login_start` | `profile_login_start` | authorized `url`, `userConfirmed: true`; all tasks must have ended |
| `velmren_profile_login_status` | `profile_login_status` | `{}`; does not inspect sign-in state |
| `velmren_profile_login_finish` | `profile_login_finish` | current `loginId`, `userConfirmed: true`; ordinary browser must be closed |
| `velmren_create_task` | `task_create` | `url`, optional `label` |
| `velmren_list_tasks` | `task_list` | `{}` |
| `velmren_observe` | `task_observe` | `taskId`, optional `query`, `offset`, `limit`, `textOffset`, `textLimit` |
| `velmren_act` | `task_act` | `taskId`, `observationId`, `actions` |
| `velmren_upload_files` | `task_upload_files` | `taskId`, `observationId`, `files`, exactly one `ref` or `chooserId`, optional `pageId` |
| `velmren_navigate` | `task_navigate` | `taskId`, `url` |
| `velmren_wait` | `task_wait` | `taskId`, exactly one `text` or `predicate`, optional `timeoutMs` (1–15000) |
| `velmren_screenshot` | `task_screenshot` | `taskId` |
| `velmren_list_pages` | `task_list_pages` | `taskId` |
| `velmren_list_frames` | `task_list_frames` | `taskId`, optional `pageId` |
| `velmren_list_options` | `task_list_options` | `taskId`, `observationId`, select `ref`, optional `query`, `offset`, `limit` |
| `velmren_select_page` | `task_select_page` | `taskId`, `pageId` |
| `velmren_close_page` | `task_close_page` | `taskId`, `pageId` |
| `velmren_handle_dialog` | `task_handle_dialog` | `taskId`, `accept`, optional `pageId`, `promptText` |
| `velmren_request_human` | `task_request_human` | `taskId`, `reason`, optional `pageId`, `showWindow` |
| `velmren_resume` | `task_resume` | `taskId`, current `handoffId`, `userConfirmed: true` |
| `velmren_finish` | `task_finish` | `taskId` |
| `velmren_cancel` | `task_cancel` | `taskId` |

Observe returns page text, `observationId`, and element refs. Use those refs in
small action batches; after navigation, page changes, or a stale-observation
error, observe again. Actions are `fill` (`ref`, `value`), `click` (`ref`),
`select` (`ref`, exact option `value`), `setChecked` (`ref`, boolean `checked`),
or `press` (`key`, optional `ref`). Empty
fill values clear a field. The adapter accepts at most 20 actions in a batch;
the broker also applies its own checks.

Observations include `complete`, `truncated`, `limits`, `counts`, and explicit
frame `coverage`. A response includes at most 150 elements and 10000 visible-text
characters. Use `query` to find controls by name, or follow
`pagination.nextOffset` in a subsequent observation. For text, use
`textPagination.nextOffset` as `textOffset`. Every observation replaces that
frame's previous refs, including when changing the query or offset.
Discovery includes explicit keyboard/click semantics and bounded visible pointer
surfaces, including icon controls. Native submit/button values participate in
names and queries. A custom checkable card can supply its sole native control's
name and visible activation surface; disabled, obscured, origin and post-action
state checks still apply. These heuristics do not guarantee every custom widget.
Initial select previews contain at most 50 options and may shorten values.
Use `list_options` to search labels/values or follow its `pagination.nextOffset`.
This read preserves the observation ID and returns complete selectable values;
never act on a value marked incomplete. A list larger than one response can be
read to the end without increasing the response limits.
Open shadow roots are included automatically. Closed shadow roots are excluded.
Use `list_frames` to discover ordinary child forms, then pass their `frameId`
to observe, act, wait, list_options or upload_files. Frame IDs and observations
remain bound to the owning page and task; frame navigation invalidates old refs.
The same network policy applies to main and child frames.
Each element's `availableActions` comes from the action validator. `uploadFiles`
means use the separate upload tool; it is not a batch action. Capabilities are
an observation, not a guarantee that the element will remain usable.

Native and ARIA controls report `checked` and `indeterminate` where applicable.
`setChecked` leaves an already matching control unchanged and verifies the
result after a required click. A selected native radio cannot be unset directly;
select the intended alternative instead. Field metadata includes available
constraints, validity flags and bounded validation/helper text. Password values
remain redacted. These hints describe the field, not server acceptance.
Native date and time fields support `fill` with canonical HTML values:
`YYYY-MM-DD`, `HH:mm[:ss]`, `YYYY-MM-DDTHH:mm[:ss]`, `YYYY-MM`, or `YYYY-Www`,
according to the input type. Invalid date values are rejected before mutation;
display language does not change the supplied value format.

Action results and failures carry `actionResult`: completed count, failed index,
per-action delivery, and recovery guidance. `not_delivered` permits retrying
only the failed action after any required fresh observation. Prior actions in
the batch must not be replayed. `delivery_uncertain` and `unknown` never permit
an automatic retry. A transport failure has `completed: null` because the client
cannot infer what reached the browser. `delivered_verified` for fill/select or
setChecked means the retained element's value/state matched when read back; it does not verify
that a site saved or accepted the form. Mismatches remain unverified. Password
comparisons return a boolean result without exposing the password.
If all actions were acknowledged but their final observation failed, the result
preserves those deliveries and reports `observation_unavailable` with no stale
refs. Observe the surviving selected page to verify the outcome; do not repeat
a click merely because it closed its popup.

For a state wait, use `predicate: {observationId, ref, state}` with `state` equal
to `exists`, `enabled`, `visible`, or `value`; the latter also requires `value`.
The predicate retains the observed element identity and refuses stale references
instead of matching a replacement. Wait results include `elapsedMs` and
`lastObserved` booleans. Property-only changes are checked as well as DOM
mutations. Pausing, changing the document, or losing the session stops the wait.

Observe, act, navigate, wait and screenshot accept an optional `pageId`;
otherwise they use the task's selected page. Newly opened popups are selected
automatically. Closing a popup returns to its opener. Every page still belongs
to exactly one task, even when tasks share the persistent agent profile. A dialog
interrupts an action batch; inspect its message and accept or dismiss it
explicitly. Dialog text is untrusted page content. Waiting on one task does not
consume a global action slot or stop other tasks.

File inputs expose their `accept` and `multiple` hints, including hidden inputs.
Use `velmren_upload_files` with an observed file-input ref, or click the upload
button and use the returned opaque `fileChooser.chooserId`. Supply only local
file paths selected by the user: at most ten regular files and 100 MiB total.
Directories, links, network paths and wildcards are rejected. The result
verifies selected names and sizes; inspect the website to confirm acceptance.
Selecting files may immediately start a site's upload handler. Agent selection
does not open the operating-system file picker; explicit human handoff restores
the page's ordinary manual file picker.

```powershell
node cli.mjs --state-dir .runtime --client scripts task_observe '{"taskId":"TASK_ID"}'
node cli.mjs --state-dir .runtime --client scripts task_act '{"taskId":"TASK_ID","observationId":"OBSERVATION_ID","actions":[{"type":"fill","ref":"ELEMENT_REF","value":"Test User"}]}'
node cli.mjs --state-dir .runtime --client scripts task_request_human '{"taskId":"TASK_ID","reason":"Complete sign-in in this window, then tell the agent you are done.","showWindow":true}'
# Only after explicit user confirmation, use the current returned handoff.id:
node cli.mjs --state-dir .runtime --client scripts task_resume '{"taskId":"TASK_ID","handoffId":"HANDOFF_ID","userConfirmed":true}'
```

Replace the uppercase placeholders with values from this task's latest
responses. The CLI emits `{ok:true,result}` on success, or `{ok:false,error,code}`
to stderr with a nonzero exit status. It never retries actions automatically.
Errors also preserve sanitized `actionResult` and `waitResult` when available.
`diagnostic` adds an enumerated `reason` and `phase`; navigation failures may also
carry an allowlisted `networkError`. No raw browser/site exception, field value,
or URL is included. Validated task/page/frame IDs identify the owned context;
a failed create can return its already-cancelled task ID for inspection. A failed
readback or final observation keeps acknowledged delivery and adds its diagnostic.
After an interrupted request, inspect the task before retrying a mutation.
An initial `CONNECTION_ERROR` permits a new protocol check on the next explicit
client call. It never replays the interrupted operation. Incompatible protocols
remain rejected.
Public text and metadata keys reduce literal and encoded URLs to origins.
Validated PNG image payloads remain byte-identical; sensitive phases still
suppress screenshots and page text.
The MCP screenshot tool returns an image content block; the CLI returns the PNG
as base64 JSON. `node cli.mjs --state-dir .runtime --client codex mcp` is an
alternate stdio entry point.

## Human control panel

The panel is for the local operator. Agent task creation and routine actions
stay in the background. The main paths are reviewing active work, answering a
human-help request, and returning a task to the agent.

- **Observe** reads page text and controls into the inspector. **Capture
  screenshot** requests a single image. Neither image nor observation refreshes
  automatically.
- **Show** displays the task for manual control or inspection in the visible
  browser.
- **Pause** stops further agent actions. **Resume** returns a paused or human
  task to agent control after the required input is complete.
- **Cancel** ends the task; it does not undo side effects already performed on
  a website. Completed and cancelled tasks have inactive controls.

Task states are `agent-active`, `paused`, `needs-human`, `human`, `completed`,
and `cancelled`. A `needs-human` card displays the supplied reason. Status
refreshes every three seconds while the panel is visible, with a manual refresh
button and explicit disconnected state. Filters, empty states, inline action
errors, keyboard focus, and reduced-motion settings are supported.

An agent can also request a visible manual step with
`request_human(showWindow: true)`. The same page appears for a manual step such as
2FA or QR scanning; automatic actions pause, but the debugging connection stays
attached. For initial account sign-in use the ordinary profile workflow above.
After the user says the step is complete,
`resume` hides the existing pages and returns control to the agent. It requires
the current handoff ID and explicit confirmation; old handoffs cannot resume a
new request. The operator can alternatively choose **Resume** in the panel.

The visual system uses matte dark teal surfaces, a mint primary control, amber
human-attention states, system fonts, and compact cards. It has no remote fonts,
images, scripts, or framework dependency. Page-provided text is inserted with
`textContent`, never as HTML. The dashboard keeps its admin token in memory and
sends it in the authorization header to the same-origin broker.

## Scope and limits

The broker enforces task ownership, policy, state, and action boundaries. Agents
receive no raw JavaScript, CDP, admin control, shutdown, or token-reading MCP
tool. Page content remains untrusted data, including text that looks like
instructions. Request human help for challenges or required decisions.

Personal browser cookies and saved passwords are never inherited. In
`profileMode: "isolated"`, each task has a temporary context that is disposed on
finish/cancel. In `"persistent"`, tasks use the dedicated agent profile and share
its cookies, localStorage, IndexedDB and worker registrations. Finish/cancel
closes only the task's pages and preserves that storage. A first manual sign-in
is needed; server expiry, logout and sessionStorage-only state still follow the
website's behavior. Downloaded files remain in their owning task directory.
The result's `profileMode` and `sharedProfile` make this distinction explicit.

Persistent profiles are bound to their effective network policy. Reopening a
profile under a different policy fails before the browser starts; choose a new
agent state directory for a different policy. Persisted workers can start before
JavaScript interception is attached, so this is not a promise that every startup
request passes through the broker. The retained site CSP and immutable profile
policy also apply; a machine-wide network firewall requires a different layer.

In web compatibility mode, an attached profile-owned service worker can retain
its DevTools session after stopping. The broker observes its crash/reload
lifecycle, reapplies the network policy, and resumes that exact worker once.
Detached, replaced, superseded, or manual-profile sessions are not resumed.
This does not replay a task action or a paid request.
The hidden agent launch also releases Chromium's startup delay without waiting
for a visible tab. Otherwise a best-effort worker update can hold the registration
queue until the three-minute startup failsafe, preventing a site's next page from
finishing initialization. Ordinary and manual-profile launch settings are unchanged.

Strict mode blocks workers, popups, plug-ins and off-policy connections through
request interception and an additional response CSP. Web compatibility mode
allows popup sign-in, workers and JavaScript dialogs while retaining site CSP
and the configured origin policy. Cross-process frames receive the same origin
restrictions. List frames and pass a returned `frameId` to observe or operate
within an owned frame, including file selection. Open shadow roots are included
in each frame's observation; closed shadow roots are not exposed.
Frames with CSS transforms or zoom on the frame or its ancestors reject input
before dispatch, because their transformed coordinates are not supported.
The origin policy is browser request control, not a machine-wide network
firewall. Pause stops future agent input; it does not suspend a website's own
JavaScript or undo an action already dispatched.

The API boundary is not an operating-system security sandbox: programs already
running as the same OS user can read the descriptor file and local browser data.
Protect the state directory accordingly. Stdio clients can show and resume their
own task for a human handoff; they cannot take over another client's task.
Shared profile storage is not a hostile-site isolation boundary. Broker shutdown
or restart preserves persistent profile data but not in-progress task execution.

## Files and verification

| File | Role |
|---|---|
| `broker.mjs`, `runtime.mjs` | Local HTTP service, page ownership, browser lifecycle and policy |
| `cdp.mjs`, `page.mjs`, `frames.mjs` | Internal browser transport and owned page/frame operations |
| `form-controls.mjs`, `document-observation.mjs` | Form state, validation, native values and paginated shadow-aware observations |
| `client.mjs` | Descriptor loading, argument boundary, authenticated RPC |
| `action-result.mjs`, `trace.mjs` | Delivery/error contracts and bounded metadata-only request diagnostics |
| `mcp.mjs`, `handoff.mjs` | Eighteen task tools and explicit manual handoff over MCP |
| `managed-*.mjs`, `policy-identity.mjs`, `Start-VelmrenMcp.ps1` | Shared broker startup, scoped leases and signed installation resolution |
| `cli.mjs` | Script client and private dashboard-link command |
| `public/` | Local operator dashboard |
| `test/adapters.test.mjs` | Mock-broker HTTP, CLI, and real MCP stdio tests |

```powershell
node --test test/adapters.test.mjs
npm test
node test/integration.mjs E:/Astra/work/velmren-build/src/out/Component/velmren.exe E:/Astra/work/velmren-build/qa/agent-integration-new
node test/multi-agent-web-integration.mjs E:/Astra/work/velmren-build/src/out/Component/velmren.exe E:/Astra/work/velmren-build/qa/agent-five-clients-new
node test/upload-integration.mjs E:/Astra/work/velmren-build/src/out/Component/velmren.exe E:/Astra/work/velmren-build/qa/agent-uploads-new
node test/ergonomics-integration.mjs E:/Astra/work/velmren-build/src/out/Component/velmren.exe E:/Astra/work/velmren-build/qa/agent-contracts-new
```

The integration run normally shows a temporary task window for handoff. Add
`--background-only` when the desktop is in use, or `--headless` to exercise
the handoff protocol without a visible window. Add `--lifecycle-soak` for a
90-second check after task cleanup; `--soak-seconds=300` extends it to five
minutes. The soak verifies that the same browser can create another task after
Chromium's delayed profile cleanup. Hidden targets must be closed before their
isolated browser context is disposed.

The adapter suite checks wire arguments, selected credentials, ownership-error
propagation, narrow action inputs, loopback descriptor checks, refused redirects,
CLI output, stdio discovery, two independent MCP clients, and PNG image results.
It uses a mock broker; actual native-browser behavior and end-to-end Codex/Claude
execution need the separate integration check with the running browser.

The broker keeps `requests.jsonl` and one rotated `requests.1.jsonl` in its
private state directory, at most 1 MiB each. Records contain owned IDs, request
method, queue/duration timings, outcome, and sanitized action metadata. They omit
arguments, URLs, field values, file paths, page text, credentials, and screenshots.
The pending queue is bounded; excess records are dropped and a logging failure
does not fail or repeat an action. Close the broker before collecting the final
trace so accepted records have been flushed.
