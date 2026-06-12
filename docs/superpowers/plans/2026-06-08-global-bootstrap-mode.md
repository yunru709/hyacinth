# Global Bootstrap Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace session/file-deletion bootstrap with a global first-run `bootstrap` mode that writes persona files once and then stops injecting.

**Architecture:** Reuse the existing `ModeManager` lifecycle and Zone 5 `mode-injection` path. Add a global persona bootstrap store, a `bootstrap` mode, and a dedicated `bootstrap_mark` tool; startup code activates the mode only when global persona state is incomplete.

**Tech Stack:** TypeScript, Node.js ESM, Vitest, existing `ModeDefinition`, `ConfigManager`, and prompt loader patterns.

---

### Task 1: Global Persona Store

**Files:**
- Modify: `src/setup/persona-bootstrap.ts`
- Test: `src/setup/persona-bootstrap.test.ts`

- [ ] Add tests for global directory resolution, template creation, validation, and completion state.
- [ ] Refactor `DEFAULT_PERSONA_DIR` to resolve under `~/.agent/prompts/persona` by default.
- [ ] Add `ensureGlobalPersonaFiles()`, `validatePersonaFiles()`, `isBootstrapComplete()`, and `markBootstrapComplete()`.
- [ ] Keep compatibility wrappers for existing callers where practical.
- [ ] Run `pnpm test src/setup/persona-bootstrap.test.ts`.

### Task 2: Bootstrap Mode

**Files:**
- Create: `src/modes/bootstrap.mode.ts`
- Modify: `src/modes/index.ts`
- Create: `src/prompts/modes/bootstrap.md`
- Test: `src/modes/bootstrap.mode.test.ts`

- [ ] Add a failing test that `bootstrap` renders mode guidance and stays active before completion.
- [ ] Add a failing test that `bootstrap_mark({ action: "complete" })` only completes after validation passes.
- [ ] Implement `createBootstrapMode(personaDir)` using the existing `ModeDefinition` interface.
- [ ] Add prompt instructions for natural first-run identity collection and persona file writing.
- [ ] Export the mode from `src/modes/index.ts`.
- [ ] Run `pnpm test src/modes/bootstrap.mode.test.ts`.

### Task 3: Bootstrap Mark Tool

**Files:**
- Create: `src/tools/bootstrap.ts`
- Modify: `src/gateway/factory.ts`
- Test: `src/tools/bootstrap.test.ts`

- [ ] Add a failing test for `bootstrap_mark` returning progress and completion errors.
- [ ] Implement a small tool that delegates `progress` and `complete` actions to `ModeManager.dispatchToolCall()`.
- [ ] Register `bootstrap_mark` in `createAgent()` after `ModeManager` exists.
- [ ] Ensure `bootstrap_mark` is available during bootstrap even when tool bundles are active.
- [ ] Run `pnpm test src/tools/bootstrap.test.ts`.

### Task 4: Startup Integration

**Files:**
- Modify: `src/gateway/cli.ts`
- Modify: `src/gateway/tui.ts`
- Modify: `src/gateway/factory.ts`
- Modify: `src/orchestrator/loop.ts`
- Test: focused integration/unit tests if existing gateway tests permit

- [ ] Ensure both TUI and non-TUI paths call the same global persona status helpers.
- [ ] Register `bootstrap` mode in `createAgent()` and auto-activate it when global state is incomplete.
- [ ] Trigger an automatic first model turn when bootstrap is active.
- [ ] Remove reliance on deleting `BOOTSTRAP.md` as the completion signal.
- [ ] Keep `startBootstrap()` as a compatibility wrapper around the new active mode if needed.
- [ ] Run `pnpm test` or the narrowest available test set.

### Task 5: Prompt Loading and Backward Compatibility

**Files:**
- Modify: `src/context/section-resolver.ts`
- Modify: `src/prompts/persona/BOOTSTRAP.md`
- Test: covered by previous tests or add resolver test if available

- [ ] Prefer project persona override, then global persona files, then built-in templates for `SOUL/IDENTITY/USER`.
- [ ] Stop using `persona/BOOTSTRAP.md` as a stateful bootstrap prompt.
- [ ] Turn `BOOTSTRAP.md` into a legacy note or leave it unused for compatibility.
- [ ] Verify compose output includes bootstrap only through `mode-injection`.

### Task 6: Final Verification

**Files:**
- All changed files

- [ ] Run `pnpm test`.
- [ ] Run `pnpm build`.
- [ ] Inspect changed files for accidental secrets or home-directory writes beyond intended global persona defaults.
- [ ] Summarize final behavior and any test gaps.
