---
name: deep-research
description: Answer a research question from web sources with cross-checked claims and citations
execution: adaptive
domains:
  - research
  - web-search
side_effects: read-only
approval: adaptive
inputs:
  question:
    type: string
    description: The research question to answer
  angles:
    type: number
    description: Roughly how many distinct search angles to cover
  minSupport:
    type: number
    description: Distinct sources a claim needs before it is reported as supported
example: Research whether "{{question}}" with citations
---

# Outcome

Answer the research question using only claims that survived cross-checking
against independent sources. Cite a source URL next to each claim. Say
explicitly when the evidence is thin, contested, or one-sided — an honest "the
sources disagree" beats a confident synthesis of weak material.

# Coordinator guidance

Plan before searching: decompose the question into several genuinely different
search angles (technical, historical, comparative, adoption, criticism). Three
to five angles usually cover a question; add more only when the question is
genuinely multi-domain.

Fan the angles out as independent research Agents or research-oriented skills.
Each researcher should search, read the most relevant results, and return
concrete claims each tagged with the exact source URL it came from. A claim
without a fetchable source is dropped, not repaired. Instruct researchers to
report only what the fetched pages actually say and to say "not found" rather
than filling gaps.

Cross-check before writing: group claims that assert the same fact across
different URLs. Keep a claim supported by several distinct sources or one
clearly authoritative source; discard single-source weak claims and flag
conflicts rather than silently picking a side.

Synthesize in the main context: a structured answer to the question, inline
citations, a short note on what was discarded and why, and the residual
uncertainty. Do not pad with claims that did not survive cross-checking.

Scale to the question: a quick factual check may need one researcher and no
fan-out; a contested or fast-moving topic deserves more angles and a stricter
`minSupport`.
