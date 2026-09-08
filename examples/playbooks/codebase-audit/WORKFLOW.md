---
name: codebase-audit
description: Run parallel checks against a codebase scope, cross-validate findings, and report by priority
execution: adaptive
domains:
  - software-development
  - audit
side_effects: read-only
approval: adaptive
inputs:
  scope:
    type: string
    description: Directory, module, or surface to audit
  checks:
    type: array
    description: Concrete concerns to check (e.g. missing auth, swallowed errors, stale deps)
example: Audit {{scope}} for {{checks}}
---

# Outcome

A prioritized audit report of the scope: confirmed findings with file and line
evidence, false positives removed by cross-validation, and actionable
recommendations ordered by impact.

# Coordinator guidance

Scope before fanning out: use `read`/`grep`/`find` (or one scouting Agent) to
learn what the scope actually contains — its size, languages, and structure
decide how many checkers it can support.

Run each check as an independent Agent over the same scope, briefed to report
concrete findings with file paths (and line numbers where possible) or an
explicit "none". A checker that reports a hunch without a location is asked
again or dropped, not forwarded.

Cross-validate before reporting: verify each finding against the actual code
with direct tool reads or a verification Agent. Remove false positives, merge
duplicates across checks, and correct severity. An audit that ships unverified
findings trains readers to ignore audits.

Report by priority in the main context: confirmed findings first (impact
ordered), then the discarded-and-why summary, then recommendations. State what
the audit did not cover — checks skipped, directories excluded — rather than
implying the scope was exhaustively cleared.

Scale the fan-out to the scope: a single-directory scope may need one Agent per
check running serially; a repo-wide audit with many checks deserves parallel
Agents. Keep one writer — audit Agents are read-only; recommendations belong to
the report, not to unrequested edits.
