# Ono Project Inspector

First plugin in the Ono internal AI Marketplace. Inspects an existing repository and gradually builds a structured AI knowledge base for it: `CLAUDE.md`, `AUDIT.md`, a `docs/project/` knowledge base, and per-topic `audits/*.md` files — then syncs approved audit findings back into `CLAUDE.md`.

This is not an implementation assistant. It never modifies source code, never writes feature docs, implementation plans, or source-code patches.

## Prerequisites

- **Node.js 22.18 or later on Node 22, or Node.js 24 or later**, on the `PATH` Claude Code uses — the same requirement as the Ono Mobile Dev Plugin. Every deterministic helper is a TypeScript file run directly by `node` (built-in type stripping); there is nothing to install: no Bun, no npm packages, no `npx`/`tsx`/`ts-node`. **If you already have a supported Node.js — for example because the Dev Plugin works for you — you do not need to install anything else.** Every command first runs `node "<plugin>/scripts/node-preflight.mjs"`; on a missing or unsupported Node.js (Node 20, Node 22 before 22.18, any Node 23) it stops before touching any file and says which Node.js it found and where. The Node.js inside Claude Code can differ from your terminal's: check it with `! node -v` and `! which node`.
- **Git** — knowledge freshness is tracked against Git history.

Platforms: macOS and Linux, and Windows 11 with Git Bash (the shell Claude Code uses on Windows) — the helpers and the write guard are written and tested for all three, including paths with spaces and non-Latin characters such as Hebrew; see the CHANGELOG for what has been verified in a live Claude Code session. Known Windows limitation: if Git converts the Inspector's committed Markdown artifacts to CRLF line endings on checkout (`core.autocrlf=true`), the knowledge checks do not recognise them — see CHANGELOG 0.12.0. The Inspector works with any Git host — Bitbucket included — using local Git only: it needs no GitHub account, `gh`, API or credentials.

## Project Root and Git Root

The Inspector analyzes the **project directory you select**, which may sit below the Git repository root (e.g. `yestvos/YesTVOS/` inside the Git root `yestvos/`). Pass that path to the command — `/ono-project-inspector:inspect path/to/YesTVOS` — and every artifact (`CLAUDE.md`, `AUDIT.md`, `docs/project/`, `audits/`, `.ono/`) is written there; Git operations still use the repository root. A project at the Git root behaves exactly as before.

The Inspector never picks a subproject for you. With no path, it starts from the current directory and asks when that is ambiguous — several projects under the Git root, a nested project not explicitly selected, or a nested project selected while an inspection already exists at the Git root (it never migrates or duplicates existing artifacts without your confirmation).

## Protected branches

Inspection results are never written to `main`, `master`, or a detached HEAD. The Inspector may read and analyze the repository on any branch, but before its first write it asks **once** to create a local working branch from your current checkout — suggested `chore/project-inspection` (or the first free `chore/project-inspection-2`, `-3`, …), or any valid name you give — switches to it, verifies HEAD is still the same commit, and leaves you on it. In `/inspect` that question is folded into the start/continue menu, so it adds no extra prompt; `/inspect-status` and "leave everything unchanged" never create a branch. On an ordinary working branch nothing is asked and nothing changes.

Your staged, unstaged, and untracked changes are carried over untouched (no stash, reset, restore, or clean). An existing branch is never reused, reset, or deleted. Only local Git is used — nothing is fetched, pulled, committed, pushed, or merged, and no pull request is opened, so it works the same with any Git host. The results are uncommitted changes on the working branch: review, commit, and push them yourself.

The protection is mechanical, not just an instruction: every helper that writes Inspector output (`inspection-state` except `detect`, `repo-knowledge emit`, `knowledge-refresh-guard`) and `verify-artifacts.ts` refuse with exit 5 on a protected branch before writing anything, and there is no bypass flag. Branch checks and creation live in `scripts/work-branch.ts`.

The Inspector's own file edits are guarded the same way. `hooks/hooks.json` registers a `PreToolUse` hook for `Write`, `Edit`, `MultiEdit` and `NotebookEdit` that acts **only** on calls Claude Code labels as coming from the Inspector agent (`agent_type` `ono-project-inspector:project-inspector`). Such a call is denied while the target file's repository is on `main`, `master`, a detached HEAD, or a branch that cannot be determined; once the working branch exists it is allowed. Your own edits in the main session and every other agent's edits are allowed immediately — the hook never inspects their paths or content and never asks anything.

## Commands

| Command | Responsibility |
|---|---|
| `/inspect [repo-path]` | Run or resume the complete guided workflow end to end. Default entry point. On a completed inspection whose source changed since Project Knowledge was generated, offers **Refresh Project Knowledge**. |
| `/inspect-status [repo-path]` | Read-only progress report: artifacts present, audit topic counts, enabled/disabled skills, recommended next action. Invokes no skill. |
| `/inspect-topic [topic-name] [repo-path]` | Jump straight to breaking down one audit topic (or the next pending one), skipping the general narrative. |
| `/inspect-approve [repo-path]` | Approve the current gate: finalize the reviewed audit Draft (`Draft` → `Approved`) and break down the next topic, or advance one non-repeatable stage. |
| `/inspect-sync [repo-path]` | Run the `audit-sync` documentation-maintenance tool on demand: refresh the managed blocks in `CLAUDE.md` from approved audits, verify consistency, repair drift. Not part of the linear workflow. Never refreshes source-backed Project Knowledge. |

No command invokes a skill directly by name — every command routes through the `project-inspector` agent, which is the only thing that knows how to sequence skills.

## What it does

1. Runs `project-analysis` to generate `CLAUDE.md` (including a fixed-column **Targets and Surfaces** section discovered from real project/build files) and a concise `AUDIT.md` topic index.
2. Runs `project-docs` to build a descriptive `docs/project/` knowledge base: overview, surface-scoped component inventory, patterns (shared conventions plus per-surface overrides, including architecture, input, lifecycle, media, platform adapters, accessibility, and repository-defined performance constraints), integrations, and an evidence-backed **Feature & Capability Map** (`capabilities.md`) with first-degree capability relationships. Every surface, capability and relationship is verified against the current source before it is certified.
3. Runs the **breakdown → approve loop** over audit topics, one at a time:
   - `audit-breakdown` expands one topic into a `Draft` audit document under `audits/<topic-slug>/` and stops for review.
   - `audit-approve` finalizes the reviewed Draft (`Draft` → `Approved` in `AUDIT.md`) — it is the single owner of that transition — after which the next topic is broken down automatically.
4. Stops for developer approval between every stage and after every Draft.
5. Once complete, keeps Project Knowledge current: the HEAD at which source-backed knowledge was generated is recorded, and when later source changes are detected `/inspect` offers **Refresh Project Knowledge** — `project-docs` (plus `project-analysis` when build or surface-declaring manifests, recorded surface evidence, or top-level structure changed, or when existing knowledge predates the current knowledge model) re-run in Update mode under a guard that preserves every audit status and `CLAUDE.md` managed block. No re-audit.
6. Separately, on demand, `audit-sync` (documentation maintenance) folds the HIGH/MEDIUM findings of approved topics into managed blocks inside `CLAUDE.md` and checks the index for drift. It never approves anything and is not part of the linear workflow.

## Documentation

Architecture and workflow documentation for the whole plugin ecosystem lives in the **marketplace repository**, [`OnOAppsDev/ono-plugin-marketplace`](https://github.com/OnOAppsDev/ono-plugin-marketplace), which is the single source of truth for it:

| Document | Answers |
|---|---|
| [`docs/architecture/ecosystem-overview.html`](https://github.com/OnOAppsDev/ono-plugin-marketplace/blob/main/docs/architecture/ecosystem-overview.html) | **Start here.** How the plugins cooperate, what Repository Knowledge is, the complete Claude Code workflow, and how information flows between commands. |
| [`docs/plugins/ono-plugin-project-inspector/plugin-architecture.md`](https://github.com/OnOAppsDev/ono-plugin-marketplace/blob/main/docs/plugins/ono-plugin-project-inspector/plugin-architecture.md) | How **this** plugin is built: registry-driven orchestration, skill types, approval gates, hooks, deterministic scripts, state and resume, worktree safety. |
| [`docs/plugins/ono-plugin-project-inspector/inspection-workflow.md`](https://github.com/OnOAppsDev/ono-plugin-marketplace/blob/main/docs/plugins/ono-plugin-project-inspector/inspection-workflow.md) | What to type, in what order, and what each of the five commands does. |

The one document that stays here is [`docs/repo-knowledge-contract.md`](docs/repo-knowledge-contract.md) — the outbound contract other Ono plugins consume. It ships with the plugin because the code that implements it lives here, and it is vendored byte-identically into each consuming plugin.

## Structure

```
.claude-plugin/plugin.json   plugin manifest
agents/project-inspector.md  orchestrator (sequences skills and hooks; the skills it invokes run in its context; 5 invocation modes)
commands/inspect.md          /inspect — full workflow
commands/inspect-status.md   /inspect-status — read-only progress report
commands/inspect-topic.md    /inspect-topic — targeted topic breakdown
commands/inspect-approve.md  /inspect-approve — finalize the reviewed Draft, then continue
commands/inspect-sync.md     /inspect-sync — on-demand documentation-sync maintenance
skills/                      vendored skills + registry.json (extensibility seam); includes internal inspection-state
hooks/                       agent-read checkpoint instructions between stages (*.md), plus hooks.json:
                             the Inspector-agent-scoped write guard (scripts/write-guard.sh / .ts)
scripts/                     deterministic helpers (slug rules, AUDIT.md consistency, .ono/state.json state and knowledge drift,
                             .ono/repo-knowledge.json manifest, knowledge-refresh preservation guard, generic knowledge-model
                             parser, source-evidence gate, Project/Git Root resolver, Node.js preflight, protected-branch guard
                             and working-branch creation) + *.test.ts suites
                             (fixtures in scripts/fixtures/); check.ts runs them all; live-smoke.ts is the on-demand real
                             Claude Code smoke test
.github/workflows/check.yml  CI for this plugin only: the strict suite on Ubuntu, macOS and Windows, Node 22.18.0 and 24
templates/                   reserved for future skills; unused by current skills by design
docs/repo-knowledge-contract.md   outbound contract consumed by other Ono plugins
                             (architecture and workflow docs live in ono-plugin-marketplace)
```

The plugin also maintains a committed, portable state file at `<target-repo>/.ono/state.json` (owned by the internal `inspection-state` skill) so an interrupted inspection resumes exactly where it left off. `AUDIT.md` remains the source of truth; the state file only mirrors it.

## Testing

```
node scripts/check.ts --strict      # every suite; a skipped assertion fails the run
node --no-warnings scripts/<name>.test.ts   # one suite
```

The suites need only Node.js (22.18+ / 24+) and Git — no Bun, no dependencies — and run on macOS, Linux and Windows (Git Bash). CI (`.github/workflows/check.yml`) runs the strict suite on all three with Node 22.18.0 and Node 24, with Bun removed from `PATH`. `scripts/live-smoke.ts` is a separate, paid, real Claude Code run and is never started by the suite.

## Adding a new inspection skill

1. Place it under `skills/<id>/` and list it in `plugin.json`'s `skills[]`.
2. Add one entry to `skills/registry.json` (with `type` = `workflow` or `internal`, and `role`/`pairsWith`/`workflowRole` as appropriate).
3. Optionally add `hooks/after-<id>.md` and a command.

A skill that fits an existing shape (a linear stage, a breakdown-approve loop partner, or an on-demand maintenance tool) needs no change to the agent or existing hooks; only a genuinely new orchestration pattern does. See the plugin-architecture document in the marketplace repository for details.

## Status

All skills are implemented and enabled:

- `inspection-state` — enabled (internal infrastructure, auto-invoked; not user-facing)
- `repo-knowledge` — enabled (internal infrastructure, auto-invoked; not user-facing)
- `project-analysis` — enabled (stage 1, inspection)
- `project-docs` — enabled (stage 2, inspection)
- `audit-breakdown` — enabled (stage 3, inspection — breakdown half of the loop)
- `audit-approve` — enabled (stage 3, inspection — approval half of the loop)
- `audit-sync` — enabled (maintenance tool, outside the linear workflow)
