---
name: audit-recheck
description: >-
  On-demand maintenance tool for the project-inspector plugin (0.13.0). Re-checks
  one already-Approved audit topic: only the findings whose cited files changed
  since the topic's verification baseline (git diff <baseline>..HEAD) are
  re-verified against the current source and classified still-open, fixed, or
  changed. Results are recorded in .ono/state.json and reported. It is AI
  re-verification, never a human approval: it never changes AUDIT.md, the
  approval, or any audit file. Invoked via /inspect-recheck <topic>.
---

# Audit Re-check Skill

## Purpose

Tell the developer which findings of an **Approved** audit topic may no longer hold because the code they cite has changed — and re-verify only those, so a re-check costs a fraction of a new breakdown.

This skill is a **maintenance tool, not a workflow stage** (`workflowRole: maintenance`). The Project Inspector agent runs it only on demand, via `/inspect-recheck <topic>`, in `maintenance` mode.

## What it never does

- It never approves anything and never presents its results as an approval. A topic's `Approved` status, its approval date and its recorded approval HEAD stay exactly as the human left them.
- It never writes `AUDIT.md`, an audit file, `CLAUDE.md`, `docs/`, or source code. Its only write is through `inspection-state.ts record-recheck`, into `.ono/state.json`.
- It never marks a finding `fixed` because its file changed, moved, or was deleted. `fixed` means the corrective behavior was verified in the current code.
- It never resolves a `changed` finding on the developer's behalf: `changed` means a human has to review it. Once a finding needs human review (`changed`, or cannot be scoped), it stays flagged: no later AI result clears it, and every re-check lists it again. Clearing it requires an explicit human-review step that does not exist yet.

## Steps

All helper commands run by absolute plugin path, with every path quoted (see the agent's "Plugin Root and Execution"). Inspect source read-only, under `docs/shell-execution-rules.md`.

1. **Scope (read-only).** Run `node --no-warnings "${CLAUDE_PLUGIN_ROOT}/scripts/audit-recheck.ts" scope "<TARGET_ROOT>" "<topic>"`. Exit 1 = stop and show its message (unknown topic, not `Approved`, missing audit file, Git unavailable). Its JSON lists every finding with:
   - `scope: affected` — a cited file changed since the baseline (`changes` shows modified / deleted / renamed → new path); re-verify it;
   - `scope: unaffected` — no cited file changed; do not re-verify it;
   - `scope: cannot-scope` — no usable file reference; report it as **cannot scope — manual review**, never guess a result;
   - `baseline.label` — say it to the developer verbatim. `mode: full` with "baseline unknown" means the topic was approved before 0.13.0 (or its baseline left the history): every scopable finding is re-verified once. No historical approval commit is inferred.
   - `needsHumanReview` — findings still waiting for a human (earlier `changed` results, cannot-scope findings); always list them.
2. **Confirm.** Show the developer the topic, the baseline label, and the counts (affected / unaffected / cannot scope / needing human review). Ask before re-verifying — it reads source and costs time. If they decline, stop; nothing is written.
3. **Re-verify each affected finding** — and only those. Read the finding in the audit file, then the current code at its cited paths (for a rename, at the new path). Classify it:
   - **`still-open`** — the problem the finding describes is still present. Evidence: where and what.
   - **`fixed`** — you verified that the code now behaves correctly in the way the finding asked for. Evidence: the corrective behavior and where it is. A deleted or rewritten file is not evidence of a fix on its own.
   - **`changed`** — the code changed so that the finding no longer clearly applies, applies differently, or cannot be decided. Evidence: what changed. This always needs human review.

   Evidence is one or two sentences of your own words with file paths — never pasted source code, secrets, or credentials.
   A commit that last touched the cited files is only a **candidate** fixing commit; the helper records it as such. Name a `fixCommit` (with `fixCommitEvidence`) only when you verified that commit's diff made the fix.
4. **Record.** Run `node --no-warnings "${CLAUDE_PLUGIN_ROOT}/scripts/inspection-state.ts" record-recheck "<TARGET_ROOT>" "<topic>" -` with the results as JSON on stdin:

   ```json
   { "scopeHead": "<the scope's head>", "results": [ { "id": "F-…", "result": "still-open|fixed|changed", "evidence": "…" } ] }
   ```

   Exit 0 = every affected finding recorded; the topic's `verifiedHead` / `verifiedAt` now point at this HEAD. Exit 3 = partial: what you gave is recorded, the baseline does **not** advance, and the next re-check covers the rest again — say which findings are still pending. Exit 1 = nothing recorded (it lists why: a stale scope, an unknown or out-of-scope id, a missing evidence); fix the input or re-run the scope — never edit `state.json` by hand.
5. **Report.** Per finding: id, heading, result and evidence; `fixed` with its candidate commit labelled "candidate"; every `changed` and cannot-scope finding under **Needs human review**; the unaffected count; the baseline label. State plainly: *AI re-verification — the topic's human approval is unchanged.*

## Hard Constraints

- Re-verify only `affected` findings. Never record a result for an `unaffected` or `cannot-scope` finding.
- Never write any file yourself; `record-recheck` is the only writer, and it refuses on `main`, `master`, or a detached HEAD.
- Never change `AUDIT.md` statuses or notes, approval data, audit files, or `CLAUDE.md` managed blocks.
- Never describe a re-check result as approval, re-approval, or sign-off.
- Never assume the current working directory is the repository. Operate only on the absolute `<TARGET_ROOT>` the orchestrator passes.
