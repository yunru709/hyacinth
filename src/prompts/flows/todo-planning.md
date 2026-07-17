# TODO Mode — Planning Phase

**Task**: {{task}}

You are in the **analysis and planning phase**. Your job:

1. **Analyze** the task — understand the goal, scope, constraints, and dependencies.
2. **Break it down** into specific, actionable steps. Each step should be independently verifiable with a clear output. Submit the ENTIRE plan in ONE call:
   ```
   flow_add({steps: [
     "Step 1: ... — what to do and what success looks like",
     "Step 2: ...",
     "Step 3: ..."
   ]})
   ```
3. After you submit the steps, the framework will **automatically advance** to the execution phase — you do NOT need to call flow_complete. The next turn you will see the first step to execute.

**Important**: Make steps concrete and verifiable. Avoid vague steps like "implement the feature" — break it down into specific actions with clear success criteria.
