# Optional Agent Templates

These files are examples, not built-in agents. Nothing here is loaded automatically.
Copy only the definitions you want into `.pi/agents/`, `.agents/agents/`, or your
global agent directory, and edit their names, prompts, tools, models, extensions,
and skills for your environment. Do not copy this README as an agent definition.

`Worker.md` demonstrates bounded execution. `Explorer.md` and `Reviewer.md`
include Bash for Git history and enable extensions and skills; their instruction
not to modify reviewed work is a convention, not a sandbox. The existing
`code-reviewer.md` is a more restricted reading-only alternative.

Calls must name an enabled definition. For workflow examples that omit `agentType`,
explicitly set `defaultAgent` in `subagents.json` to one of your installed names,
or add `agentType` to each call. Unknown names never fall back to another agent.
