---
description: Approve the current Ono Project Inspector gate — finalize the reviewed audit Draft (or advance one stage), then continue.
argument-hint: "[repository-path]"
---

Invoke the `project-inspector` agent in **`resume` mode** (see the agent's "Invocation Modes" section in `agents/project-inspector.md`).

This is the explicit, discoverable equivalent of replying "approved, continue" in conversation. Its effect depends on what is awaiting approval:

- **A Stage 3 audit Draft** — the agent runs the `audit-approve` skill to finalize that topic (`Draft` -> `Approved` in `AUDIT.md`), then immediately breaks down the **next** `Pending Breakdown` topic and stops at that new Draft's review gate. If no topics remain, it reports Stage 3 complete instead.
- **A non-repeatable stage** (`project-analysis`, `project-docs`) — the agent advances exactly one step to the next stage.

If an argument was provided, treat it as the repository path in case conversation context was lost; otherwise rely on context from the current session. This command advances one finalize-and-continue cycle; it never generates two Drafts without a review gate in between, and it never marks a topic Approved without your approval (running this command is that approval).

**Protected branches.** Inspection results are never written to `main`, `master`, or a detached HEAD. On one of those, before writing anything, the agent asks once to create a local working branch from your current checkout (suggested: `chore/project-inspection`, or the next free `-2`, `-3`, …; you may give another name), switches to it, and stays there. Your local changes are kept as they are; nothing is fetched, committed, or pushed. On an ordinary working branch nothing is asked.

$ARGUMENTS
