# External ACP agents

For users who want the main Pi session to delegate work to Codeg's 15 built-in ACP coding agents. This feature is opt-in, uses stable ACP v1 through the official `@agentclientprotocol/sdk`, and does not change the existing user-defined Pi `Agent` tool. Launch pins match Codeg `get_agent_meta`; native CLI/config reuse is applied for those agents.

## Enable and approve an agent

1. Open `/agents → Settings → External ACP agents` and set it to `on`. This is a machine-wide switch (`<agentDir>/subagents.json`); a project file cannot override it.
2. Open `/agents → External ACP agents → Approve agent`.
3. Pick from Codeg's 15 built-in ACP agents (the same pins as Codeg `get_agent_meta`). Filter in that list. There is no official ACP Registry catalog or refresh.
4. Confirm the version, source, exact command, and the derived `@acp-*` handle.
5. The agent is available in the current session as `@acp-<id>` (Codex is `@acp-codex`). Kimi is `@acp-kimi-code` and reuses `~/.kimi-code` credentials. Official Registry `kimi` (kimi-cli) is not offered.

The master switch is `acpEnabled` in `<agentDir>/subagents.json` and defaults to `false`. Launch approvals are deliberately separate and machine-local:

```text
<agentDir>/acp-agents.json
```

Project configuration cannot supply or override an executable, arguments or environment. The approve list is the Codeg builtin catalog, not the official ACP Registry.

`npx` commands use `--prefix <agentDir>` so they do not inherit a project's `package.json` or `.npmrc`, and the `npx`/`uvx` binaries themselves are resolved from PATH (never the project cwd). The catalog has no `uvx` entries. Binary pins are streamed on approval into `<agentDir>/acp-binaries/<registryId>/<version-hash>/` with a 1 GiB cap, SHA-256 verified only when that pin supplies a digest (Codeg binary pins currently do not), extracted without archive links/symlinks, and approved as an exact absolute command. Installer formats such as `.dmg`, `.deb`, `.rpm` and `.msi` are rejected. Missing SHA-256 is shown in the approval prompt.

## Security and permissions

Enabling ACP agents starts local processes under the same OS user as Pi. Only exact machine-approved commands may start.

Permission policy is **YOLO**:

1. choose `allow_always` when the ACP request offers it;
2. otherwise choose `allow_once`;
3. fail the attempt when no allow option exists.

The client does not advertise ACP `fs/*`, `terminal/*` or elicitation capabilities. External agents use their own file and command tools. Their capabilities are not constrained by Pi Agent `tools:`, `extensions:` or `isolated:` configuration.

Authentication reuses the agent/adapter's existing CLI login. Pi-subagents does not collect or store provider credentials and does not advertise ACP terminal-auth capability. Kimi Code preserves a real `~/.kimi-code/credentials/kimi-code.json` login. Its local ACP gate token is created only when `config.toml` or `KIMI_MODEL_API_KEY` contains a non-empty API key; OAuth configurations with an empty `api_key` must have a real access/refresh token and remove any synthetic token previously written by this extension. Native `settings.json` `env` string values are projected only into the launched child for Claude (`claude-acp`; `~/.claude` or `CLAUDE_CONFIG_DIR`), Gemini (`gemini`; `$GEMINI_CLI_HOME/.gemini` or `~/.gemini`) and Qwen (`qwen-code`; `$QWEN_HOME` or `~/.qwen`); approved static env still wins. The catalog pin is `qoder-cli`, not `qwen-code`, so that Qwen projection does not apply to Qoder.

Codex ACP otherwise ignores `~/.codex/config.toml` sandbox/approval for ordinary turns. The launch sets `DISABLE_MCP_CONFIG_FILTERING=true` and, when those keys are present, `INITIAL_AGENT_MODE` (`read-only` / `agent` / `agent-full-access`) so a `danger-full-access` + `never` config can use the network. Grok gets `--no-auto-update` and a non-default `[ui].permission_mode` as `--permission-mode` before `agent stdio`. Cursor gets `--force` / `--model` from `CURSOR_FORCE` / `CURSOR_MODEL` when set. `npx --prefix` is launch-only; `npm_config_prefix` is stripped from the child unless the approval stored it. If an attempt reports authentication required, the error lists the methods the agent actually advertised. Verify the corresponding CLI can complete a non-interactive prompt, then log in again if needed.

## `AcpAgent` tool

`AcpAgent` is registered only when the feature is on and at least one approval is enabled. It always runs in the background. Once the process attempt is registered, the tool returns a launch receipt and terminates an all-ACP tool batch instead of spending another main-model round trip saying that delegation started. Completion notifications trigger the later result-processing turn.

```text
AcpAgent({
  agent: "codex-acp",
  prompt: "Review the current authentication changes. Return Markdown findings.",
  description: "Review auth changes",
})
```

Continue an existing conversation:

```text
AcpAgent({
  resume: "acp-codex",
  prompt: "Now verify the tests covering the highest-severity finding.",
  description: "Verify auth tests",
})
```

Parameters:

| Field | Meaning |
|---|---|
| `agent` | Approved Codeg builtin id for a fresh conversation; mutually exclusive with `resume` |
| `resume` | ACP attempt id or `@acp-*` conversation handle; mutually exclusive with `agent` |
| `prompt` | Complete prompt for the sub-agent (goal, background, paths, constraints, what to return) |
| `description` | Short Widget/notification label |
| `cwd` | Absolute fresh-conversation working directory; defaults to the main Pi cwd |

The tool has no foreground mode, model/thinking override, Pi tools/skills/extensions configuration, scheduling, nesting, inheritance, or worktree isolation.

The returned attempt id is immutable. `get_subagent_result` by id always reads that attempt. A conversation handle resolves to the active/queued attempt, otherwise its latest settled attempt.

## `@acp-*` mentions

Approved agents appear in the normal `@` autocomplete with an `acp-` prefix:

```text
@acp-codex review this diff
```

ACP mentions stay in the main model turn. `@acp-codex` names the approved agent type and always starts a fresh conversation, matching Codeg's `@agent` routing. Continuation uses explicit `AcpAgent(resume=...)` or `steer_subagent` on a running attempt, not a second `@` mention. Routing only binds the channel: call `AcpAgent` once per distinct target. What to put in `prompt` comes from the tool schema — the sub-agent cannot see this conversation, so the coordinator spells out the goal, background, paths, constraints, and what to return.

Inline fan-out is supported:

```text
Ask @acp-claude to implement the fix and @acp-codex to review it.
```

Repeated mentions of the same handle require one call. If the main model omits a required target, the extension shows a warning and records a TUI-only `subagents:acp-route-miss` entry; it does not silently broadcast the original text.

The `acp-` handle namespace belongs to external conversations while the feature is active. A colliding user-defined Pi Agent receives a numbered Pi handle instead and remains callable through the ordinary `Agent` tool.

## Prompt queue and continuation

ACP v1 has no universal mid-turn steering. A message sent to a running ACP conversation becomes a new queued attempt:

```text
steer_subagent({ agent_id: "acp-codex", message: "Also check the RPC path." })
```

Each queued prompt gets its own attempt id, record, result artifact and completion notification. Attempts run FIFO, one `session/prompt` at a time per conversation. A saturated background pool returns a queued id immediately and does not claim that ACP initialization has completed.

Within the same Pi session, the extension persists the ACP session id and resumes with `session/resume` when available, falling back to `session/load`. Agents supporting neither remain continuable only while their process is alive. `/new`, fork and clone cannot take ownership of another Pi session's conversation because persisted references are bound to the exact root session id.

Idle ACP processes are disconnected after 3 minutes with no activity and no in-flight or queued turn, matching Codeg's connection sweep. The conversation record stays so a later `resume` can restart the process. Set `PI_SUBAGENTS_ACP_IDLE_TIMEOUT_SECS` to change the threshold, or `0` to disable.

## Working directory and parallel writes

ACP agents run in the current or explicitly supplied `cwd`. Pi-subagents does not create worktrees for ACP agents.

Multiple external agents may run concurrently and can modify the same files through their own tools. The extension cannot serialize or sandbox those writes. Give concurrent agents read-only or non-overlapping responsibilities, or create separate directories/worktrees yourself and pass their absolute paths through `cwd`.

Existing Pi Agent `isolation: "worktree"` behavior is unchanged.

## UI and results

ACP attempts appear in the existing Agents Widget with bounded text/tool activity and use the ordinary completion notification. Opening an ACP row from FleetView or `/agents` shows a live overlay of the attempt output. Enter queues a follow-up; `x` stops the attempt. ACP attempts do not write Pi-format `.output` conversation transcripts; result body persistence follows the existing `outputTranscript` policy. Read the final result with `get_subagent_result`.

Lifecycle events reuse the top-level subagent channels. ACP attempts add `runtime: "acp"`, `conversationId`, `handle` and `registryId` where applicable. Cross-extension `subagents:rpc:spawn` remains Pi-agent-only.

## Failure behavior

| Failure | Behavior |
|---|---|
| Feature off or no enabled approvals | `AcpAgent` is absent/inactive and no ACP mentions are offered |
| Command missing or exits during startup | The background attempt fails with command/process error and bounded stderr; its notification wakes the main model like an ordinary background subagent result |
| ACP stdout is not valid NDJSON | Protocol error; stdout is not treated as terminal prose |
| Agent selects another protocol version | Startup fails; no v2 fallback |
| Agent returns `end_turn` without output | Attempt fails instead of being reported as completed. The error includes a structured prompt-response failure when supplied, otherwise bounded/redacted stderr from this turn (or recent stderr), plus an agent diagnostic adapter when the ACP wire hides the underlying failure |
| Authentication missing | The background attempt reports a CLI-login instruction and advertised method ids; no credentials are stored, and the notification wakes the main model to report or handle the failure |
| Binary archive missing SHA-256 | Approval still proceeds after an explicit warning; the downloaded bytes are hashed only when the pin supplies a digest |
| Binary archive contains links or unsupported formats | Install fails before the approval is saved |
| Permission has no allow option | Attempt fails instead of choosing reject and pretending success |
| `session/resume`/`session/load` unsupported | Persisted conversation is not silently replaced by a fresh one |
| Process ignores cancellation | Connection closes, then the extension terminates its owned process tree |
| Approval removed/disabled | New starts and follow-ups fail; the current running turn may finish or be stopped |

## Limitations

- ACP v1 only; no experimental v2 behavior.
- Only Codeg's 15 builtin pins can be approved. Codex ACP 1.10.0 and Claude Agent ACP 0.75.1 are the approved pins and match live smoke. Other catalog entries remain untested against live models.
- Binary installs are version-locked at approval time; a later pin change requires a new approval. Automatic uninstall/update is not provided.
- No ACP terminal login UI, client filesystem, elicitation, rich diff or complete transcript UI.
- No ACP agents from `TaskExecute`, `SubagentWorkflow`, schedules, nested agents or cross-extension RPC.
- No external-agent recursive delegation through this extension.
