# Recovering a Stage 1 run stopped by the Windows line-ending defect

Applies to: a `project-analysis` (Stage 1) run on Inspector **0.12.0 or 0.13.0** that wrote `CLAUDE.md` and `AUDIT.md` but stopped in its after-hook because Git for Windows checked the Markdown out with CRLF line endings (`core.autocrlf=true`):

- `verify-artifacts.ts` passed;
- `knowledge-evidence.ts verify … surfaces` failed with exit 3 and `surfaces-missing`, although `CLAUDE.md` has a valid `## Targets and Surfaces` section;
- no knowledge baseline was recorded, `.ono/` was not created, and Stage 2 (`project-docs`) did not start.

Inspector 0.14.0 reads CRLF Markdown correctly. This procedure finishes the **remaining checks of that Stage 1 run on the documents it already wrote**, with the exact commands of `hooks/after-project-analysis.md`. Nothing is analyzed again, and nothing is approved on anyone's behalf.

## Why not just run `/inspect` again

With no `.ono/state.json`, `/inspect` sees no inspection and offers **Start a new inspection** — which re-runs `project-analysis` from the beginning (the expensive stage) and asks again how to treat the existing documents. `/inspect-approve` relies on the earlier session's context, which a new session does not have. Neither is needed: the only missing work is the deterministic checks below, which do not depend on any session.

## What must be true before you start

- `CLAUDE.md` and `AUDIT.md` contain the uncommitted Stage 1 changes. **Do not commit, reset, stash, or switch branches** — the checks below must see the output exactly as Stage 1 wrote it, at the commit it was written from.
- `.ono/` does not exist.
- Your branch is an ordinary working branch (not `main`, `master` or a detached HEAD).
- Inspector **0.14.0** is installed, and Claude Code was restarted after the update so that version is the one in use:
  - **Managed update** — if your plugins are updated for you (for example by the Ono Platform Guardian), let that update complete, then quit and restart Claude Code. Do not also update by hand.
  - **Manual update** — otherwise, in Claude Code run `/plugin`, update `ono-project-inspector`, then quit and restart Claude Code.

  Either way, never assume the update happened: step 1 below verifies the installed version and its location before anything runs.

Every command below is read-only except the five marked **writes**, and each of those writes only inside the project (`.ono/state.json`, `.ono/repo-knowledge.json`, and one header line in `CLAUDE.md` and `AUDIT.md`). Run them in **Git Bash** — the shell Claude Code uses on Windows — from the project directory:

```bash
cd "/c/path/to/your/project"
unalias node 2>/dev/null || true
```

Some interactive Git Bash setups on Windows define an alias that runs `node` as `winpty node.exe`. Not every installation has it. Where it exists, a command that captures Node's output, such as `PLUGIN="$(node -e …)"` in step 1, fails with `stdout is not a tty`. The `unalias` line above removes that alias for this Git Bash window only, and does nothing if there is no alias. It does not change any permanent shell setting or your Git configuration. Run it again if you open a new window.

## 1. Find the installed Inspector — and prove it is 0.14.0

Claude Code records the active installation in `~/.claude/plugins/installed_plugins.json`. This prints every registered `ono-project-inspector` installation (to the terminal) and selects the one whose files on disk are version 0.14.0. It stops if there is none, or more than one:

```bash
# step: plugin
PLUGIN="$(node -e '
const fs = require("fs"), path = require("path"), os = require("os");
const reg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json"), "utf8"));
const rows = [];
for (const [key, list] of Object.entries(reg.plugins || {})) {
  if (!key.startsWith("ono-project-inspector@")) continue;
  for (const e of [].concat(list)) {
    let onDisk = null;
    try { onDisk = JSON.parse(fs.readFileSync(path.join(e.installPath, ".claude-plugin", "plugin.json"), "utf8")).version; } catch {}
    rows.push({ key, scope: e.scope, registered: e.version, onDisk, installPath: e.installPath });
  }
}
for (const r of rows) console.error(JSON.stringify(r));
const ok = rows.filter((r) => r.registered === "0.14.0" && r.onDisk === "0.14.0");
if (ok.length !== 1) { console.error("Expected exactly one installed ono-project-inspector 0.14.0; found " + ok.length + ". Stop here."); process.exit(1); }
process.stdout.write(ok[0].installPath);
')" && echo "Inspector 0.14.0 at: $PLUGIN"
```

If it stops: update the plugin in Claude Code and restart it, then run this step again.

## 2. Check Node.js, the Project Root and the branch (read-only)

```bash
# step: preflight
node "$PLUGIN/scripts/node-preflight.mjs"
ROOT="$(node --no-warnings "$PLUGIN/scripts/resolve-repo-root.ts" | node -e '
let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const j = JSON.parse(s);
  if (!j.ok || j.decision || j.targetIsWorktree) { console.error(s); console.error("The Project Root needs a decision. Stop here and run /inspect-status instead."); process.exit(1); }
  process.stdout.write(j.targetRoot);
});')" && echo "Project Root: $ROOT"
node --no-warnings "$PLUGIN/scripts/work-branch.ts" check "$ROOT"
git -C "$ROOT" status --short
test ! -e "$ROOT/.ono" && echo "No .ono directory yet (expected)."
```

Expect `"supported": true`, `"protected": false` with your task branch, and only `CLAUDE.md` and `AUDIT.md` listed as modified. Stop if anything differs.

## 3. Confirm the approved work is intact (read-only)

The Stage 1 run you are recovering was started as a first inspection, so its preservation snapshot was never taken. This applies the same rule the Refresh guard uses — every `AUDIT.md` topic row (status, file, `Approved <date>` note) and every `CLAUDE.md` `audit-sync` block — comparing your working files with the last commit:

```bash
# step: preserved
node --no-warnings --input-type=module -e '
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
const [plugin, root] = process.argv.slice(1);
const guard = await import(pathToFileURL(join(plugin, "scripts", "knowledge-refresh-guard.ts")).href);
const atHead = (f) => execFileSync("git", ["show", "HEAD:./" + f], { cwd: root, encoding: "utf8" });
const before = { takenAt: "HEAD", topics: guard.parseTopicRows(atHead("AUDIT.md")), managedBlocks: guard.parseManagedBlocks(atHead("CLAUDE.md")) };
const violations = guard.findViolations(before, root);
const approved = before.topics.filter((t) => t.status === "Approved").length;
console.log(approved + " Approved topic(s), " + before.topics.length + " topic row(s), " + Object.keys(before.managedBlocks).length + " managed block(s) at HEAD.");
if (violations.length) { console.log("NOT preserved:\n- " + violations.join("\n- ")); process.exit(3); }
console.log("All of them are preserved in the working files.");
' "$PLUGIN" "$ROOT"
```

On exit 3, stop and report the listed differences — do not continue.

## 4. Finish the Stage 1 checks (`hooks/after-project-analysis.md`)

Run these in order and stop at the first non-zero exit. Step 4 of the hook (the Refresh guard `verify`) does not apply: it runs only inside the Refresh flow, and this run was started as a first inspection (step 3 above made the same check).

```bash
# step: checks
node --no-warnings "$PLUGIN/scripts/verify-artifacts.ts" "$ROOT" CLAUDE.md AUDIT.md
node --no-warnings "$PLUGIN/scripts/knowledge-evidence.ts" verify "$ROOT" surfaces
node --no-warnings "$PLUGIN/scripts/inspection-state.ts" record-knowledge "$ROOT" project-analysis
node --no-warnings "$PLUGIN/scripts/inspection-state.ts" stamp-docs "$ROOT" CLAUDE.md AUDIT.md
node --no-warnings "$PLUGIN/scripts/repo-knowledge.ts" emit "$ROOT"
node --no-warnings "$PLUGIN/scripts/verify-artifacts.ts" "$ROOT" .ono/repo-knowledge.json
node --no-warnings "$PLUGIN/scripts/repo-knowledge.ts" validate "$ROOT"
node --no-warnings "$PLUGIN/scripts/inspection-state.ts" sync "$ROOT"
```

| Command | Effect |
|---|---|
| `verify-artifacts`, `knowledge-evidence` | read-only checks (hook steps 1 and 5) |
| `record-knowledge` | **writes** `.ono/state.json`: the knowledge baseline of Stage 1 (hook step 6) |
| `stamp-docs` | **writes** one header line under the H1 of `CLAUDE.md` and `AUDIT.md`, in each file's own line endings (hook step 7) |
| `repo-knowledge emit` | **writes** `.ono/repo-knowledge.json` (hook step 8); `validate` may report `coverage unknown: capabilities` until Stage 2 runs — expected |
| `sync` | **writes** `.ono/state.json`: stages, topics and the resume pointer, as after every stage |

All of them are safe to run again: a repeated run changes nothing in the documents and records the same baseline.

On Windows, some Git Bash consoles show the middle dot `·` in the header line (`Generated by ono-project-inspector … · knowledge at … · updated …`) as `┬╖`. If the files themselves contain the correct UTF-8 `·`, this is only how the console displays it. Do not edit the files, change their encoding, edit the manifest fingerprint, or change your Git configuration to fix it.

## 5. Check the result (read-only)

```bash
# step: detect
node --no-warnings "$PLUGIN/scripts/inspection-state.ts" detect "$ROOT"
git -C "$ROOT" status --short
```

Expect `"stage3Complete": true`, `"resume": { "nextAction": "stage3-complete", … }`, every audit topic still `Approved` in `counts`, and under `knowledge`: `"refreshPlan": { "stages": ["project-docs"], … }`. The status is `BASELINE_UNKNOWN` until Stage 2 has run — the complete knowledge baseline is recorded only when every source-backed stage has regenerated at the same commit. `git status` lists `CLAUDE.md` and `AUDIT.md` (modified) and `.ono/` (new) — nothing else.

`stage3Complete` describes the audit loop, not Stage 1: it is true because every audit topic in `AUDIT.md` is `Approved` (by earlier human approvals, unchanged here). A Stage 1 run that had not been interrupted would leave exactly this state at its approval gate; it records no approval of Stage 1.

This procedure covers a project inspected before, which already has its `docs/project/` documents. If `nextAction` is anything other than `stage3-complete`, stop here and ask for guidance before running `/inspect`.

## 6. Stage 1 approval — a human step

The workflow stops after Stage 1 for the developer to review its output; that review has not happened yet. **Stop here.** Review the diff of `CLAUDE.md` and `AUDIT.md` (`git diff`), with your lead where the refresh requires it. Nothing in the steps above records an approval, and nothing proceeds to Stage 2 until you choose it in the next step.

Do not continue to step 7 until this review is complete. Opening a new Claude Code session is not an approval, and neither is running `/inspect`: it only reports the state and waits for your choice.

If the review finds a problem in the Stage 1 output, stop here and ask for guidance; do not edit the documents by hand.

## 7. Continue the workflow

Only after the review in step 6: in a new Claude Code session, run `/inspect`. The Inspector reports the completed inspection with `BASELINE_UNKNOWN` (its reason reads "No knowledge-authoring HEAD recorded" — expected, because the full baseline is recorded only after Stage 2) and offers **Refresh Project Knowledge**, labelled optional, among its choices, then waits. Choosing it is your approval to continue, exactly as choosing to continue is after any Stage 1 approval gate. It runs **only `project-docs`** (Stage 2) — `project-analysis` is not repeated — with its preservation snapshot, Refresh guard, and evidence gate, then stops at the Stage 2 approval gate. No audit topic is re-opened and no audit approval is asked for again.

After reviewing Stage 2, commit and push the results yourself; the Inspector never commits.

## If something goes wrong

Every step is idempotent: after fixing the cause, start again from step 1. Nothing here deletes or overwrites your Stage 1 work. The only files written are `.ono/state.json`, `.ono/repo-knowledge.json`, and the header line in `CLAUDE.md` and `AUDIT.md`. Never reset the branch or change your global Git configuration to work around a failure — report the output instead.
