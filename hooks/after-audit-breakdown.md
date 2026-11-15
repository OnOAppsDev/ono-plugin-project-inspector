# Hook: after-audit-breakdown

Type: agent-read checkpoint instruction.
Consumed by: `agents/project-inspector.md`, immediately after each `audit-breakdown` cycle (one topic) reports completion.

Not a Claude Code `hooks.json` event — a checklist the agent follows itself.

## Checklist

1. Confirm the skill's completion report lists exactly one topic processed, one new/updated `audits/<slug>/<slug>-audit.md`, and one updated row in `AUDIT.md`. If more than one topic was touched, flag this as a contract violation — `audit-breakdown` must process exactly one topic per run.
2. Run `scripts/update-audit-index.ts` against the repository's `AUDIT.md` as a deterministic verification pass: it re-derives the expected slug for the processed topic via `scripts/slugify.ts` and checks that the `File` column matches. This is a check, not a rewrite — if it disagrees with what the skill wrote, report the discrepancy to the developer rather than silently correcting the file. Then **independently verify the Draft file exists at the real root** (do not rely on the skill's textual report): run `bun "<PLUGIN_ROOT>/scripts/verify-artifacts.ts" <TARGET_ROOT> audits/<slug>/<slug>-audit.md` with the concrete `<slug>` just derived. On exit 2 STOP (root is a worktree). On exit 4, if `leakedTo` points under `.claude/worktrees/…` report that the Draft was written into a Claude agent worktree instead of the repository; in all exit-4 cases report the gap and do not report the Draft complete.
3. Confirm the row's `Status` is `Draft`, never `Approved`. Only the developer can set `Approved`; if you see `Approved` written by the skill itself, flag it.
4. This stage always has `requiresApproval: true` — stop at the Draft's review gate after one cycle, regardless of how many `Pending Breakdown` topics remain. Do not break down another topic until the developer approves this one.
5. In your stage-transition report, tell the developer the Draft is ready for review and how many `Pending Breakdown` topics remain. Make clear that approving (via `/inspect-approve`) runs `audit-approve` to finalize this topic and then automatically breaks down the next one — so they know whether an approval will continue the loop or complete Stage 3.

## Why this exists

`audit-breakdown` is repeatable and stateful (it mutates `AUDIT.md` row by row). This hook is the enforcement point that keeps repeated cycles from drifting — verifying the deterministic slug/status contract independently of the LLM-driven edit, and making sure the one-Draft-per-review-gate rule is never silently skipped (the loop only advances when the developer approves, which runs `audit-approve`).
