# Changelog

## 0.11.2 — 2026-11-15

Execution and project-root fixes from a field report. The Inspector agent can now carry out its own workflow end to end, checks for Bun before it starts, and inspects a project that lives below the Git root.

- **Agent tools (fix).** `agents/project-inspector.md` declared `tools: Read, Skill`, yet the skills it invokes run inline in its context and its hooks run Bun helpers — so the agent could not run a script or write `CLAUDE.md` / `AUDIT.md` / `docs/project/*.md` without the main session compensating. It now has `Read, Write, Edit, Bash, Glob, Grep, Skill` (no `Agent`, no web tools), used only to carry out invoked skills and hook checklists; the "never write artifacts yourself" constraint is reworded accordingly (only while executing the invoked skill, only its declared artifacts).
- **Plugin paths (fix).** Helpers, hooks, the registry and `docs/shell-execution-rules.md` were referenced relative to the working directory (`bun scripts/…`), which is the developer's repository, not the plugin. The agent now defines `PLUGIN_ROOT` from `${CLAUDE_PLUGIN_ROOT}` (substituted by Claude Code in agent and skill markdown) and reads/runs plugin files by absolute path; hook files, which the agent reads as plain files, use a `<PLUGIN_ROOT>` placeholder the agent expands. The internal skills run their helpers as `bun "${CLAUDE_PLUGIN_ROOT}/scripts/…"` and no longer suggest "a TypeScript runner".
- **Bun preflight (new).** `scripts/check-bun.sh` (POSIX sh) runs as `before-inspect` step 0 in every mode, before the first Bun call and before anything is written. A missing or broken Bun stops with an actionable install message (macOS/Linux, Homebrew, Windows). It never installs Bun and never switches runtimes.
- **Project Root vs Git Root (fix).** `scripts/resolve-repo-root.ts` used `git rev-parse --show-toplevel`, so selecting `yestvos/YesTVOS` inspected `yestvos`. It now returns `gitRoot`, `projectRoot` (= `targetRoot`), `projectPath` and `nested`, and: honors an explicit path exactly; walks only *up* from a working-directory default (a project at the Git root resolves exactly as before); never descends into a subproject; asks (`select-project`) when no path was given and the Git root holds several projects or an inspected subproject — immediate subdirectories only, no recursive scan; asks (`confirm-project`) when the working directory is inside an uninspected nested project; asks (`confirm-nested`, re-run with `--confirm-nested`) before creating an inspection in a nested project when Inspector artifacts already exist in an ancestor; never migrates artifacts. Exit 4 means a developer decision is required. Claude-worktree unwrapping keeps the selected subdirectory.
- **Nested drift (fix).** `inspection-state` used `git diff --name-only`, whose paths are Git-root-relative, against Project-Root-relative records — a nested project saw its own artifacts and sibling directories as source drift (permanent `REFRESH_RECOMMENDED`). Drift now uses `git diff --relative` (a no-op at the Git root). `verify-artifacts` also detects artifacts leaked into a worktree under the Git root.
- **Docs.** README Prerequisites and "Project Root and Git Root"; `/inspect` argument wording; `docs/repo-knowledge-contract.md` states the manifest lives at the Project Root (the Dev Plugin's vendored copy and its Git-root-only resolver are intentionally not updated here; nested projects are simply "manifest absent" to it until then).
- **Tests.** New `scripts/agent-contract.test.ts` (tool contract, plugin-path resolution, every referenced plugin file exists, preflight ordering, root-decision handling), `scripts/check-bun.test.ts` (missing / broken / present Bun under a controlled PATH; nothing written), `scripts/resolve-repo-root.test.ts` (root, nested, multiple projects, ancestor and subproject inspections, worktrees, non-git), and `scripts/e2e-smoke.test.ts` (the real helper pipeline by absolute plugin path from the project as CWD — full inspection, nested drift, Refresh Project Knowledge, 0.10.0-shaped upgrade — for root and nested layouts). `scripts/live-smoke.ts` is an on-demand real Claude Code smoke test (`bun scripts/live-smoke.ts`; uses model credits) asserting the subagent runs the preflight and helpers by absolute plugin path and writes every artifact itself, the main session never compensates, and all artifacts land at the nested Project Root.

## 0.11.1 — 2026-11-15

Documentation fix; no behavior change.

- **`/inspect` refresh triggers.** `commands/inspect.md` now describes the 0.11.0 Refresh Project Knowledge triggers accurately: `REFRESH_RECOMMENDED` also fires when existing knowledge predates the current knowledge model (e.g. no `CLAUDE.md` Targets and Surfaces section or no `docs/project/capabilities.md`), even with no source change; `project-analysis` re-runs on build/dependency/CI or surface-declaring manifest changes, recorded surface-evidence changes, top-level entry changes, or a model gap in its own output (a stage with a model gap re-runs together with every later source-backed stage). It also documents the `BASELINE_UNKNOWN` branch (refresh offered as optional). The text now matches `agents/project-inspector.md` and `scripts/inspection-state.ts`.

## 0.11.0 — 2026-09-29

Generic Project Architecture, Surfaces & Feature Relationship Knowledge (Stage A, producer side). The Inspector now answers, for every supported project family (iOS, Android, React Native, React/web, tvOS, Android TV, Smart TV, and multi-target repositories), both "how is THIS repository structured and implemented, per surface?" and "how are THIS repository's capabilities related?" — without any platform-specific architecture and without moving SDLC methodology into the Inspector.

- **Targets and surfaces.** `project-analysis` writes a fixed-column `## Targets and Surfaces` table in `CLAUDE.md` (surface id, platform, Inspector-neutral form factor `handheld | desktop | tv | wearable | other`, build selector, source roots, shared-with, packaging, minimum OS/runtime as declared in the repository, evidence) plus a `### Shared Code` table. Surfaces are discovered from real project/build files; one repository may have one or many; conflicting facts are never flattened. The form factor is deliberately not the Dev Plugin's `device_type`.
- **Generic patterns with per-surface overrides.** `patterns.md` gains Architecture and Composition, Input and Interaction, App Lifecycle and State, Media and Playback, Platform Adapters, Accessibility, and Performance Constraints (only repository-defined budgets). Each is a shared convention; a surface that differs gets `### <Section> (<surface-id>)` under it. No TV-specific headings.
- **Inventory scoping.** `components.md` (Screens, Components, Hooks / Utilities) and `integrations.md` (Services, SDKs) tables gain a `Surface` column (`all` or surface ids).
- **Feature & Capability Map.** New `docs/project/capabilities.md` (produced by `project-docs`): evidence-backed capabilities (source roots — surface-specific ones suffixed, shared code once — entry points, component/integration references into the existing inventory, services, routes, data dependencies, state ownership, tests, evidence) and direct capability relationships over a closed vocabulary (`depends_on`, `used_by`, `contains`, `navigates_to`, `shares_component_with`, `shares_state_with`, `reads_from`, `writes_to`, `covered_by`, `related_to`) with a closed evidence-kind list. Naming or semantic similarity is never evidence; no impact scores, first-degree edges only.
- **Evidence gate.** New `scripts/knowledge-evidence.ts verify <root> <surfaces|docs|all>` resolves every evidence ref (`path` / `path::token`) against the current source and enforces the model's rules (shared-* relationships need the same token on both endpoints, overrides only for declared surfaces and never repeating the shared text, no per-surface capability copies, references must resolve into the inventory). Both source-backed after-hooks run it before `record-knowledge`; a violation stops the stage.
- **Manifest (schema v1, additive).** `.ono/repo-knowledge.json` gains `surfaces[]`, `sharedCode[]`, `structure.surfaces` (only when the section exists), `documents.<key>.surfaceAnchors`, `documents.capabilities`, `capabilities[]`, `capabilityRelationships[]`, and `coverage.surfaces` / `coverage.capabilities`. Indexes only — ids, short repository facts, evidence refs, `path#anchor` pointers; no prose. Old manifests remain valid; absent means `unknown`.
- **Anchors.** A repeated heading now gets a deterministic `-1`, `-2`, … suffix instead of being dropped; unique anchors are unchanged. The anchor rule moved to the shared `scripts/knowledge-model.ts` parser used by the manifest, the evidence gate and drift detection.
- **Refresh / staleness (same mechanism).** Surface-declaring files (Xcode schemes / `.xcconfig`, project generators, `AndroidManifest.xml`, RN/Expo app config, web bundler configs, Tizen `config.xml`, webOS `appinfo.json`) and files recorded as surface evidence now signal `project-analysis`. A registry `knowledgeModel` per source-backed stage makes knowledge produced before this model plan a Refresh (`refreshPlan.modelSignals`) even with no drift, without reopening the completed inspection; `record-knowledge` refuses output with a model gap. `detect` also reports `affectedCapabilities` / `affectedRelationships` / `affectedSurfaces`. `knowledgeHead` semantics are unchanged.
- **Contract (Inspector copy only).** `docs/repo-knowledge-contract.md` documents the new fields, evidence refs, surface-scoped knowledge, Guarantees 8–9 (evidence-backed; advisory, current source authoritative, never routing) and consumer obligation 9. The Dev Plugin's vendored copy is intentionally not updated in this release (Stage B).
- Tests first: `scripts/knowledge-model.test.ts`, `scripts/knowledge-evidence.test.ts`, `scripts/knowledge-templates.test.ts` (skill templates ↔ parser ↔ registry ↔ hooks ↔ contract), shared fixtures in `scripts/fixtures/knowledge-fixtures.ts`; extended `scripts/repo-knowledge.test.ts` and `scripts/inspection-state.test.ts`.

## 0.10.0 — 2026-09-28

Project Knowledge staleness recovery (producer side). A completed inspection now has a safe, generic path back to fresh knowledge after source changes: `COMPLETE` → source drift → `REFRESH_RECOMMENDED` → `/inspect` → **Refresh Project Knowledge** → `COMPLETE`.

- **Fixed:** `/inspect-sync` (and every other re-emit) could stamp `.ono/repo-knowledge.json` with the current HEAD without regenerating the knowledge documents, making stale Project Knowledge look fresh. Emits now carry a separate, never-advanced-by-emit `fingerprint.knowledgeHead`.
- Added the knowledge-authoring HEAD. `scripts/inspection-state.ts record-knowledge <root> <stage>` is its single writer, allowed only for registry `sourceBacked: true` stages (`project-analysis`, `project-docs`) whose artifacts exist, and called only from their after-hooks. It stamps `stages.<id>.knowledgeHead` and advances `repository.knowledgeHead` only once every downstream source-backed stage is at the same HEAD, so an interrupted two-stage refresh never looks complete. `sync` / `set-stage` now carry these fields forward (previously `sync` rebuilt each stage entry and would have dropped them).
- `inspection-state detect` derives (never persists) a `knowledge` block for completed inspections: `COMPLETE`, `REFRESH_RECOMMENDED`, `BASELINE_UNKNOWN`, or `NOT_APPLICABLE`, with changed source files and a registry-driven `refreshPlan`. Inspector-owned paths (`.ono/**`, `CLAUDE.md`, `AUDIT.md`, their `.bak`s, `docs/project/**`, `audits/**`) are never drift evidence.
- Refresh plan: `project-docs` by default (`knowledgeRefresh: "default"`); `project-analysis` (`"when-signaled"`) only when a build/dependency/CI manifest changed or a top-level entry appeared/disappeared, or on developer request. No audit stage is ever re-run.
- `/inspect` Smart Startup branch C now offers **Refresh Project Knowledge** on drift (recommended) or unknown baseline (optional). It runs through the normal Invocation Loop, after-hooks, and approval gates. No new command.
- Added `scripts/knowledge-refresh-guard.ts` (`snapshot` / `verify`): a refresh must keep every `AUDIT.md` topic row, status, file reference, and `Approved <date>` note, and every `CLAUDE.md` `audit-sync:*` managed block byte-identical. The after-hooks run `verify` before recording the knowledge HEAD and stop on a violation. `project-analysis` Update mode now states these preservation rules explicitly.
- `repo-knowledge` emits `fingerprint.knowledgeHead` (from state; else carried from the prior manifest; else `null`) and validates it as optional. Schema stays v1 (additive). Contract (Inspector copy) documents Guarantee 7 and producer-side drift.
- Added `scripts/inspection-state.test.ts` and `scripts/knowledge-refresh-guard.test.ts`; extended `scripts/repo-knowledge.test.ts`.

## 0.9.1 — 2026-09-09

Housekeeping only. Deduplicated the repository-inspection shell policy and removed an obsolete embedded marketplace registration. **No workflow, stage, approval-gate, or output-contract behavior changed.**

- Extracted the read-only shell policy into `docs/shell-execution-rules.md`. The allowed-command list (15 entries), the command-shape rules, and the forbidden-command list (17 entries) existed as three byte-identical copies in `project-analysis` (Step 4), `project-docs` (Step 5), and `audit-breakdown` (Step 6); a policy defining what may never be run is exactly what must not drift between copies. The extracted content is byte-identical to what it replaced.
- **Each skill keeps its own redirection exception**, because that one line is the only part that was ever skill-specific: `project-analysis` writes "the final generated artifacts", `project-docs` "the four generated artifacts", `audit-breakdown` "the selected audit file and updating `AUDIT.md`". Each matches that skill's `produces` entry in `skills/registry.json`, which is unchanged. The shared file states the rule generically and defers to each skill's own wording as authoritative for that skill.
- Step numbers and section headings are unchanged in all three skills, so every heading anchor still resolves.
- Removed `.claude-plugin/marketplace.json`. It declared a marketplace (`ono-ai-marketplace`) that was never registered anywhere, listed this plugin against a `"source": "./"` nobody resolves, and duplicated a `version` that `.claude-plugin/plugin.json` already owns — the copy it had drifted from once before (see 0.9.0). Discovery, install, and source are owned by `ono-plugin-marketplace`, which installs this plugin as `ono-project-inspector@ono-plugin-marketplace` from its own `url` source; the version is owned here and read by `scripts/repo-knowledge.ts` and `scripts/inspection-state.ts`. Nothing in this repository referenced the deleted file, and the README's structure block never listed it. `.claude-plugin/plugin.json` is now the only metadata file in that directory.
- No change to `skills/registry.json`, the commands, the agent, the hooks, the deterministic scripts, `docs/repo-knowledge-contract.md`, inspection state, or `.ono/` artifact production.

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
