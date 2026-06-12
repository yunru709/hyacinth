---
name: subagent-adversarial-collaboration
description: Multi-agent adversarial collaboration pattern requirement for sub-agent system design
metadata:
  type: project
---

Sub-agent system must support adversarial collaboration patterns, not just task-splitting:

**Pattern verified in practice** (2026-05-24): The user runs a "需求方 → 主执行agent → 多个独立审查agent → 修改agent" loop, where review agents work in isolation from each other to avoid context pollution and maximize blind-spot discovery.

**Key requirements for sub-agent design:**
- Context isolation: each sub-agent gets its own independent context window. No shared mutable state.
- Adversarial review loops: multiple RISC (template) sub-agents can independently assess the same output, and their results are compared/merged.
- Mailbox communication (CodeWhale pattern): sub-agents exchange results via message queue, not shared memory.
- CISC vs RISC distinction: RISC = fixed templates (code review, debug), CISC = runtime-created for novel tasks.

**Why:** The user's audit proved this works — two independent TRAE review agents each found things the other missed, and the adversarial process produced a more accurate completion assessment (80%→75% corrections).