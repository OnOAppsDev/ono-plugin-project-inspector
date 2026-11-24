# Hook: after-audit-recheck

Type: agent-read checkpoint instruction.
Consumed by: `agents/project-inspector.md`, immediately after each `audit-recheck` run reports completion.

Not a Claude Code `hooks.json` event — a checklist the agent follows itself.

`audit-recheck` is a maintenance tool (`workflowRole: maintenance`), run on demand via `/inspect-recheck <topic>`. It is AI re-verification, never an approval.

## Checklist

1. Confirm the skill wrote nothing itself: `AUDIT.md`, the topic's audit file, `CLAUDE.md`, `docs/` and source are unchanged, and the topic's row is still `Approved` with its notes untouched. Any other change is a contract violation — report it and do not continue.
2. Confirm results were recorded only through `node --no-warnings "<PLUGIN_ROOT>/scripts/inspection-state.ts" record-recheck "<TARGET_ROOT>" "<topic>" -`. Exit 0: complete. Exit 3: partial — the verification baseline did not move; list the pending findings. Exit 1: nothing was recorded; report why.
3. Do **not** run `stamp-docs` and do not emit the manifest: a re-check changes only `.ono/state.json`, which the manifest does not index, and no document's header changes.
4. In the report, keep **Needs human review** (every `changed` and cannot-scope finding) visible, label candidate fixing commits as candidates, give the baseline label (including "baseline unknown" for a topic approved before 0.13.0), and say: *AI re-verification — the topic's human approval is unchanged.*
5. This is maintenance, not workflow advancement: do not run any inspection stage, do not call `record-knowledge`, and do not change any topic's status.
