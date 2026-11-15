/**
 * e2e-smoke.test.ts
 *
 * Deterministic end-to-end smoke test of the Inspector's helper pipeline
 * (0.11.2). It drives the REAL scripts exactly as the agent and its hooks do —
 * by absolute plugin path (`bun <PLUGIN_ROOT>/scripts/<name>.ts`) from the
 * developer's project as working directory, never from the plugin directory —
 * through a full inspection, a source change, a Refresh Project Knowledge, and
 * the upgrade of a 0.10.0-shaped inspection. It runs for a project at the Git
 * Root and for a project nested below it.
 *
 * Only the model-authored artifact text is substituted by fixtures (what the
 * skills would write); every gate, state transition and manifest emit is the
 * real code path. The live, model-driven run is covered separately by the
 * real Claude Code smoke test (see CHANGELOG 0.11.2).
 *
 * No external test framework. Run with:
 *   bun scripts/e2e-smoke.test.ts
 */

import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  APP_SHARED,
  APP_SOURCE,
  APP_SURFACES,
  claudeMd,
  commitAll,
  initGit,
  surfacesSection,
  write,
  writeKnowledge,
} from "./fixtures/knowledge-fixtures";

const HERE = typeof __dirname !== "undefined" ? __dirname : ".";
const PLUGIN_ROOT = realpathSync(join(HERE, ".."));
const RUNTIME = process.execPath;

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ""}`); }
}

interface Run { code: number; stdout: string; stderr: string; json: any }
/** `bun "<PLUGIN_ROOT>/scripts/<script>" …` with the developer's project as CWD — exactly the agent's invocation. */
function helper(cwd: string, script: string, ...args: string[]): Run {
  let code = 0, stdout = "", stderr = "";
  try {
    stdout = execFileSync(RUNTIME, [join(PLUGIN_ROOT, "scripts", script), ...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err: any) {
    code = typeof err.status === "number" ? err.status : 1;
    stdout = err.stdout?.toString() ?? "";
    stderr = err.stderr?.toString() ?? "";
  }
  let json: any = null;
  try { json = JSON.parse(stdout); } catch { json = null; }
  return { code, stdout, stderr, json };
}
function preflight(cwd: string): Run {
  try {
    const stdout = execFileSync("/bin/sh", [join(PLUGIN_ROOT, "scripts", "check-bun.sh")], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout, stderr: "", json: null };
  } catch (err: any) {
    return { code: err.status ?? 1, stdout: "", stderr: err.stderr?.toString() ?? "", json: null };
  }
}

const AUDIT_PENDING = `# AUDIT.md — Demo

## Audit Topics

| # | Status | Topic | Priority | File | Notes |
|---|--------|-------|----------|------|-------|
| 1 | Pending Breakdown | Architecture | High | Not created yet | later |
`;
const AUDIT_APPROVED = AUDIT_PENDING
  .replace("| Pending Breakdown | Architecture | High | Not created yet | later |", "| Approved | Architecture | High | audits/architecture/architecture-audit.md | ok. Approved 2026-11-15 |");
const DOCS = ["docs/project/overview.md", "docs/project/components.md", "docs/project/patterns.md", "docs/project/integrations.md", "docs/project/capabilities.md"];
const INSPECTOR_FILES = ["CLAUDE.md", "AUDIT.md", ".ono/state.json", ".ono/repo-knowledge.json", "docs/project", "audits"];

/** Run a complete inspection the way the agent does, against TARGET_ROOT. Returns the final detect JSON. */
function fullInspection(label: string, gitRoot: string, target: string): any {
  check(`${label} preflight: Bun available`, preflight(target).code === 0);
  const fresh = helper(target, "inspection-state.ts", "detect", target).json;
  check(`${label} detect: no inspection yet`, fresh?.inspected === false, JSON.stringify(fresh));

  // Stage 1 — project-analysis writes CLAUDE.md + AUDIT.md; after-project-analysis gates.
  write(target, "CLAUDE.md", claudeMd(surfacesSection(APP_SURFACES, APP_SHARED), "React web, Tizen"));
  write(target, "AUDIT.md", AUDIT_PENDING);
  check(`${label} analysis: verify-artifacts at TARGET_ROOT`, helper(target, "verify-artifacts.ts", target, "CLAUDE.md", "AUDIT.md").code === 0);
  const ev1 = helper(target, "knowledge-evidence.ts", "verify", target, "surfaces");
  check(`${label} analysis: surfaces evidence gate`, ev1.code === 0, ev1.stdout + ev1.stderr);
  check(`${label} analysis: state sync`, helper(target, "inspection-state.ts", "sync", target).code === 0);
  const rk1 = helper(target, "inspection-state.ts", "record-knowledge", target, "project-analysis");
  check(`${label} analysis: record-knowledge`, rk1.code === 0, rk1.stderr);
  check(`${label} analysis: manifest emit + validate`, helper(target, "repo-knowledge.ts", "emit", target).code === 0 && helper(target, "repo-knowledge.ts", "validate", target).code === 0);

  // Stage 2 — project-docs writes the five docs (capabilities.md included); after-project-docs gates.
  writeKnowledge(target);
  const va = helper(target, "verify-artifacts.ts", target, ...DOCS);
  check(`${label} docs: all five docs (incl. capabilities.md) at TARGET_ROOT`, va.code === 0, va.stdout);
  const ev2 = helper(target, "knowledge-evidence.ts", "verify", target, "docs");
  check(`${label} docs: docs evidence gate`, ev2.code === 0, ev2.stdout + ev2.stderr);
  check(`${label} docs: record-knowledge`, helper(target, "inspection-state.ts", "record-knowledge", target, "project-docs").code === 0);
  check(`${label} docs: sync + manifest`, helper(target, "inspection-state.ts", "sync", target).code === 0 && helper(target, "repo-knowledge.ts", "emit", target).code === 0);

  // Stage 3 — one topic broken down and approved.
  write(target, "audits/architecture/architecture-audit.md", "# Architecture audit\n");
  write(target, "AUDIT.md", AUDIT_APPROVED);
  check(`${label} audits: verify-artifacts`, helper(target, "verify-artifacts.ts", target, "audits/architecture/architecture-audit.md").code === 0);
  helper(target, "inspection-state.ts", "sync", target);
  helper(target, "repo-knowledge.ts", "emit", target);
  commitAll(gitRoot, `${label}: inspector artifacts`);

  const done = helper(target, "inspection-state.ts", "detect", target).json;
  check(`${label} inspection complete`, done?.stage3Complete === true && done?.resume?.nextAction === "stage3-complete", JSON.stringify(done?.resume));
  check(`${label} knowledge COMPLETE right after inspection`, done?.knowledge?.status === "COMPLETE", JSON.stringify(done?.knowledge));
  const m = helper(target, "repo-knowledge.ts", "show", target).json ?? JSON.parse(readFileSync(join(target, ".ono", "repo-knowledge.json"), "utf-8"));
  check(`${label} manifest indexes capabilities.md`, m?.documents?.capabilities?.exists === true && (m?.capabilities ?? []).length > 0, JSON.stringify(m?.documents?.capabilities));
  return done;
}

/** Refresh Project Knowledge exactly as the agent runs it for each planned stage. */
function refresh(label: string, gitRoot: string, target: string, stages: string[]): void {
  for (const stage of stages) {
    check(`${label} refresh ${stage}: preservation snapshot`, helper(target, "knowledge-refresh-guard.ts", "snapshot", target).code === 0);
    if (stage === "project-analysis") {
      write(target, "CLAUDE.md", claudeMd(surfacesSection(APP_SURFACES, APP_SHARED), "React web, Tizen"));
    } else {
      writeKnowledge(target);
    }
    const guard = helper(target, "knowledge-refresh-guard.ts", "verify", target);
    check(`${label} refresh ${stage}: preservation guard passes (audit rows + managed blocks intact)`, guard.code === 0, guard.stdout + guard.stderr);
    const ev = helper(target, "knowledge-evidence.ts", "verify", target, stage === "project-analysis" ? "surfaces" : "docs");
    check(`${label} refresh ${stage}: evidence gate`, ev.code === 0, ev.stdout);
    const rk = helper(target, "inspection-state.ts", "record-knowledge", target, stage);
    check(`${label} refresh ${stage}: record-knowledge`, rk.code === 0, rk.stderr);
    helper(target, "inspection-state.ts", "sync", target);
    helper(target, "repo-knowledge.ts", "emit", target);
  }
  commitAll(gitRoot, `${label}: refreshed`);
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "inspector-e2e-")));
try {
  for (const layout of ["root", "nested"] as const) {
    const L = `E2E[${layout}]`;
    const gitRoot = join(root, `${layout}-repo`);
    initGit(gitRoot);
    const projectDir = layout === "root" ? gitRoot : join(gitRoot, "YesTVOS");
    for (const [rel, body] of Object.entries(APP_SOURCE)) write(projectDir, rel, body);
    write(projectDir, "package.json", "{\"name\":\"demo\"}\n");
    if (layout === "nested") {
      write(gitRoot, "README.md", "# umbrella repository\n");
      write(gitRoot, "tools/sibling/script.sh", "echo sibling\n");
    }
    commitAll(gitRoot, "source");

    // Root resolution, as before-inspect step 1 runs it (explicit selection, CWD = the project).
    const res = helper(projectDir, "resolve-repo-root.ts", projectDir);
    check(`${L} resolver: exit 0`, res.code === 0, res.stdout);
    check(`${L} resolver: TARGET_ROOT is the selected project`, res.json?.targetRoot === projectDir, res.json?.targetRoot);
    check(`${L} resolver: Git Root preserved`, res.json?.gitRoot === gitRoot && res.json?.nested === (layout === "nested"));
    const target: string = res.json.targetRoot;

    fullInspection(L, gitRoot, target);

    if (layout === "nested") {
      check(`${L} no Inspector artifacts at the Git Root (no duplicate outputs)`, INSPECTOR_FILES.every((f) => !existsSync(join(gitRoot, f))), INSPECTOR_FILES.filter((f) => existsSync(join(gitRoot, f))).join(","));
      check(`${L} all Inspector artifacts at the Project Root`, INSPECTOR_FILES.every((f) => existsSync(join(target, f))));

      // Nested drift: a change outside the project is not drift for it.
      write(gitRoot, "tools/sibling/script.sh", "echo sibling v2\n");
      write(gitRoot, "README.md", "# umbrella repository v2\n");
      commitAll(gitRoot, "sibling change");
      const d0 = helper(target, "inspection-state.ts", "detect", target).json;
      check(`${L} change outside the project -> knowledge still COMPLETE`, d0?.knowledge?.status === "COMPLETE" && d0?.knowledge?.changedSourceCount === 0, JSON.stringify(d0?.knowledge));
    }

    // Source change inside the project -> REFRESH_RECOMMENDED with project-relative paths.
    write(target, "src/features/search/SearchScreen.tsx", (APP_SOURCE["src/features/search/SearchScreen.tsx"] ?? "") + "\n// edited\n");
    commitAll(gitRoot, "edit search");
    const d1 = helper(target, "inspection-state.ts", "detect", target).json;
    check(`${L} source change -> REFRESH_RECOMMENDED`, d1?.knowledge?.status === "REFRESH_RECOMMENDED", JSON.stringify(d1?.knowledge));
    check(`${L} changed files are project-relative`, JSON.stringify(d1?.knowledge?.changedSourceFiles) === JSON.stringify(["src/features/search/SearchScreen.tsx"]), JSON.stringify(d1?.knowledge?.changedSourceFiles));
    check(`${L} Inspector-owned files never count as drift`, !(d1?.knowledge?.changedSourceFiles ?? []).some((f: string) => /^(CLAUDE|AUDIT)\.md$|^\.ono\/|^docs\/project\//.test(f)));
    check(`${L} plain source change plans project-docs only`, JSON.stringify(d1?.knowledge?.refreshPlan?.stages) === JSON.stringify(["project-docs"]), JSON.stringify(d1?.knowledge?.refreshPlan));
    check(`${L} the refresh does not reopen the inspection`, d1?.stage3Complete === true);
    refresh(L, gitRoot, target, d1.knowledge.refreshPlan.stages);
    const d2 = helper(target, "inspection-state.ts", "detect", target).json;
    check(`${L} after refresh -> COMPLETE`, d2?.knowledge?.status === "COMPLETE", JSON.stringify(d2?.knowledge));
    check(`${L} audit status preserved through refresh`, readFileSync(join(target, "AUDIT.md"), "utf-8").includes("| Approved | Architecture |"));

    // An existing 0.10.0-shaped completed inspection (no capabilities.md, no surfaces) -> refresh regenerates it.
    rmSync(join(target, "docs", "project", "capabilities.md"));
    write(target, "CLAUDE.md", "# CLAUDE.md — Demo\n\n## Tech Stack\n\n- Platform(s): Web\n");
    write(target, "docs/project/patterns.md", "# patterns\n\n## State Management\n\nRedux.\n");
    commitAll(gitRoot, "0.10.0-era artifacts");
    helper(target, "inspection-state.ts", "sync", target);
    const d3 = helper(target, "inspection-state.ts", "detect", target).json;
    check(`${L} legacy inspection: stays complete (not reopened)`, d3?.stage3Complete === true, JSON.stringify(d3?.resume));
    check(`${L} legacy inspection: REFRESH_RECOMMENDED without source drift`, d3?.knowledge?.status === "REFRESH_RECOMMENDED" && d3?.knowledge?.changedSourceCount === 0, JSON.stringify(d3?.knowledge));
    check(`${L} legacy inspection: model signal names capabilities.md`, (d3?.knowledge?.refreshPlan?.modelSignals ?? []).some((s: string) => s.includes("docs/project/capabilities.md")));
    check(`${L} legacy inspection: plan = both source-backed stages, no audit stages`, JSON.stringify(d3?.knowledge?.refreshPlan?.stages) === JSON.stringify(["project-analysis", "project-docs"]), JSON.stringify(d3?.knowledge?.refreshPlan));
    refresh(`${L} legacy`, gitRoot, target, d3.knowledge.refreshPlan.stages);
    const d4 = helper(target, "inspection-state.ts", "detect", target).json;
    check(`${L} legacy refresh generated capabilities.md`, existsSync(join(target, "docs", "project", "capabilities.md")));
    check(`${L} legacy refresh -> COMPLETE`, d4?.knowledge?.status === "COMPLETE", JSON.stringify(d4?.knowledge));
    const manifest = JSON.parse(readFileSync(join(target, ".ono", "repo-knowledge.json"), "utf-8"));
    check(`${L} manifest valid and capabilities populated after legacy refresh`, helper(target, "repo-knowledge.ts", "validate", target).code === 0 && manifest.coverage?.capabilities === "populated", JSON.stringify(manifest.coverage));
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
