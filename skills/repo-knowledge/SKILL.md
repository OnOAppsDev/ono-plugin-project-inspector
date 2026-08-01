---
name: repo-knowledge
description: >-
  Internal infrastructure skill (not user-facing). Emits and refreshes the
  repository-knowledge manifest at <repo>/.ono/repo-knowledge.json via the
  deterministic scripts/repo-knowledge.ts helper, so downstream Ono plugins
  consume canonical repository knowledge instead of re-deriving it. The
  manifest is DERIVED from artifacts the workflow has already produced and a
  human has already approved — CLAUDE.md, AUDIT.md, and docs/project/*.md. It
  performs no repository analysis, reads no source files, and never modifies
  CLAUDE.md, AUDIT.md, audits/, docs/, or source code.
---

# Repo Knowledge Skill

## Type

**Internal.** This skill has no command and is never invoked directly by a developer. The `project-inspector` agent invokes it automatically whenever repository knowledge changes (see "When the Agent Invokes This"). In `skills/registry.json` it is `type: internal` with `autoInvoke: true`, so it is not a workflow stage, has no approval gate, and is excluded from both the linear inspection loop and on-demand maintenance.

## Purpose

Give downstream Ono plugins one deterministic, versioned, fingerprinted entry point to this repository's approved knowledge, so they stop re-deriving it. Without this manifest, every consumer re-scans the repository and reaches its own conclusions, which then diverge from the human-approved artifacts.

## Source of Truth

The approved artifacts remain the source of truth. This manifest is an **index over them**:

- `CLAUDE.md` — stack, commands, structure pointers.
- `AUDIT.md` — the audit-topic index (topic, status, file). **Bodies of audit files are never read.**
- `docs/project/*.md` — pointers plus heading anchors for the inventory, conventions, and integrations knowledge bases.

Prose is never copied into the manifest. Consumers receive a path and an anchor and read the artifact themselves.

## Output Contract

This skill may create or modify only:

```text
<repository-root>/.ono/repo-knowledge.json
```

It never writes `CLAUDE.md`, `AUDIT.md`, `audits/`, `docs/`, `.ono/state.json`, or any source file. All reads/writes go through the deterministic helper — never hand-edit the JSON.

## The Deterministic Helper

All logic lives in `scripts/repo-knowledge.ts` (run with a TypeScript runner, e.g. `bun scripts/repo-knowledge.ts <command> <repo-root>`). Commands:

| Command | Purpose |
|---------|---------|
| `emit <repo-root>` | Rebuild the manifest from the current approved artifacts and write it. Idempotent. |
| `validate <repo-root>` | Structural validation of an existing manifest. Exit 2 if absent or invalid. |
| `show <repo-root>` | Print the manifest (read-only). |

Always pass the orchestrator's resolved absolute `TARGET_ROOT`. The helper refuses to operate on any path containing `.claude/worktrees/` and exits non-zero.

## Coverage and Graceful Degradation

Every knowledge category carries a `coverage` value of `populated`, `partial`, or `unknown`. A category is `unknown` when its source artifact is missing or its content could not be parsed deterministically. **This is a normal state, not an error.** A repository inspected before this skill existed has no `repo-knowledge:facts` block in `CLAUDE.md`, so some fields resolve from the template's prose bullets and others report `unknown`. Consumers are contractually required to derive `unknown` categories themselves.

Never fabricate a value to fill a category. An honest `unknown` leaves a consumer no worse off than before this manifest existed; a guessed value makes it worse.

## When the Agent Invokes This

The agent calls this skill automatically — the developer never asks for it. Refresh at every point where the approved knowledge changes:

1. **After `project-analysis`** — `CLAUDE.md` and `AUDIT.md` now exist.
2. **After `project-docs`** — the `docs/project/` pointers and anchors now resolve.
3. **After each `audit-approve`** — the audit-topic index changed.
4. **After `audit-sync` maintenance** — `audit-sync` rewrites `CLAUDE.md`'s managed blocks, changing its hash; without a refresh consumers would see a false staleness verdict.

Invoking this skill is bookkeeping, not workflow advancement, and never needs developer approval.

## Portability

The manifest is committed to Git alongside `.ono/state.json`, so a teammate who has not run `/inspect` still benefits from the approved knowledge. It stores only repo-relative paths, content hashes, and the git HEAD SHA — never an absolute filesystem path. This skill does not modify the repository's `.gitignore`.

## Hard Constraints

- Only create or modify `<repository-root>/.ono/repo-knowledge.json`.
- Never read repository source files. Only `CLAUDE.md`, `AUDIT.md`, and `docs/project/*.md`.
- Never read the body of an `audits/*.md` file — the manifest carries the topic index only.
- Never copy prose into the manifest; emit a path and an anchor instead.
- Never fabricate a value for a category that could not be parsed — report `unknown`.
- Never treat the manifest as authoritative over the artifacts it indexes.
- Always go through `scripts/repo-knowledge.ts`; never hand-edit the JSON.
- Never assume the current working directory is the target repository — the root is always the orchestrator's resolved `TARGET_ROOT`, and never a `.claude/worktrees/` path.
