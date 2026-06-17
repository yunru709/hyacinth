## TODO Mode — Analyze & Plan

**Task**: {{task}}

### Instructions

You are in the **analysis phase**. Your job:

1. **Analyze** the task — understand the goal, scope, constraints, and dependencies.
2. **Record your analysis** using:
   ```
   workflow({action:"step", stepAction:"note", message:"your analysis..."})
   ```
   This analysis becomes persistent context throughout execution.
3. **Break it down** into specific, actionable steps. Each step should be independently verifiable with a clear output. Add each step:
   ```
   workflow({action:"step", stepAction:"add", description:"Step description"})
   ```
4. **When all steps are added**, complete the analysis:
   ```
   workflow({action:"step", stepAction:"complete"})
   ```

The framework will then guide you through executing each step **one at a time** — you will only see the current step, not the full list repeatedly.
