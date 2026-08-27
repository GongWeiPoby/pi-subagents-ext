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
---

# Outcome

Review the requested change deeply enough for its actual scope and risk. Return
only actionable findings supported by file and line evidence, ordered by
severity. Disclose residual uncertainty and meaningful test gaps when no defect
is confirmed.

# Context adaptation

Inspect the target before choosing the review shape.

For a small local change, prefer one focused reviewer. For a broad or risky
change, select independent perspectives according to the surfaces that changed.
Security, UI, API contract, performance, migration, and reliability review are
conditional capabilities, not mandatory checklist items.

Do not create review work merely to fill categories. Do not duplicate work that
another reviewer already owns. Verify high-impact findings independently before
reporting them.

# Available approaches

The Planner may use:

- A single `code-reviewer` agent for a small, coherent change
- Several specialized reviewers in parallel for independent concerns
- Executable evidence or a fresh skeptical agent to verify candidate findings
- A synthesis node to merge duplicates and resolve severity disagreements

Prompt templates in `prompts/` are starting points. Adapt their variables and
wording to the actual target instead of treating them as fixed stages.

# Completion

Finish when relevant changed surfaces have been covered, high-impact findings
have independent evidence, duplicate findings are merged, and any remaining
coverage gaps or uncertainty are stated plainly.
