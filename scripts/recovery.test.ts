/**
 * recovery.test.ts — the documented recovery of a Stage 1 run stopped by the CRLF defect (0.14.0).
 *
 * Runs the command blocks of docs/recovering-interrupted-stage-1.md VERBATIM (every block
 * whose first line is `# step: <name>`) in sh, on a synthetic replica of the reported state:
 *
 *   - core.autocrlf=true checkout of an origin with LF blobs and no .gitattributes;
 *   - a task branch with uncommitted Stage 1 (Update mode) changes to CLAUDE.md and AUDIT.md;
 *   - 22 Approved audit topics and two audit-sync blocks, unchanged; no .ono; no Stage 2.
 *
 *   RC1  the released 0.13.0 after-hook stops exactly as reported (surfaces-missing, no .ono)
 *   RC2  the plugin-location step selects the installed 0.14.0 by its files, never a guess
 *   RC3  the documented steps succeed; nothing is re-analyzed; branch and HEAD unchanged
 *   RC4  nothing lost: 22 approvals, both managed blocks, every Stage 1 byte (header aside), CRLF
 *   RC5  nothing approved on anyone's behalf: no approval baselines, no audit or topic change
 *   RC6  the state equals an uninterrupted Stage 1 that reached its approval gate
 *   RC7  repeating every step is safe and idempotent
 *   RC8  the next step is project-docs only; a Refresh of Stage 2 completes the knowledge
 *   RC9  the document runs exactly the after-project-analysis hook's commands
 *   RC10 the approval boundary: no step records an approval; the document stops for the human
 *        Stage 1 review before /inspect, and says a new session / /inspect is not an approval
 *
 * Run with: node --no-warnings scripts/recovery.test.ts
 */

import { spawnSync } from "child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { extractRelease, helper, PLUGIN } from "./fixtures/inspected.ts";
import { commitOrigin, crlf, employeeClone, eolCounts, gitEol } from "./fixtures/line-endings.ts";
import {
  APP_SHARED, APP_SOURCE, APP_SURFACES, capabilitiesMd, claudeMd, componentsMd, integrationsMd, patternsMd, surfacesSection, write,
  APP_CAPABILITIES, APP_RELATIONSHIPS, APP_SCREENS, APP_COMPONENTS, APP_SERVICES,
} from "./fixtures/knowledge-fixtures.ts";
import { SH, shPath } from "./fixtures/platform.ts";
import { stripHeader } from "./doc-header.ts";
import { parseManagedBlocks, parseTopicRows } from "./knowledge-refresh-guard.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ""}`); }
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "inspector-recovery-")));
const REL_0130 = "3ef4cd1771b57fd969ff2b78e95f33931a9fcea5";
const DOC = readFileSync(join(PLUGIN, "docs", "recovering-interrupted-stage-1.md"), "utf-8");
const read = (dir: string, rel: string) => readFileSync(join(dir, rel), "utf-8");
const WORK = "task/inspect-refresh";

/** The doc's `# step:` blocks, by name, exactly as written. */
const STEPS = new Map<string, string>();
for (const m of DOC.matchAll(/```bash\n# step: ([a-z-]+)\n([\s\S]*?)```/g)) STEPS.set(m[1], m[2]);

/** A fake home whose installed_plugins.json registers the given installs. */
function fakeHome(name: string, installs: Record<string, Array<{ scope: string; version: string; installPath: string }>>): string {
  const home = join(root, name);
  mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
  writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: installs }, null, 2));
  return home;
}
/** Run doc steps in one sh process from `cwd` (the plugin and preflight steps first, quietly, when needed). */
function steps(home: string, cwd: string, names: string[]): { code: number; out: string; err: string } {
  const prelude = names[0] === "plugin" ? [] : ["plugin", "preflight"].map((n) => `{\n${STEPS.get(n)}\n} >/dev/null 2>&1`);
  const script = ["set -e", `cd "${shPath(cwd)}"`, ...prelude, ...names.map((n) => STEPS.get(n) ?? `echo "missing step ${n}" >&2; exit 99`)].join("\n");
  const r = spawnSync(SH, ["-c", script], { encoding: "utf-8", env: { ...process.env, HOME: home, USERPROFILE: home } });
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}
/** The files of a directory tree (relative path -> bytes), .git and .ono excluded. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === ".ono") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(d, e.name), r);
      else out.set(r, readFileSync(join(d, e.name), "latin1"));
    }
  };
  walk(dir, "");
  return out;
}

// --- the replica ---------------------------------------------------------------------------------
const CAUTION = "\n<!-- audit-sync:caution-areas:start -->\n- [HIGH] Shared state written from the player (Architecture).\n<!-- audit-sync:caution-areas:end -->\n";
const IMPORTANT_APPROVED = "<!-- audit-sync:important-files:start -->\n- `src/store/guideStore.ts` — shared guide state (Architecture).\n<!-- audit-sync:important-files:end -->";
function oldClaude(): string {
  // An older-model CLAUDE.md: no Targets and Surfaces section; populated audit-sync blocks.
  return claudeMd("", "React web, Tizen").replace(/<!-- audit-sync:important-files:start -->[\s\S]*?<!-- audit-sync:important-files:end -->/, IMPORTANT_APPROVED) + CAUTION;
}
const TOPICS = Array.from({ length: 22 }, (_, i) => (i === 0 ? "Architecture" : `Topic ${i + 1}`));
const slug = (t: string) => t.toLowerCase().replace(/\s+/g, "-");
const auditMd = (extra = "") => `# AUDIT.md\n\n${extra}## Audit Topics\n\n| # | Status | Topic | Priority | File | Notes |\n|---|---|---|---|---|---|\n` +
  TOPICS.map((t, i) => `| ${i + 1} | Approved | ${t} | Medium | audits/${slug(t)}/${slug(t)}-audit.md | Approved 2026-10-${String(i + 1).padStart(2, "0")} |`).join("\n") + "\n";

function origin(dir: string): void {
  for (const [rel, body] of Object.entries(APP_SOURCE)) write(dir, rel, body);
  write(dir, "CLAUDE.md", oldClaude());
  write(dir, "AUDIT.md", auditMd());
  for (const t of TOPICS) write(dir, `audits/${slug(t)}/${slug(t)}-audit.md`, `# ${t} Audit\n\n## Findings\n\nNone.\n`);
  // Older-model docs/project: no capabilities.md, none of the generic patterns sections.
  write(dir, "docs/project/overview.md", "# Project Overview — Demo\n\n## What This Project Is\n\nDemo.\n");
  write(dir, "docs/project/patterns.md", "# Patterns\n\n## State Management\n\nA store.\n");
  write(dir, "docs/project/components.md", componentsMd(APP_SCREENS, APP_COMPONENTS));
  write(dir, "docs/project/integrations.md", integrationsMd(APP_SERVICES));
}
/** What Stage 1 (Update mode) wrote on the employee machine: CRLF, surfaces added, blocks kept byte for byte. */
function stage1Output(dir: string): void {
  const before = read(dir, "CLAUDE.md");
  const blocks = [...before.matchAll(/<!--\s*audit-sync:([a-z-]+):start\s*-->[\s\S]*?<!--\s*audit-sync:\1:end\s*-->/g)].map((m) => m[0]);
  let k = 0;
  const next = claudeMd(surfacesSection(APP_SURFACES, APP_SHARED), "React web, Tizen")
    .replace("Demo.", "Demo, refreshed from source.")
    .replace(/<!-- audit-sync:important-files:start -->[\s\S]*?<!-- audit-sync:important-files:end -->/, () => blocks[k++].replace(/\r\n/g, "\n")) + CAUTION.replace(/<!--[\s\S]*-->/, () => blocks[k++].replace(/\r\n/g, "\n"));
  writeFileSync(join(dir, "CLAUDE.md"), crlf(next));
  writeFileSync(join(dir, "AUDIT.md"), crlf(auditMd("Index refreshed for the current source.\n\n")));
}

try {
  const released = join(root, "inspector-0.13.0");
  extractRelease(REL_0130, ["scripts", "skills", ".claude-plugin"], released);
  const home = fakeHome("home", {
    "ono-project-inspector@ono-plugin-marketplace": [{ scope: "user", version: "0.14.0", installPath: PLUGIN }],
    "ono-project-inspector@an-older-marketplace": [{ scope: "project", version: "0.13.0", installPath: released }],
    "some-other-plugin@ono-plugin-marketplace": [{ scope: "user", version: "0.14.0", installPath: join(root, "elsewhere") }],
  });

  const o = join(root, "origin");
  origin(o);
  commitOrigin(o, "dev");
  const co = employeeClone(o, join(root, "employee"), "CLAUDE.md", WORK);
  const E = co.dir;
  stage1Output(E);
  const HEAD = gitEol(E, "true", "rev-parse", "HEAD");
  const beforeTree = snapshot(E);
  const stage1Claude = read(E, "CLAUDE.md");
  const stage1Audit = read(E, "AUDIT.md");
  check("RC0 replica: autocrlf=true clone of LF blobs, no .gitattributes, CRLF Stage 1 output, no .ono",
    co.crlfInWorktree && co.lfInBlob && co.localAutocrlf === "true" && !existsSync(join(E, ".gitattributes")) && !existsSync(join(E, ".ono")) && eolCounts(join(E, "CLAUDE.md")).bareLf === 0);
  check("RC0 replica: only CLAUDE.md and AUDIT.md are modified", gitEol(E, "true", "status", "--porcelain") === " M AUDIT.md\n M CLAUDE.md");
  check("RC0 replica: 22 Approved topics and 2 audit-sync blocks at HEAD", parseTopicRows(gitEol(E, "true", "show", "HEAD:AUDIT.md")).filter((t) => t.status === "Approved").length === 22 && Object.keys(parseManagedBlocks(stage1Claude)).length === 2);

  // --- RC1 --------------------------------------------------------------------------------------
  {
    const old = (script: string, ...args: string[]) => spawnSync(process.execPath, ["--no-warnings", join(released, "scripts", script), ...args], { encoding: "utf-8" });
    check("RC1 released 0.13.0: verify-artifacts passes", old("verify-artifacts.ts", E, "CLAUDE.md", "AUDIT.md").status === 0);
    const ev = old("knowledge-evidence.ts", "verify", E, "surfaces");
    check("RC1 released 0.13.0: the evidence gate fails with surfaces-missing (exit 3)", ev.status === 3 && /surfaces-missing/.test(ev.stdout), ev.stdout.slice(0, 200));
    check("RC1 ...and nothing was written", !existsSync(join(E, ".ono")) && read(E, "CLAUDE.md") === stage1Claude);
  }

  // --- RC2 --------------------------------------------------------------------------------------
  {
    check("RC2 the document has every step", ["plugin", "preflight", "preserved", "checks", "detect"].every((s) => STEPS.has(s)), [...STEPS.keys()].join(","));
    const p = steps(home, E, ["plugin"]);
    check("RC2 the installed 0.14.0 is selected by its files, among other registered installs", p.code === 0 && p.out.trim() === `Inspector 0.14.0 at: ${PLUGIN}`, p.out + p.err);
    const two = fakeHome("home-two", { "ono-project-inspector@a": [{ scope: "user", version: "0.14.0", installPath: PLUGIN }], "ono-project-inspector@b": [{ scope: "project", version: "0.14.0", installPath: PLUGIN }] });
    check("RC2 two 0.14.0 installs: stop (no guess)", steps(two, E, ["plugin"]).code !== 0);
    const stale = fakeHome("home-stale", { "ono-project-inspector@a": [{ scope: "user", version: "0.14.0", installPath: released }] });
    const s = steps(stale, E, ["plugin"]);
    check("RC2 registered as 0.14.0 but 0.13.0 on disk: stop", s.code !== 0 && /found 0/.test(s.err), s.err);
    const none = fakeHome("home-none", {});
    check("RC2 not installed: stop", steps(none, E, ["plugin"]).code !== 0);
  }

  // --- RC3 --------------------------------------------------------------------------------------
  const pre = steps(home, E, ["preflight"]);
  check("RC3 preflight: Node supported, the Project Root resolved, an ordinary branch, no .ono", pre.code === 0 && /"supported": ?true/.test(pre.out) && pre.out.includes(`Project Root: ${E}`) && /"protected": false/.test(pre.out) && /No \.ono directory yet/.test(pre.out), pre.out + pre.err);
  const pres = steps(home, E, ["preserved"]);
  check("RC3 preserved-work check: 22 Approved topics and both managed blocks intact", pres.code === 0 && /22 Approved topic\(s\), 22 topic row\(s\), 2 managed block\(s\) at HEAD/.test(pres.out) && /All of them are preserved/.test(pres.out), pres.out + pres.err);
  const run1 = steps(home, E, ["checks"]);
  check("RC3 the remaining Stage 1 checks all succeed", run1.code === 0, (run1.out + run1.err).slice(-800));
  check("RC3 the evidence gate passed on the CRLF output and the baseline was recorded", /"ok": true/.test(run1.out) && /Recorded knowledgeHead/.test(run1.out));
  check("RC3 branch and HEAD unchanged", gitEol(E, "true", "rev-parse", "HEAD") === HEAD && gitEol(E, "true", "branch", "--show-current") === WORK);
  check("RC3 git status: CLAUDE.md, AUDIT.md and .ono/ only", gitEol(E, "true", "status", "--porcelain") === " M AUDIT.md\n M CLAUDE.md\n?? .ono/");

  // --- RC4 --------------------------------------------------------------------------------------
  const afterClaude = read(E, "CLAUDE.md");
  const afterAudit = read(E, "AUDIT.md");
  check("RC4 every Stage 1 byte is kept: only the header line and its blank line were added", stripHeader(afterClaude) === stage1Claude && stripHeader(afterAudit) === stage1Audit);
  check("RC4 the header sits below the H1, in CRLF", afterClaude.startsWith("# CLAUDE.md — Demo\r\n\r\nGenerated by ono-project-inspector 0.14.0 · knowledge at ") && afterAudit.startsWith("# AUDIT.md\r\n\r\nGenerated by"));
  check("RC4 both documents are still uniformly CRLF", eolCounts(join(E, "CLAUDE.md")).bareLf === 0 && eolCounts(join(E, "AUDIT.md")).bareLf === 0);
  check("RC4 both managed blocks are byte-identical", JSON.stringify(parseManagedBlocks(afterClaude)) === JSON.stringify(parseManagedBlocks(stage1Claude)));
  check("RC4 all 22 topic rows (status, file, approval note) are unchanged", JSON.stringify(parseTopicRows(afterAudit)) === JSON.stringify(parseTopicRows(stage1Audit)) && parseTopicRows(afterAudit).filter((t) => t.status === "Approved").length === 22);
  const afterTree = snapshot(E);
  const changed = [...new Set([...beforeTree.keys(), ...afterTree.keys()])].filter((k) => beforeTree.get(k) !== afterTree.get(k));
  check("RC4 no other file changed (audits/, docs/, source)", JSON.stringify(changed.sort()) === '["AUDIT.md","CLAUDE.md"]', JSON.stringify(changed));

  // --- RC5 --------------------------------------------------------------------------------------
  const st = JSON.parse(read(E, ".ono/state.json"));
  check("RC5 no approval baseline is fabricated (no audits records)", st.audits === undefined);
  check("RC5 the topic snapshot mirrors AUDIT.md: 22 Approved, none re-opened", st.counts?.approved === 22 && st.counts?.total === 22 && st.counts?.draft === 0 && st.counts?.pendingBreakdown === 0);
  check("RC5 only project-analysis has a knowledge baseline; the complete baseline is not claimed", st.stages?.["project-analysis"]?.knowledgeHead === HEAD && !st.stages?.["project-docs"]?.knowledgeHead && st.repository?.knowledgeHead == null);
  check("RC5 header records exist only for the two Stage 1 documents", JSON.stringify(Object.keys(st.documents ?? {}).sort()) === '["AUDIT.md","CLAUDE.md"]');

  // --- RC6 --------------------------------------------------------------------------------------
  {
    // The same Stage 1 output, LF, run through the hook uninterrupted (0.14.0): the state it leaves
    // at the Stage 1 approval gate is the state the recovery leaves.
    const twin = join(root, "twin");
    cpSync(o, twin, { recursive: true });
    gitEol(twin, "false", "switch", "-q", "-c", WORK);
    writeFileSync(join(twin, "CLAUDE.md"), stage1Claude.replace(/\r\n/g, "\n"));
    writeFileSync(join(twin, "AUDIT.md"), stage1Audit.replace(/\r\n/g, "\n"));
    const t = steps(home, twin, ["checks"]);
    const shape = (dir: string) => { const s = helper(dir, "inspection-state.ts", "detect", dir).json; return JSON.stringify({ c: s.completedStages, s3: s.stage3Complete, n: s.counts, r: s.resume?.nextAction, k: s.knowledge?.status, p: s.knowledge?.refreshPlan?.stages, m: s.knowledge?.refreshPlan?.modelSignals }); };
    check("RC6 the recovered state equals an uninterrupted Stage 1 at its approval gate", t.code === 0 && shape(E) === shape(twin), `${shape(E)} vs ${shape(twin)}`);
  }

  // --- RC7 --------------------------------------------------------------------------------------
  {
    const manifest = (d: string) => { const m = JSON.parse(read(d, ".ono/repo-knowledge.json")); delete m.generatedAt; return JSON.stringify(m); };
    const m1 = manifest(E);
    const again = steps(home, E, ["preserved", "checks"]);
    const st2 = JSON.parse(read(E, ".ono/state.json"));
    check("RC7 repeating every step succeeds", again.code === 0, (again.out + again.err).slice(-600));
    check("RC7 ...the documents are byte-identical (header stamp: unchanged)", read(E, "CLAUDE.md") === afterClaude && read(E, "AUDIT.md") === afterAudit && /"action": "unchanged"/.test(again.out));
    check("RC7 ...the same baseline, stages and topics are recorded; the manifest is identical", st2.stages["project-analysis"].knowledgeHead === HEAD && JSON.stringify(st2.counts) === JSON.stringify(st.counts) && JSON.stringify(st2.documents) === JSON.stringify(st.documents) && manifest(E) === m1);
  }

  // --- RC8 --------------------------------------------------------------------------------------
  {
    const d = steps(home, E, ["detect"]);
    const j = JSON.parse(d.out.slice(0, d.out.lastIndexOf("}") + 1));
    check("RC8 detect: inspection complete, BASELINE_UNKNOWN, next refresh = project-docs only", j.stage3Complete === true && j.resume?.nextAction === "stage3-complete" && j.knowledge?.status === "BASELINE_UNKNOWN" && JSON.stringify(j.knowledge?.refreshPlan?.stages) === '["project-docs"]', JSON.stringify(j.knowledge?.refreshPlan));
    // Stage 2 through the Refresh flow (what /inspect -> Refresh Project Knowledge runs), CRLF output.
    const run = (script: string, ...args: string[]) => helper(E, script, ...args);
    check("RC8 Refresh: preservation snapshot", run("knowledge-refresh-guard.ts", "snapshot", E).code === 0);
    writeFileSync(join(E, "docs/project/patterns.md"), crlf(patternsMd({ "Input and Interaction": { tizen: "Arrow-key focus via `src/tv/FocusRow.tsx`." } })));
    writeFileSync(join(E, "docs/project/capabilities.md"), crlf(capabilitiesMd(APP_CAPABILITIES, APP_RELATIONSHIPS)));
    const docs = ["docs/project/overview.md", "docs/project/components.md", "docs/project/patterns.md", "docs/project/integrations.md", "docs/project/capabilities.md"];
    const hook = [
      run("verify-artifacts.ts", E, ...docs), run("knowledge-refresh-guard.ts", "verify", E), run("knowledge-evidence.ts", "verify", E, "docs"),
      run("inspection-state.ts", "record-knowledge", E, "project-docs"), run("inspection-state.ts", "stamp-docs", E, ...docs),
      run("repo-knowledge.ts", "emit", E), run("repo-knowledge.ts", "validate", E), run("inspection-state.ts", "sync", E),
    ];
    check("RC8 Stage 2 after-hook steps all succeed on CRLF (guard, evidence, record, stamp, emit)", hook.every((h) => h.code === 0), hook.map((h) => h.code).join(","));
    const k = run("inspection-state.ts", "detect", E).json?.knowledge;
    check("RC8 after Stage 2 the knowledge is COMPLETE at the same commit, with no gaps", k?.status === "COMPLETE" && k?.knowledgeHead === HEAD, JSON.stringify(k));
    check("RC8 the 22 approvals and both blocks are still intact", parseTopicRows(read(E, "AUDIT.md")).filter((t) => t.status === "Approved").length === 22 && JSON.stringify(parseManagedBlocks(read(E, "CLAUDE.md"))) === JSON.stringify(parseManagedBlocks(stage1Claude)));
  }

  // --- RC9 --------------------------------------------------------------------------------------
  {
    const hookText = readFileSync(join(PLUGIN, "hooks", "after-project-analysis.md"), "utf-8").replace(/<PLUGIN_ROOT>/g, "$PLUGIN").replace(/<TARGET_ROOT>/g, "$ROOT");
    const lines = (STEPS.get("checks") ?? "").split("\n").filter((l) => l.startsWith("node "));
    check("RC9 every command of the checks step appears verbatim in hooks/after-project-analysis.md", lines.length === 8 && lines.filter((l) => !l.includes("repo-knowledge.ts\" emit") && !l.includes("inspection-state.ts\" sync")).every((l) => hookText.includes(l)), lines.filter((l) => !hookText.includes(l)).join(" | "));
    check("RC9 ...emit is the hook's repo-knowledge emit step, sync the Invocation Loop's state update", /Invoke the internal `repo-knowledge` skill \(`emit`\)/.test(hookText) && /inspection-state.*sync/.test(readFileSync(join(PLUGIN, "agents", "project-inspector.md"), "utf-8")));
  }

  // --- RC10 -------------------------------------------------------------------------------------
  {
    const all = [...STEPS.values()].join("\n");
    check("RC10 no step can record or imply an approval (no record-approval, set-stage, audit-approve, AUDIT.md edit)",
      !/record-approval|set-stage|audit-approve|inspect-approve|record-recheck|knowledge-refresh-guard\.ts" snapshot/.test(all) && !/>\s*"?\$ROOT"?\/(AUDIT|CLAUDE)\.md/.test(all));
    const i6 = DOC.indexOf("## 6. Stage 1 approval"), i7 = DOC.indexOf("## 7. Continue the workflow");
    check("RC10 the human Stage 1 review comes before /inspect, with an explicit stop", i6 > 0 && i7 > i6 && /\*\*Stop here\.\*\*/.test(DOC.slice(i6, i7)) && /Do not continue to step 7 until this review is complete/.test(DOC.slice(i6, i7)));
    check("RC10 a new session or /inspect is stated not to be an approval", /Opening a new Claude Code session is not an approval, and neither is running `\/inspect`/.test(DOC));
    check("RC10 /inspect only waits for a choice (as the agent's Smart Startup requires)", /always stop for the developer's choice before doing work/.test(readFileSync(join(PLUGIN, "agents", "project-inspector.md"), "utf-8")));
    check("RC10 managed and manual plugin updates are distinguished, and both are verified by step 1", /\*\*Managed update\*\*/.test(DOC) && /\*\*Manual update\*\*/.test(DOC) && /never assume the update happened/.test(DOC));
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
