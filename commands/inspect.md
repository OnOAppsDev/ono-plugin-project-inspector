---
description: Start, resume, or manage the Ono Project Inspector workflow on a local repository — state-aware.
argument-hint: "[repository-path]"
---

Invoke the `project-inspector` agent in **`full` mode** (see the agent's "Invocation Modes" and "Smart Startup Decision" sections in `agents/project-inspector.md`).

This is **state-aware**: it does not blindly start from the beginning. The agent first uses `inspection-state` to detect where the repository stands, then presents a status summary and a tailored set of choices and waits for your decision:

- if no inspection exists — offers to start a new one, or leave things unchanged;
- if an inspection is in progress — shows the current status and next recommended action, and offers to continue, review & approve the current Draft, generate the next topic, run `/inspect-sync`, or leave unchanged;
- if the inspection is complete and the source is unchanged since Project Knowledge was generated — reports completion and offers maintenance only (e.g. `/inspect-sync`);
- if the inspection is complete and Project Knowledge is stale (`REFRESH_RECOMMENDED`) — because source code changed since it was generated, or because it predates the current knowledge model (e.g. it lacks the `CLAUDE.md` Targets and Surfaces section or `docs/project/capabilities.md`; this applies even with no source change) — reports the drift and/or missing sections and offers **Refresh Project Knowledge**: it re-runs `project-docs` in Update mode, plus `project-analysis` only when a build/dependency/CI or surface-declaring manifest changed, a file recorded as surface evidence changed, a top-level entry appeared or disappeared, or `project-analysis`'s own output predates the knowledge model (a stage with a model gap always re-runs, together with every later source-backed stage). It keeps every audit status and `CLAUDE.md` managed block intact, regenerates `.ono/repo-knowledge.json`, and never re-runs the audit loop;
- if the inspection is complete but no knowledge baseline is recorded (`BASELINE_UNKNOWN`, e.g. inspected before 0.10.0) — says freshness cannot be established and offers the same Refresh as an optional step.

If an argument was provided, treat it as the path of the project to inspect — the repository root, or a project directory below it (the Project Root; Git still operates on the repository root). Otherwise the agent resolves it from the current directory and asks whenever that is ambiguous; it never picks a subproject on its own. This command performs no inspection logic itself — all orchestration lives in `agents/project-inspector.md` and the skills it invokes. Nothing is written until you choose to start or continue. Use `/inspect-status` for a read-only snapshot, or `/inspect-topic`, `/inspect-approve`, `/inspect-sync` for narrower actions.

$ARGUMENTS
