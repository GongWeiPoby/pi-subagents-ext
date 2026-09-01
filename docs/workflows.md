# Scripted workflows

For users who explicitly need deterministic JavaScript orchestration: loops, parallel fan-out, pipelines, retries, shell gates, or named composition. This guide covers `SubagentWorkflow`, its runtime, approval and status surfaces, and saved `.js` workflows.

For reusable natural-language guidance that the main coordinator adapts with ordinary tools, skills, and `Agent` calls, see [Adaptive workflow Playbooks](playbooks.md). A Playbook is Markdown guidance, not a script and not an automatic invocation of this tool.

## What a workflow is

`SubagentWorkflow` runs a JavaScript program that coordinates many subagents. The script can discover a list through one child, loop over it, branch on text results, pipeline items through stages, retry a child, run shell gates, or compose a saved script. The script itself has no filesystem, network, or module access; all real work happens in its child agents or in host-provided gates.

Use the ordinary `Agent` tool for one delegated task or a small set of calls the main coordinator can choose directly. Use `SubagentWorkflow` only when the user explicitly asks for deterministic scripted control flow or a named JavaScript workflow. A Playbook may suggest a script when that is appropriate, but Markdown guidance never silently becomes generated JavaScript.

Every `agent()` child returns final text or Markdown. The script may deterministically return any JSON-shaped value, including an object, array, status, or path assembled from those text results. `agent({ schema })` is rejected; see [Migration](#migration). There is no structured child-result channel.

## Lifecycle

### 1. Ask for an explicit workflow

There is no `/workflows` command. Ask the main model to use `SubagentWorkflow`, provide an inline script, point at a script path, or name a saved `.js` workflow. The model writes the script when the user asks for scripted orchestration; it should not use this tool merely because a Playbook was read.

A direct invocation supplies exactly one of `script`, `scriptPath`, or `name`, except that `resumeFromRunId` may reuse the previous run's source. In a UI, every direct source and exact resume is shown in the current approval preview and requires direct confirmation. Headless direct calls proceed under the automation caller's trust boundary.

The approval preview is exact for the statically disclosed behavior. A bordered, larger fixed-height custom dialog keeps `Cancel` and `Approve` visible while the current view scrolls. The summary contains the goal, static call-site tree, runtime branch uncertainty, and repeated gate/worktree impact. Press `d` to switch to the independently scrollable technical appendix with complete prompts and literal options, then `d` again to return. Static `parallel()` and `pipeline()` structure is shown; arbitrary loops and branches are described as potentially changing call count or order rather than being presented as guaranteed execution.

UI-confirmed direct scripts are refused when the preview cannot faithfully disclose behavior: injected globals are aliased or indirectly called, local declarations shadow them, agent arguments use spreads or dynamic/computed/shorthand option keys, options are not literal objects, or behavior-affecting values are dynamic. Rewrite the script with direct injected-global calls and literal option objects. Parse failures also fail closed in the UI. These preview checks do not apply to headless automation. User prose, workflow names, and risk words never count as approval.

`SubagentWorkflow` can also be started by the explicit `--subagents-workflow-file=<path>` CLI flag. The flag is a trusted, user-selected startup automation boundary: it starts the script without opening the tool approval dialog.

### 2. Read what came back

The tool returns a workflow task ID immediately. The run continues in the background, updates its live card, and sends the normal completion notification when the owning parent session is ready. Use `TaskOutput` with the returned `wf_*` ID to inspect or join it:

```text
SubagentWorkflow started in the background.
Task ID: wf_9f3ab21c04de
Script: <session task path>/<run id>.workflow.js

You will be notified when it finishes — do NOT poll or sleep waiting for it.
```

`TaskOutput({ task_id, block: false })` reports current state and counts. `block: true` waits event-first until settlement, timeout, abort, or session change. A timeout or abort does not consume the future notification. Returning settled workflow output consumes its held notification so it is not delivered twice.

The inline script is persisted in the session task directory so the model can edit and re-run it. It is scratch storage and may disappear with a reboot or temp cleanup. A named workflow reports its durable source path instead.

### 3. Watch the run

The inline workflow card shows the controller, dynamic child total, phases, child statuses, labels, effective model, turns, tool uses, tokens, and bounded current output:

```text
▸ SubagentWorkflow  auth-audit                3/7 agents so far · 1m12s
  Find routes missing auth checks, then verify each finding
  ╭─ Scan
  │ └─ ✓ discover        · Explore · ↻2 · 8 tool uses · 26.4k token · 25.0s
  ╰─ Audit
    ├─ ✓ audit:src/a.ts  · Explore · ↻3 · 12 tool uses · 18.4k token · 42.0s
    ├─ ⟳ audit:src/b.ts  · Explore · ↻2 · 8 tool uses · 21.0s
    │    ⎿  inspecting route guards…
    └─ ⟳ audit:src/c.ts
  ⎿  auditing 6 route files
```

The total says `agents so far` while running or paused because deterministic loops and branches can discover later children. Settled totals are final. The default workflow concurrency is 2, independent of the session background and foreground pools; excess child calls queue inside the workflow.

The above-editor Agents widget puts workflow controllers before ordinary agents and renders workflow → phase → child trees under one 12-line budget. Live children reuse ordinary Agent status and activity wording, including model wait, active tools, responding output, positive `↻N` turns, context/compaction information when available, and bounded streaming output. A live child uses the ordinary two-line header plus `⎿` activity/output shape; terminal children use one row. Workflow and phase animation uses the shared 80 ms braille language. Paused workflow roots use `‖`; paused time is excluded from elapsed time. Finished workflows linger briefly.

FleetView renders the same workflow controller and tree below the editor. Workflows start collapsed; `→` expands a controller into phases and children, `←` collapses it, and `Enter` opens the controller inspector or the selected child's ordinary live conversation viewer. Workflow children remain owned by the workflow and are not duplicated as top-level agents, notifications, mentions, lifecycle events, or session-pool entries. Their stop/skip/retry controls remain workflow-owned.

`/agents → Workflows` opens the two-pane inspector: phases on the left and the selected phase's children on the right. `Enter` opens a child detail view with its prompt, activity, current output, and outcome. `c` opens the same conversation viewer as FleetView. The direct run controls are:

| Key | Behavior |
|---|---|
| `x` | Stop the workflow |
| `p` | Pause or resume; running children finish, but no new children start |
| `s` | Skip the selected queued/running child; its `agent()` call returns `null` |
| `r` | Retry the selected running child; the same pending call receives the replacement result |
| `c` | Open the selected child's live conversation |

Skipping and terminal child failure both appear as `null` to the script. A script should filter or handle that result where a later stage needs a value. The workflow controls do not rewrite the script or invent a replacement call.

### 4. Edit, resume, and re-run

Open the returned `Script:` path, edit it, and invoke `SubagentWorkflow` again with `scriptPath`. A normal run pays for every child again. `resumeFromRunId` replays the unchanged leading prefix of the previous run's journal and starts the first changed or failed call live, followed by the remaining calls.

Each settled child call is journaled beside the script as `<run id>.workflow.jsonl`. The journal is keyed to the current session and is a prefix cache, not a lookup table. It will not:

- resume across sessions;
- resume a live run;
- replay a journaled failure; or
- replay a run that used `agent({ resume })`, because a replayed child has no live conversation for a later continuation.

Replayed children are marked `from resume journal` in the card and inspector, and completion output counts them. A gate-rejected child remains resumable, so a script can tell the same child what failed and try again with its context intact. `resume` cannot be combined with a new child type, model, effort, isolation, or gate.

### 5. Save a deterministic script

This section is for legacy deterministic `.js` workflows. To save reusable adaptive guidance, use `WorkflowPlaybookSave` and promote generalized Markdown after its direct confirmation; do not save generated JavaScript from a Playbook. See [WorkflowPlaybookSave](playbooks.md#workflowplaybooksave).

Copy a script into one of these locations with a `.js` extension:

| Location | Scope |
|---|---|
| `<project>/.pi/workflows/<name>.js` | Project |
| `<project>/.agents/workflows/<name>.js` | Workspace |
| `<agent dir>/workflows/<name>.js` | Global |

Project `.pi` wins over workspace `.agents`, which wins over the global directory. A saved script must contain a pure-literal `export const meta = { name, description }` declaration. `name` and `description` are required; `phases` and `whenToUse` are optional. The metadata is read before execution so initial progress groups can render immediately. Nothing in the script is executed to decide whether it is a saved workflow.

Invoke a saved script by asking the model to run it or by passing `name: "<name>"`. Interactive approval rejects any nested `workflow()` call because the top-level preview cannot disclose child behavior. Trusted headless automation may compose one level of saved workflows. `/agents → Workflows` lists current runs, not every saved file.

## Script reference

### Tool parameters

| Parameter | Type | Description |
|---|---|---|
| `script` | string | Inline workflow source beginning with `export const meta = { name, description }` |
| `scriptPath` | string | Absolute or project-relative workflow script path |
| `name` | string | Saved `<name>.js` workflow from the project, workspace, or global roots |
| `args` | JSON-shaped value | Passed verbatim to the script as the `args` global |
| `resumeFromRunId` | string | Replay the unchanged prefix of a completed run in this session |
| `title` / `description` | string | Accepted and ignored for Claude Code parity; the script's `meta` names it |

Use exactly one source among `script`, `scriptPath`, and `name`. A resume may omit the source and reuse the previous script path. `args` is optional and may be an object or array; pass actual JSON values rather than a JSON-encoded string.

### `agent(prompt, opts?)`

`agent()` spawns one child and resolves to its final text or Markdown, or `null` after terminal failure or an inspector skip. Every child result is text; the script can parse or transform that text deterministically and can return an object or other JSON-shaped summary itself.

| Option | Type | Notes |
|---|---|---|
| `label` | string | Display label and the name used by `resume` |
| `phase` | string | Explicit progress group, useful inside `pipeline` or `parallel` stages |
| `agentType` | string | Agent definition; defaults to `general-purpose` |
| `model` | string | Provider/model ID or fuzzy model name |
| `effort` | string | `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |
| `isolation` | `"worktree"` | Run the child in an isolated git worktree; changes are preserved on a branch when it settles |
| `gate` | string | Run a shell command after the child and fail the call if it exits non-zero |
| `resume` | string | Continue the child identified by its prior `label`; mutually exclusive with `agentType`, `model`, `effort`, `isolation`, and `gate` |

Any other option, including `schema`, is rejected before the child starts with an explicit migration error. See [Migration](#migration).

### `pipeline()` and `parallel()`

```js
await pipeline(items, ...stages)
await parallel(thunks)
```

`pipeline` sends each item through every stage independently with no barrier between stages. Item A can be in a later stage while item B is still in its first stage. Each stage receives `(previousResult, originalItem, index)`, and a thrown stage drops that item to `null` and skips its remaining stages.

`parallel` is a barrier: it waits for all thunks before the script continues. A thunk failure becomes `null` while fatal run errors, such as a cap breach or an unavailable nested workflow, propagate. Prefer `pipeline` when each item can advance independently; use `parallel` only when a later step genuinely needs all prior text together.

### `workflow(nameOrRef, args?)`

Runs a saved workflow inline and returns its script result. Pass a name or `{ scriptPath }`; the second argument becomes the child's `args`. The child shares the worker, concurrency cap, agent counter, abort signal, journal, and budget. Its progress renders as a separate workflow group. This is available only to trusted headless automation: interactive approval rejects nested behavior because it cannot preview the child. One level of nesting is allowed; a workflow called from a child throws.

### `phase()`, `log()`, `args`, and `budget`

- `phase(title)` starts a progress group. Inside concurrent stages, prefer the `phase` option on each `agent()` call.
- `log(message)` emits a progress line under the workflow tree.
- `args` is the value passed to the tool.
- `budget` is `{ total, spent(), remaining() }`; `total` is always `null` because pi has no token-target directive, `remaining()` is `Infinity`, and `spent()` reports this run's output tokens.

### Determinism and return values

Scripts run in a worker thread and `node:vm` context. `Date.now()`, `new Date()` without arguments, and `Math.random()` throw because they would make journal replay diverge. `eval` and `Function(...)` throw because code generation is disabled. There is no filesystem, network, or module access. Values crossing the script boundary are checked for cycles, non-finite numbers, sparse arrays, symbol keys, and exotic prototypes.

The script's final value is checked at the host boundary and can be a JSON-shaped object, array, string, number, boolean, or `null`. This is separate from child output: children always return text/Markdown.

### Files, caps, and settings

| What | Location or value |
|---|---|
| Inline script | `<tmp>/pi-subagents-<uid>/<encoded-cwd>/<session>/tasks/<run id>.workflow.js` |
| Resume journal | Beside the script as `<run id>.workflow.jsonl` |
| Default child concurrency | 2 per workflow |
| Agents per run | 1000 |
| Items per `parallel`/`pipeline` call | 4096 |
| Nested `workflow()` calls | 256 |
| Script length | 512 KiB |

`workflowsEnabled` is on by default and can be disabled in `subagents.json` or `/agents → Settings → Workflows`. Leaving it unset uses auto mode and stands down for the session if another extension provides `Workflow` or `SubagentWorkflow`. See [Persistent settings](../README.md#persistent-settings).

## Migration

The removed structured child-result option is not accepted. Calls written as `agent(prompt, { schema: ... })` fail before any model call with:

```text
agent() opts.schema is no longer supported; workflow children return text/Markdown.
```

Update the child prompt to request concise line-oriented text or Markdown, then parse that text in the script if deterministic extraction is required. For richer aggregation, keep the child response as Markdown and have the script return an object built from text, labels, counts, or statuses. Existing structured-result callers receive this explicit migration error rather than silently receiving a different value.

## Recipes

### Fan out over a discovered list

```js
export const meta = { name: 'auth-audit', description: 'Find and verify auth gaps' }
const listing = await agent('List route files under src/routes/. One path per line.')
const files = listing.split('\n').map(line => line.trim()).filter(Boolean)
return await pipeline(
  files,
  file => agent(`Audit ${file} for missing auth checks. Return Markdown.`, { label: `audit:${file}` }),
  (finding, file) => agent(`Try to refute the finding for ${file}:\n${finding}`, { label: `verify:${file}`, phase: 'Verify' }),
)
```

### Verify with a gate and retry context

```js
let fixed = await agent('Fix the failing test.', { label: 'fix', gate: 'npm test' })
if (fixed === null) {
  fixed = await agent('The test gate still fails. Fix the cause.', { label: 'fix', resume: 'fix' })
  const verified = await agent('Run npm test and report the result. Change nothing.', {
    label: 'verify',
    gate: 'npm test',
    effort: 'low',
  })
  return { passed: verified !== null, summary: fixed }
}
return { passed: true, summary: fixed }
```

### Combine text for one synthesis child

```js
const reviews = await parallel([
  () => agent('Review correctness and return Markdown.'),
  () => agent('Review security and return Markdown.'),
  () => agent('Review performance and return Markdown.'),
])
const combined = reviews.filter(Boolean).join('\n\n---\n\n')
return await agent(`Deduplicate and synthesize these reviews:\n${combined}`)
```

## Troubleshooting

**`agent() opts.schema is no longer supported`.** The script uses the removed structured child-result option. Request text or Markdown and parse it in the script, or return a deterministic object assembled from text.

**The script failed because `Date.now()`, `new Date()`, or `Math.random()` is unavailable.** Use the loop index for stable labels, pass a timestamp through `args`, or add timestamps after the workflow returns.

**The meta object must be a pure literal.** `meta` is read before execution. Move variables, calls, spreads, and interpolation into the script body.

**The script failed because an `agent()` call was not awaited.** A dropped `await` would let the script finish while a child was still running. Await every child call, including calls inside stage callbacks.

**The worktree isolation gate failed.** The target must be a Git repository with at least one commit and a working `git worktree add`. Isolation is a strict guarantee; the run does not silently continue in the shared checkout.

**The run appears queued.** Default workflow concurrency is two. A pause also prevents new children from starting while active children finish.

**The saved workflow cannot be found.** Check the three saved-workflow roots and ensure the file contains `export const meta = { name, description }`. A Markdown `WORKFLOW.md` is a Playbook and is loaded by `WorkflowPlaybook`, not by the JavaScript name loader.

**A direct UI call is refused before approval.** Rewrite injected globals as direct identifier calls and use literal option objects without spreads, computed keys, shorthand properties, methods, or dynamic behavior fields. Headless automation does not use these UI completeness checks.
