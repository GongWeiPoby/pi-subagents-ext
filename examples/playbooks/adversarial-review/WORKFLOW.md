---
name: adversarial-review
description: Investigate a task, then try to refute every finding with independent skeptics
execution: adaptive
domains:
  - software-development
  - review
  - verification
side_effects: read-only
approval: adaptive
inputs:
  task:
    type: string
    description: What to investigate (a module, a design, a change, a claim)
  reviewers:
    type: number
    description: Roughly how many skeptics challenge each finding
  threshold:
    type: string
    description: How much agreement a finding needs to survive
example: Adversarially review "{{task}}" — find issues and keep only what survives refutation
---

# Outcome

Produce findings that survived an honest attempt to refute them. Report each
survivor with its supporting evidence and note how many candidate findings were
discarded — the discard count is part of the result, not an embarrassment.

# Coordinator guidance

Investigate first: one focused Agent (or direct tool work) enumerates concrete,
individually checkable findings. Reject vague findings at the source — each one
must name a file, component, or claim specific enough that a skeptic knows what
to check.

Then attack each finding independently. Spawn skeptics with a brief to REFUTE,
not to evaluate: "default to refuted when uncertain", "investigate with the
available tools". Diverse lenses (correctness, security, repro, does-it-matter)
catch more than N identical skeptics — vary the lens, not just the count.

Vote deterministically in the main context: a finding survives when the share
of skeptics that failed to refute it meets the requested threshold (default
"most"). A finding every skeptic ignored is not confirmed — treat no-vote as
not-survived.

Synthesize the survivors in the main context: each with a short justification
and its strongest surviving evidence, plus the discard summary. Keep the
per-finding verdicts available; do not resurrect discarded findings during
synthesis.

Scale to the stakes: one skeptic per finding for a quick check, two or three
with distinct lenses for anything that will drive a decision.
