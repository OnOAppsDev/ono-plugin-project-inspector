# Hook: after-project-analysis

Type: agent-read checkpoint instruction.
Consumed by: `agents/project-inspector.md`, immediately after the `project-analysis` skill reports completion.

Not a Claude Code `hooks.json` event — a checklist the agent follows itself.

## Checklist

1. **Independently verify artifacts at the real root — do not rely on the skill's textual "written" report.** Run `bun scripts/verify-artifacts.ts <TARGET_ROOT> CLAUDE.md AUDIT.md`. Advance only on exit 0. On failure:
   - exit 2 (`target-root-is-worktree`) → root resolution failed upstream; STOP and report — the workflow must not run against a `.claude/worktrees/` path.
   - exit 4 → an artifact is missing at the real root. If the JSON shows `leakedTo` pointing under `.claude/worktrees/…`, report that the skill wrote into a Claude agent worktree instead of the repository. In all exit-4 cases: do NOT advance to `audit-breakdown` and do NOT report the stage complete; report the gap to the developer instead.
2. Confirm the report explicitly states `audits/` was **not** created. If the skill's own output contract was violated (e.g. it created `audits/` prematurely), flag this to the developer — do not silently continue, and do not attempt to fix it yourself (you never touch repository files directly).
3. Read the `AUDIT.md` topic count from the skill's summary. Include it in your own stage-transition report to the developer.
4. **Preservation guard (Refresh Project Knowledge only).** If this run is part of the agent's "Refresh Project Knowledge" flow, run `bun scripts/knowledge-refresh-guard.ts verify <TARGET_ROOT>`. On exit 3 STOP: report the listed violations (a removed or re-statused `AUDIT.md` topic row, a changed file reference, a lost `Approved <date>` note, or an altered/removed `audit-sync:*` managed block in `CLAUDE.md`), tell the developer to restore those files from Git, and do **not** run steps 5–6 or report the stage complete. On exit 2 (no snapshot) STOP and report that the refresh was started without its snapshot. Skip this step on a first-time inspection.
5. **Record the knowledge-authoring HEAD.** Run `bun scripts/inspection-state.ts record-knowledge <TARGET_ROOT> project-analysis`. This is the only point where the Project Knowledge HEAD is recorded for this stage — it certifies that `project-analysis` just regenerated its knowledge from source. On a non-zero exit report the error and do not report the stage complete. Never run this from any other hook or mode.
6. **Refresh the repository-knowledge manifest.** Invoke the internal `repo-knowledge` skill (`emit`) with `TARGET_ROOT`, then verify it landed at the real root: `bun scripts/verify-artifacts.ts <TARGET_ROOT> .ono/repo-knowledge.json`. On exit 2 STOP (the root is a worktree). Then run `bun scripts/repo-knowledge.ts validate <TARGET_ROOT>`; on exit 2 report that the manifest is missing or malformed and do not report the stage complete. If `validate` reports any category as `coverage unknown`, mention which ones once in your stage-transition report — that is informational, not a failure, and it tells the developer which knowledge downstream plugins will still derive themselves.
7. This stage always has `requiresApproval: true` in the registry — stop here regardless of how clean the output looks. Do not auto-invoke `audit-breakdown`. During a refresh, the next approved step is the next stage in the refresh plan (normally `project-docs`), never `audit-breakdown`.
8. When presenting the pause to the developer, surface the recommended first breakdown topic that `project-analysis` reported, so approving forward progress is a one-line reply.

## Why this exists

`project-analysis` and `audit-breakdown` are independent skills that don't know about each other's execution at runtime — this hook is where the orchestrator enforces the contract between them (audit index must exist and be well-formed before breakdown starts) without either skill needing to be aware of the other.
