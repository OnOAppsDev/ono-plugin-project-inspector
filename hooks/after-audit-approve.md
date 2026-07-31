# Hook: after-audit-approve

Type: agent-read checkpoint instruction.
Consumed by: `agents/project-inspector.md`, immediately after each `audit-approve` run reports completion.

Not a Claude Code `hooks.json` event — a checklist the agent follows itself.

## Checklist

1. Confirm the skill's completion report finalized exactly one topic: one `AUDIT.md` row moved `Draft` -> `Approved`, and nothing else was written. If more than one row changed, or any `audits/*.md`, `CLAUDE.md`, `docs/`, or source file was touched, flag it as a contract violation — `audit-approve` only edits the one topic's row in `AUDIT.md`.
2. Confirm the approved topic was in `Draft` immediately before this run. If the skill reports it forced an approval from `Pending Breakdown`, from a missing/`Not created yet` file, or from an already-`Approved` state, flag it — approval requires a valid Draft.
3. Run `scripts/update-audit-index.ts` against the repository's `AUDIT.md` for the finalized topic as a deterministic verification pass: it confirms the row is well-formed and that the `File` column still matches the expected slug now that the status is `Approved`. This is a check, not a rewrite — if it disagrees with what the skill wrote, report the discrepancy to the developer rather than silently correcting the file. As a location backstop, confirm the edit landed at the real root — run `bun scripts/verify-artifacts.ts <TARGET_ROOT> AUDIT.md`; on exit 2 STOP (the finalize ran against a `.claude/worktrees/` path, not the repository).
4. Confirm the `File` reference was left exactly as `audit-breakdown` wrote it (the permanent reference) and was not recomputed or renamed.
5. **Refresh the repository-knowledge manifest.** Invoke `repo-knowledge` (`emit`) with `TARGET_ROOT` so the manifest's audit-topic index reflects the new `Approved` status. As a location backstop, confirm the manifest landed at the real root — run `bun scripts/verify-artifacts.ts <TARGET_ROOT> .ono/repo-knowledge.json`; on exit 2 STOP (the emit ran against a `.claude/worktrees/` path, not the repository). Then run `bun scripts/repo-knowledge.ts validate <TARGET_ROOT>`; on exit 2 report that the manifest is missing or malformed and do not report this step complete. The manifest carries the topic index only — topic, status, and file path — never the audit's findings, so this is a cheap index refresh and not a re-read of the audit document.
6. This is the loop-continuation signal. After a clean approval, the agent should immediately invoke `audit-breakdown` for the next `Pending Breakdown` topic (no separate approval gate between approve and the next draft), then stop at that new Draft's review gate. If there are no `Pending Breakdown` topics left and no `Draft` topics remain, do not invoke `audit-breakdown` again — report that Stage 3 is complete.
7. In your stage-transition report, tell the developer how many topics are now `Approved`, how many `Draft` remain, and how many `Pending Breakdown` remain, so they can see the loop's progress.

## Why this exists

`audit-approve` is the single owner of the `Draft` -> `Approved` transition and the trigger that lets the Stage 3 breakdown-approve loop advance. This hook is the enforcement point that keeps the transition developer-owned and single-row, verifies the deterministic slug/status contract independently of the LLM-driven edit, and tells the agent when to break down the next topic versus when to declare Stage 3 complete.
