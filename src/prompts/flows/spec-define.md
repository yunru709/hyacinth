# Spec Definition — 撰写需求文档

**Task**: {{task}}
**Target directory**: {{specDir}}

You are in the **spec definition phase**. Write all three files at once:

### 1. `{{specDir}}/spec.md` — Requirements Spec
```markdown
# <Title> Spec

## Why
<Why this change is needed — the problem or motivation>

## What Changes
<High-level description of what will change>

## Impact
- Affected specs: <related specs>
- Affected code: <files/modules to be modified>

## ADDED Requirements

### Requirement: <name>
<Description>

#### Scenario: <name>
- **WHEN** <condition>
- **THEN** <expected outcome>
- **AND** <additional outcomes>

## MODIFIED Requirements (if any)

## REMOVED Requirements (if any)
```

### 2. `{{specDir}}/tasks.md` — Task Breakdown
```markdown
# Tasks

- [ ] Task 1: <concise title>
  - [ ] <specific SubTask>
  - [ ] <specific SubTask>

- [ ] Task 2: <concise title>
  - [ ] <specific SubTask>

# Task Dependencies
- Task 2 depends on Task 1
```

Every Task MUST have at least 2 SubTasks. Use `- [ ]` (unchecked) for all items.

### 3. `{{specDir}}/checklist.md` — Verification Checklist
```markdown
# Checklist

- [ ] <verifiable outcome matching each SubTask>
- [ ] <final integration validation>
```

Every SubTask from tasks.md MUST have a corresponding checklist item. Each item MUST be independently verifiable.

**Write all three files now. When done, call `flow_complete`.**
