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

Review the requested change deeply enough for its actual scope and risk. Return
only actionable findings supported by file and line evidence, ordered by
severity. Disclose residual uncertainty and meaningful test gaps when no defect
is confirmed.

# Coordinator guidance

Inspect the target and current conversation before choosing the review shape.
Use one focused `Agent` call for a small, coherent change. For a broad or risky
change, choose several independent reviewers according to the surfaces actually
present. Use ordinary tools such as `read`, `grep`, `find`, or `bash` when they
provide direct evidence, and use relevant skills when they improve the review.

Do not create review work merely to fill categories or duplicate another reviewer.
Choose prompts, agent types, and lenses based on the evidence. A reviewer may
cover correctness, security, UI, API contracts, performance, migration, or
reliability when that surface is relevant; these are conditional capabilities,
not a mandatory checklist.

Verify high-impact candidate findings independently. Verification may be a
focused follow-up `Agent` call, an ordinary tool command, or a relevant skill.
Then synthesize the verified findings in the main context, merging duplicates,
resolving severity disagreements, and stating coverage gaps or uncertainty.

Every child should return concise text or Markdown with file and line evidence.
Keep the final response in the main context. Do not assume that every suggested
reviewer, prompt resource, or paragraph must be used, and do not claim coverage
that the available evidence does not support.
