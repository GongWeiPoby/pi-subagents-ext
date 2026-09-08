---
name: multi-perspective
description: Analyze a topic from several independent perspectives, then synthesize a balanced view
execution: adaptive
domains:
  - analysis
  - decision-making
side_effects: read-only
approval: adaptive
inputs:
  topic:
    type: string
    description: Topic, decision, or proposal to analyze
  perspectives:
    type: array
    description: Perspective labels; defaults to technical, product, security, user experience, maintainability
example: Analyze "{{topic}}" from multiple perspectives and reconcile them
---

# Outcome

A balanced analysis of the topic that keeps the perspectives genuinely
independent before reconciling them, so the synthesis weighs real disagreement
instead of averaging away the sharpest observations.

# Coordinator guidance

Choose perspectives from the topic, not from a fixed list. The defaults
(technical, product, security, user experience, maintainability) fit most
software decisions; swap in domain lenses (cost, compliance, performance,
adoption, risk) when the topic warrants. Fewer, sharper lenses beat a checkbox
panel.

Analyze independently first: one Agent per perspective, each briefed to argue
its own lens only — no hedging toward a consensus view, no reading the other
analyses. A perspective that has nothing to say should say so; do not force
content.

Synthesize in the main context: where perspectives agree, state it once; where
they disagree, name the tension and adjudicate it with evidence rather than
splitting the difference; where one lens exposes a blocker, let it block. The
synthesis is allowed to reach a conclusion the individual analyses did not.

Every child returns concise text or Markdown grounded in the topic and any
available project evidence. Do not spawn perspectives the topic cannot support,
and do not let the synthesis introduce claims no perspective made.
