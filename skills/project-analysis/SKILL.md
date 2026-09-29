---
name: project-analysis
description: >-
  Understands an existing local software repository and generates exactly two
  AI-ready project context artifacts: CLAUDE.md and AUDIT.md. AUDIT.md must be
  a concise audit topic index, not a detailed audit report. This is the first
  step in a multi-skill workflow. It identifies audit topics that can later be
  expanded one-by-one by the audit-breakdown skill. It does not create an
  audits/ directory and does not create detailed audit files.
---

# Project Analysis Skill

## Purpose

Understand a local repository well enough to produce two AI-ready artifacts:

- `CLAUDE.md` — compact project context for Claude Code sessions.
- `AUDIT.md` — concise repository overview and audit topic index.

This skill is a reading and mapping skill. It is not a full audit, implementation review, refactor plan, task generator, or feature documentation generator.

## Output Contract

This skill generates only:

```text
<TARGET_ROOT>/CLAUDE.md
<TARGET_ROOT>/AUDIT.md
```

`<TARGET_ROOT>` is the absolute repository root the orchestrator passes in (resolved via `scripts/resolve-repo-root.ts`, with any Claude agent worktree already unwrapped to the main working tree). Always write to that absolute path. Never resolve the root yourself from the current working directory or `git rev-parse --show-toplevel`, and never write to any path containing `.claude/worktrees/`.

This skill must not create:

```text
<repository-root>/audits/
<repository-root>/audits/*.md
```

Detailed audit files are created later by `audit-breakdown`, one topic at a time, only after developer approval.

## Core Workflow

1. Ask the developer for repository details.
2. Show a confirmation summary.
3. Wait for explicit approval.
4. Inspect the repository using read-only commands only.
5. Generate `CLAUDE.md` using the embedded `CLAUDE.md Template` in this file.
6. Generate `AUDIT.md` using the embedded `AUDIT.md Template` in this file.
7. Report completion and recommend the first `audit-breakdown` topic.

No external template files are required.

---

## Step 1: Ask the Developer

Before scanning, ask these questions exactly enough to resolve execution:

```text
I'll need a few details before starting the analysis:

1. Repository folder: What is the full path to the local repository you want analyzed?

2. Scope: Should I analyze the entire repository, or focus on a specific folder or module?

3. Existing artifacts: If CLAUDE.md or AUDIT.md already exist, should I:
   - Overwrite — replace them entirely
   - Update — preserve useful existing structure and refresh content
   - Preserve — skip existing files
   - Version — save old copies as .bak before writing new ones

4. Source code safety: Should all source code remain completely unchanged?
   Default: Yes — I will only read files and only write CLAUDE.md / AUDIT.md.
```

Wait for the developer's answers before proceeding.

---

## Step 2: Confirmation Summary

After the developer answers, show:

```text
Here's what I'm about to do:

- Repository: <path>
- Scope: <entire repo / specific folder>
- Existing artifacts: <overwrite / update / preserve / version>
- Source code: Read-only — no source files will be modified

I will generate or update:
  ✓ CLAUDE.md — project context for AI-assisted development
  ✓ AUDIT.md  — repository overview and audit topic index

I will not create:
  ✗ audits/
  ✗ audits/*.md

Shall I proceed?
```

Only begin scanning after explicit approval.

---

## Step 3: Repository Inspection

Inspect the repository systematically and incrementally. Prefer small commands over long chained commands.

Collect only the information needed to populate the two embedded templates:

- Project identity: README, package/build files, license.
- Tech stack: languages, frameworks, package managers, platforms.
- **Targets and surfaces** — discovered from real project/build files, never from the README's marketing claims or from the stack alone: Xcode projects/schemes/`.xcconfig` and project generators (`project.yml`, `Project.swift`), Gradle modules/flavors/build types and each module's `AndroidManifest.xml`, `package.json` scripts and bundler configs, RN/Expo app config, Smart TV app descriptors (e.g. `config.xml`, `appinfo.json`). One surface per independently built/shipped target (a scheme, a module, a flavor, a bundle target). See "Targets and Surfaces rules" below.
- **Shared vs target-specific source roots** — which folders each surface builds from, and which roots are shared between surfaces and by what mechanism (target membership, a local package/module dependency, conditional compilation, platform file extensions, a shared source folder).
- Build/run/test commands: scripts, Makefile, CI config, README instructions.
- Repository structure: top-level tree, key modules, entry points.
- Configuration: sample env files, config folders, feature flags; variable names only.
- Conventions: linters, formatters, code style, contribution docs.
- External integrations: SDKs, APIs, analytics, crash reporting, auth, payment, media, DRM, push, cloud providers.
- High-level risk signals: large files/classes, singletons/global state, cross-layer coupling, old dependencies, missing tests, missing CI, sensitive areas.

Do not write detailed findings during this step. Convert observations into audit topics for `AUDIT.md`.

---

## Step 4: Shell Execution Rules

Repository inspection must be strictly read-only. Follow
[`docs/shell-execution-rules.md`](../../docs/shell-execution-rules.md) in full: the allowed
command list, the command-shape rules, and the forbidden list live there and are not
restated here.

- Do not use output redirection except when writing the final generated artifacts through the normal workflow.

---

## Step 5: Existing Artifact Handling

Before writing, check whether `CLAUDE.md` or `AUDIT.md` already exist.

| Developer choice | Action |
|------------------|--------|
| Overwrite | Replace generated artifacts directly |
| Update | Preserve useful existing structure and refresh content |
| Preserve | Skip existing files |
| Version | Save `CLAUDE.md.bak` / `AUDIT.md.bak`, then write new files |

**Update mode must preserve approved inspection work.** Update is the mode the orchestrator uses for **Refresh Project Knowledge** on a completed inspection, and a deterministic guard (`scripts/knowledge-refresh-guard.ts`) verifies the result afterwards. In Update mode:

- Keep every existing `## Audit Topics` row: same topic name, same `Status`, same `File` reference. Never reset a topic to `Pending Breakdown`, never change `Draft` or `Approved`, never rewrite a `File` path, and never delete a row. Keep any `Approved <YYYY-MM-DD>` note `audit-approve` wrote in `Notes` (you may append to `Notes`, not replace it).
- You may append a **new** topic row (next `#`, `Pending Breakdown`, `Not created yet`) when the source changed enough to warrant one.
- Copy both `<!-- audit-sync:important-files:... -->` and `<!-- audit-sync:caution-areas:... -->` blocks from the existing `CLAUDE.md` byte-for-byte, markers included. Their content belongs to `audit-sync`; do not reset them to the template placeholder.
- Refresh everything else — overview, stack, commands, structure, the `Targets and Surfaces` section, the `repo-knowledge:facts` block, cross-cutting observations — from the current source. A `CLAUDE.md` written before the surfaces model existed has no `## Targets and Surfaces` section: add it.

Never modify source code.

---

## Step 6: Generate CLAUDE.md

Generate `CLAUDE.md` using the embedded template below.

Rules:

- Target 600–1100 words (the surfaces table is compact; do not pad it).
- Write for Claude Code as the reader.
- Prefer concise bullets and tables.
- Include practical commands when confidently detected.
- Mark uncertain items as `Unknown` rather than guessing.
- Keep the file useful as compact working context, not a long documentation report.
- Preserve the `<!-- audit-sync:important-files:... -->` and `<!-- audit-sync:caution-areas:... -->` marker pairs exactly as written in the template. Leave their placeholder text in place — the `audit-sync` skill regenerates the content between these markers from Approved audit topics later. Do not populate them yourself and do not remove them.
- Preserve the `<!-- repo-knowledge:facts:start -->` / `<!-- repo-knowledge:facts:end -->` marker pair exactly as written, and populate the block with the **same values** you wrote into the prose sections above it. This block is the machine-readable form of the Tech Stack and Commands sections — it exists so the `repo-knowledge` skill can index them deterministically instead of parsing prose. Rules for it:
  - Use only `key: value` and `key: [a, b, c]` — no nesting, no multi-line values, no comments.
  - List values are comma-separated inside square brackets. A single value is still a valid list: `languages: [Swift]`.
  - Write `Unknown` for any value you could not determine confidently. Never guess — `Unknown` is read as "not known" and the consumer derives it itself, whereas a wrong value silently misleads every downstream plugin.
  - Never write a secret, credential, or environment-variable **value** here. Variable names only, consistent with this skill's other constraints.
  - Do not add keys beyond the nine shown in the template.
- Populate `## Targets and Surfaces` exactly as the "Targets and Surfaces rules" below describe. Its table headers are parsed deterministically: never rename, reorder, or drop a column.
- Keep `## External Integrations` to a two-to-four-line summary plus the pointer to `docs/project/integrations.md`. The full inventory belongs to `project-docs`; restating it here creates two sources of truth for the same facts that then drift apart.

### Targets and Surfaces rules

A **surface** is one independently built/shipped target of this repository (an app target or scheme, a Gradle app module or flavor, a bundle target, a TV app package). A repository has one or many; a single-surface repository still gets exactly one row.

- **Surface** — a stable lowercase slug you choose from the repository's own naming (`ios`, `tvos`, `android-mobile`, `android-tv`, `web`, `tizen`, `paid-flavor`, …). Unique. Later documents reference surfaces only by this id, so keep it stable across refreshes.
- **Platform** — the platform as the repository targets it (e.g. `iOS`, `tvOS`, `Android TV`, `React web`, `Samsung Tizen (React)`).
- **Form factor** — exactly one of `handheld`, `desktop`, `tv`, `wearable`, `other`. This is an Inspector-neutral description of the device class, **not** the Dev Plugin's `device_type` and not a routing decision; never write `mobile`, `phone`, or any other value.
- **Build selector** — how this surface is selected when building: a scheme, a module/flavor/variant, a script, a bundler mode. Quote literal names in backticks.
- **Source roots** — the surface's own (target-specific) roots, as backticked repo-relative paths; a directory ends with `/`.
- **Shared with** — the other surface ids this surface shares code with, or `None`.
- **Packaging** — the shipped artifact / deployment shape as the repository configures it (IPA, AAB, APK, `.wgt`, `.ipk`, static bundle, SSR server, …).
- **Minimum OS / runtime** — only as **declared in the repository's build files** (deployment target, `minSdk`, a descriptor's required version). If nothing declares it, write `Not declared`. Never fill it from what you know about the platform.
- **Evidence** — at least one evidence ref proving the row, in the form `path` or `path::token` (the token must literally occur in that file, e.g. `` `App.xcodeproj/project.pbxproj::TVOS_DEPLOYMENT_TARGET = 17.0` ``). Evidence is repository source/build files — never `CLAUDE.md`, `AUDIT.md`, `docs/project/**`, `audits/**`, or `.ono/**`.

Under `### Shared Code`, list each source root shared by two or more surfaces, which surfaces share it, the mechanism, and evidence for the mechanism. For a single-surface repository replace the whole table with `Not applicable — single surface.`

Never flatten: two surfaces with different build selectors, roots, packaging or minimums are two rows, and a fact true for only one surface is written only on that surface's row. Never invent a surface the build files do not define.

The after-hook runs `scripts/knowledge-evidence.ts verify <TARGET_ROOT> surfaces`, which resolves every source root and evidence ref against the current source; a row that cannot be proven stops the stage.

### Evidence and volatile knowledge

Every persisted fact must answer "where in THIS repository did this come from?". Persist repository facts only (what the repository's code, build files and repository docs say). Do **not** persist volatile platform knowledge — current SDK or OS release notes, OS capabilities, vendor bugs, store policy, recommended practices — even when you know it. If the repository contains a workaround for such an issue, record the workaround, its source location, and the local trigger/condition if visible — not the vendor claim as a universal truth.

### CLAUDE.md Template

```markdown
# CLAUDE.md — {{PROJECT_NAME}}

> Auto-generated by project-analysis skill.
> Review before relying on it for development work.

## Project Overview

{{PROJECT_OVERVIEW}}

## Tech Stack

- Language(s): {{LANGUAGES}}
- Framework(s): {{FRAMEWORKS}}
- Platform(s): {{PLATFORMS}}
- Runtime / Tooling: {{RUNTIME_TOOLING}}
- Package manager(s): {{PACKAGE_MANAGERS}}

<!-- repo-knowledge:facts:start -->
```yaml
languages: [{{LANGUAGES}}]
frameworks: [{{FRAMEWORKS}}]
platform_hints: [{{PLATFORMS}}]
runtime_tooling: [{{RUNTIME_TOOLING}}]
package_managers: [{{PACKAGE_MANAGERS}}]
install_command: {{INSTALL_COMMAND}}
run_command: {{RUN_COMMAND}}
test_command: {{TEST_COMMAND}}
build_command: {{BUILD_COMMAND}}
```
<!-- repo-knowledge:facts:end -->

## Targets and Surfaces

| Surface | Platform | Form factor | Build selector | Source roots | Shared with | Packaging | Minimum OS / runtime | Evidence |
|---------|----------|-------------|----------------|--------------|-------------|-----------|----------------------|----------|
{{SURFACES_TABLE}}

### Shared Code

| Source root | Shared by | Mechanism | Evidence |
|-------------|-----------|-----------|----------|
{{SHARED_CODE_ROWS}}

## Repository Structure

```text
{{REPOSITORY_TREE}}
```

## Key Modules

| Module / Folder | Responsibility |
|-----------------|----------------|
{{KEY_MODULES_TABLE}}

## Entry Points

{{ENTRY_POINTS}}

## Build, Run, and Test Commands

```bash
# Install dependencies
{{INSTALL_COMMAND}}

# Run / develop
{{RUN_COMMAND}}

# Test
{{TEST_COMMAND}}

# Build
{{BUILD_COMMAND}}
```

If a command is unknown, leave it as `Unknown`.

## Configuration and Environment

{{CONFIGURATION_SUMMARY}}

Environment variables detected from sample/template files only:

{{ENVIRONMENT_VARIABLES}}

## External Integrations

{{EXTERNAL_INTEGRATIONS_SUMMARY}}

Full inventory: [`docs/project/integrations.md`](docs/project/integrations.md) — generated by the `project-docs` stage. That file is the authoritative list of backend services, SDKs, auth, analytics, push, payments, and environment-variable names; this section is a two-to-four-line summary that points at it rather than restating it.

## Conventions and Tooling

{{CONVENTIONS_AND_TOOLING}}

## AI Development Rules and Constraints

- Treat this repository as read-only unless the developer explicitly asks for code changes.
- Do not modify generated, vendor, dependency, cache, build, or distribution folders.
- Do not read or reproduce secret values.
- Use `AUDIT.md` as the starting point for deeper repository review.
- Detailed audit files are not created by project-analysis; use `audit-breakdown` for one audit topic at a time.

## Important Files

| File | Purpose |
|------|---------|
{{IMPORTANT_FILES_TABLE}}

<!-- audit-sync:important-files:start -->
_No approved audits yet. This block is managed by the `audit-sync` skill and is regenerated from Approved audit topics — do not edit by hand._
<!-- audit-sync:important-files:end -->

## Caution Areas

{{CAUTION_AREAS}}

<!-- audit-sync:caution-areas:start -->
_No approved audits yet. This block is managed by the `audit-sync` skill and is regenerated from Approved audit topics — do not edit by hand._
<!-- audit-sync:caution-areas:end -->

## Unknown / Unverified Areas

{{UNKNOWN_AREAS}}
```

---

## Step 7: Generate AUDIT.md

Generate `AUDIT.md` using the embedded template below.

`AUDIT.md` must be small and must contain only audit topics, not detailed issue lists.

Audit topic rules:

- Each row represents one future detailed audit file to be created by `audit-breakdown`.
- Do not link to a future file before it exists.
- The `File` column must be `Not created yet` for every new topic.
- The `Status` column must be `Pending Breakdown` for every new topic.
- Include only topics that are meaningful for the inspected repository.
- Recommended length: 400–900 words excluding tables.

Use clear topic names, for example:

```text
Architecture
Managers and Singletons
Networking
Security
State Management
Player / Media
CI / Build
Dependencies
Testing
Dead Code / Legacy
Configuration
Data / Persistence
UI / Navigation
Analytics / Observability
```

Example topic row:

```markdown
| 1 | Pending Breakdown | Managers and Singletons | High | Not created yet | Large manager/singleton surface detected; should be broken down into a focused audit. |
```

### AUDIT.md Template

```markdown
# AUDIT.md — {{PROJECT_NAME}}

> Repository understanding overview and audit topic index.
> Auto-generated by project-analysis skill.
> Generated: {{GENERATED_DATE}}

## Project Overview

{{PROJECT_OVERVIEW}}

## Architecture Summary

{{ARCHITECTURE_SUMMARY}}

## Main Modules and Responsibilities

| Module / Folder | Apparent Responsibility |
|-----------------|------------------------|
{{MAIN_MODULES_TABLE}}

## Audit Topics

These topics are candidates for detailed breakdown by the `audit-breakdown` skill.

Important rules:

- This file does not link to detailed audit files until those files actually exist.
- `project-analysis` does not create the `audits/` directory.
- `project-analysis` does not create detailed audit files.
- `audit-breakdown` is responsible for creating the `audits/` directory.
- `audit-breakdown` is responsible for creating each detailed audit `.md` file.
- After creating each detailed audit file, `audit-breakdown` must update this table with the file link.
- Each detailed audit file starts as `Draft` until approved by the developer.

| # | Status | Topic | Priority | File | Notes |
|---|--------|-------|----------|------|-------|
{{AUDIT_TOPICS_TABLE}}

## Key Cross-Cutting Observations

{{KEY_CROSS_CUTTING_OBSERVATIONS}}

## Recommended Breakdown Order

{{RECOMMENDED_BREAKDOWN_ORDER}}

## Recommended Next Skill

Run `audit-breakdown` on the first approved topic from the list above.

`audit-breakdown` must process one topic at a time and must not continue to the next topic until the developer explicitly approves.

## Unknown Areas Requiring Verification

{{UNKNOWN_AREAS}}
```

---

## Step 8: Completion Report

After writing artifacts, report:

```text
Analysis complete.

Files written:
  ✓ <target-path>/CLAUDE.md
  ✓ <target-path>/AUDIT.md

Files intentionally not created:
  ✗ <target-path>/audits/
  ✗ <target-path>/audits/*.md

Summary:
- Tech stack: <brief>
- Surfaces: <count> (<surface ids>)
- Architecture: <one sentence>
- Audit topics identified: <count>
- Recommended first breakdown topic: <topic>

Next: Review CLAUDE.md and AUDIT.md. Then run audit-breakdown on one topic from AUDIT.md.
```

---

## Hard Constraints

- Never modify source code.
- Only write `CLAUDE.md` and `AUDIT.md`.
- Never create `audits/` or `audits/*.md`.
- Never clone remote repositories.
- Never create feature docs, story docs, Jira tasks, implementation plans, or source-code patches.
- Never read or reproduce actual secret values from `.env` files; variable names only.
- Never reproduce credentials, tokens, private keys, or secrets from any file.
- Never persist a fact without repository evidence, and never persist volatile platform/vendor knowledge (see "Evidence and volatile knowledge").
- Never map a surface's form factor to a Dev Plugin `device_type` or make any routing decision.
- Never proceed without explicit developer confirmation after the summary.
- Never assume the current working directory is the target repository. Write every artifact under the absolute `<TARGET_ROOT>` passed by the orchestrator; never resolve the root from CWD or `git rev-parse --show-toplevel`, and never write to any path containing `.claude/worktrees/`. If the provided root contains that segment, stop and report instead of writing.
- Never produce long detailed issue lists in `AUDIT.md`.
- Never link to audit files that do not exist yet.
- Do not depend on external template files; the required templates are embedded in this `SKILL.md`.
