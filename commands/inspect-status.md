---
description: Show current Ono Project Inspector progress for a repository without running or changing anything.
argument-hint: "[repository-path]"
---

Invoke the `project-inspector` agent in **`status` mode** (see the agent's "Invocation Modes" section in `agents/project-inspector.md`).

If an argument was provided, treat it as the target repository path. If not, ask for it once — do not guess and do not scan the filesystem to find it.

This command is read-only: it never invokes a skill and never writes anything — on `main`, `master`, or a detached HEAD it reports that writing commands will first ask to create a local working branch, but it never creates one. It exists so a developer can check what stage the inspection is at, how many audit topics remain, and what to run next, without starting or advancing the workflow.

$ARGUMENTS
