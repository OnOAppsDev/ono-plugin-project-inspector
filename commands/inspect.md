---
description: Start, resume, or manage the Ono Project Inspector workflow on a local repository — state-aware.
argument-hint: "[repository-path]"
---

Invoke the `project-inspector` agent in **`full` mode** (see the agent's "Invocation Modes" and "Smart Startup Decision" sections in `agents/project-inspector.md`).

This is **state-aware**: it does not blindly start from the beginning. The agent first uses `inspection-state` to detect where the repository stands, then presents a status summary and a tailored set of choices and waits for your decision:

- if no inspection exists — offers to start a new one, or leave things unchanged;
- if an inspection is in progress — shows the current status and next recommended action, and offers to continue, review & approve the current Draft, generate the next topic, run `/inspect-sync`, or leave unchanged;
- if the inspection is complete and the source is unchanged since Project Knowledge was generated — reports completion and offers maintenance only (e.g. `/inspect-sync`);
- if the inspection is complete but source code changed since Project Knowledge was generated (`REFRESH_RECOMMENDED`) — reports the drift and offers **Refresh Project Knowledge**: it re-runs `project-docs` (and `project-analysis` only when build manifests or top-level structure changed) in Update mode, keeps every audit status and `CLAUDE.md` managed block intact, and regenerates `.ono/repo-knowledge.json`. It never re-runs the audit loop.

If an argument was provided, treat it as the target repository path; otherwise the agent asks for it. This command performs no inspection logic itself — all orchestration lives in `agents/project-inspector.md` and the skills it invokes. Nothing is written until you choose to start or continue. Use `/inspect-status` for a read-only snapshot, or `/inspect-topic`, `/inspect-approve`, `/inspect-sync` for narrower actions.

$ARGUMENTS
