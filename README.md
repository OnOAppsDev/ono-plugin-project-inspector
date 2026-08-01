# Ono Project Inspector

First plugin in the Ono internal AI Marketplace. Inspects an existing repository and gradually builds a structured AI knowledge base for it: `CLAUDE.md`, `AUDIT.md`, a `docs/project/` knowledge base, and per-topic `audits/*.md` files — then syncs approved audit findings back into `CLAUDE.md`.

This is not an implementation assistant. It never modifies source code, never writes feature docs, implementation plans, or source-code patches.

## Commands

| Command | Responsibility |
|---|---|
| `/inspect [repo-path]` | Run or resume the complete guided workflow end to end. Default entry point. |
| `/inspect-status [repo-path]` | Read-only progress report: artifacts present, audit topic counts, enabled/disabled skills, recommended next action. Invokes no skill. |
| `/inspect-topic [topic-name] [repo-path]` | Jump straight to breaking down one audit topic (or the next pending one), skipping the general narrative. |
| `/inspect-approve [repo-path]` | Approve the current gate: finalize the reviewed audit Draft (`Draft` → `Approved`) and break down the next topic, or advance one non-repeatable stage. |
| `/inspect-sync [repo-path]` | Run the `audit-sync` documentation-maintenance tool on demand: refresh the managed blocks in `CLAUDE.md` from approved audits, verify consistency, repair drift. Not part of the linear workflow. |

No command invokes a skill directly by name — every command routes through the `project-inspector` agent, which is the only thing that knows how to sequence skills.

## What it does

1. Runs `project-analysis` to generate `CLAUDE.md` and a concise `AUDIT.md` topic index.
2. Runs `project-docs` to build a descriptive `docs/project/` knowledge base (overview, component inventory, patterns, integrations).
3. Runs the **breakdown → approve loop** over audit topics, one at a time:
   - `audit-breakdown` expands one topic into a `Draft` audit document under `audits/<topic-slug>/` and stops for review.
   - `audit-approve` finalizes the reviewed Draft (`Draft` → `Approved` in `AUDIT.md`) — it is the single owner of that transition — after which the next topic is broken down automatically.
4. Stops for developer approval between every stage and after every Draft.
5. Separately, on demand, `audit-sync` (documentation maintenance) folds the HIGH/MEDIUM findings of approved topics into managed blocks inside `CLAUDE.md` and checks the index for drift. It never approves anything and is not part of the linear workflow.

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
agents/project-inspector.md  orchestrator (coordination only, never inspects repos itself; supports 5 invocation modes)
commands/inspect.md          /inspect — full workflow
commands/inspect-status.md   /inspect-status — read-only progress report
commands/inspect-topic.md    /inspect-topic — targeted topic breakdown
commands/inspect-approve.md  /inspect-approve — finalize the reviewed Draft, then continue
commands/inspect-sync.md     /inspect-sync — on-demand documentation-sync maintenance
skills/                      vendored skills + registry.json (extensibility seam); includes internal inspection-state
hooks/                       agent-read checkpoint instructions between stages
scripts/                     deterministic helpers (slug rules, AUDIT.md consistency, .ono/state.json state, .ono/repo-knowledge.json manifest)
templates/                   reserved for future skills; unused by current skills by design
docs/repo-knowledge-contract.md   outbound contract consumed by other Ono plugins
                             (architecture and workflow docs live in ono-plugin-marketplace)
```

The plugin also maintains a committed, portable state file at `<target-repo>/.ono/state.json` (owned by the internal `inspection-state` skill) so an interrupted inspection resumes exactly where it left off. `AUDIT.md` remains the source of truth; the state file only mirrors it.

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
