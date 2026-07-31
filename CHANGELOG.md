# Changelog

## 0.9.0 — 2026-07-28

Made the plugin the single producer of repository knowledge for the Ono plugin ecosystem, by publishing a deterministic, versioned manifest downstream plugins consume instead of re-deriving repository facts from source.

- Added the internal `repo-knowledge` skill (registry `type: internal`, `autoInvoke: true`) and `scripts/repo-knowledge.ts` (`emit` / `validate` / `show`). It owns one file, `<repo>/.ono/repo-knowledge.json`.
- The manifest is **derived, never authored**: it indexes `CLAUDE.md`, `AUDIT.md`, and `docs/project/*.md` — artifacts the workflow already produced and a developer already approved. It reads no repository source and never reads an audit file's body, so it introduces no new analysis and no new approval gate.
- It carries **pointers, not copies** (paths plus heading anchors), so the approved artifacts remain the source of truth, plus a fingerprint (git HEAD and per-artifact SHA-256) and per-category `coverage` (`populated` / `partial` / `unknown`) so a consumer can tell what it may trust and what it must still derive itself.
- `project-analysis`'s `CLAUDE.md` template now emits a `<!-- repo-knowledge:facts:start/end -->` block mirroring the Tech Stack and Commands sections in a strict machine-readable subset, so those facts are indexed deterministically rather than parsed from prose. The helper falls back to the template's fixed bullet labels when the block is absent, so repositories inspected by earlier versions produce a manifest on the next `/inspect-sync` with no re-inspection.
- `project-analysis`'s `CLAUDE.md` template no longer restates the full external-integrations inventory; it now carries a short summary plus a pointer to `docs/project/integrations.md`, removing a duplication internal to this plugin.
- The agent invokes `repo-knowledge` (`emit`) alongside `inspection-state` (`sync`) after `project-analysis`, after `project-docs`, after each `audit-approve`, and after `audit-sync`. Startup detection remains read-only — `before-inspect` does not emit.
- All four affected `after-*` hooks verify the manifest at the real root via `verify-artifacts.ts` and run `repo-knowledge.ts validate`, reporting any `unknown` category as information rather than failure.
- `/inspect-sync` documents the on-demand refresh path. No new command.
- Added `docs/repo-knowledge-contract.md` — the schema and the obligations a consumer accepts, pinned to schema v1 and duplicated verbatim in every participating plugin.
- Added `scripts/repo-knowledge.test.ts`, the plugin's first automated test suite: fixture-based extraction, marker-block override, prose fallback, malformed-input degradation, byte-determinism, portability, and worktree refusal.
- Corrected `.claude-plugin/marketplace.json`, which pinned `0.7.0` against `plugin.json`'s `0.8.0`.
- No changes to the workflow shape, stage order, approval gates, the `Draft` → `Approved` single-writer rule, `AUDIT.md` as human source of truth, `inspection-state`, or `.ono/state.json`. No changes to any target repository's source code.

## 0.8.0 — 2026-07-09

Fixed an architectural issue where, when Claude Code ran the workflow inside an agent git worktree (`.claude/worktrees/agent-<id>/`), artifacts were written into that ephemeral copy and the workflow still reported success — because writes, state, and completion checks all resolved to the same wrong root. The plugin now resolves and verifies the real target repository root (Options 1 + 3).

- Added `scripts/resolve-repo-root.ts`: resolves a single authoritative `TARGET_ROOT` and unwraps Claude agent worktrees to the main working tree via `git worktree list --porcelain` (unwraps only `.claude/worktrees/` paths; a deliberately-targeted worktree is honored). Exits non-zero if a worktree can't be safely unwrapped.
- Added `scripts/verify-artifacts.ts`: independently confirms a stage's artifacts exist at `TARGET_ROOT` (never trusting a skill's textual report), fails if the root is itself a worktree, and detects artifacts that leaked into `.claude/worktrees/`.
- `scripts/inspection-state.ts` now refuses to operate on any `.claude/worktrees/` path.
- `hooks/before-inspect.md` resolves `TARGET_ROOT` first and stops if it can't; the agent threads `TARGET_ROOT` (absolute) into every skill and `inspection-state` call and reports a stage complete only after `verify-artifacts` passes at `TARGET_ROOT`.
- All `after-*` hooks now verify produced artifacts at the real root instead of trusting the skill's report.
- Every artifact-writing skill's hard constraints now require writing under the absolute `TARGET_ROOT` and forbid `.claude/worktrees/` paths.
- Documented the resolution + verification layer in `docs/architecture.md`.
- No changes to any target repository's source code. No registry, command, or workflow-shape changes.

## 0.7.0 — 2026-07-04

Made `/inspect` state-aware ("smart startup"). It no longer blindly starts from stage 1.

- `/inspect` (`full` mode) now first runs `inspection-state` (`detect`, read-only) and presents a status summary plus a tailored set of choices, then waits for the developer before doing any work:
  - **No inspection exists** → offer to start a new inspection or leave unchanged.
  - **In progress** → show completed/current stages, topic counts, and the recommended next action; offer to continue, review & approve the current Draft, generate the next topic, run `/inspect-sync`, or leave unchanged.
  - **Complete** → report completion and offer maintenance only (`/inspect-sync`).
- Added a "Smart Startup Decision" section to `agents/project-inspector.md`; reworked the `full` mode and Startup Sequence to detect-then-decide.
- `before-inspect` no longer `init`s state eagerly — `detect` is read-only, and state is first written only once the developer chooses to start or continue, so "leave everything unchanged" writes nothing.
- Updated `commands/inspect.md` description to reflect the state-aware behavior.
- `/inspect-status` remains status-only. No new skills, commands, registry, or `inspection-state` structure changes; the registry-driven workflow is unchanged.
- No changes to any target repository's source code.

## 0.6.0 — 2026-07-04

Made the inspection workflow fully registry-driven. `scripts/inspection-state.ts` previously hardcoded the stage list, order, produced artifacts, and completion/resume logic; it now derives all of that from `skills/registry.json`.

- Added a `completion` field to `workflow`+`inspection` registry entries: `"artifacts"` (complete when all `produces` exist — the default) or `"topics"` (complete when every AUDIT.md topic is Approved). Set `artifacts` for `project-analysis`/`project-docs`, `topics` for `audit-breakdown`/`audit-approve`.
- Refactored `scripts/inspection-state.ts` to load `registry.json` and compute per-stage completion, `completedStages`, `currentStage`, `stage3Complete`, and the `resume` pointer generically from each stage's `stage`, `produces`, and `completion`. Removed the hardcoded `NON_TOPIC_STAGES` and stage-specific artifact/resume logic. Still fully deterministic — no logic moved to the LLM.
- Result: adding a new **linear** workflow skill now requires only creating `skills/<id>/SKILL.md` and adding one registry entry (with `produces` + `completion`). The agent executes it (its loop was already generic) and the state helper tracks/resumes it automatically — no edits to the script, agent, or plugin.json. Verified by temporarily adding a stage-5 entry and observing it auto-tracked and resumed.
- Registry `description` documents the `produces`/`completion` completion contract. Small update to `skills/inspection-state/SKILL.md` and the architecture docs to reflect the registry-driven behavior.
- The agent and the workflow shape are unchanged; no new commands.
- No changes to any target repository's source code.

## 0.5.0 — 2026-07-03

Added `inspection-state`, an internal infrastructure skill that tracks resumable inspection state per repository.

- New internal skill `skills/inspection-state` (registry `type: internal`, `autoInvoke: true`) — not user-facing, no command. The agent invokes it automatically at startup and after each stage/loop step. It owns a single file, `<repo>/.ono/state.json`.
- New deterministic helper `scripts/inspection-state.ts` (`detect` / `init` / `sync` / `set-stage` / `migrate`). `AUDIT.md` stays the source of truth; state.json mirrors it into portable orchestration state.
- State file tracks: plugin version + `stateSchemaVersion`, completed stages, a reconciled snapshot of the AUDIT.md topics (status/counts/timestamps), and a `resume` pointer. Detects prior inspection, detects plugin/schema version mismatch, and supports schema migrations.
- Portable by design: stores only repo-relative paths and the git remote — never absolute filesystem paths — so it is committed to Git and travels across machines/clones. `.ono/` is the shared Ono infrastructure directory; this plugin owns only `state.json`.
- Introduced a `type` field on registry entries (`workflow` vs `internal`) to cleanly separate user-facing workflow skills from auto-invoked infrastructure. Existing entries tagged `type: workflow`.
- Wired the agent (`before-inspect` startup detect/init/migrate/version/resume; `sync` after each step; `status` mode reads state via `detect`) to use the resume pointer instead of re-deriving progress from files.
- Updated `.claude-plugin/plugin.json` (registered the skill, bumped to 0.5.0), `README.md`, `docs/plugin-workflow.md`, `docs/architecture.md`.
- No changes to any target repository's source code.

## 0.4.0 — 2026-07-03

Redesigned the audit approval workflow around a dedicated `audit-approve` skill, so each skill has a single responsibility. Previously, "approve & continue" only advanced to the next Draft and never finalized the reviewed topic — Drafts accumulated with none marked `Approved`. Approval is now its own step.

- Added `audit-approve` (stage 3, approval half of the new breakdown → approve loop). It is the single owner of the `Draft` → `Approved` transition: it validates the topic is `Draft`, flips its `AUDIT.md` row to `Approved`, confirms the permanent file reference, and never generates a topic or touches `CLAUDE.md`.
- Reworked `agents/project-inspector.md`: Stage 3 is now a breakdown → review → approve → continue loop. After a clean `audit-approve`, the agent immediately breaks down the next `Pending Breakdown` topic and stops at its review gate; when all topics are `Approved` it reports Stage 3 complete. Added a fifth invocation mode (`maintenance`) and redefined `resume` to finalize the reviewed Draft.
- `/inspect-approve` now finalizes the reviewed Draft (runs `audit-approve`) and continues the loop, instead of merely advancing one breakdown cycle.
- Added `/inspect-sync` and a `maintenance` mode to run `audit-sync` on demand.
- Repurposed `audit-sync` as a documentation-maintenance tool only (`workflowRole: maintenance`), removed from the linear workflow. It no longer marks anything `Approved` and now treats `AUDIT.md` as read-only — it syncs approved findings into the `CLAUDE.md` managed blocks, verifies consistency, detects drift, and repairs references inside its blocks.
- Extended `skills/registry.json` with `role`, `pairsWith`, and `workflowRole` fields to express the breakdown/approve pairing and the maintenance role. `audit-breakdown` unchanged in responsibility (create one Draft, stop) — only its completion/approval wording now points at `audit-approve`.
- Added hook `after-audit-approve`; updated `after-audit-sync` (maintenance, no approval) and `after-audit-breakdown` (points at approve). Extended `scripts/update-audit-index.ts` to verify the file reference on `Approved` rows too.
- Updated `.claude-plugin/plugin.json` (registered the new skill and command, bumped to 0.4.0), `README.md`, `docs/plugin-workflow.md`, and `docs/architecture.md`.
- No changes to any target repository's source code.

## 0.3.0 — 2026-07-02

Completed the four-stage workflow and prepared for distribution.

- Vendored and enabled `audit-sync` (stage 4) — marks developer-approved topics `Approved` in `AUDIT.md` and regenerates the two managed blocks in `CLAUDE.md` from all Approved topics. Previously registered as a disabled placeholder.
- Vendored and enabled `project-docs` (stage 2) — builds a descriptive `docs/project/` knowledge base (overview, component inventory, patterns, integrations). Adapted to this plugin's conventions: read-only shell rules instead of the external guard-marker/PreToolUse mechanism, direct read-only inspection instead of a `repo-scanner` agent, and all four templates embedded in `SKILL.md` instead of external template files.
- Fixed a cross-skill coupling gap: `project-analysis`'s `CLAUDE.md` template now emits the `audit-sync:important-files` and `audit-sync:caution-areas` managed-block markers that `audit-sync` depends on, with placeholder content and a rule to preserve them.
- Renumbered the workflow to four stages: `project-analysis` → `project-docs` → `audit-breakdown` → `audit-sync`, all enabled in `skills/registry.json`.
- Added hook checkpoints `after-project-docs` and `after-audit-sync`.
- Updated `.claude-plugin/plugin.json` skills list and bumped the version.
- Added `.claude-plugin/marketplace.json` so the plugin is installable via the Ono internal AI Marketplace, plus a `.gitignore` for repository hygiene.
- Updated `README.md` and `docs/plugin-workflow.md` to document all four enabled stages.
- No changes to any target repository's source code.

## 0.2.0 — 2026-07-02

Expanded command API.

- Added `/inspect-status` — read-only progress report, invokes no skill.
- Added `/inspect-topic` — targeted single-topic breakdown, bypassing the general narrative.
- Added `/inspect-approve` — explicit, discoverable approval to advance one gate.
- Added an "Invocation Modes" section to `agents/project-inspector.md` (`full`, `status`, `targeted`, `resume`) so the same orchestrator dispatches correctly per command, with no duplicated orchestration logic.
- Updated `.claude-plugin/plugin.json` commands list.
- Updated `README.md` and `docs/plugin-workflow.md` to document all four commands.
- No changes to skill business logic (`project-analysis`, `audit-breakdown`) and no changes to any target repository's source code.

## 0.1.0 — 2026-07-02

Initial release.

- Added orchestrating agent `agents/project-inspector.md`.
- Added `/inspect` command.
- Vendored existing skills: `project-analysis`, `audit-breakdown`.
- Added `skills/registry.json` as the extensibility seam for future skills.
- Registered `audit-sync` as a disabled placeholder — skill not yet implemented locally.
- Added agent-read hook checkpoints: `before-inspect`, `after-project-analysis`, `after-audit-breakdown`.
- Added deterministic verification scripts: `slugify.ts`, `update-audit-index.ts`.
- Added architecture and workflow documentation.
