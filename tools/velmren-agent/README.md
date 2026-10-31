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
  "maxActiveActions": 2
}
```

Pass it when starting the broker:

```powershell
node broker.mjs --browser E:/Astra/work/velmren-build/src/out/Component/velmren.exe --state-dir .runtime --policy .runtime/policy.json --port 0
```

Include the local test origin in that list if you also need the local fixture.
Use the origins needed for the actual task, including required redirect origins.

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
```

For a test session, pass the entry on the command line instead of editing
`~/.codex/config.toml`:

```powershell
codex -c 'mcp_servers.velmren.command="node"' -c 'mcp_servers.velmren.args=["E:/Astra/work/velmren-build/src/brave/tools/velmren-agent/mcp.mjs","--state-dir","E:/Astra/work/velmren-build/src/brave/tools/velmren-agent/.runtime","--client","codex"]'
```

This adds the Velmren entry only for that process. Other pre-existing Codex MCP
entries are unaffected. Use `/mcp` to inspect the connection. The stdio
`command`/`args` format is documented in the
[official MCP configuration guide](https://learn.chatgpt.com/docs/extend/mcp#stdio-servers).
The installed CLI's `codex --help` describes process-only `-c` overrides.

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
| `velmren_create_task` | `task_create` | `url`, optional `label` |
| `velmren_list_tasks` | `task_list` | `{}` |
| `velmren_observe` | `task_observe` | `taskId` |
| `velmren_act` | `task_act` | `taskId`, `observationId`, `actions` |
| `velmren_navigate` | `task_navigate` | `taskId`, `url` |
| `velmren_wait` | `task_wait` | `taskId`, `text`, optional `timeoutMs` (1–15000) |
| `velmren_screenshot` | `task_screenshot` | `taskId` |
| `velmren_request_human` | `task_request_human` | `taskId`, `reason` |
| `velmren_finish` | `task_finish` | `taskId` |
| `velmren_cancel` | `task_cancel` | `taskId` |

Observe returns page text, `observationId`, and element refs. Use those refs in
small action batches; after navigation, page changes, or a stale-observation
error, observe again. Actions are `fill` (`ref`, `value`), `click` (`ref`),
`select` (`ref`, exact option `value`), or `press` (`key`, optional `ref`). Empty
fill values clear a field. The adapter accepts at most 20 actions in a batch;
the broker also applies its own checks.

```powershell
node cli.mjs --state-dir .runtime --client scripts task_observe '{"taskId":"TASK_ID"}'
node cli.mjs --state-dir .runtime --client scripts task_act '{"taskId":"TASK_ID","observationId":"OBSERVATION_ID","actions":[{"type":"fill","ref":"ELEMENT_REF","value":"Test User"}]}'
node cli.mjs --state-dir .runtime --client scripts task_request_human '{"taskId":"TASK_ID","reason":"Complete the login in this task, then choose Resume."}'
```

Replace the uppercase placeholders with values from this task's latest
responses. The CLI emits `{ok:true,result}` on success, or `{ok:false,error,code}`
to stderr with a nonzero exit status. It never retries actions automatically.
After an interrupted request, inspect the task before retrying a mutation.
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
- **Show** displays the task for manual control. Use it for login, MFA, CAPTCHA,
  or inspection that requires the visible browser.
- **Pause** stops further agent actions. **Resume** returns a paused or human
  task to agent control after the required input is complete.
- **Cancel** ends the task; it does not undo side effects already performed on
  a website. Completed and cancelled tasks have inactive controls.

Task states are `agent-active`, `paused`, `needs-human`, `human`, `completed`,
and `cancelled`. A `needs-human` card displays the supplied reason. Status
refreshes every three seconds while the panel is visible, with a manual refresh
button and explicit disconnected state. Filters, empty states, inline action
errors, keyboard focus, and reduced-motion settings are supported.

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

Each task uses a separate temporary browser context, so personal browser
cookies and saved passwords are not inherited. Showing a task preserves its
document and its temporary context. Finishing or cancelling destroys that
context; downloaded files remain in its task directory.

This first prototype blocks workers, popups, plug-ins, and off-policy
connections through request interception and an additional response CSP.
Cross-process frames receive the same restrictions, but element observations
and actions currently cover the main document only. Sites that require workers,
popup sign-in, or cross-frame interaction may therefore need a later extension.
The origin policy is browser request control, not a machine-wide network
firewall. Pause stops future agent input; it does not suspend a website's own
JavaScript or undo an action already dispatched.

The API boundary is not an operating-system security sandbox: programs already
running as the same OS user can read the descriptor file and local browser data.
Protect the state directory accordingly. Stdio clients cannot show, resume, or
take over each other's tasks through the exposed task API. Broker shutdown or
restart is not a durable task-resume mechanism.

## Files and verification

| File | Role |
|---|---|
| `broker.mjs` | Local HTTP service, browser lifecycle, ownership and policy |
| `cdp.mjs`, `page.mjs` | Internal browser transport and page operations |
| `client.mjs` | Descriptor loading, argument boundary, authenticated RPC |
| `mcp.mjs` | Ten task tools over the official MCP SDK stdio transport |
| `cli.mjs` | Script client and private dashboard-link command |
| `public/` | Local operator dashboard |
| `test/adapters.test.mjs` | Mock-broker HTTP, CLI, and real MCP stdio tests |

```powershell
node --test test/adapters.test.mjs
npm test
node test/integration.mjs E:/Astra/work/velmren-build/src/out/Component/velmren.exe E:/Astra/work/velmren-build/qa/agent-integration-new
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
