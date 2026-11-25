# Knowledge freshness contract (contractVersion 1)

`inspection-state.ts freshness` tells another tool — for example the Ono Platform Guardian — whether the Project Knowledge of an inspected project still matches its source. It is read-only, needs only Node.js and local Git, works on every branch (including `main`, `master` and a detached HEAD), and never refreshes anything.

```bash
node --no-warnings "<plugin>/scripts/inspection-state.ts" freshness "<project root>"              # checked-out HEAD + working tree
node --no-warnings "<plugin>/scripts/inspection-state.ts" freshness "<project root>" --ref <rev>  # one exact commit (0.14.0)
node --no-warnings "<plugin>/scripts/inspection-state.ts" freshness "<project root>" --ref=<rev>  # same
```

`<project root>` is the inspected project's directory (it may sit below the Git root).

## Exit codes and output

- **Exit 0** — every handled outcome, including every `BASELINE_UNKNOWN` and `NOT_APPLICABLE`. stdout is exactly one JSON object; stderr is empty.
- **Exit 1** — a usage error, with a message on stderr and nothing on stdout: a missing project root, a path inside `.claude/worktrees/`, or a malformed argument — `--ref` without a value, an empty `--ref=`, `--ref` given twice, a revision starting with `-` or containing a control character, or any other argument.

## Fields

```json
{
  "contractVersion": 1,
  "status": "REFRESH_RECOMMENDED",
  "changedSourceCount": 6,
  "checkedAt": "2026-11-25T10:00:00.000Z",
  "checkedHead": "<40-hex commit>",
  "knowledgeHead": "<40-hex commit>",
  "reason": "6 source file(s) changed since knowledge was generated.",
  "signals": {
    "analysis": [
      { "kind": "build-manifest-changed", "count": 3 },
      { "kind": "top-level-entry-added", "count": 1 },
      { "kind": "top-level-entry-removed", "count": 1 },
      { "kind": "surface-evidence-changed", "count": 2, "surfaces": ["tizen", "web"] }
    ],
    "model": [],
    "refreshStages": ["project-analysis", "project-docs"],
    "affected": { "surfaces": ["tizen", "web"], "capabilities": ["epg"], "relationships": [] }
  },
  "ref": { "requested": "origin/dev", "resolved": "<40-hex commit>" }
}
```

| Field | Type | Meaning |
|---|---|---|
| `contractVersion` | `1` | This contract. Additive fields keep 1; a consumer ignores fields it does not know. |
| `status` | string | See "Statuses". |
| `changedSourceCount` | number \| null | Changed source files between `knowledgeHead` and `checkedHead` (Inspector-owned paths excluded). `0` for `COMPLETE`; `null` whenever not established. |
| `checkedAt` | ISO-8601 | When this result was computed. |
| `checkedHead` | commit \| null | The commit measured: the checked-out HEAD, or with `--ref` the resolved commit. `null` when it cannot be read or the revision did not resolve. |
| `knowledgeHead` | commit \| null | The knowledge-authoring commit recorded in the measured state, or `null`. |
| `reason` | string | For people; never parse it. |
| `signals` | object \| null | *Additive (0.14.0).* The classification behind the status — see "Signals". `null` whenever the status is not established (`BASELINE_UNKNOWN`, `NOT_APPLICABLE`). |
| `ref` | object | *Additive (0.14.0), present only with `--ref`.* `requested`: the revision exactly as given. `resolved`: the commit it resolved to — always equal to `checkedHead` — or `null` when it did not resolve. |

## Statuses

| Status | Meaning |
|---|---|
| `COMPLETE` | The knowledge matches the source at `checkedHead`, and is in the current knowledge model. |
| `REFRESH_RECOMMENDED` | Source changed since `knowledgeHead`, or the knowledge lacks a section the current model requires. |
| `BASELINE_UNKNOWN` | Freshness cannot be established. Never reported as fresh. Causes: no recorded `knowledgeHead`; `knowledgeHead` not in the local history (rewritten or shallow); a failed Git command; Git unavailable; unreadable or invalid state; with `--ref`, a revision that does not resolve to exactly one commit, or a Git object (state, knowledge document, tree) that is not available locally. |
| `NOT_APPLICABLE` | No completed inspection: no `.ono/state.json` in the project (with `--ref`: at that commit), or an inspection still in progress. |

## `--ref <rev>` — one exact commit

1. **Resolve.** `<rev>` is any revision Git accepts — a branch, `origin/dev`, a tag, a commit id, `refs/heads/dev`, `HEAD~1`. It must resolve to exactly one commit; a range, a path (`dev:file`), a tree or blob id, an unknown name, and an **ambiguous** name (a branch and a tag with the same name, or a ref that also abbreviates an object id) are not resolved — use a full ref name or a commit id. Inspector never chooses the central branch: the caller does.
2. **Read that commit only.** The state, the knowledge documents (`CLAUDE.md`, `docs/project/*.md`) and the knowledge-model sections are read from Git objects at the resolved commit, at the project's path inside the repository (nested projects work). Drift is computed from that state's `knowledgeHead` to the resolved commit. The checked-out branch, the working tree and the index are never read — a dirty or divergent checkout has no effect — and nothing ever falls back to them.
3. **Absent vs unavailable.** A file that is not in the commit's tree is absent (no state → `NOT_APPLICABLE`). A tree entry whose object cannot be read is unavailable → `BASELINE_UNKNOWN`, never `NOT_APPLICABLE` and never `COMPLETE`.
4. **Read-only, offline.** No checkout, fetch, ref update, index change or file write. Every Git call that resolves the revision or reads the commit runs with `GIT_NO_LAZY_FETCH=1`, `GIT_OPTIONAL_LOCKS=0` and `GIT_TERMINAL_PROMPT=0`. In a partial clone (a promisor remote — the only case where Git can fetch a missing object lazily) every such call also passes `git --no-lazy-fetch`; a Git that does not support that option rejects the call, so the result is `BASELINE_UNKNOWN` rather than a network access. A missing object is never downloaded: it gives `BASELINE_UNKNOWN`. This is a run-time capability check, not a Git version number, and ordinary (non-partial) clones get no additional requirement.

Without `--ref` the command behaves exactly as in 0.13.0 (plus `signals`): it measures the checked-out HEAD with the state and documents in the working tree.

## Signals

Present whenever `status` is `COMPLETE` or `REFRESH_RECOMMENDED`.

- **`analysis`** — always all four kinds, in this order; consumers must ignore kinds they do not know (future versions may append):

  | `kind` | `count` |
  |---|---|
  | `build-manifest-changed` | changed source files that are build, dependency, CI or surface-declaring manifests (`package.json`, Gradle/Xcode/Podfile/… files, `AndroidManifest.xml`, Smart TV descriptors, bundler configs, `.github/workflows/**`, …) |
  | `top-level-entry-added` | top-level entries of the project that exist at `checkedHead` but not at `knowledgeHead` and contain a changed file |
  | `top-level-entry-removed` | top-level entries that existed at `knowledgeHead` and no longer exist at `checkedHead` |
  | `surface-evidence-changed` | changed source files that are (or are inside) a path recorded as evidence of a surface or a Shared Code row; `surfaces` lists the declared surface ids that evidence belongs to (sorted) |

  Counts are of distinct files (entries for the two top-level kinds) over the **full** change list. A file may count under more than one kind. `0` means established and absent; an unknown count is never reported as `0` — the whole `signals` is `null` instead.
- **`model`** — knowledge-model requirements the knowledge lacks, `{ stage, requirement }`, in registry stage order then requirement order (`requirement` is an Inspector document section such as `docs/project/patterns.md#accessibility`).
- **`refreshStages`** — the source-backed stages a Refresh Project Knowledge would run now, in registry order (empty when `COMPLETE`).
- **`affected`** — sorted ids of the recorded surfaces, capabilities and relationships whose recorded roots or evidence contain a changed file. Attribution, not a verdict.

`signals` carries no file path, no source content and no credential: only signal kinds, counts, and ids that are already in the committed knowledge documents. Inspector classifies; it sets no threshold and never refreshes on its own. Whether a change justifies offering a refresh is the consumer's decision.

## Detecting support (Guardian)

**Inspector 0.13.0 silently ignores `--ref`** and returns the working-tree result for the checked-out HEAD. Before trusting a ref-based result, a consumer must verify, on every call:

1. `contractVersion === 1`;
2. `ref` is an object with `ref.requested` equal to the revision it passed;
3. either `ref.resolved` is a 40- or 64-hex commit id **equal to `checkedHead`**, or `ref.resolved === null` with `status === "BASELINE_UNKNOWN"`.

Any other shape — in particular a missing `ref` — means the installed Inspector does not support `--ref`: treat the result as unknown. `signals` is absent (not `null`) on 0.13.0, so its presence is a second capability indicator for the classification itself.
