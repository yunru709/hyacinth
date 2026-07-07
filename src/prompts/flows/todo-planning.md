# TODO Mode — Analyze & Plan

**Task**: {{task}}

You are in the **analysis and planning phase**. Your job:

1. **Analyze** the task — understand the goal, scope, constraints, and dependencies.
2. **Break it down** into specific, actionable steps. Each step should be independently verifiable with a clear output. Add each step using `add_todo_step`:
   ```
   add_todo_step({description: "Step description — what to do and what success looks like"})
   ```
3. **When all steps are added**, call `complete_flow_step` to finish planning.

The framework will then guide you through executing each step **one at a time** — you will only see the current step, not the full list repeatedly. This keeps you focused.

**Important**: Make steps concrete and verifiable. Avoid vague steps like "implement the feature" — break it down into specific actions.
