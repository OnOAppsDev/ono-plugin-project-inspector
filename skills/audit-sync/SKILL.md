---
name: audit-sync
description: >-
  On-demand documentation-maintenance tool for the project-inspector plugin.
  Syncs the HIGH and MEDIUM findings of already-Approved audit topics into the
  managed blocks inside CLAUDE.md (Caution Areas and Important Files), verifies
  AUDIT.md consistency, detects documentation drift, repairs broken references
  inside the managed blocks, and reports. It does NOT approve anything — the
  Draft -> Approved transition belongs to the audit-approve skill. It is not
  part of the linear inspection workflow; it runs only when explicitly invoked.
---

# Audit Sync Skill

## Purpose

Keep `CLAUDE.md` a living reflection of the **already-Approved** audits, so every future Claude Code session sees the key findings without re-reading full audit files — and keep the audit index self-consistent over time.

This skill is a **maintenance tool, not a workflow stage.** In the registry it carries `workflowRole: maintenance`; the Project Inspector agent never runs it as part of the normal inspection sequence. It is invoked on demand via `/inspect-sync` once one or more topics are `Approved`.

Where the other skills sit:

1. `project-analysis` creates `CLAUDE.md` and `AUDIT.md`.
2. `project-docs` creates the `docs/project/` knowledge base.
3. `audit-breakdown` creates one Draft audit per topic and stops for review.
4. `audit-approve` finalizes a reviewed Draft (`Draft` -> `Approved` in `AUDIT.md`).
5. `audit-sync` (this skill) — maintenance: reflect Approved audits into `CLAUDE.md`, verify consistency, detect drift, repair references, report.

## Responsibilities

- **Synchronize** the `CLAUDE.md` managed blocks with all currently-`Approved` audit documents.
- **Verify** `AUDIT.md` consistency (statuses, slugs, file references) and report problems.
- **Detect drift** between `AUDIT.md`, the `audits/` files, and the `CLAUDE.md` managed blocks.
- **Repair broken references** inside the managed blocks it owns.
- **Report** a synchronization summary.

This skill does **not** approve topics, break down topics, or generate audits.

## Output Contract

This skill may modify only:

```text
<repository-root>/CLAUDE.md   — content INSIDE the audit-sync managed blocks only
```

It **reads** `AUDIT.md` and the `audits/*.md` files to do its job but **never writes** them. It never marks a topic `Approved` (that is `audit-approve`'s exclusive job), and it never touches source code, `docs/`, or `audits/` files. If it detects an `AUDIT.md` inconsistency (e.g. a status/file mismatch, a broken `File` path), it **reports** it for the developer or `audit-approve`/`audit-breakdown` to fix — it does not rewrite `AUDIT.md`.

## Approval Is Not This Skill's Job

This skill acts on the set of topics **already marked `Approved`** in `AUDIT.md`. It never changes a topic's status and never decides approval. If the developer asks it to "approve and sync," approve first with `audit-approve` (via `/inspect-approve`), then run this maintenance step. If no topics are `Approved` yet, report that there is nothing to sync.

## Managed Blocks in CLAUDE.md

This skill writes only between these marker pairs (created by the project-analysis template):

```markdown
<!-- audit-sync:caution-areas:start -->
...replaced on every sync...
<!-- audit-sync:caution-areas:end -->

<!-- audit-sync:important-files:start -->
...replaced on every sync...
<!-- audit-sync:important-files:end -->
```

Rules:

- On every run, regenerate the full content of each block from ALL currently-`Approved` topics in `AUDIT.md` — not just recently changed ones. This makes re-runs idempotent: no duplication, no stale entries for topics that were re-drafted, and any broken links inside the blocks are repaired by the regeneration.
- If the markers are missing from `CLAUDE.md` (e.g., an older or hand-written file), add the marker pairs at the end of the `## Caution Areas` and `## Important Files` sections respectively. If those sections don't exist either, ask the developer before adding them.
- Never modify anything outside the markers.

## Core Workflow

1. Ask for the repository root (or confirm the current one if already established in the conversation).
2. Read `AUDIT.md`; list topics by status. Identify all `Status = Approved` topics.
3. **Consistency & drift check** (read-only): for every topic, verify the `File` reference resolves and matches the deterministic slug, and that `Approved` rows point to existing audit files. Note any `Draft`/`Pending Breakdown` drift or broken references to include in the report. Do not fix `AUDIT.md`.
4. If there are no `Approved` topics, report that there is nothing to sync (still surface any consistency issues) and stop.
5. Show a confirmation summary (see below) and wait for explicit approval to proceed.
6. Read every `Approved` topic's audit file (path from the `File` column).
7. Extract findings tagged `[HIGH]` and `[MEDIUM]` (the format written by `audit-breakdown`).
8. Regenerate both managed blocks in `CLAUDE.md` from the full Approved set.
9. Report completion, including any consistency/drift findings for the developer to act on.

## Confirmation Summary

```text
Here's what I'm about to do (documentation maintenance only):

- Repository: <path>
- Approved topics to sync: <topic list>
- Consistency issues detected: <count, or none>

I will update:
  ✓ CLAUDE.md — regenerate the two audit-sync managed blocks from all Approved topics

I will not touch:
  ✗ AUDIT.md (read-only — I report issues, audit-approve owns status)
  ✗ anything in CLAUDE.md outside the managed blocks
  ✗ audits/ files
  ✗ source code

Shall I proceed?
```

## Block Content Format

### Caution Areas block

One entry per finding, grouped by topic, most severe first:

```markdown
<!-- audit-sync:caution-areas:start -->
_From approved audits (managed by audit-sync — do not edit by hand):_

**Networking** ([audit](audits/networking/networking-audit.md))
- 🔴 HIGH — `APIClient` retry logic can duplicate POST requests (`src/api/client.ts`)
- 🟡 MEDIUM — Auth token refresh is not thread-safe (`src/api/auth.ts`)

**Managers and Singletons** ([audit](audits/managers-and-singletons/managers-and-singletons-audit.md))
- 🔴 HIGH — `SessionManager` holds mutable global state accessed from 14 files
<!-- audit-sync:caution-areas:end -->
```

Keep each finding to one line: severity, symbol/area, short consequence, file path. The full detail stays in the audit file — this block is a pointer layer, not a copy.

### Important Files block

```markdown
<!-- audit-sync:important-files:start -->
| Approved audit | File |
|----------------|------|
| Networking | audits/networking/networking-audit.md |
| Managers and Singletons | audits/managers-and-singletons/managers-and-singletons-audit.md |
<!-- audit-sync:important-files:end -->
```

## Completion Report

```text
Audit sync complete (documentation maintenance).

Synced from Approved topics:
  ✓ <topics>

CLAUDE.md updated:
  ✓ Caution Areas block — <n> findings from <m> approved audits
  ✓ Important Files block — <m> audit pointers

Consistency / drift:
  <list any AUDIT.md or reference issues detected, or "none — index is consistent">

Every future Claude Code session in this repo now sees these findings via CLAUDE.md.
```

## Hard Constraints

- **Generation header.** Never write, edit or copy the `Generated by ono-project-inspector … · knowledge at … · updated …` line. The orchestrator's after-hook stamps it deterministically (`inspection-state.ts stamp-docs`) with the installed version, the knowledge commit and the date. In Update mode, leaving an existing header line where it is, or omitting it, are both fine — stamping normalizes it and never duplicates it.
- Never mark a topic `Approved` or change any `AUDIT.md` status — that is `audit-approve`'s exclusive responsibility. This skill treats `AUDIT.md` as read-only.
- Never write outside the two managed blocks in `CLAUDE.md`.
- Never modify `audits/` files, `docs/`, or source code.
- Never sync findings below MEDIUM severity (LOW stays in the audit file only).
- Never copy full finding bodies into `CLAUDE.md` — one line per finding plus a link.
- Never reproduce secret values, even if an audit file quotes variable names.
- If an `Approved` topic's audit file is missing or unreadable, skip it in the blocks and report the broken reference — do not guess its findings and do not change its status.
- Never assume the current working directory is the target repository. Operate only under the absolute `<TARGET_ROOT>` passed by the orchestrator; never resolve the root from CWD or `git rev-parse --show-toplevel`, and never write to any path containing `.claude/worktrees/`. If the provided root contains that segment, stop and report instead of writing.
