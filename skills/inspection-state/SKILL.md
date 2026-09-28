---
name: inspection-state
description: >-
  Internal infrastructure skill (not user-facing). Creates and maintains the
  plugin's orchestration state file at <repo>/.ono/state.json via the
  deterministic scripts/inspection-state.ts helper. Detects whether a
  repository was already inspected, tracks completed stages and topic
  progress, records plugin/schema versions, detects version mismatch,
  prepares for schema migrations, and computes a resume pointer so the
  workflow can continue after an interruption. AUDIT.md remains the human
  source of truth for topic status; this skill only mirrors it into
  orchestration state. It never modifies source code, AUDIT.md, CLAUDE.md,
  audits/, or docs/.
---

# Inspection State Skill

## Type

**Internal.** This skill has no command and is never invoked directly by a developer. The `project-inspector` agent invokes it automatically at workflow checkpoints (see "When the agent invokes this"). In `skills/registry.json` it is marked `type: internal` with `autoInvoke: true`, so it is not a workflow stage, has no approval gate, and is excluded from both the linear inspection loop and on-demand maintenance.

## Purpose

Give the workflow a durable, portable, versioned memory of what has been inspected, so the agent can:

- detect whether a repository was already inspected;
- resume exactly where it left off after an interruption;
- know which plugin/schema version last wrote the state, and react to a mismatch;
- migrate an older state file forward when the schema changes.

## Source of Truth

`AUDIT.md` is the **human source of truth** for topic status (`Pending Breakdown` / `Draft` / `Approved`) and file references. `.ono/state.json` is the **plugin's orchestration state**: it holds versions, per-stage completion, timestamps, a resume pointer, and a *reconciled snapshot* of the AUDIT.md topic table for fast, interruption-safe reads. On every update this skill re-derives the snapshot from `AUDIT.md`; it never lets state.json override `AUDIT.md`.

## Output Contract

This skill may create or modify only:

```text
<repository-root>/.ono/state.json
```

The `.ono/` directory is the shared Ono infrastructure directory; this plugin owns only `state.json` within it. This skill never writes `AUDIT.md`, `CLAUDE.md`, `audits/`, `docs/`, or any source file. All reads/writes of `state.json` go through the deterministic helper — do not hand-edit the JSON.

## Portability

The state file is committed to Git and must be portable across machines and clones:

- **Never store absolute filesystem paths.** The helper persists only repo-relative paths (exactly as `AUDIT.md` records them) and, optionally, the git remote URL.
- The repository root is a runtime argument passed to the helper, never written into the file.

Advise the developer to **commit `.ono/state.json`** (like `AUDIT.md`) so inspection progress is shared with the team. This skill does not modify the repository's `.gitignore`.

## The Deterministic Helper

All state logic lives in `scripts/inspection-state.ts` (run with a TypeScript runner, e.g. `bun scripts/inspection-state.ts <command> <repo-root> [args]`). The helper is fully **registry-driven**: it reads `skills/registry.json` for the ordered set of `type: workflow` + `workflowRole: inspection` stages and derives completion from each stage's `produces` and `completion` (`"artifacts"` = all produced paths exist; `"topics"` = every AUDIT.md topic is Approved). It contains no hardcoded stage names, so a new linear workflow skill is tracked automatically once its registry entry exists. Commands:

| Command | Purpose |
|---------|---------|
| `detect <repo-root>` | Print JSON: inspected?, stored vs current plugin/schema version, `versionMismatch`, `needsMigration`, completed stages, counts, resume pointer, and the derived `knowledge` freshness block (see "Project Knowledge freshness"). Always exits 0. |
| `init <repo-root> [gitRemote]` | Create `state.json` if absent (idempotent). |
| `sync <repo-root> [gitRemote] [gitHead]` | Reconcile the topic snapshot, counts, per-stage completion, and the resume pointer, then write. Stage identity, order, produced artifacts, and completion are read from `skills/registry.json` — the helper has no hardcoded stage list. |
| `set-stage <repo-root> <stage> <status>` | Record a non-topic stage's status (`pending`/`in-progress`/`complete`). |
| `record-knowledge <repo-root> <stage>` | Record that a `sourceBacked` stage just regenerated Project Knowledge at the current git HEAD. The **only** writer of the knowledge-authoring HEAD. Exits 1 for a non-source-backed stage, missing stage artifacts, or no git HEAD. |
| `migrate <repo-root>` | Migrate an older `stateSchemaVersion` forward to the current one. |

## When the Agent Invokes This

The agent calls this skill automatically — the developer never asks for it:

1. **At startup** (from `hooks/before-inspect.md`): run `detect`. If `inspected` is false, `init`. If `needsMigration`, `migrate`. If `versionMismatch`, report it to the developer before proceeding. Use the `resume` pointer to decide where `full`/`resume` continues.
2. **After each inspection stage and each Stage 3 loop step** (project-analysis, project-docs, each audit-breakdown Draft, each audit-approve finalize): run `sync` so completed stages, topic statuses, counts, and the resume pointer stay current.
3. **In `status` mode** (`/inspect-status`): run `detect` for an instant, accurate snapshot (falling back to reading `AUDIT.md` if no state file exists yet).
4. **After `audit-sync` maintenance**: run `sync` (the helper refreshes `maintenance.lastSyncAt` on write).
5. **After a source-backed stage's artifacts are verified** (`hooks/after-project-analysis.md`, `hooks/after-project-docs.md`, first run or refresh): run `record-knowledge <repo-root> <stage>`. Never from any other hook or mode.

## Project Knowledge freshness

`stages.<id>.knowledgeHead` is the git HEAD at which a `sourceBacked` stage (registry) last regenerated its knowledge; `repository.knowledgeHead` is the HEAD at which the whole source-backed knowledge set is current. `record-knowledge` stamps the stage, and advances `repository.knowledgeHead` only when every downstream source-backed stage is already stamped at the same HEAD — an interrupted multi-stage refresh therefore never looks complete. `sync`, `set-stage`, and `migrate` carry both values forward and never advance them.

`detect` derives — never persists — `knowledge.status`:

| Status | Condition |
|---|---|
| `NOT_APPLICABLE` | Inspection not complete (`stage3Complete: false`). Normal resume behavior applies. |
| `COMPLETE` | `repository.knowledgeHead` equals HEAD, or every file changed between them is Inspector-owned. |
| `REFRESH_RECOMMENDED` | At least one non-Inspector-owned file changed between `repository.knowledgeHead` and HEAD. |
| `BASELINE_UNKNOWN` | No `repository.knowledgeHead` (pre-0.10.0 state), it is not in history, or git is unavailable. |

Inspector-owned (never drift evidence): `.ono/**`, `CLAUDE.md`, `AUDIT.md`, `CLAUDE.md.bak`, `AUDIT.md.bak`, `docs/project/**`, `audits/**`. The block also carries `knowledgeHead`, `currentHead`, `reason`, `changedSourceCount`, `changedSourceFiles` (sorted, first 50), and `refreshPlan: { stages, analysisSignals }` — registry-ordered source-backed stages to re-run: every `knowledgeRefresh: "default"` stage, plus `"when-signaled"` stages when a build/dependency/CI manifest changed or a top-level entry was added/removed, minus any stage already stamped at the current HEAD.

## state.json Shape (schema v1)

```jsonc
{
  "stateSchemaVersion": 1,
  "plugin": { "name": "ono-project-inspector", "version": "0.6.0" },
  "repository": { "gitRemote": "git@github.com:org/repo.git or null", "gitHead": "sha at last sync, or null", "knowledgeHead": "sha at which Project Knowledge was generated, or null (optional)" },
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",
  "inspection": { "started": true, "completedStages": ["project-analysis"], "currentStage": "project-docs", "stage3Complete": false },
  "stages": { "project-analysis": { "status": "complete", "completedAt": "ISO", "knowledgeHead": "sha (optional)", "knowledgeRegeneratedAt": "ISO (optional)" }, "...": {} },
  "topics": [ { "index": "1", "topic": "Architecture", "slug": "architecture", "status": "Approved", "file": "audits/architecture/architecture-audit.md", "draftedAt": "ISO", "approvedAt": "ISO" } ],
  "counts": { "pendingBreakdown": 0, "draft": 0, "approved": 1, "total": 1 },
  "resume": { "nextAction": "review-draft | breakdown-next | run-stage | stage3-complete | idle", "topic": "or null", "hint": "human-readable next step" },
  "maintenance": { "lastSyncAt": "ISO or null" },
  "migrations": { "history": [] }
}
```

## Hard Constraints

- Only create or modify `<repository-root>/.ono/state.json`. Never write `AUDIT.md`, `CLAUDE.md`, `audits/`, `docs/`, or source.
- Never treat `state.json` as authoritative over `AUDIT.md` for topic status — always reconcile from `AUDIT.md`.
- Never store absolute filesystem paths or any machine-specific location in the file.
- Never mark a topic `Approved` or change topic status — that is `audit-approve`'s job; this skill only reflects the current `AUDIT.md`.
- Always go through `scripts/inspection-state.ts`; never hand-edit `state.json`.
- Never assume the current working directory is the target repository — the repo root is always passed explicitly (the orchestrator's resolved `TARGET_ROOT`, with any Claude agent worktree already unwrapped). The helper refuses to operate on any path containing `.claude/worktrees/` and exits non-zero; never pass a raw CWD.
