---
name: project-docs
description: >-
  Generates a docs/project/ knowledge base for an already-analyzed repository:
  overview.md (plain-language project overview), components.md (reusable
  component and screen inventory), patterns.md (state management, API,
  navigation, and styling conventions), and integrations.md (SDKs, APIs,
  external services — names only, no secrets). Requires CLAUDE.md to exist
  (run project-analysis first). Never modifies source code. Part of the
  project-inspector workflow.
---

# Project Docs Skill

## Purpose

Generate a `docs/project/` knowledge base that serves two audiences:

- **People writing feature specs** — a plain-language overview and an inventory of existing screens/components, so specs reuse what exists instead of re-inventing it.
- **Claude in future sessions** — component, pattern, and integration facts available without a fresh full scan.

This skill is step 2 of the project-inspector workflow:

1. `project-analysis` creates `CLAUDE.md` and `AUDIT.md`.
2. `project-docs` (this skill) creates the `docs/project/` knowledge base.
3. `audit-breakdown` expands one audit topic at a time into a Draft audit.
4. `audit-sync` syncs approved audit findings into `CLAUDE.md`.

This skill is a reading and mapping skill. It is not a full audit, implementation review, refactor plan, task generator, or feature documentation generator.

## Precondition: CLAUDE.md Must Exist

Before doing anything else, check the repository root for `CLAUDE.md`.

If it is missing, output:

> ❌ **CLAUDE.md not found.** This skill builds on the project context created by `project-analysis`.
> Please run `/inspect` (the project-analysis stage) first, then return here.

And stop. Do not continue.

## Output Contract

This skill generates only:

```text
<repository-root>/docs/project/overview.md
<repository-root>/docs/project/components.md
<repository-root>/docs/project/patterns.md
<repository-root>/docs/project/integrations.md
```

It must not create any other file under `docs/`, must not modify `CLAUDE.md` or `AUDIT.md`, and must never modify source code.

## Step 1: Ask the Developer

```text
I'll need a few details before generating the project docs:

1. Repository folder: What is the full path to the local repository?

2. Stack focus: Is this React Native, Native iOS/Android, web, or another stack?
   (This shapes what I inventory — screens, components, hooks, navigators, etc.)

3. Existing docs/project/ files: If any already exist, should I:
   - Overwrite — replace them entirely
   - Update — preserve useful existing structure and refresh content
   - Preserve — skip existing files
   - Version — save old copies as .bak before writing new ones

4. Source code safety: Should all source code remain completely unchanged?
   Default: Yes — I will only read files and only write the four docs/project/ files.
```

Wait for the developer's answers before proceeding.

## Step 2: Confirmation Summary

```text
Here's what I'm about to do:

- Repository: <path>
- Stack focus: <react-native / native / web / other>
- Existing docs handling: <overwrite / update / preserve / version>
- Source code: Read-only — no source files will be modified

I will generate or update:
  ✓ docs/project/overview.md      — plain-language project overview
  ✓ docs/project/components.md    — screen & reusable component inventory
  ✓ docs/project/patterns.md      — coding patterns and conventions
  ✓ docs/project/integrations.md  — SDKs, APIs, services (names only)

I will not modify:
  ✗ CLAUDE.md
  ✗ AUDIT.md
  ✗ audits/
  ✗ any source code

Shall I proceed?
```

Only begin after explicit approval.

## Step 3: Read Existing Context First

Before scanning source, read what already exists — do not rediscover known facts:

1. `CLAUDE.md` — stack, structure, key modules, conventions.
2. `AUDIT.md` (if present) — architecture summary, module table, cross-cutting observations.
3. `audits/**/*.md` (if present) — verified findings about specific areas.

Use source inspection to fill the gaps these files leave, not to repeat them.

## Step 4: Targeted Inspection

Inspect the repository directly using read-only commands, one focused pass per output file:

- For `components.md`: inventory all screens, reusable UI components, and shared hooks — name, path, one-line purpose. Note duplicates and deprecated-looking components.
- For `patterns.md`: identify the state management, data fetching, navigation, styling, error handling, and i18n patterns actually used, with representative file paths.
- For `integrations.md`: list third-party SDKs, backend APIs, auth, analytics, push, and payment integrations from dependency manifests and imports. Names and purposes only — no keys or secret values.
- For `overview.md`: describe the app in plain language — what it does, main features/screens, user roles, high-level architecture.

Rules:

- Do not fabricate. Mark unverifiable items as `Unknown`.
- Variable names only from env/sample files — never values.
- Prefer file paths and symbol names over vague descriptions.

## Step 5: Shell Execution Rules

Repository inspection must be strictly read-only. Follow
[`docs/shell-execution-rules.md`](../../docs/shell-execution-rules.md) in full: the allowed
command list, the command-shape rules, and the forbidden list live there and are not
restated here.

- Do not use output redirection except when writing the four generated artifacts through the normal workflow.

## Step 6: Existing File Handling

| Developer choice | Action |
|------------------|--------|
| Overwrite | Replace the target files directly |
| Update | Preserve useful existing structure and refresh content |
| Preserve | Skip files that already exist |
| Version | Save `<file>.bak`, then write new files |

Never modify source code.

## Step 7: Generate the Four Files

Use the embedded templates below as the exact structure for each file. No external template files are required.

Writing rules:

- `overview.md` is written for non-developers: plain language, no code jargon, explain acronyms.
- `components.md` and `patterns.md` are written for developers and Claude: concrete paths and symbols.
- Adapt terminology to the stack (screens/navigators for RN, ViewControllers/Activities for native, routes/pages for web).
- Keep each file focused and scannable; tables over prose where the template uses tables.
- If a template section does not apply, write `Not applicable — <reason>` rather than deleting it.
- Never reproduce secret values, tokens, private keys, or credentials — variable names only.

### overview.md Template

```markdown
# Project Overview — {{PROJECT_NAME}}

> Auto-generated by the project-inspector plugin (project-docs skill).
> Audience: product and anyone who needs to understand the project without reading code.
> Generated: {{GENERATED_DATE}}

## What This Project Is

{{WHAT_IT_IS}}

## Who Uses It

{{USERS_AND_ROLES}}

## Main Features / Screens

| Feature / Screen | What it does | Entry point |
|------------------|--------------|-------------|
{{FEATURES_TABLE}}

## High-Level Architecture

{{ARCHITECTURE_PLAIN_LANGUAGE}}

## Platforms and Stack (Plain Language)

{{STACK_PLAIN_LANGUAGE}}

## Key Terms and Domain Glossary

| Term | Meaning in this project |
|------|------------------------|
{{GLOSSARY_TABLE}}

## Where Things Live

| Area | Location |
|------|----------|
| Feature specs | {{SPECS_LOCATION}} |
| Design documents | {{DESIGN_DOCS_LOCATION}} |
| Audit reports | audits/ |
| AI project context | CLAUDE.md |

## Known Limitations and Caution Areas (Non-Technical Summary)

{{LIMITATIONS_SUMMARY}}

## Unknowns

{{UNKNOWNS}}
```

### components.md Template

```markdown
# Component Inventory — {{PROJECT_NAME}}

> Auto-generated by the project-inspector plugin (project-docs skill).
> Audience: spec writers and developers checking what already exists before speccing or building a feature.
> Generated: {{GENERATED_DATE}}

## How to Use This File

Before writing a spec or design doc for a new feature, check here whether a screen, component, or flow already exists that the feature should reuse. Each entry lists the file path so it can be inspected directly.

## Screens

| Screen | Path | Purpose | Notes |
|--------|------|---------|-------|
{{SCREENS_TABLE}}

## Reusable UI Components

| Component | Path | Purpose | Reuse notes |
|-----------|------|---------|-------------|
{{COMPONENTS_TABLE}}

## Shared Hooks / Utilities

| Name | Path | Purpose |
|------|------|---------|
{{HOOKS_UTILITIES_TABLE}}

## Navigation Map

{{NAVIGATION_MAP}}

## Design System / Theming

{{DESIGN_SYSTEM_NOTES}}

## Known Duplicates or Deprecated Components

{{DUPLICATES_AND_DEPRECATED}}

## Unknowns

{{UNKNOWNS}}
```

### patterns.md Template

```markdown
# Patterns and Conventions — {{PROJECT_NAME}}

> Auto-generated by the project-inspector plugin (project-docs skill).
> Audience: developers and Claude Code — how things are done in this codebase.
> Generated: {{GENERATED_DATE}}

## State Management

{{STATE_MANAGEMENT}}

## Data Fetching / API Conventions

{{API_CONVENTIONS}}

## Navigation Patterns

{{NAVIGATION_PATTERNS}}

## Styling Conventions

{{STYLING_CONVENTIONS}}

## Error Handling Patterns

{{ERROR_HANDLING}}

## Localization / RTL

{{LOCALIZATION}}

## Naming and Folder Conventions

{{NAMING_CONVENTIONS}}

## Testing Patterns

{{TESTING_PATTERNS}}

## Patterns to Avoid (Observed Anti-Patterns)

{{ANTI_PATTERNS}}

## Unknowns

{{UNKNOWNS}}
```

### integrations.md Template

```markdown
# External Integrations — {{PROJECT_NAME}}

> Auto-generated by the project-inspector plugin (project-docs skill).
> Names and purposes only — never keys, tokens, or secret values.
> Generated: {{GENERATED_DATE}}

## Backend Services / APIs

| Service / API | Used for | Where in code |
|---------------|----------|---------------|
{{BACKEND_SERVICES_TABLE}}

## Third-Party SDKs

| SDK | Purpose | Where in code |
|-----|---------|---------------|
{{SDKS_TABLE}}

## Authentication

{{AUTH_SUMMARY}}

## Analytics / Crash Reporting

{{ANALYTICS_SUMMARY}}

## Push Notifications

{{PUSH_SUMMARY}}

## Payments / Billing

{{PAYMENTS_SUMMARY}}

## Environment Configuration

Environment variable names detected from sample/template files only (values never reproduced):

{{ENV_VAR_NAMES}}

## Unknowns

{{UNKNOWNS}}
```

## Step 8: Completion Report

After writing the files, report:

```text
Project docs complete.

Files written:
  ✓ <target-path>/docs/project/overview.md
  ✓ <target-path>/docs/project/components.md
  ✓ <target-path>/docs/project/patterns.md
  ✓ <target-path>/docs/project/integrations.md

Files intentionally not modified:
  ✗ CLAUDE.md
  ✗ AUDIT.md
  ✗ audits/

Next steps:
1. Review the four files, especially components.md accuracy.
2. Continue to audit-breakdown (via /inspect-approve, or /inspect-topic <topic>) to expand
   the first audit topic from AUDIT.md.
3. Re-run this stage after major refactors to keep the inventory fresh.
```

## Hard Constraints

- Never run without `CLAUDE.md` present — stop and point to `project-analysis`.
- Never modify source code.
- Only write the four files in the Output Contract.
- Never modify `CLAUDE.md`, `AUDIT.md`, or `audits/`.
- Never clone remote repositories.
- Never read or reproduce actual secret values; variable names only.
- Never reproduce credentials, tokens, private keys, or secrets from any file.
- Never proceed without explicit developer confirmation after the Step 2 summary.
- Never assume the current working directory is the target repository. Write every artifact under the absolute `<TARGET_ROOT>` passed by the orchestrator; never resolve the root from CWD or `git rev-parse --show-toplevel`, and never write to any path containing `.claude/worktrees/`. If the provided root contains that segment, stop and report instead of writing.
- Do not depend on external template files; the required templates are embedded in this `SKILL.md`.
