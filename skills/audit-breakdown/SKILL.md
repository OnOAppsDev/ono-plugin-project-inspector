---
name: audit-breakdown
description: >-
  Breaks down exactly one Pending Breakdown topic from AUDIT.md into a single
  detailed Draft audit document under an audits topic folder, then
  updates AUDIT.md with the created file path and Draft status. This skill is
  self-contained and does not require external templates. It never modifies
  source code and never proceeds to another topic without explicit developer
  approval.
---

# Audit Breakdown Skill

## Purpose

Process exactly one audit topic from `AUDIT.md` and create one detailed audit document in Draft status.

This skill is part of a multi-skill workflow:

1. `project-analysis` creates `CLAUDE.md` and `AUDIT.md`.
2. `AUDIT.md` contains audit topics with `Status = Pending Breakdown` and `File = Not created yet`.
3. `audit-breakdown` expands one topic into a focused Draft audit document.
4. The developer reviews and approves the Draft before the next topic is processed.

This skill is not a task generator, implementation planner, code reviewer, or refactoring assistant.

## Output Contract

For one selected topic, this skill may create or update only:

```text
<repository-root>/audits/<topic-slug>/<topic-slug>-audit.md
<repository-root>/AUDIT.md
```

Example:

```text
audits/managers-and-singletons/managers-and-singletons-audit.md
```

The generated audit document must start as:

```text
Status: Draft
```

This skill must stop after processing one topic.

## Core Workflow

1. Locate and read `AUDIT.md`.
2. Parse the `Audit Topics` table.
3. Find topics with `Status = Pending Breakdown`.
4. Present the pending topics to the developer.
5. Ask which one topic to process; default to the first pending topic.
6. Wait for explicit approval.
7. Inspect only the repository areas relevant to the selected topic.
8. Create `audits/<topic-slug>/` if needed.
9. Generate `audits/<topic-slug>/<topic-slug>-audit.md` using the embedded domain audit template.
10. Update the selected row in `AUDIT.md`:
    - `Status` -> `Draft`
    - `File` -> relative path of the created audit file
11. Stop and report completion.
12. Do not continue to the next topic until the developer explicitly asks to continue.

## Step 1: Ask the Developer

Before reading or writing files, ask:

```text
Before I start, I need a few details:

1. AUDIT.md location:
   Should I use AUDIT.md from the repository root, or a specific path?

2. Repository root:
   What is the full path to the repository?

3. Topic selection:
   Should I process the first Pending Breakdown topic, or do you want to choose a specific topic?

4. Existing topic audit file:
   If the target audit file already exists, should I:
   - Overwrite — replace it entirely
   - Update — preserve useful structure and refresh content
   - Preserve — skip it
   - Version — save a .bak copy before writing

5. Source code safety:
   Should all source code remain completely unchanged?
   Default: Yes — I will only read files and only write the selected audit file and AUDIT.md.
```

Wait for the developer's answers before proceeding.

## Step 2: Confirmation Summary

After the developer answers, show:

```text
Here's what I'm about to do:

- Repository: <path>
- AUDIT.md: <path>
- Topic: <selected topic or first Pending Breakdown topic>
- Target output: audits/<topic-slug>/<topic-slug>-audit.md
- Existing target file handling: <overwrite / update / preserve / version>
- Source code: Read-only — no source files will be modified

I will update:
  ✓ AUDIT.md — selected topic row only

I will create or update:
  ✓ audits/<topic-slug>/<topic-slug>-audit.md — Draft audit document

I will not create:
  ✗ docs/
  ✗ feature docs
  ✗ Jira tasks
  ✗ implementation plans
  ✗ source-code patches

Shall I proceed?
```

Only begin after explicit approval.

## Step 3: Parse AUDIT.md

Read `AUDIT.md` and find the `## Audit Topics` table.

Expected table shape:

```markdown
| # | Status | Topic | Priority | File | Notes |
|---|--------|-------|----------|------|-------|
| 1 | Pending Breakdown | Architecture | High | Not created yet | ... |
```

Rules:

- Only topics with `Status = Pending Breakdown` are eligible for new breakdown.
- If the developer selected a specific topic, it must exist in the table.
- If the topic status is already `Draft`, ask whether to update the existing Draft or choose another topic.
- If the topic status is `Approved`, do not regenerate it unless the developer explicitly requests it.
- Do not modify rows for unrelated topics.

## Step 4: Topic Slug and Output Path

Convert the topic name to a stable kebab-case slug.

Examples:

| Topic | Slug | Output File |
|-------|------|-------------|
| Architecture | `architecture` | `audits/architecture/architecture-audit.md` |
| Managers and Singletons | `managers-and-singletons` | `audits/managers-and-singletons/managers-and-singletons-audit.md` |
| Player / Media | `player-media` | `audits/player-media/player-media-audit.md` |
| UI / Navigation | `ui-navigation` | `audits/ui-navigation/ui-navigation-audit.md` |

Slug rules:

- Lowercase all letters.
- Replace spaces and `/` with `-`.
- Remove special characters.
- Collapse repeated hyphens.
- Trim leading/trailing hyphens.

## Step 5: Targeted Repository Inspection

Inspect only files and folders relevant to the selected topic.

Do not repeat a full `project-analysis` scan.

Use the topic name and notes from `AUDIT.md` to decide what to inspect.

Examples:

- `Architecture`: top-level folders, app entry points, module boundaries.
- `Managers and Singletons`: files named Manager, Service, Singleton, Store, Coordinator, Provider.
- `Networking`: API clients, request builders, auth headers, retry logic, network configuration.
- `Security`: secrets patterns, token handling, sensitive logs, DRM, cryptography, permissions.
- `State Management`: stores, caches, global state, shared mutable dictionaries, concurrency-sensitive state.
- `Player / Media`: player SDK usage, DRM, streaming, playback state, buffering, media sessions.
- `CI / Build`: build scripts, CI files, signing, release configuration.
- `Testing`: test folders, test targets, test commands, missing test seams.

Do not fabricate facts. If something cannot be verified, mark it as unknown.

## Step 6: Shell Execution Rules

Repository inspection must be strictly read-only. Follow
[`docs/shell-execution-rules.md`](../../docs/shell-execution-rules.md) in full: the allowed
command list, the command-shape rules, and the forbidden list live there and are not
restated here.

- Do not use output redirection except when writing the selected audit file and updating `AUDIT.md` through the normal workflow.

## Step 7: Existing File Handling

Before writing, check whether the target audit file already exists.

| Developer choice | Action |
|------------------|--------|
| Overwrite | Replace the target audit file |
| Update | Preserve useful headings and refresh content |
| Preserve | Skip the target audit file and do not update `AUDIT.md` |
| Version | Save `<file>.bak`, then write the new Draft |

If `Preserve` is selected and the file exists, stop and report that nothing was changed.

## Step 8: Generate the Domain Audit File

Use this embedded template exactly as the structure for every generated topic audit file.

```markdown
# {{TOPIC_NAME}} Audit

Status: Draft

Parent: ../../AUDIT.md

## Purpose
{{PURPOSE}}

## Scope
{{SCOPE}}

## Summary
{{SUMMARY}}

## Findings
{{FINDINGS}}

## Evidence
{{EVIDENCE}}

## Risks
{{RISKS}}

## Suggested Review Areas
{{REVIEW}}

## Cross-References
{{CROSS_REFERENCES}}

## Unknowns
{{UNKNOWNS}}
```

Writing rules:

- Keep the file focused only on the selected topic.
- Use concise findings, not long essays.
- Prefer file paths and symbols over vague descriptions.
- Do not create implementation tasks.
- Do not create Jira stories.
- Do not create code patches.
- Do not recommend a full roadmap.
- Do not reproduce secret values, tokens, private keys, credentials, or sensitive payloads.
- Include line numbers only when confidently available from line-aware inspection.
- If a finding spans multiple domains, document it here only if this topic is the primary domain. Otherwise mention it briefly in Cross-References.

Recommended finding format:

```markdown
### [HIGH / MEDIUM / LOW] `<symbol or area>` — <short finding title>
- **File:** `<path>` or `Unknown / multiple files`
- **Evidence:** <what was observed>
- **Why it matters:** <practical impact or review reason>
- **Suggested review:** <what the developer should inspect next>
```

## Step 9: Update AUDIT.md

After the Draft audit file is successfully created or updated, update only the selected topic row in `AUDIT.md`.

Change:

```markdown
| <n> | Pending Breakdown | <Topic> | <Priority> | Not created yet | <Notes> |
```

To:

```markdown
| <n> | Draft | <Topic> | <Priority> | audits/<topic-slug>/<topic-slug>-audit.md | <Notes> |
```

Rules:

- Update only the selected topic row.
- Do not reorder topics.
- Do not alter unrelated topic rows.
- Do not add links for files that were not created.
- Do not mark a topic as Approved. Only the developer can approve.
- If the audit file was not written, do not update `AUDIT.md`.

## Step 10: Completion Report

After processing the one selected topic, report:

```text
Audit breakdown complete.

Topic processed:
  ✓ <Topic>

Files written or updated:
  ✓ <target-path>/audits/<topic-slug>/<topic-slug>-audit.md
  ✓ <target-path>/AUDIT.md

Status:
  Draft — awaiting developer approval

Next:
  Review the Draft audit file.
  When you approve it (say "approved, continue" or run /inspect-approve), the
  audit-approve skill finalizes this topic (Draft → Approved) and the next
  Pending Breakdown topic is broken down automatically.

I stopped after one topic as required.
```

## Approval Rule

This skill produces one Draft and stops. It must never continue to another topic on its own, and it must never mark a topic `Approved` — finalization is the separate `audit-approve` skill's exclusive job.

Continuation is orchestrated by the Project Inspector agent, not by this skill: once the developer approves the Draft (e.g. "approved, continue" or `/inspect-approve`), the agent runs `audit-approve` to finalize this topic and then invokes this skill again for the next `Pending Breakdown` topic. Each invocation still processes exactly one topic and stops at its own review gate.

## Hard Constraints

- Process exactly one topic per run.
- Never continue to the next topic without explicit developer approval.
- Never modify source code.
- Only create or update the selected audit file and `AUDIT.md`.
- Never create `docs/`.
- Never create feature documents.
- Never create architecture documentation outside the selected audit file.
- Never create story docs, Jira tasks, sprint plans, implementation plans, or source-code patches.
- Never clone remote repositories.
- Never read or reproduce actual secret values from `.env` files; variable names only.
- Never reproduce credentials, tokens, private keys, or secrets from any file.
- Never proceed without explicit developer confirmation after the Step 2 summary.
- Never assume the current working directory is the target repository. Write every artifact under the absolute `<TARGET_ROOT>` passed by the orchestrator; never resolve the root from CWD or `git rev-parse --show-toplevel`, and never write to any path containing `.claude/worktrees/`. If the provided root contains that segment, stop and report instead of writing.
- Never mark a Draft as Approved. Only the developer can approve.
