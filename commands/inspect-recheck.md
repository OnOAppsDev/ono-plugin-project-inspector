---
description: Re-check one Approved audit topic — re-verify only the findings whose cited files changed since the topic was approved or last verified.
argument-hint: "<topic> [repository-path]"
---

Invoke the `project-inspector` agent in **`maintenance` mode** (see the agent's "Invocation Modes" section in `agents/project-inspector.md`) to run the `audit-recheck` maintenance tool for the topic named in the arguments.

`audit-recheck` takes the topic's verification baseline — its last complete re-check, or the HEAD recorded when a human approved it — and looks at what changed since (`git diff <baseline>..HEAD`, renames included). Only findings whose cited files changed are re-verified against the current code and classified:

- **still open** — the problem is still there;
- **fixed** — the corrective behavior was verified in the code (a commit that last touched the files is shown only as a *candidate* fixing commit);
- **changed** — the code moved on in a way that needs **human review**.

Findings without a usable file reference are reported as **cannot scope — manual review**. A topic approved before Inspector 0.13.0 has no recorded approval HEAD: its first re-check re-verifies every finding once, labelled **baseline unknown**, and later re-checks are scoped from that verification.

Once a finding needs human review it stays flagged across later re-checks — an AI result never clears that; a future explicit review step will. This is AI re-verification, never approval. The topic stays `Approved` exactly as you approved it; `AUDIT.md`, the audit file and `CLAUDE.md` are not changed. Results, the verified HEAD and the verification date are recorded in `.ono/state.json` and shown in the report. A partial or interrupted re-check never moves the baseline, so the next one picks up the unverified findings again.

If a repository path is given after the topic, treat it as the repository path in case conversation context was lost.

**Protected branches.** Inspection results are never written to `main`, `master`, or a detached HEAD. On one of those, before writing anything, the agent asks once to create a local working branch from your current checkout (suggested: `chore/project-inspection`, or the next free `-2`, `-3`, …; you may give another name), switches to it, and stays there. Your local changes are kept as they are; nothing is fetched, committed, or pushed. On an ordinary working branch nothing is asked.

$ARGUMENTS
