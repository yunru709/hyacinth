# Global Bootstrap Mode Design

## Why

The first-run identity bootstrap is a staged task, but the current implementation treats it like a conditional prompt plus a file-deletion signal. This makes it easy to retrigger per session, skip in some startup paths, or complete without verifying that persona files were actually written.

## What Changes

- Add a dedicated `bootstrap` mode alongside `plan`, `spec`, and `todo`.
- Store bootstrap state globally, not in a session directory.
- Move bootstrap instructions from `persona/BOOTSTRAP.md` semantics into a mode prompt such as `prompts/modes/bootstrap.md`.
- Trigger bootstrap automatically only when the global persona state is incomplete.
- Complete bootstrap only after required global persona files are written and validated.
- Stop injecting bootstrap guidance immediately after completion.

## Scope

In scope:

- Global persona bootstrap lifecycle.
- Startup detection and automatic activation.
- Mode prompt injection through the existing `mode-injection` Zone 5 path.
- Completion state persisted in global persona state.
- TUI and non-TUI startup consistency.

Out of scope:

- Provider installation and API key setup.
- Changing normal `plan`, `spec`, or `todo` behavior.
- Project-specific persona profiles beyond optional future override support.

## Storage

Use a global persona directory as the default identity source:

```text
~/.agent/
  prompts/
    persona/
      SOUL.md
      IDENTITY.md
      USER.md
      .state/
        persona-state.json
```

The project-level `.agent/prompts/persona` directory may remain as an override mechanism, but first-run identity bootstrap writes to the global persona directory.

The state file records at least:

```json
{
  "version": 1,
  "bootstrapSeededAt": "ISO timestamp",
  "setupCompletedAt": "ISO timestamp"
}
```

`setupCompletedAt` is the source of truth for completion. Deleting a prompt file is not a completion signal.

## Startup Flow

1. Load normal install/config state.
2. Resolve the global persona directory.
3. Ensure global `SOUL.md`, `IDENTITY.md`, and `USER.md` exist.
4. Read global persona state.
5. If `setupCompletedAt` exists, start normally.
6. If `setupCompletedAt` is missing, activate `bootstrap` mode before the first model turn.
7. The first model turn is initiated automatically so the Agent greets the user and starts collecting identity preferences.
8. Bootstrap mode remains active across turns until completion.
9. On completion, write state, deactivate the mode, and continue normal conversation without bootstrap injection.

## Bootstrap Mode Behavior

`bootstrap` is a framework mode, not a normal task mode users are expected to activate for daily work.

It should:

- Prompt the Agent to greet the user naturally.
- Collect Agent identity fields: name, role, style, boundaries, optional symbol.
- Collect user fields: name, preferred address, timezone, background, preferences.
- Collect collaboration preferences: initiative level, confirmation boundaries, coding style.
- Ask follow-up questions only when required information is missing.
- Write persona files with existing tools or a dedicated persona write helper.
- Mark completion only after validation passes.

## Completion Contract

Bootstrap can complete when all of the following are true:

- `IDENTITY.md` no longer contains the untouched template placeholders.
- `USER.md` no longer contains the untouched template placeholders.
- `SOUL.md` exists and remains usable as the long-term style/behavior guide.
- The user has either explicitly confirmed the captured identity information or the Agent has summarized it and received no correction in the final bootstrap turn.

After completion:

- Write `setupCompletedAt`.
- Deactivate `bootstrap` mode.
- Do not inject `bootstrap` prompt again in new sessions.

## Components

### `BootstrapMode`

New mode definition implementing the existing `ModeDefinition` interface:

- `createState()` initializes global persona paths and required fields.
- `renderForInjection()` renders `prompts/modes/bootstrap.md`.
- `handleToolCall()` accepts progress markers or a completion marker.
- `isComplete()` returns true only after validation.

### `PersonaBootstrapStore`

Small global store for:

- Resolving the global persona directory.
- Ensuring template files exist.
- Reading and writing persona state.
- Validating whether persona files are still templates.
- Marking bootstrap complete.

Existing `persona-bootstrap.ts` can be refactored into this role.

### Startup Integration

Both TUI and non-TUI creation paths should pass the same global persona state into `createAgent`.

If bootstrap is incomplete, `createAgent` or the gateway activates `bootstrap` mode before the first turn. The activation should not depend on a session-specific file.

### Prompt Loading

Long-term persona loading should prefer:

1. Project override, if explicitly present and intended.
2. Global persona files.
3. Built-in templates as fallback.

Bootstrap mode prompt should be loaded from `prompts/modes/bootstrap.md`, not from `persona/BOOTSTRAP.md`.

## Error Handling

- If persona files cannot be written, keep bootstrap active and report the write failure.
- If validation fails, keep bootstrap active and inject the missing fields in the next turn.
- If the user exits mid-bootstrap, keep state incomplete so the next session resumes bootstrap.
- If global state says complete but persona files are missing, recreate missing files and mark bootstrap incomplete.

## Testing

Unit tests:

- Global store creates missing persona files.
- Incomplete state activates bootstrap.
- Complete state does not activate bootstrap.
- Template files fail validation.
- Filled files pass validation.

Integration tests:

- First TUI startup activates bootstrap once.
- First non-TUI startup follows the same activation rule.
- Completing bootstrap writes global state and stops injection.
- New session after completion does not reinject bootstrap.

## Completion Tool

Use a dedicated `bootstrap_mark` tool instead of reusing `task_mark`.

The tool should support at least:

- `bootstrap_mark({ action: "progress", message })` for recording what has been collected.
- `bootstrap_mark({ action: "complete" })` for requesting completion after files have been written.

The mode still performs validation before accepting completion. If validation fails, the tool result explains what is missing and bootstrap mode remains active.
