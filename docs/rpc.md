# Driving subagents from another extension

Another pi extension can spawn a top-level subagent, listen for completion, consume its result, and stop it over the `pi.events` bus. The public request/reply channels are `subagents:rpc:ping`, `subagents:rpc:spawn`, `subagents:rpc:stop`, and `subagents:rpc:consume`. Lifecycle events and the in-process manager registry are separate surfaces.

The bus is in-process. Requests and replies are synchronous event-bus traffic, although handlers may complete asynchronously. This is why function values and an `AbortSignal` can work in a spawn payload, and why none of this is a process-boundary protocol.

## Protocol and envelopes

Protocol v4 uses the same reply envelope for every request:

```ts
{ success: true, data?: T }
{ success: false, error: string }
```

`subagents:rpc:ping` replies with `{ version: 4 }`. The version covers the envelope and method contracts. Version 4 adds attempt-aware structured-task execution refs to the spawn reply and matching lifecycle events. `subagents:rpc:consume` remains additive and best-effort; callers should send it when they have presented a result and ignore an unavailable reply on older installations.

A caller should always provide a unique `requestId`. It is interpolated into the reply channel and is not validated. A missing ID sends the reply to the literal `...:undefined` channel shared by other callers that also omit it.

## Spawn options

`subagents:rpc:spawn` forwards the caller's options through the top-level manager path. The boundary strips internal ownership and dispatcher fields and replaces activity callbacks with the extension's own tracker. These options are honored:

| Field | Type | Notes |
|---|---|---|
| `description` | string | Displayed in the widget, FleetView, and completion notification |
| `name` | string | Additional handle such as `@auth-audit` |
| `model` | Model or `"provider/modelId"` | String overrides resolve against the active session registry; `null` means inherit |
| `maxTurns` | number | Turn ceiling |
| `isolated` | boolean | Removes extensions, skills, and nested tools; it is not a git worktree |
| `inheritContext` | boolean | Fork the parent conversation into the child |
| `thinkingLevel` | ThinkingLevel | Clamped to the resolved model's availability |
| `isBackground` | boolean | Selects whether the detached spawn occupies the background pool |
| `bypassQueue` | boolean | Starts immediately without waiting for the background pool |
| `isolation` | `"worktree"` | Runs in a temporary git worktree and preserves changes on a branch |
| `cwd` | absolute path | Child tool working directory; the directory must exist |
| `invocation` | AgentInvocation | Resolved display snapshot |
| `signal` | AbortSignal | Aborts the child when triggered |
| `taskExecution` | TaskExecutionClaim | Internal unbound claim used by the bundled `TaskExecute` client; the type and runtime guard both forbid an `executorId`, which the manager stamps from its generated agent ID |
| `onSpawned`, `onQueued`, `onCompaction`, `onBeforeWorktreeCleanup` | functions | Manager lifecycle callbacks; function values work because the bus is in-process |

Internal ownership fields such as `parentAgentId`, `workflowId`, `depth`, `maxSubagentDepth`, `configCwd`, `rootSessionId`, `resumeSessionFile`, `reclaim`, and `blocking` are stripped. `taskExecution` is the narrow exception used by the bundled task client: it contains `{ storeId, taskId, taskAttemptId, attemptId, kind }`; callers cannot supply `executorId`. The manager returns `{ id, taskExecutionRef }`, adding that generated ID as the executor, and carries the same ref on the terminal lifecycle event. The task store still performs the authoritative CAS, so possessing or fabricating a ref does not bypass the current store binding. Activity callbacks such as `onToolActivity`, `onTextDelta`, `onTurnEnd`, `onSessionCreated`, and `onAssistantUsage` are replaced by the extension's tracker.

RPC spawns are detached regardless of the `run_in_background` spelling. `isBackground` controls pool participation; `maxConcurrentForeground` does not apply. A top-level RPC agent appears in the widget and FleetView with the same live activity and turn information as an Agent-tool spawn. Workflow-owned and nested children remain hidden from this surface.

The RPC result is ordinary child output text/Markdown. There is no structured child-result option. A legacy payload containing `options.structuredOutput` is rejected before session/model resolution or manager calls with:

```text
options.structuredOutput is no longer supported; workflow children return text/Markdown. Migrate structured results to line-oriented text or Markdown.
```

Callers should request line-oriented text or Markdown and parse it themselves when they need machine-readable fields. Existing callers receive this explicit migration error rather than a silently changed result type.

## Names that look right

RPC options use manager camelCase names, not the Agent tool's snake_case names:

| You might write | Result | Use instead |
|---|---|---|
| `run_in_background` | Forwarded and ignored | `isBackground` |
| `isolated: true` | Removes extensions and skills | `isolation: "worktree"` for a git worktree |
| `isolation: "worktree"` | Creates a git worktree | `isolated: true` for a hermetic child |
| `configCwd` | Stripped | `cwd` |
| `max_turns` / `thinking` / `inherit_context` | Ignored | `maxTurns` / `thinkingLevel` / `inheritContext` |
| `memory` | No effect | Configure memory in agent frontmatter |

Unknown option keys are accepted by this bus path and are not validated. Use the documented manager spelling.

## Errors

Every failure is returned as `{ success: false, error }`, using the error message from the handler:

| Error | Meaning |
|---|---|
| `No active session` | The request arrived before the bound session started, or the current session excludes this extension |
| `options.structuredOutput is no longer supported; ...` | Legacy structured-result request; migrate to text/Markdown |
| `Model override "<label>" provided but ctx.modelRegistry is unavailable` | A model override was supplied without a registry |
| `Model not found: "<input>."` plus available models | Model resolution failed |
| `Model not in scope: "<input>."` plus allowed models | `scopeModels` rejected a caller-supplied model |
| `Unknown or disabled agent type: "<raw>". Available: <list>.` | Strict fallback dispatch rejected the type |
| `No agent type given. Available: <list>.` | Strict dispatch received no type |
| `SpawnOptions.cwd must be an absolute path: "<value>"` | Invalid working directory |
| `SpawnOptions.cwd does not exist: "<cwd>"` | Missing working directory |
| `SpawnOptions.cwd is not a directory: "<cwd>"` | Non-directory working directory |
| `Cannot run with isolation: "worktree" — not a git repo, no commits yet, or 'git worktree add' failed.` | Strict worktree startup failed |
| `Invalid task execution binding` | `taskExecution` is malformed or illegally includes a caller-selected `executorId` |
| `Agent not found` | Stop target does not exist |
| `Agent is owned by another agent or workflow` | Stop target is not a top-level RPC-owned agent |
| `Agent is not running` | Stop target already settled |
| `Agent not found or still running` | Consume target is unknown or not settled |

When `worktreeIsolation` is disabled project-wide, `isolation: "worktree"` is downgraded to a normal run without an error. This setting is a capability gate, so the Agent tool schema and prose omit the field in the next session while lower-level callers are still protected.

## Channels

### Ping

```ts
const requestId = crypto.randomUUID();
const replyChannel = `subagents:rpc:ping:reply:${requestId}`;
const unsub = pi.events.on(replyChannel, (reply) => {
  unsub();
  if (reply.success) console.log("Protocol version:", reply.data.version);
});
pi.events.emit("subagents:rpc:ping", { requestId });
```

### Spawn

```ts
const requestId = crypto.randomUUID();
const unsub = pi.events.on(`subagents:rpc:spawn:reply:${requestId}`, (reply) => {
  unsub();
  if (!reply.success) console.error("Spawn failed:", reply.error);
  else {
    console.log("Agent ID:", reply.data.id);
    if (reply.data.taskExecutionRef) console.log("Task execution:", reply.data.taskExecutionRef);
  }
});
pi.events.emit("subagents:rpc:spawn", {
  requestId,
  type: "Worker",
  prompt: "Inspect the authentication flow and return findings as Markdown.",
  options: { description: "Inspect authentication", isBackground: true },
});
```

### Stop

```ts
const requestId = crypto.randomUUID();
const unsub = pi.events.on(`subagents:rpc:stop:reply:${requestId}`, (reply) => {
  unsub();
  if (!reply.success) console.error("Stop failed:", reply.error);
});
pi.events.emit("subagents:rpc:stop", { requestId, agentId });
```

Only top-level agents can be stopped over RPC. A workflow or nested owner must control its own children.

### Consume

```ts
pi.events.emit("subagents:rpc:consume", {
  requestId: crypto.randomUUID(),
  agentId,
});
```

Consumption tells pi-subagents that the caller already presented the settled result, suppressing the duplicate completion notification. This channel is intentionally best-effort and outside the ping version handshake.

## Ownership and lifecycle

`subagents:rpc:stop` accepts only a top-level agent: records with neither `parentAgentId` nor `workflowId`. A nested child or workflow child is owned by the process waiting on it and cannot be stopped from another extension. `consume` accepts an id or handle through the same result-resolution path used by `get_subagent_result`; it marks only settled results.

Six agent events are top-level only. `started`, `completed`, `failed`, and `compacted` are the four universal lifecycle events; `created` covers only the Agent tool's background path and detached resumes, while `steered` reports accepted steering.

| Event | Meaning |
|---|---|
| `subagents:created` | Agent registered by the Agent tool's background path or a detached resume; RPC, scheduler, and mention spawns do not emit it |
| `subagents:started` | Agent began running |
| `subagents:completed` | Agent completed successfully or with a steered result; a TaskExecute agent also carries its immutable `taskExecutionRef` |
| `subagents:failed` | Agent stopped, aborted, or failed; a TaskExecute agent carries the same `taskExecutionRef` |
| `subagents:steered` | A steering message was accepted |
| `subagents:compacted` | Child session compacted |

Workflow-owned and nested children emit no lifecycle events; their owner reports them. Top-level settles also append a `subagents:record` session entry containing the id, type, description, status, result/error, and timestamps.

## Availability and notification timing

`subagents:ready` is emitted on the first bound `session_start`, after RPC handlers are registered. A session that filters out this extension emits no ready event and answers no RPC requests. Give discovery a timeout and treat expiry as unavailable. The payload is `{}`. Handlers are removed on `session_shutdown` and register again on a later session start.

The completion-notification race is intentional:

1. A child settles and emits `subagents:completed`.
2. The notification decision runs shortly afterward.
3. A synchronous `subagents:rpc:consume` from the completion handler marks the result consumed before that decision.
4. Consumption after an `await` can still cancel the held notification during the 200 ms hold; after that, the notification may already have fired.

Steering or a background resume un-consumes the record because the new reply still needs delivery.

## Manager registry

The extension also exposes `globalThis[Symbol.for("pi-subagents:manager")]`:

| Member | Signature | Notes |
|---|---|---|
| `waitForAll()` | `() => Promise<void>` | Resolves when all agents finish; this is a shutdown barrier, not a join for one caller |
| `hasRunning()` | `() => boolean` | Reports whether any agent is active or queued |
| `spawn(pi, ctx, type, prompt, options)` | `=> string` | Same top-level spawn path and stripping rules |
| `getRecord(id)` | `=> AgentRecord \| undefined` | Returns top-level records only |

The registry has no reply envelope, version, or availability event. Prefer the bus for new integrations; use the registry when a host needs a process-local running check or shutdown barrier. Legacy `structuredOutput` is rejected by the shared manager before either RPC or registry/direct spawns can start an agent.

## Reference implementation

The bundled [`src/tasks/`](../src/tasks/) integration drives `subagents:rpc:spawn` for agent-backed tasks and `subagents:rpc:consume` when `TaskOutput` presents a result. It atomically claims a pending Todo, passes the unbound `taskExecution` through spawn, binds the manager-stamped reply, and accepts completion/failure/stop only when the terminal event's store, Todo attempt, child attempt, kind, and executor ID still match. Its in-memory id map supports lookup and reload reconciliation but is not commit authority; a reset, new attempt, or store/session generation change rejects an old event.

For many coordinated agents with deterministic loops or gates, use [`SubagentWorkflow`](workflows.md). Workflow children remain owned by the workflow and do not appear on this RPC surface.
