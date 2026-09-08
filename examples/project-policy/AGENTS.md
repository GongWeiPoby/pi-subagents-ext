# Dynamic Coordination Policy

This project defaults to direct execution in the main session, with adaptive delegation when it adds value.

## Default interaction

- Treat a user request as a desired outcome. Users normally only need to describe the goal; do not require them to design the delegation plan.
- The main Agent owns the work as well as coordination: read, reason, edit, and validate directly by default. Use Todo items for genuinely complex mutable work; a Todo or completed plan does not require a Worker.
- Delegate only for useful parallelism, substantial context isolation, needed specialist capabilities, or an independent review perspective. Already-understood serial changes stay in the main session. Respect explicit requests to delegate or not to delegate.
- Choose from user-defined agents by their configured capabilities. The extension provides no built-in roles; example templates are optional. Give each delegate a self-contained scope and output; give writers ownership and acceptance criteria, with one writer per checkout.
- Read a relevant Skill or Playbook when it can improve the current task and the user permits it. Reading guidance does not require every instruction or resource to be used.
- Independently verify important work with the available tools or a focused Agent, then synthesize the verified result in the main context.
- Adapt the amount, order, and roles of delegated work to the request and the evidence found. Do not create work merely to fill a preset structure.

## Choosing orchestration

- Use `SubagentWorkflow` only when the user explicitly asks for a deterministic JavaScript script or named workflow, including deterministic loops, fan-out, pipelines, gates, retries, or resume behavior.
- Do not silently convert this policy, a Playbook, or a natural-language request into generated JavaScript orchestration.

## Policy and runtime boundaries

- This `AGENTS.md` is stable project policy, not a fixed execution graph. Do not encode a mandatory phase order, fixed agent roster, dependency graph, or call count here.
- The runtime remains authoritative for actual task and agent state, permissions, concurrency, recovery and resume, and execution evidence. Use its real status and result surfaces instead of inventing state in policy text.
- Follow this policy together with the project's other instructions and the current task's scope.
