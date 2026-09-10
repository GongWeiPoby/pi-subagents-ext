# Agent profiles

Audience: users who want to reuse an Agent definition in the main session.
`/profile` is instruction and routing guidance, not permissions or a sandbox.

## One definition, two entry points

Define an ordinary Agent in `.pi/agents/`, `.agents/agents/`, or the global agent directory (normally `~/.pi/agent/agents/`, honoring `PI_CODING_AGENT_DIR`). Discovery and precedence are identical to [Custom Agents](../README.md#custom-agents): project `.pi` wins over workspace `.agents`, then global. The frontmatter `name` is the identity, falling back to the filename. There is no separate profile storage or creation tool.

```markdown
---
name: Fiction Writer
description: Develop fiction while preserving established voices
model: anthropic/claude-sonnet-4-6
thinking: high
skills:
  allow: ["writing-*", "research?"]
---
Preserve established character voices. Distinguish proposed plot changes
from accepted story facts.
```

Use `Agent({ subagent_type: "Fiction Writer", ... })` for a separate child session, or `/profile Fiction Writer` to adopt those instructions in the main session. Create/edit the same file through `/agents` (manual editor or existing-agent generation), or ask the main assistant to update an Agent file with ordinary file tools. Review generated instructions before selecting them. File edits do not activate a profile.

| Agent field | Child `Agent` execution | Main `/profile` |
|-------------|-------------------------|-----------------|
| Markdown body | `prompt_mode` chooses replace/append | Always append to the current chained system prompt |
| `model`, `thinking` | Normal agent defaults/routing | Apply only on explicit profile switches; omissions inherit the captured baseline |
| `skills: true` (default) | Normal pi skill discovery | Recommend all eligible loaded skills |
| `skills: false` | Disable skill discovery | No recommendations; native skill functionality remains enabled |
| CSV / `string[]` skills | Preload named full bodies; disable other discovery | Recommend exact loaded names; never preload bodies |
| `{allow: [...]}` / `{deny: [...]}` skills | Filter pi's discovered skill catalogue; bodies load on demand | Filter recommendations by actual loaded metadata only |
| `tools`, `extensions`, `isolated`, `max_turns`, etc. | Normal child configuration | Not applied; `/profile show` lists these omissions |

Main-session selection does not change tools, tool denylists, extensions, extension exclusions, isolation/worktrees, turn limits, memory, nesting, context inheritance, background mode, session persistence, transcript policy, or session directories. In particular, `isolated: true` does **not** turn the main session into an isolated child. The Agent body may request behavior, but such instructions are not runtime enforcement.

## Skill name rules

The Agent `skills` field additionally accepts exactly one of `{allow: string[]}` and `{deny: string[]}`. Both keys together, unknown keys, non-string values, blank patterns, control characters, more than 256 patterns, or patterns longer than 256 characters are rejected. Invalid rule objects skip the file with a source-path warning; `strictAgentFiles` makes them fail startup like other invalid Agent files. Existing boolean, CSV and array forms retain their behavior.

- Patterns match the entire skill name, case-sensitively. `*` matches zero or more Unicode characters; `?` matches one. All other characters are literal, including brackets, dots, slashes and exclamation marks.
- `allow: []` selects none; `deny: []` selects all.
- Child rule objects use `DefaultResourceLoader.skillsOverride` on discovered skills, with discovery enabled and **without full-body preloading**. `false` and child isolation still disable discovery; legacy arrays retain full-body preloading.
- Main guidance uses only `before_agent_start.systemPromptOptions.skills`: actual names, descriptions and exact `filePath` values. Manual-only skills are not recommended for automatic invocation. Main lists use exact names, not globs.
- Main unmatched patterns warn once per activation/restore. Matching follows current loaded metadata on every prompt, so newly loaded skills can become recommended without rereading the Agent file.

Main guidance does not hide pi's native skill catalogue, completion or `/skill` commands, block `read`, or enforce how the model chooses skills. Child discovery filtering is also **not a file-access sandbox**: a tool with file access can still read other files. Neither entry point removes old instructions already copied into a parent prompt or conversation. In particular, a child's `prompt_mode: append` copies the existing parent prompt, and `inherit_context` copies conversation content; filtering the new skill catalogue does not scrub those strings. Existing child sessions are not reconfigured when the main profile changes.

## Commands

| Command | Behavior |
|---------|----------|
| `/profile` | Pick from enabled Agent definitions, plus off |
| `/profile Fiction Writer` | Select an Agent, including names containing spaces |
| `/profile use Fiction Writer` | Explicit Agent selection |
| `/profile show`, `/profile status` | Active/unavailable Agent name, actual model/thinking, baseline, source file, guidance and unapplied fields |
| `/profile list` | List enabled Agents and their sources |
| `/profile off`, `/profile default` | Restore baseline and remove the appended profile |

Names resolve exactly first, otherwise case-insensitively only when unambiguous. Unknown, disabled and ambiguous names fail without substitution. Use `/profile use off`, `/profile use default`, `/profile use list`, etc. to select actual Agents with command-word names. There are no reserved Agent names introduced by `/profile`.

Only top-level sessions register this command. Switching requires an idle session and refuses concurrent switches, including while a picker is open. Session switch/fork/tree requests are refused while a profile switch is pending. The footer shows `profile: <agent name>`; unavailable restored definitions are marked explicitly.

## Model baseline and failures

The first successful enable captures the current model and thinking level as the **baseline**. Later explicit switches use that baseline for fields the new Agent omits, not the previous Agent's defaults. Off restores both fields and releases the baseline; the next enable captures a new one. Select a model before enabling if the session has no restorable model.

Model names reuse the existing fuzzy resolver, including separator/date tolerance. Unlike child routing, an explicitly named provider may **not** silently fall back to another provider: `/profile` rejects a resolver result under a different provider. Unavailable model requests fail before activation. Baseline restoration uses the exact captured provider/id, not fuzzy matching.

After activation, manual `/model` and thinking changes remain in effect: profile routing is not reapplied on ordinary prompts. Pi still clamps unsupported thinking levels; switches disclose the actual applied level.

If model/thinking selection or profile-state persistence fails, the command keeps the previous profile and attempts to restore the previous route. Failed rollback reports the actual remaining model/thinking instead of claiming restoration. An invalid/missing saved baseline cannot be honestly restored; off reports that failure instead of inventing a baseline.

## Prompts and session lifecycle

Each `before_agent_start` appends the cached Agent body and fresh skill guidance to **that event's chained system prompt**. It never caches the base prompt, replaces global/project instructions, or accumulates repeated history messages. Agent files are read on explicit selection and session restore/reload/tree navigation, not on ordinary prompts. Select the Agent again or `/reload` to pick up file edits.

The branch-local `subagents:profile` custom entry contains only the selected Agent name (null for off) and captured baseline provider/id/thinking. It contains no prompt body or credentials and is not an LLM message.

- `/new`: starts off.
- Existing-session startup, `/resume`, `/reload`, `/fork` or `/clone`: restore the latest entry on the active branch and reread the Agent definition.
- `/tree`: reconstruct only from the selected branch.
- Restore applies the prompt, **not** the Agent model/thinking defaults: pi's persisted manual route is left intact.
- Unknown, deleted, disabled, ambiguous or invalid restored definitions report an unavailable profile and apply no profile prompt. A valid captured baseline remains available for off.

No pi-core changes, additional dependencies, or native skill-command interception are involved.
