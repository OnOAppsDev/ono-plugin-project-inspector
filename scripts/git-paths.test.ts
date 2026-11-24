/**
 * git-paths.test.ts
 *
 * Knowledge freshness with non-ASCII and special Git paths (0.13.0). Regression for the
 * reported false REFRESH_RECOMMENDED: Git C-quoted `docs/project/<hebrew>.md`
 * (`"docs/project/\327\241…md"`), so an Inspector-owned document counted as a source
 * change and raised a bogus `top-level entry added: "docs` analysis signal.
 *
 *   N1  Inspector-owned files with Hebrew / spaces / other scripts stay COMPLETE
 *   N2  real source changes keep their exact path; no false top-level signal
 *   N3  a new non-ASCII top-level entry IS an analysis signal, named exactly
 *   N4  names Git quotes even with core.quotePath=false (", \, tab, newline) — committed
 *       through the index, so the case runs on every OS including Windows, where such
 *       names cannot exist on disk
 *   N5  NFC and NFD spellings of one name are two distinct Git paths: never merged
 *   N6  attribution matches a recorded non-ASCII source root regardless of NFC/NFD
 *   N7  renamed and deleted source files; nested project below the Git Root
 *   N8  the git calls use NUL-delimited output with core.quotePath=false
 *
 * No external test framework. Run with:
 *   node --no-warnings scripts/git-paths.test.ts
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { commitIndexPath, edit, g, helper, inspectedRepo } from "./fixtures/inspected.ts";
import { comparablePath } from "./inspection-state.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ""}`); }
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "inspector-paths-")));
const put = (dir: string, rel: string, body: string) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), body); };
const commit = (dir: string, msg: string) => { g(dir, "add", "-A"); g(dir, "commit", "-q", "-m", msg); };
const knowledge = (dir: string) => helper(dir, "inspection-state.ts", "detect", dir).json?.knowledge;

try {
  // --- N1: Inspector-owned non-ASCII files ------------------------------------------------
  {
    const repo = join(root, "n1");
    inspectedRepo(repo);
    check("N1 baseline is COMPLETE", knowledge(repo)?.status === "COMPLETE");
    put(repo, "docs/project/סקירה.md", "# סקירה\n");
    put(repo, "docs/project/release notes.md", "# notes\n");
    put(repo, "docs/project/日本語.md", "# x\n");
    put(repo, "audits/ניהול מצב/ניהול-audit.md", "# x\n");
    put(repo, ".ono/notes é.json", "{}\n");
    commit(repo, "inspector-owned non-ASCII files");
    const k = knowledge(repo);
    check("N1 Hebrew / space / CJK files under docs/project, audits, .ono -> still COMPLETE", k?.status === "COMPLETE" && k?.changedSourceCount === 0, JSON.stringify(k));
    check("N1 no analysis signal from Inspector-owned files", (k?.refreshPlan?.analysisSignals ?? []).length === 0);
  }

  // --- N2 / N3: real source changes ----------------------------------------------------------
  {
    const repo = join(root, "n2");
    inspectedRepo(repo);
    put(repo, "src/features/epg/מסך תוכניות.tsx", "export const X = 1;\n");
    put(repo, "src/components/Café Tile.tsx", "export const Y = 1;\n");
    commit(repo, "non-ASCII source files in existing directories");
    const k = knowledge(repo);
    check("N2 non-ASCII source changes -> REFRESH_RECOMMENDED", k?.status === "REFRESH_RECOMMENDED");
    check("N2 exact paths, unquoted", JSON.stringify(k?.changedSourceFiles) === JSON.stringify(["src/components/Café Tile.tsx", "src/features/epg/מסך תוכניות.tsx"].sort()), JSON.stringify(k?.changedSourceFiles));
    check("N2 no false top-level signal for an existing directory", !(k?.refreshPlan?.analysisSignals ?? []).some((s: string) => /top-level/.test(s)), JSON.stringify(k?.refreshPlan?.analysisSignals));
    check("N2 attribution works on the exact path (epg capability)", (k?.affectedCapabilities ?? []).includes("epg"), JSON.stringify(k?.affectedCapabilities));
    put(repo, "מסמכים/a.md", "x\n");
    commit(repo, "new Hebrew top-level directory");
    const k2 = knowledge(repo);
    check("N3 a new non-ASCII top-level entry is a signal, named exactly", (k2?.refreshPlan?.analysisSignals ?? []).includes("top-level entry added: מסמכים"), JSON.stringify(k2?.refreshPlan?.analysisSignals));
    check("N3 a top-level signal re-plans project-analysis", (k2?.refreshPlan?.stages ?? []).includes("project-analysis"));
  }

  // --- N4: names Git quotes even with core.quotePath=false ---------------------------------------
  {
    const repo = join(root, "n4");
    inspectedRepo(repo);
    const names = ['src/we"ird.ts', "src/back\\slash.ts", "src/tab\tname.ts", "src/new\nline.ts"];
    for (const n of names) commitIndexPath(repo, n, "x\n", `index-only ${JSON.stringify(n)}`);
    const k = knowledge(repo);
    check("N4 quote, backslash, tab, newline names: counted exactly once each", k?.changedSourceCount === 4, JSON.stringify(k));
    check("N4 reported with their exact Git identity", JSON.stringify(k?.changedSourceFiles) === JSON.stringify([...names].sort()), JSON.stringify(k?.changedSourceFiles));
    commitIndexPath(repo, 'docs/project/a"b\tc.md', "x\n", "inspector-owned special name");
    check("N4 an Inspector-owned special name is still excluded", knowledge(repo)?.changedSourceCount === 4);
  }

  // --- N5: NFC and NFD spellings stay distinct --------------------------------------------------------
  {
    const repo = join(root, "n5");
    inspectedRepo(repo);
    const nfc = "src/caf\u00e9.ts";
    const nfd = "src/cafe\u0301.ts";
    commitIndexPath(repo, nfc, "a\n", "NFC name");
    commitIndexPath(repo, nfd, "b\n", "NFD name");
    const k = knowledge(repo);
    check("N5 two Git paths that differ only in normalization are two changes", k?.changedSourceCount === 2 && (k?.changedSourceFiles ?? []).includes(nfc) && (k?.changedSourceFiles ?? []).includes(nfd), JSON.stringify(k?.changedSourceFiles));
    check("N5 comparablePath is comparison-only (NFC)", comparablePath(nfd) === nfc && nfd !== nfc);
  }

  // --- N6: attribution across normalization forms ------------------------------------------------------
  {
    const HEB_NFC = "src/features/caf\u00e9-history/";
    const repo = join(root, "n6");
    inspectedRepo(repo, "chore/project-inspection", (dir) => {
      renameSync(join(dir, "src/features/search-history"), join(dir, HEB_NFC.slice(0, -1)));
      edit(dir, "docs/project/capabilities.md", /src\/features\/search-history\//g, HEB_NFC);
      edit(dir, "docs/project/capabilities.md", /src\/features\/search-history\/SearchHistoryScreen\.tsx/g, `${HEB_NFC}SearchHistoryScreen.tsx`);
    });
    check("N6 baseline with a non-ASCII recorded source root is COMPLETE", knowledge(repo)?.status === "COMPLETE", JSON.stringify(knowledge(repo)));
    commitIndexPath(repo, "src/features/cafe\u0301-history/Extra.tsx", "x\n", "NFD spelling under the NFC-recorded root");
    const k = knowledge(repo);
    check("N6 a change spelled NFD is attributed to the capability recorded NFC", (k?.affectedCapabilities ?? []).includes("search-history"), JSON.stringify(k?.affectedCapabilities));
    check("N6 ...while the reported path keeps its NFD identity", (k?.changedSourceFiles ?? []).includes("src/features/cafe\u0301-history/Extra.tsx"));
  }

  // --- N7: renames, deletions, nested project --------------------------------------------------------------
  {
    const repo = join(root, "n7");
    inspectedRepo(repo);
    g(repo, "mv", "src/features/epg/EpgScreen.tsx", "src/features/epg/מסך EPG.tsx");
    g(repo, "rm", "-q", "src/store/guideStore.ts");
    g(repo, "commit", "-q", "-m", "rename + delete");
    const k = knowledge(repo);
    check("N7 a rename counts old and new path (no rename folding), a deletion counts once", k?.changedSourceCount === 3 && JSON.stringify(k?.changedSourceFiles) === JSON.stringify(["src/features/epg/EpgScreen.tsx", "src/features/epg/מסך EPG.tsx", "src/store/guideStore.ts"].sort()), JSON.stringify(k?.changedSourceFiles));

    const umbrella = join(root, "n7 nested", "umbrella repo");
    mkdirSync(umbrella, { recursive: true });
    const project = join(umbrella, "פרויקט TV");
    inspectedRepoNested(umbrella, project);
    check("N7 nested project with a non-ASCII path: COMPLETE", knowledge(project)?.status === "COMPLETE", JSON.stringify(knowledge(project)));
    put(umbrella, "tools/סקריפט.sh", "echo\n");
    put(project, "docs/project/סקירה.md", "# x\n");
    commit(umbrella, "outside-project change + inspector-owned doc");
    check("N7 nested: changes outside the project and Inspector-owned docs -> still COMPLETE", knowledge(project)?.status === "COMPLETE", JSON.stringify(knowledge(project)));
    put(project, "src/features/epg/חדש.tsx", "x\n");
    commit(umbrella, "project source change");
    const kn = knowledge(project);
    check("N7 nested: a project source change is reported relative to the Project Root", kn?.status === "REFRESH_RECOMMENDED" && JSON.stringify(kn?.changedSourceFiles) === JSON.stringify(["src/features/epg/חדש.tsx"]), JSON.stringify(kn?.changedSourceFiles));
  }

  // --- N8: implementation contract ------------------------------------------------------------------------------
  {
    const src = readFileSync(join(import.meta.dirname, "inspection-state.ts"), "utf-8");
    check("N8 the diff uses -z with core.quotePath=false", /gitPaths\(repoRoot, \["diff", "-z", "--relative", "--name-only", "--no-renames"/.test(src) && /\["-c", "core\.quotePath=false", \.\.\.args\]/.test(src));
    check("N8 ls-tree uses -z", /gitPaths\(repoRoot, \["ls-tree", "-z", "--name-only", rev\]\)/.test(src));
    check("N8 no newline-split git path listing remains", !/\["(diff|ls-tree)"[^\]]*\]\)\s*\?\?\s*""\)\.split\("\\n"\)/.test(src) && !/diff\.split\("\\n"\)/.test(src));
    check("N8 a failed ls-tree is BASELINE_UNKNOWN, never COMPLETE", /git ls-tree of knowledgeHead or HEAD failed/.test(src));
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

/** The fixture placed as a project below an umbrella Git Root, inspected at the Project Root. */
function inspectedRepoNested(umbrella: string, project: string): void {
  g(umbrella, "init", "-q", "-b", "chore/project-inspection");
  put(umbrella, "README.md", "# umbrella\n");
  const tmp = join(root, "nested-src");
  inspectedRepoTreeOnly(tmp);
  mkdirSync(project, { recursive: true });
  for (const entry of ["src", "tizen", "package.json", "vite.config.ts", "CLAUDE.md", "AUDIT.md", "docs", "audits", ".ono"]) {
    renameSync(join(tmp, entry), join(project, entry));
  }
  commit(umbrella, "nested inspected project");
  for (const stage of ["project-analysis", "project-docs"]) {
    const r = helper(project, "inspection-state.ts", "record-knowledge", project, stage);
    if (r.code !== 0) throw new Error(r.stderr);
  }
  commit(umbrella, "knowledge recorded");
}
function inspectedRepoTreeOnly(dir: string): void {
  // The fixture tree without its own Git history.
  inspectedRepo(dir);
  rmSync(join(dir, ".git"), { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
