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
- Build/run/test commands: scripts, Makefile, CI config, README instructions.
- Repository structure: top-level tree, key modules, entry points.
- Configuration: sample env files, config folders, feature flags; variable names only.
- Conventions: linters, formatters, code style, contribution docs.
- External integrations: SDKs, APIs, analytics, crash reporting, auth, payment, media, DRM, push, cloud providers.
- High-level risk signals: large files/classes, singletons/global state, cross-layer coupling, old dependencies, missing tests, missing CI, sensitive areas.

Do not write detailed findings during this step. Convert observations into audit topics for `AUDIT.md`.

---

## Step 4: Shell Execution Rules

Repository inspection must be strictly read-only.

Allowed commands include:

```text
ls
find
tree
cat
head
tail
grep
rg
wc
file
pwd
git status
git branch
git log
git show
```

Rules:

- Prefer one command per action.
- Avoid chaining unrelated commands with `&&`.
- Avoid multiple `cd` operations inside one command.
- Do not use output redirection except when writing the final generated artifacts through the normal workflow.

Never use:

```text
rm
mv
cp
touch
tee
sed -i
perl -i
git add
git commit
git checkout
git switch
git restore
git clean
git reset
git revert
>
>>
```

---

## Step 5: Existing Artifact Handling

Before writing, check whether `CLAUDE.md` or `AUDIT.md` already exist.

| Developer choice | Action |
|------------------|--------|
| Overwrite | Replace generated artifacts directly |
| Update | Preserve useful existing structure and refresh content |
| Preserve | Skip existing files |
| Version | Save `CLAUDE.md.bak` / `AUDIT.md.bak`, then write new files |

Never modify source code.

---

## Step 6: Generate CLAUDE.md

Generate `CLAUDE.md` using the embedded template below.

Rules:

- Target 600–1000 words.
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
- Keep `## External Integrations` to a two-to-four-line summary plus the pointer to `docs/project/integrations.md`. The full inventory belongs to `project-docs`; restating it here creates two sources of truth for the same facts that then drift apart.

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
- Never proceed without explicit developer confirmation after the summary.
- Never assume the current working directory is the target repository. Write every artifact under the absolute `<TARGET_ROOT>` passed by the orchestrator; never resolve the root from CWD or `git rev-parse --show-toplevel`, and never write to any path containing `.claude/worktrees/`. If the provided root contains that segment, stop and report instead of writing.
- Never produce long detailed issue lists in `AUDIT.md`.
- Never link to audit files that do not exist yet.
- Do not depend on external template files; the required templates are embedded in this `SKILL.md`.
