# Hook: after-project-docs

Type: agent-read checkpoint instruction.
Consumed by: `agents/project-inspector.md`, immediately after the `project-docs` skill reports completion.

Not a Claude Code `hooks.json` event — a checklist the agent follows itself.

## Checklist

1. **Independently verify artifacts at the real root — do not rely on the skill's textual "written" report.** Run `bun scripts/verify-artifacts.ts <TARGET_ROOT> docs/project/overview.md docs/project/components.md docs/project/patterns.md docs/project/integrations.md`. Advance only on exit 0. On exit 2 (`target-root-is-worktree`) STOP and report — the workflow must not run against a `.claude/worktrees/` path. On exit 4, if any `leakedTo` points under `.claude/worktrees/…` report that the skill wrote into a Claude agent worktree instead of the repository; in all exit-4 cases report the gap and do not advance or report completion.
2. Confirm the report states that `CLAUDE.md`, `AUDIT.md`, and `audits/` were **not** modified. `project-docs` is descriptive-only and must not touch those files or the audit index. If its output contract was violated, flag it and do not attempt to fix it yourself.
3. `project-docs` requires `CLAUDE.md` to already exist. If the skill reported that it stopped because `CLAUDE.md` was missing, do not treat the stage as complete — report that `project-analysis` must run first.
4. **Refresh the repository-knowledge manifest.** Invoke `repo-knowledge` (`emit`) with `TARGET_ROOT`. As a location backstop, confirm the manifest landed at the real root — run `bun scripts/verify-artifacts.ts <TARGET_ROOT> .ono/repo-knowledge.json`; on exit 2 STOP (the emit ran against a `.claude/worktrees/` path, not the repository). Then run `bun scripts/repo-knowledge.ts validate <TARGET_ROOT>`; on exit 2 report that the manifest is missing or malformed and do not report this step complete. Three of the four `docs/project/` files back a manifest coverage category — `components.md` → `inventory`, `patterns.md` → `conventions`, `integrations.md` → `integrations` — so those categories only become usable to downstream plugins after this refresh. `overview.md` is indexed as a pointer but has no coverage category of its own. Report any category still `unknown`.
5. This stage always has `requiresApproval: true` in the registry — stop here regardless of how clean the output looks. Do not auto-invoke `audit-breakdown`.
6. In your stage-transition report, remind the developer that `project-docs` (a descriptive inventory) and `audit-breakdown` (evaluative findings) are complementary — the next stage produces per-topic audit findings, not a repeat of the docs.

## Why this exists

`project-docs` sits between `project-analysis` and `audit-breakdown` and consumes the former's output (`CLAUDE.md`) without knowing about the latter at runtime. This hook is where the orchestrator confirms the descriptive knowledge base was produced within its read-only contract before the workflow moves on to evaluative audit work.
