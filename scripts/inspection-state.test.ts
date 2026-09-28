/**
 * inspection-state.test.ts
 *
 * Self-contained tests for scripts/inspection-state.ts, focused on the
 * Project Knowledge lifecycle: the knowledge-authoring HEAD recorded by
 * `record-knowledge`, source-drift detection in `detect`, and the guarantee
 * that routine `sync` never advances knowledge freshness. Builds throwaway
 * git repositories in a temp dir and exercises the CLI end-to-end.
 *
 * No external test framework. Run with:
 *   bun scripts/inspection-state.test.ts
 */

import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";

const HERE = typeof __dirname !== "undefined" ? __dirname : ".";
const HELPER = join(HERE, "inspection-state.ts");
const RUNTIME = process.execPath;

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ""}`); }
}

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(RUNTIME, [HELPER, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout, stderr: "" };
  } catch (err: any) {
    return { code: typeof err.status === "number" ? err.status : 1, stdout: err.stdout?.toString() ?? "", stderr: err.stderr?.toString() ?? "" };
  }
}

function detect(repo: string): any {
  const r = run(["detect", repo]);
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { __unparsed: r.stdout, __stderr: r.stderr, __code: r.code };
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function write(root: string, rel: string, body: string): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body, "utf-8");
}

function commitAll(repo: string, msg: string): void {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "--allow-empty", "-m", msg);
}

function readState(repo: string): any {
  return JSON.parse(readFileSync(join(repo, ".ono", "state.json"), "utf-8"));
}

const AUDIT_ALL_APPROVED = `# AUDIT.md — Demo

## Audit Topics

| # | Status | Topic | Priority | File | Notes |
|---|--------|-------|----------|------|-------|
| 1 | Approved | Architecture | High | audits/architecture/architecture-audit.md | ok. Approved 2026-09-01 |
`;

const AUDIT_IN_PROGRESS = `# AUDIT.md — Demo

## Audit Topics

| # | Status | Topic | Priority | File | Notes |
|---|--------|-------|----------|------|-------|
| 1 | Approved | Architecture | High | audits/architecture/architecture-audit.md | ok |
| 2 | Pending Breakdown | Networking | Medium | Not created yet | later |
`;

function writeKnowledgeArtifacts(repo: string, audit: string): void {
  write(repo, "CLAUDE.md", "# CLAUDE.md — Demo\n");
  write(repo, "AUDIT.md", audit);
  for (const f of ["overview", "components", "patterns", "integrations"]) {
    write(repo, `docs/project/${f}.md`, `# ${f}\n\n## Section\n`);
  }
  write(repo, "audits/architecture/architecture-audit.md", "# Architecture audit\n");
}

/**
 * A repository whose inspection completed at the current HEAD: source code,
 * every knowledge artifact, a synced state file, and a knowledge-authoring
 * HEAD recorded for both source-backed stages — all committed.
 */
function completedRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  write(dir, "src/app.ts", "export const app = 1;\n");
  write(dir, "package.json", "{\"name\":\"demo\"}\n");
  commitAll(dir, "source");
  writeKnowledgeArtifacts(dir, AUDIT_ALL_APPROVED);
  run(["sync", dir]);
  run(["record-knowledge", dir, "project-analysis"]);
  run(["record-knowledge", dir, "project-docs"]);
  run(["sync", dir]);
  commitAll(dir, "inspector artifacts");
  return dir;
}

const root = mkdtempSync(join(realpathSync(tmpdir()), "is-"));
try {
  // --- T1: complete inspection + unchanged source -> no refresh offered ---
  {
    const repo = completedRepo(join(root, "t1"));
    const d = detect(repo);
    check("T1 stage3Complete", d.stage3Complete === true, JSON.stringify(d));
    check("T1 knowledge.status COMPLETE", d.knowledge?.status === "COMPLETE", JSON.stringify(d.knowledge));
    check("T1 no changed source files", Array.isArray(d.knowledge?.changedSourceFiles) && d.knowledge.changedSourceFiles.length === 0, JSON.stringify(d.knowledge));
    check("T1 refreshPlan empty", Array.isArray(d.knowledge?.refreshPlan?.stages) && d.knowledge.refreshPlan.stages.length === 0, JSON.stringify(d.knowledge?.refreshPlan));
    check("T1 knowledgeHead is a 40-char sha", typeof d.knowledge?.knowledgeHead === "string" && d.knowledge.knowledgeHead.length === 40, JSON.stringify(d.knowledge));
    check("T1 resume unchanged (stage3-complete)", d.resume?.nextAction === "stage3-complete", JSON.stringify(d.resume));
  }

  // --- T2: source changed after knowledge generation -> refresh offered ---
  {
    const repo = completedRepo(join(root, "t2"));
    write(repo, "src/app.ts", "export const app = 2;\n");
    commitAll(repo, "change source");
    const d = detect(repo);
    check("T2 knowledge.status REFRESH_RECOMMENDED", d.knowledge?.status === "REFRESH_RECOMMENDED", JSON.stringify(d.knowledge));
    check("T2 changed source file listed", d.knowledge?.changedSourceFiles?.includes("src/app.ts"), JSON.stringify(d.knowledge?.changedSourceFiles));
    check("T2 currentHead differs from knowledgeHead", d.knowledge?.currentHead && d.knowledge.currentHead !== d.knowledge.knowledgeHead);
    check("T2 refreshPlan defaults to project-docs only", JSON.stringify(d.knowledge?.refreshPlan?.stages) === JSON.stringify(["project-docs"]), JSON.stringify(d.knowledge?.refreshPlan));
    check("T2 status is derived, not persisted", !JSON.stringify(readState(repo)).includes("REFRESH_RECOMMENDED"));
    check("T2 resume pointer unchanged", d.resume?.nextAction === "stage3-complete", JSON.stringify(d.resume));
  }

  // --- T2b: a build manifest / top-level structure change adds project-analysis ---
  {
    const repo = completedRepo(join(root, "t2b"));
    write(repo, "package.json", "{\"name\":\"demo\",\"dependencies\":{\"x\":\"1\"}}\n");
    write(repo, "server/index.ts", "export {};\n");
    commitAll(repo, "deps + new top-level module");
    const d = detect(repo);
    check("T2b refreshPlan includes project-analysis then project-docs",
      JSON.stringify(d.knowledge?.refreshPlan?.stages) === JSON.stringify(["project-analysis", "project-docs"]),
      JSON.stringify(d.knowledge?.refreshPlan));
    check("T2b analysis signals name the manifest", d.knowledge?.refreshPlan?.analysisSignals?.some((s: string) => s.includes("package.json")), JSON.stringify(d.knowledge?.refreshPlan));
    check("T2b analysis signals name the new top-level entry", d.knowledge?.refreshPlan?.analysisSignals?.some((s: string) => s.includes("server")), JSON.stringify(d.knowledge?.refreshPlan));
  }

  // --- T3: Inspector-owned document changes alone -> no source drift ---
  {
    const repo = completedRepo(join(root, "t3"));
    write(repo, "CLAUDE.md", "# CLAUDE.md — Demo\n\nedited by audit-sync\n");
    write(repo, "AUDIT.md", AUDIT_ALL_APPROVED + "\n<!-- note -->\n");
    write(repo, "docs/project/patterns.md", "# patterns\n\n## Changed\n");
    write(repo, "audits/architecture/architecture-audit.md", "# Architecture audit v2\n");
    write(repo, ".ono/repo-knowledge.json", "{}\n");
    write(repo, "CLAUDE.md.bak", "old\n");
    commitAll(repo, "inspector-owned edits only");
    const d = detect(repo);
    check("T3 knowledge.status COMPLETE", d.knowledge?.status === "COMPLETE", JSON.stringify(d.knowledge));
    check("T3 no changed source files", d.knowledge?.changedSourceFiles?.length === 0, JSON.stringify(d.knowledge?.changedSourceFiles));
  }

  // --- T4: routine sync (as /inspect-sync runs it) cannot advance knowledgeHead ---
  {
    const repo = completedRepo(join(root, "t4"));
    const before = readState(repo);
    write(repo, "src/app.ts", "export const app = 3;\n");
    commitAll(repo, "change source");
    const head = git(repo, "rev-parse", "HEAD");
    run(["sync", repo, "git@example.com:demo.git", head]);
    const after = readState(repo);
    check("T4 repository.knowledgeHead unchanged by sync", after.repository?.knowledgeHead === before.repository?.knowledgeHead && typeof before.repository?.knowledgeHead === "string", `${before.repository?.knowledgeHead} -> ${after.repository?.knowledgeHead}`);
    check("T4 per-stage knowledgeHead preserved by sync", after.stages?.["project-docs"]?.knowledgeHead === before.stages?.["project-docs"]?.knowledgeHead && typeof before.stages?.["project-docs"]?.knowledgeHead === "string", JSON.stringify(after.stages));
    check("T4 sync still records the emit-time gitHead", after.repository?.gitHead === head);
    check("T4 drift still reported after sync", detect(repo).knowledge?.status === "REFRESH_RECOMMENDED");
  }

  // --- T5: record-knowledge is the only writer, and only for source-backed stages ---
  {
    const repo = completedRepo(join(root, "t5"));
    write(repo, "src/app.ts", "export const app = 4;\n");
    commitAll(repo, "change source");
    const head = git(repo, "rev-parse", "HEAD");

    const refused = run(["record-knowledge", repo, "audit-sync"]);
    check("T5 record-knowledge refuses a non-source-backed stage", refused.code === 1, `code=${refused.code}`);
    check("T5 refused call leaves knowledgeHead untouched", readState(repo).repository.knowledgeHead !== head);

    const ok = run(["record-knowledge", repo, "project-docs"]);
    check("T5 record-knowledge exit 0", ok.code === 0, `code=${ok.code} stderr=${ok.stderr}`);
    const s = readState(repo);
    check("T5 repository.knowledgeHead advanced to HEAD", s.repository.knowledgeHead === head, s.repository.knowledgeHead);
    check("T5 stage knowledgeHead advanced to HEAD", s.stages["project-docs"].knowledgeHead === head);
    check("T5 knowledgeRegeneratedAt stamped", typeof s.stages["project-docs"].knowledgeRegeneratedAt === "string");
    commitAll(repo, "refreshed knowledge");
    check("T5 lifecycle returns to COMPLETE", detect(repo).knowledge?.status === "COMPLETE", JSON.stringify(detect(repo).knowledge));

    // Missing artifacts: a stage cannot claim regenerated knowledge it did not produce.
    rmSync(join(repo, "docs", "project", "patterns.md"));
    const missing = run(["record-knowledge", repo, "project-docs"]);
    check("T5 record-knowledge refuses when stage artifacts are missing", missing.code === 1, `code=${missing.code}`);
  }

  // --- T5b: a two-stage refresh is not "current" until the downstream stage regenerates ---
  {
    const repo = completedRepo(join(root, "t5b"));
    const before = readState(repo).repository.knowledgeHead;
    write(repo, "package.json", "{\"name\":\"demo\",\"version\":\"2\"}\n");
    commitAll(repo, "manifest change");
    const head = git(repo, "rev-parse", "HEAD");
    check("T5b plan is analysis + docs", JSON.stringify(detect(repo).knowledge?.refreshPlan?.stages) === JSON.stringify(["project-analysis", "project-docs"]));

    run(["record-knowledge", repo, "project-analysis"]);
    const mid = readState(repo);
    check("T5b upstream stamp alone does not advance repository.knowledgeHead", mid.repository.knowledgeHead === before, `${mid.repository.knowledgeHead}`);
    check("T5b upstream stage stamped at HEAD", mid.stages["project-analysis"].knowledgeHead === head);
    const dMid = detect(repo);
    check("T5b interrupted refresh still REFRESH_RECOMMENDED", dMid.knowledge?.status === "REFRESH_RECOMMENDED", JSON.stringify(dMid.knowledge));
    check("T5b resumed plan skips the already-refreshed stage", JSON.stringify(dMid.knowledge?.refreshPlan?.stages) === JSON.stringify(["project-docs"]), JSON.stringify(dMid.knowledge?.refreshPlan));

    run(["record-knowledge", repo, "project-docs"]);
    check("T5b downstream stamp completes the refresh", readState(repo).repository.knowledgeHead === head);
    check("T5b lifecycle back to COMPLETE", detect(repo).knowledge?.status === "COMPLETE");
  }

  // --- T6: legacy state with no knowledgeHead -> BASELINE_UNKNOWN, never COMPLETE ---
  {
    const repo = join(root, "t6");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    write(repo, "src/app.ts", "export const app = 1;\n");
    writeKnowledgeArtifacts(repo, AUDIT_ALL_APPROVED);
    run(["sync", repo]);
    commitAll(repo, "legacy inspection");
    const d = detect(repo);
    check("T6 legacy: detect still exits cleanly with JSON", d.inspected === true, JSON.stringify(d));
    check("T6 legacy: knowledge.status BASELINE_UNKNOWN", d.knowledge?.status === "BASELINE_UNKNOWN", JSON.stringify(d.knowledge));
    check("T6 legacy: knowledgeHead null", d.knowledge?.knowledgeHead === null);
    check("T6 legacy: refreshPlan still offers project-docs", JSON.stringify(d.knowledge?.refreshPlan?.stages) === JSON.stringify(["project-docs"]), JSON.stringify(d.knowledge?.refreshPlan));
  }

  // --- T6b: knowledgeHead unreachable (history rewritten) -> BASELINE_UNKNOWN ---
  {
    const repo = completedRepo(join(root, "t6b"));
    const s = readState(repo);
    s.repository.knowledgeHead = "0".repeat(40);
    writeFileSync(join(repo, ".ono", "state.json"), JSON.stringify(s, null, 2) + "\n");
    const d = detect(repo);
    check("T6b unreachable: BASELINE_UNKNOWN", d.knowledge?.status === "BASELINE_UNKNOWN", JSON.stringify(d.knowledge));
  }

  // --- T8: first-run and in-progress flows unchanged ---
  {
    const fresh = join(root, "t8-fresh");
    mkdirSync(fresh, { recursive: true });
    git(fresh, "init", "-q");
    const d0 = detect(fresh);
    check("T8 first run: inspected false", d0.inspected === false, JSON.stringify(d0));
    check("T8 first run: resume run-stage", d0.resume?.nextAction === "run-stage");
    check("T8 first run: no knowledge block", !("knowledge" in d0), JSON.stringify(d0));

    const prog = join(root, "t8-progress");
    mkdirSync(prog, { recursive: true });
    git(prog, "init", "-q");
    git(prog, "config", "user.email", "test@example.com");
    git(prog, "config", "user.name", "Test");
    write(prog, "src/app.ts", "export const app = 1;\n");
    writeKnowledgeArtifacts(prog, AUDIT_IN_PROGRESS);
    run(["sync", prog]);
    run(["record-knowledge", prog, "project-analysis"]);
    run(["record-knowledge", prog, "project-docs"]);
    commitAll(prog, "in progress");
    write(prog, "src/app.ts", "export const app = 2;\n");
    commitAll(prog, "source change mid-inspection");
    const d1 = detect(prog);
    check("T8 in progress: stage3Complete false", d1.stage3Complete === false);
    check("T8 in progress: resume breakdown-next", d1.resume?.nextAction === "breakdown-next", JSON.stringify(d1.resume));
    check("T8 in progress: knowledge.status NOT_APPLICABLE", d1.knowledge?.status === "NOT_APPLICABLE", JSON.stringify(d1.knowledge));
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures > 0 ? 1 : 0);
