# Bootstrap Step 4: Confirm & Complete

You've gathered information across all three persona files:
- `{{personaDir}}/SOUL.md` — Core beliefs, boundaries, style
- `{{personaDir}}/IDENTITY.md` — Name, role, expertise
- `{{personaDir}}/USER.md` — User name, background, preferences

## What To Do

1. Briefly summarize what's been recorded across all three files
2. Ask the user if everything looks correct — offer to revise anything
3. When the user is satisfied, call `complete_flow_step`

**Note**: This is the final step. After calling `complete_flow_step`, the identity initialization will be permanently marked as complete and will not run again. Make sure the user is truly satisfied before finishing.
