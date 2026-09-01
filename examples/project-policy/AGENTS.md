# Dynamic Coordination Policy

This project uses adaptive coordination by default.

## Default interaction

- Treat a user request as a desired outcome. Users normally only need to describe the goal; do not require them to design the delegation plan.
- The main Agent owns the coordination. It may create and update Todo items when the work is mutable, call ordinary `Agent` types for focused work, and use ordinary tools as needed.
- Read a relevant Skill or Playbook when it can improve the current task. Reading guidance does not require every instruction or resource to be used.
- Independently verify important work with the available tools or a focused Agent, then synthesize the verified result in the main context.
- Adapt the amount, order, and roles of delegated work to the request and the evidence found. Do not create work merely to fill a preset structure.

## Choosing orchestration

- Use `SubagentWorkflow` only when the user explicitly asks for a deterministic JavaScript script or named workflow, including deterministic loops, fan-out, pipelines, gates, retries, or resume behavior.
- Do not silently convert this policy, a Playbook, or a natural-language request into generated JavaScript orchestration.

## Policy and runtime boundaries

- This `AGENTS.md` is stable project policy, not a fixed execution graph. Do not encode a mandatory phase order, fixed agent roster, dependency graph, or call count here.
- The runtime remains authoritative for actual task and agent state, permissions, concurrency, recovery and resume, and execution evidence. Use its real status and result surfaces instead of inventing state in policy text.
- Follow this policy together with the project's other instructions and the current task's scope.
