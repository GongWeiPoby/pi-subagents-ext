# Adaptive workflow Playbooks

For users and project authors who want reusable workflow guidance without maintaining JavaScript orchestration scripts.
This guide covers `WORKFLOW.md`, prompt resources, `WorkflowPlaybook`, `WorkflowPlan`, and confirmed promotion through `WorkflowPlaybookSave`; see [Scripted workflows](workflows.md) for the execution runtime itself.

## Mental model

Adaptive Playbooks separate reusable intent from one run's execution topology:

```text
Persona + request + project context
  -> WORKFLOW.md coordinator guidance
  -> structured WorkflowPlan for this run
  -> temporary JavaScript
  -> SubagentWorkflow runtime
  -> successful pattern generalized by the model
  -> confirmed WorkflowPlaybookSave (project or global)
```

The reusable source is Markdown. The generated JavaScript is an internal run artifact used by the existing deterministic worker runtime, journal, progress UI, gates, and worktree integration. It is never written into a reusable workflow directory by `WorkflowPlan`.

| Artifact | Responsibility |
|---|---|
| Persona | Current user role and preferences; a planning bias, not a stage list |
| Agent `.md` | One executor's role, tools, model, skills, and system prompt |
| Skill | How to perform a specialized capability |
| `WORKFLOW.md` | How to reason about and coordinate a class of outcomes |
| `prompts/*.md` | Optional reusable node prompt templates |
| `WorkflowPlan` | This run's selected nodes, dependencies, omissions, confidence, and approvals |
| Temporary JavaScript | Deterministic execution code consumed by `SubagentWorkflow` |
| `WorkflowPlaybookSave` | Confirmed promotion of generalized Markdown and prompt resources |

## Discovery and precedence

A Playbook is a directory containing `WORKFLOW.md`:

```text
.pi/workflows/code-review/WORKFLOW.md
.pi/workflows/code-review/prompts/verify.md
```

Playbooks are discovered in this order:

1. `<workspace>/.pi/workflows/<name>/WORKFLOW.md`
2. `<workspace>/.agents/workflows/<name>/WORKFLOW.md`
3. `<agentDir>/workflows/<name>/WORKFLOW.md`

A higher-precedence Playbook replaces a same-named lower one. Project Playbooks can therefore specialize a global workflow without modifying the global source. Project and workspace Playbooks are exposed only when Pi reports the project as trusted; untrusted projects see global Playbooks only.

Legacy `<name>.js` saved workflows remain a separate catalogue and keep their existing behavior. Markdown Playbooks are never passed to the JavaScript loader. A `.js` file alone does not appear in `WorkflowPlaybook list`.

Symlinked roots, Playbook directories, `WORKFLOW.md` files, and prompt resources are ignored. Names must be path-safe. Playbooks are size-bounded before reading; each root and Playbook has count/aggregate prompt limits, and catalogue tool output is truncated with an explicit marker.

## `WORKFLOW.md`

Frontmatter contains stable facts needed for discovery and planning. The Markdown body is the coordinator prompt:

```markdown
---
name: code-review
description: Adaptively review a code change and return validated findings
execution: adaptive
domains:
  - software-development
  - code-review
side_effects: read-only
approval: adaptive
inputs:
  target:
    type: string
    description: Diff, PR, branch, file, or directory to review
example: Review the current diff with target="HEAD"
---

# Outcome

Review the requested change deeply enough for its actual scope and risk.

# Context adaptation

Inspect the target before choosing reviewers. A small local change may need one
reviewer; a broad or risky change may need several independent perspectives.

# Completion

Finish when relevant surfaces are covered and high-impact findings have evidence.
```

Supported metadata:

| Field | Default | Meaning |
|---|---|---|
| `name` | Directory name | Stable catalogue identity |
| `description` | `name` | One-line discovery summary |
| `execution` | `adaptive` | `adaptive` or metadata-only `deterministic` marker |
| `domains` | `[]` | Searchable domain labels |
| `side_effects` | `unknown` | Human-readable impact classification |
| `approval` | `adaptive` | Advisory planning metadata: `adaptive`, `required`, or `none`; it never changes `WorkflowPlan` confirmation behavior |
| `inputs` | absent | Input documentation for the Planner |
| `example` | absent | Generalized natural-language invocation example; required for tool-saved Playbooks |

Do not encode a mandatory DAG in frontmatter. Fixed `stages`, condition expressions, and large routing tables would turn YAML into another rigid programming language. Put adaptation guidance and completion judgment in Markdown. Unknown `execution` or `approval` values cause the Playbook to be skipped with a warning instead of silently changing its behavior.

## Prompt resources

A Playbook may include direct `.md` children under `prompts/`:

```text
code-review/
  WORKFLOW.md
  prompts/
    discover.md
    review.md
    verify.md
    synthesize.md
```

Prompt resources are returned by `WorkflowPlaybook read`. They are templates for the Planner, not automatically scheduled nodes. The Planner may use one, adapt it, combine it with another, or omit it.

Example:

```markdown
Review {{target}} through the {{lens}} lens.

Known context:
{{context}}

Return only actionable findings supported by file and line evidence.
```

Agent system prompts and node prompts remain separate. An Agent `.md` defines who performs work; a Playbook prompt defines the specific work needed in this run.

## `WorkflowPlaybook`

Discover the catalogue:

```json
{ "action": "list" }
```

Filter it:

```json
{ "action": "list", "query": "review" }
```

Read one Playbook and all prompt resources:

```json
{ "action": "read", "name": "code-review" }
```

Select one exact source when project precedence shadows the revision you need:

```json
{ "action": "read", "name": "code-review", "source": "global" }
```

Playbooks guide planning. Reading one does not launch agents or create tasks.

## `WorkflowPlaybookSave`

A successful one-run plan stays temporary until the user explicitly asks to save or promote it. The main model first generalizes task-specific paths, names, platforms, environments, and commands into reusable inputs. It then calls `WorkflowPlaybookSave` with:

- Stable discovery metadata and a Markdown coordinator prompt
- Optional named `prompts/*.md` resources
- Input documentation and a reusable natural-language invocation example
- A user-visible `project` or `global` destination

The tool shows the exact target and complete contents of every file before writing. The user confirms that preview directly; the model cannot assert approval in its arguments. Project scope writes `.pi/workflows/<name>/`, while global scope writes `<agentDir>/workflows/<name>/`. The tool does not write `.agents/workflows`, which remains a discoverable tool-agnostic location managed outside this promotion flow.

```json
{
  "name": "adaptive-review",
  "scope": "project",
  "description": "Adaptively review a change",
  "body": "# Outcome\n\nReview {{target}} deeply enough for its actual risk.",
  "inputs": {
    "target": { "type": "string", "description": "Change to review" }
  },
  "example": "Review the current diff",
  "prompts": {
    "review": "Review {{target}} through the {{lens}} lens."
  }
}
```

Project saves require a trusted project. All saves require an interactive/RPC approval UI and fail closed in headless sessions. The approval preview is size-bounded so a proposal cannot hide content outside the review surface.

Creating an existing name fails without changing files. To update one, first use `WorkflowPlaybook read` with `source: "project"` or `source: "global"`, then pass both `overwrite: true` and its exact `revision`. The source selector matters when a project Playbook shadows a same-named global one. A stale revision is rejected and must be re-read. The writer uses an owner-only per-target process lock under the agent directory, validates a temporary directory with the normal Playbook loader, then replaces the whole directory. Readers fall back to the last validated backup during the rename window, and interrupted replacements recover that backup; stale prompt files disappear only after a successful replacement.

The save tool never accepts or emits JavaScript. Do not promote secrets, credentials, run/session IDs, temporary paths, or machine-specific absolute paths.

## `WorkflowPlan`

`WorkflowPlan` validates one run's adaptive graph and compiles it into temporary JavaScript for `SubagentWorkflow`.

Important fields:

| Field | Meaning |
|---|---|
| `objective` | Outcome this run must achieve |
| `playbook` | Optional Playbook that informed the plan |
| `personas` | Inferred user contexts and roles |
| `confidence` / `evidence` | Why the Planner believes its interpretation |
| `nodes` | Selected executable work nodes |
| `omitted` | Material capabilities deliberately not selected, with reasons |

A node can declare:

```json
{
  "id": "review",
  "title": "Review correctness",
  "capability": "code-review",
  "prompt": "Review the current diff",
  "agentType": "code-reviewer",
  "phase": "Review",
  "dependsOn": ["inspect"],
  "effort": "high",
  "skills": ["security-review"],
  "approval": "adaptive",
  "sideEffects": "read"
}
```

The tool rejects duplicate/unsafe IDs, missing or self dependencies, cycles, empty prompts/capabilities, invalid confidence, excessive prompt volume, and compiled scripts that exceed the runtime bound. When the project disables `worktreeIsolation`, plans containing `isolation: worktree` are rejected rather than silently running writers in the shared checkout.

Independent nodes in one topological layer compile to one `parallel()` call. Downstream prompts receive a JSON object containing prerequisite results. Ordinary child failures may therefore appear as `null`; Playbook prompts should disclose or handle missing coverage rather than assuming every child succeeded.

## Approval

Every `WorkflowPlan` is shown for direct user confirmation before any script is produced. This is deliberate: selected agents may have broad tools, so Playbook-level and node-level `approval` metadata plus `sideEffects` fields describe intent but are not accepted as the authorization boundary. `required`, `external`, shell gates, and conservatively inferred deploy/publish/destructive actions are highlighted in that same exact-plan view; `none` does not suppress it.

For example:

```json
{
  "objective": "Deploy production",
  "nodes": [
    {
      "id": "deploy",
      "title": "Deploy production",
      "capability": "deploy",
      "prompt": "Deploy the current build",
      "approval": "required",
      "sideEffects": "external"
    }
  ]
}
```

`WorkflowPlan` shows the complete behavior-affecting approval view in a human-readable summary rather than generated JavaScript: prompts, gate commands, agent/model/effort, isolation, schema, skills, dependencies, and side effects. The preview places an exact dependency map near the top, before the node details; its arrows mean prerequisite result handoffs, and a node legend shows id, title, capability, and `output=text` or `output=structured (schema)`. It explains that failure or skip can yield `null` and that final results retain each node output. It calls the session UI confirmation directly and compiles that same in-memory plan only when the user accepts. The model cannot self-assert approval in tool arguments. Playbook `approval` metadata is advisory context for the Planner and catalogue reader only: `required`, `adaptive`, and `none` all follow the same mandatory `WorkflowPlan` confirmation path. Capability/prompt classification can add emphasis, but it never creates or removes confirmation. A declined plan, or any headless Plan call, remains `awaiting_approval` and contains no script.

`approval: adaptive` and `approval: none` are planning metadata, not hidden runtime authorization rules. External effects and shell gates remain visible in the approval view even though every adaptive Plan is confirmed.

## Execution handoff

A ready `WorkflowPlan` returns:

- An inspectable YAML summary without generated source
- The normalized structured plan in tool details/session history
- A one-use opaque `planRef` for the internally retained execution script

The model passes that exact `planRef` to `SubagentWorkflow` on the next turn. It must not rewrite the generated script or save it under `.pi/workflows`, `.agents/workflows`, or the global workflow directory. A ready Plan grants a session-scoped, single-use authorization for the exact internally retained script-and-arguments digest, so a valid `planRef` executes directly without a second confirmation. `planRef` cannot be combined with `args`, `script`, `scriptPath`, `name`, or `resumeFromRunId`. Any altered execution must omit `planRef` and be submitted as a separate direct invocation: it is always confirmed when a UI exists, and allowed without UI in headless automation where the caller is the trust boundary. A declined or headless Plan grants no authorization.

The `SubagentWorkflow` run then owns execution, journal replay, progress, pause/skip/retry controls, worktree cleanup, and completion notification exactly as before.

## Example

The shipped example is [`examples/playbooks/code-review/WORKFLOW.md`](../examples/playbooks/code-review/WORKFLOW.md). Copy it into a project:

```bash
mkdir -p .pi/workflows/code-review
cp -R examples/playbooks/code-review/. .pi/workflows/code-review/
```

Then ask naturally for a code review. The Planner can discover and read the Playbook, select a review graph that fits the actual change, validate it with `WorkflowPlan`, and pass the resulting `planRef` to `SubagentWorkflow`.

## Current MVP boundaries

- The main conversation model is the Planner and promotion generalizer; there is no separate planner model setting yet.
- Persona inference is model judgment recorded in `WorkflowPlan`, not a deterministic classifier.
- Promotion saves a model-supplied generalized proposal after direct confirmation; it does not yet mine run journals or synthesize a draft automatically from a run ID.
- Promotion supports create/update for project and global Playbooks; delete/rename management is not part of this milestone.
- `WorkflowPlan` compiles and records plans but does not itself start `SubagentWorkflow`; the model performs the explicit next tool call.
- Durable cross-process workflow recovery, quality-helper globals, model tiers, and shared run storage remain future integration work.
