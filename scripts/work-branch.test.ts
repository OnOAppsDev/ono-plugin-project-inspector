/**
 * work-branch.test.ts
 *
 * Regression tests for the protected-branch workflow (0.11.3): the branch
 * check, working-branch creation, and the mechanical write guard in every
 * Inspector helper that writes. Builds throwaway Git repositories and runs the
 * REAL CLIs by absolute path, exactly as the agent does.
 *
 * No external test framework. Run with:
 *   node --no-warnings scripts/work-branch.test.ts
 */

import { execFileSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { commitAll, git, initGit, write } from "./fixtures/knowledge-fixtures.ts";
import { assertWritable, branchState, DEFAULT_WORK_BRANCH, EXIT_PROTECTED, ProtectedBranchError } from "./work-branch.ts";
import { REPO_KNOWLEDGE_SCHEMA_VERSION } from "./repo-knowledge.ts";

const HERE = import.meta.dirname;
const RUNTIME = process.execPath;

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ""}`); }
}

interface Run { code: number; stdout: string; stderr: string; json: any }
function run(script: string, cwd: string, ...args: string[]): Run {
  let code = 0, stdout = "", stderr = "";
  try {
    stdout = execFileSync(RUNTIME, ["--no-warnings", join(HERE, script), ...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err: any) {
    code = typeof err.status === "number" ? err.status : 1;
    stdout = err.stdout?.toString() ?? "";
    stderr = err.stderr?.toString() ?? "";
  }
  let json: any = null;
  try { json = JSON.parse(stdout); } catch { json = null; }
  return { code, stdout, stderr, json };
}
const wb = (cwd: string, ...args: string[]) => run("work-branch.ts", cwd, ...args);

/** Everything Git knows that a branch operation could change. */
function gitSnapshot(repo: string) {
  return {
    refs: git(repo, "for-each-ref", "--format=%(refname) %(objectname)"),
    head: (() => { try { return git(repo, "rev-parse", "HEAD"); } catch { return null; } })(),
    status: git(repo, "status", "--porcelain=v1", "--untracked-files=all"),
    stash: git(repo, "stash", "list"),
    config: git(repo, "config", "--local", "--list"),
  };
}
const current = (repo: string) => { try { return git(repo, "symbolic-ref", "-q", "--short", "HEAD"); } catch { return null; } };

let seq = 0;
function repoOn(root: string, branch: string, opts: { commit?: boolean } = {}): string {
  const repo = join(root, `repo-${++seq}`);
  initGit(repo, branch);
  write(repo, "package.json", "{\"name\":\"demo\"}\n");
  write(repo, "src/app.ts", "export const app = 1;\n");
  if (opts.commit !== false) commitAll(repo, "source");
  return repo;
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "inspector-branch-")));
try {
  // --- W1: branch state ---------------------------------------------------------
  {
    const main = repoOn(root, "main");
    const master = repoOn(root, "master");
    const feature = repoOn(root, "feature/x");
    const detached = repoOn(root, "main");
    git(detached, "switch", "-q", "--detach");
    const unborn = repoOn(root, "main", { commit: false });
    const plain = join(root, "plain");
    write(plain, "package.json", "{}\n");

    for (const [label, dir, prot, reason] of [["main", main, true, "main"], ["master", master, true, "master"], ["detached HEAD", detached, true, "detached"], ["unborn main", unborn, true, "main"], ["feature branch", feature, false, null], ["non-Git directory", plain, false, null]] as const) {
      const r = wb(dir, "check", dir);
      check(`W1 check ${label}: exit 0`, r.code === 0, r.stderr);
      check(`W1 check ${label}: protected=${prot}`, r.json?.protected === prot && r.json?.reason === reason, JSON.stringify(r.json));
    }
    check("W1 detached HEAD reported as detached with its commit", wb(detached, "check", detached).json?.detached === true && wb(detached, "check", detached).json?.head === git(detached, "rev-parse", "HEAD"));
    check("W1 unborn branch reported", wb(unborn, "check", unborn).json?.unborn === true && wb(unborn, "check", unborn).json?.head === null);
    check("W1 suggestion is chore/project-inspection", wb(main, "check", main).json?.suggestedName === DEFAULT_WORK_BRANCH && DEFAULT_WORK_BRANCH === "chore/project-inspection");

    // check is read-only on a protected branch.
    write(main, "notes.txt", "local\n");
    const before = gitSnapshot(main);
    const listing = readdirSync(main).sort().join(",");
    wb(main, "check", main); wb(main, "check", main, "chore/custom"); wb(main, "assert", main);
    check("W1 check/assert never create a branch or change Git state", JSON.stringify(gitSnapshot(main)) === JSON.stringify(before));
    check("W1 check/assert never write a file", readdirSync(main).sort().join(",") === listing);

    // assert
    for (const [label, dir] of [["main", main], ["master", master], ["detached", detached], ["unborn", unborn]] as const) {
      const a = wb(dir, "assert", dir);
      check(`W1 assert ${label}: exit ${EXIT_PROTECTED} with an actionable refusal`, a.code === EXIT_PROTECTED && /REFUSED/.test(a.stderr) && /Nothing was written/.test(a.stderr) && a.stderr.includes("work-branch.ts\" create") && a.stderr.includes(DEFAULT_WORK_BRANCH), a.stderr);
    }
    check("W1 assert feature branch: exit 0", wb(feature, "assert", feature).code === 0);
    check("W1 assert non-Git directory: exit 0", wb(plain, "assert", plain).code === 0);

    // library form
    let thrown: unknown = null;
    try { assertWritable(main, "test write"); } catch (e) { thrown = e; }
    check("W1 assertWritable throws ProtectedBranchError on main", thrown instanceof ProtectedBranchError);
    let ok = true;
    try { assertWritable(feature, "test write"); } catch { ok = false; }
    check("W1 assertWritable allows a working branch", ok);
    check("W1 branchState: linked state of a feature branch", branchState(feature).branch === "feature/x" && !branchState(feature).protected);
  }

  // --- W2: create from main — default name, HEAD/ref/commits unchanged -------------
  {
    const repo = repoOn(root, "main");
    const head = git(repo, "rev-parse", "HEAD");
    const commits = git(repo, "rev-list", "--all", "--count");
    const r = wb(repo, "create", repo, DEFAULT_WORK_BRANCH);
    check("W2 create on main: exit 0", r.code === 0, r.stdout + r.stderr);
    check("W2 switched to chore/project-inspection", current(repo) === DEFAULT_WORK_BRANCH && r.json?.branch === DEFAULT_WORK_BRANCH && r.json?.from === "main");
    check("W2 HEAD is the same commit", git(repo, "rev-parse", "HEAD") === head && r.json?.head === head);
    check("W2 main still points at the same commit", git(repo, "rev-parse", "refs/heads/main") === head);
    check("W2 no commit was created", git(repo, "rev-list", "--all", "--count") === commits);
    check("W2 no upstream configured (local branch only)", !git(repo, "config", "--local", "--list").includes(`branch.${DEFAULT_WORK_BRANCH}.`));
    check("W2 writes are allowed after the switch", wb(repo, "assert", repo).code === 0);
    // A second create while on the working branch: nothing to do, no new branch.
    const refs = git(repo, "for-each-ref", "refs/heads");
    const again = wb(repo, "create", repo, "chore/another");
    check("W2 create on a working branch -> exit 3, no new branch", again.code === 3 && again.json?.reason === "already-on-working-branch" && git(repo, "for-each-ref", "refs/heads") === refs);
  }

  // --- W3: master, detached HEAD, unborn branch -----------------------------------
  {
    const master = repoOn(root, "master");
    const h = git(master, "rev-parse", "HEAD");
    const r = wb(master, "create", master, DEFAULT_WORK_BRANCH);
    check("W3 create on master: exit 0, same HEAD, master untouched", r.code === 0 && current(master) === DEFAULT_WORK_BRANCH && git(master, "rev-parse", "HEAD") === h && git(master, "rev-parse", "refs/heads/master") === h);

    const det = repoOn(root, "main");
    git(det, "switch", "-q", "--detach");
    const dh = git(det, "rev-parse", "HEAD");
    const d = wb(det, "create", det, DEFAULT_WORK_BRANCH);
    check("W3 create from detached HEAD: exit 0, from 'detached HEAD', same commit", d.code === 0 && d.json?.from === "detached HEAD" && current(det) === DEFAULT_WORK_BRANCH && git(det, "rev-parse", "HEAD") === dh, d.stdout + d.stderr);

    const unborn = repoOn(root, "main", { commit: false });
    const st = git(unborn, "status", "--porcelain=v1", "--untracked-files=all");
    const u = wb(unborn, "create", unborn, DEFAULT_WORK_BRANCH);
    check("W3 create on an unborn main: exit 0, untracked files kept", u.code === 0 && current(unborn) === DEFAULT_WORK_BRANCH && u.json?.unborn === true && git(unborn, "status", "--porcelain=v1", "--untracked-files=all") === st, u.stdout + u.stderr);
  }

  // --- W4: dirty working tree preserved byte for byte -------------------------------
  {
    const repo = repoOn(root, "main");
    write(repo, "src/staged-new.ts", "export const n = 1;\n");
    write(repo, "package.json", "{\"name\":\"demo\",\"staged\":true}\n");
    git(repo, "add", "src/staged-new.ts", "package.json");
    write(repo, "package.json", "{\"name\":\"demo\",\"staged\":true,\"unstaged\":true}\n"); // staged AND unstaged
    write(repo, "src/app.ts", "export const app = 2; // unstaged\n");
    write(repo, "scratch/untracked.md", "untracked\n");
    git(repo, "rm", "-q", "--cached", "src/app.ts"); git(repo, "add", "src/app.ts"); // index entry rewritten, same content
    const files = ["src/staged-new.ts", "package.json", "src/app.ts", "scratch/untracked.md"];
    const bytes = files.map((f) => readFileSync(join(repo, f), "utf-8"));
    const status = git(repo, "status", "--porcelain=v1", "--untracked-files=all");
    const staged = git(repo, "diff", "--cached");
    const unstaged = git(repo, "diff");
    const r = wb(repo, "create", repo, DEFAULT_WORK_BRANCH);
    check("W4 dirty tree: create succeeds", r.code === 0, r.stdout + r.stderr);
    check("W4 dirty tree: status identical (staged, unstaged, untracked)", git(repo, "status", "--porcelain=v1", "--untracked-files=all") === status, status);
    check("W4 dirty tree: staged diff identical", git(repo, "diff", "--cached") === staged);
    check("W4 dirty tree: unstaged diff identical", git(repo, "diff") === unstaged);
    check("W4 dirty tree: file bytes identical", files.every((f, i) => readFileSync(join(repo, f), "utf-8") === bytes[i]));
    check("W4 dirty tree: nothing stashed", git(repo, "stash", "list") === "");
    check("W4 dirty tree: local changes reported", r.json?.localChangesKept === status.split("\n").filter(Boolean).length);
  }

  // --- W5: name collisions — never reused, reset or deleted --------------------------
  {
    const repo = repoOn(root, "main");
    git(repo, "branch", DEFAULT_WORK_BRANCH);
    write(repo, "later.ts", "x\n");
    commitAll(repo, "later commit on main");
    const existingSha = git(repo, "rev-parse", `refs/heads/${DEFAULT_WORK_BRANCH}`);
    check("W5 taken name -> suggests chore/project-inspection-2", wb(repo, "check", repo).json?.suggestedName === `${DEFAULT_WORK_BRANCH}-2`);
    const r = wb(repo, "create", repo, DEFAULT_WORK_BRANCH);
    check("W5 create with an existing name -> exit 6 name-taken + suggestion", r.code === 6 && r.json?.reason === "name-taken" && r.json?.suggestedName === `${DEFAULT_WORK_BRANCH}-2`, r.stdout);
    check("W5 existing branch untouched (not reset, not moved)", git(repo, "rev-parse", `refs/heads/${DEFAULT_WORK_BRANCH}`) === existingSha);
    check("W5 still on main after the refusal", current(repo) === "main");
    git(repo, "branch", `${DEFAULT_WORK_BRANCH}-2`);
    check("W5 -2 taken as well -> suggests -3", wb(repo, "check", repo).json?.suggestedName === `${DEFAULT_WORK_BRANCH}-3`);
    const c = wb(repo, "create", repo, `${DEFAULT_WORK_BRANCH}-3`);
    check("W5 the suggested free name is created from the current HEAD (not from the old branch)", c.code === 0 && git(repo, "rev-parse", "HEAD") === git(repo, "rev-parse", "refs/heads/main") && git(repo, "rev-parse", `refs/heads/${DEFAULT_WORK_BRANCH}`) === existingSha);
    check("W5 requested-name check reports taken", wb(repo, "check", repo, DEFAULT_WORK_BRANCH).json?.requested?.valid === false);

    // A remote-tracking ref known locally (no fetch) also takes the name.
    const r2 = repoOn(root, "main");
    git(r2, "update-ref", `refs/remotes/origin/${DEFAULT_WORK_BRANCH}`, "HEAD");
    check("W5 remote-tracking ref with the name -> suggests -2", wb(r2, "check", r2).json?.suggestedName === `${DEFAULT_WORK_BRANCH}-2`);
    // A path collision with an existing branch (`chore` vs `chore/…`).
    const r3 = repoOn(root, "main");
    git(r3, "branch", "chore");
    check("W5 path collision with branch 'chore' -> name taken", wb(r3, "check", r3, DEFAULT_WORK_BRANCH).json?.requested?.valid === false && wb(r3, "create", r3, DEFAULT_WORK_BRANCH).code === 6);
    check("W5 path collision -> falls back to project-inspection (never crashes)", wb(r3, "check", r3).json?.suggestedName === "project-inspection", JSON.stringify(wb(r3, "check", r3)));
    check("W5 path collision leaves 'chore' intact and HEAD on main", current(r3) === "main" && git(r3, "rev-parse", "refs/heads/chore") === git(r3, "rev-parse", "HEAD"));
  }

  // --- W6: custom names --------------------------------------------------------------
  {
    const repo = repoOn(root, "main");
    for (const bad of ["main", "master", "HEAD", "-x", "bad..name", "has space", "a.lock", "@{-1}", "x~1", "end/", ""]) {
      const r = wb(repo, "create", repo, bad);
      check(`W6 invalid name ${JSON.stringify(bad)} -> exit 6 invalid-name`, r.code === 6 && r.json?.reason === "invalid-name" && r.json?.suggestedName === DEFAULT_WORK_BRANCH, r.stdout + r.stderr);
    }
    check("W6 invalid names created nothing and stayed on main", current(repo) === "main" && git(repo, "for-each-ref", "refs/heads") .split("\n").length === 1);
    const chk = wb(repo, "check", repo, "feature/inspect run");
    check("W6 check reports an invalid requested name", chk.json?.requested?.valid === false && /not a valid Git branch name/.test(chk.json?.requested?.error ?? ""));
    check("W6 check accepts a valid custom name", wb(repo, "check", repo, "feature/inspector-run").json?.requested?.valid === true);
    const ok = wb(repo, "create", repo, "feature/inspector-run");
    check("W6 a valid custom name is created", ok.code === 0 && current(repo) === "feature/inspector-run");
  }

  // --- W7: failed branch creation -> stop, nothing written ----------------------------
  // Two ways to make Git fail to create the ref: unwritable refs/heads (POSIX permissions;
  // Windows ignores directory modes) and an existing ref lock file (every platform).
  const failures7: Array<{ how: string; inject: (repo: string) => void; undo: (repo: string) => void }> = [
    {
      how: "a stale ref lock",
      inject: (repo) => { mkdirSync(join(repo, ".git", "refs", "heads", "chore"), { recursive: true }); writeFileSync(join(repo, ".git", "refs", "heads", "chore", "project-inspection.lock"), ""); },
      undo: (repo) => rmSync(join(repo, ".git", "refs", "heads", "chore", "project-inspection.lock")),
    },
  ];
  if (process.platform !== "win32") {
    failures7.unshift({
      how: "unwritable refs",
      inject: (repo) => chmodSync(join(repo, ".git", "refs", "heads"), 0o555),
      undo: (repo) => chmodSync(join(repo, ".git", "refs", "heads"), 0o755),
    });
  }
  for (const { how, inject, undo } of failures7) {
    const repo = repoOn(root, "main");
    write(repo, "local.txt", "dirty\n");
    inject(repo);
    const before = gitSnapshot(repo);
    const r = wb(repo, "create", repo, DEFAULT_WORK_BRANCH);
    undo(repo);
    check(`W7 [${how}] -> exit 7`, r.code === 7, r.stdout + r.stderr);
    check(`W7 [${how}] the failure is reported with the branch not created`, r.json?.reason === "switch-failed" && r.json?.branchExists === false, r.stdout);
    check(`W7 [${how}] STOP message says nothing was written`, /STOP: nothing was inspected or written/.test(r.stderr), r.stderr);
    check(`W7 [${how}] still on main, HEAD unchanged`, current(repo) === "main" && git(repo, "rev-parse", "HEAD") === before.head);
    check(`W7 [${how}] no Inspector output`, !existsSync(join(repo, ".ono")) && !existsSync(join(repo, "CLAUDE.md")));
    check(`W7 [${how}] local change untouched`, readFileSync(join(repo, "local.txt"), "utf-8") === "dirty\n");
    check(`W7 [${how}] writes stay refused after the failure`, wb(repo, "assert", repo).code === EXIT_PROTECTED);
    check(`W7 [${how}] a retry after fixing the cause succeeds`, wb(repo, "create", repo, DEFAULT_WORK_BRANCH).code === 0 && current(repo) === DEFAULT_WORK_BRANCH);
  }

  // --- W8: nested project root and Claude worktrees -----------------------------------
  {
    const repo = repoOn(root, "main");
    write(repo, "YesTVOS/package.json", "{}\n");
    commitAll(repo, "nested project");
    const project = join(repo, "YesTVOS");
    const c = wb(project, "check", project);
    check("W8 nested project: Git Root reported, protected", c.json?.gitRoot === repo && c.json?.protected === true);
    const before = readFileSync(join(project, "package.json"), "utf-8");
    const r = wb(project, "create", project, DEFAULT_WORK_BRANCH);
    check("W8 nested project: branch created for the whole repository", r.code === 0 && current(repo) === DEFAULT_WORK_BRANCH && r.json?.gitRoot === repo);
    check("W8 nested project: files untouched, writes allowed", readFileSync(join(project, "package.json"), "utf-8") === before && wb(project, "assert", project).code === 0);

    const wtRepo = repoOn(root, "main");
    const wt = join(wtRepo, ".claude", "worktrees", "agent-1");
    git(wtRepo, "worktree", "add", "-q", "-b", "agent-branch", wt);
    check("W8 Claude worktree path -> check refused (exit 1)", wb(wt, "check", wt).code === 1);
    check("W8 Claude worktree path -> create refused, nothing created", wb(wt, "create", wt, DEFAULT_WORK_BRANCH).code === 1 && !git(wtRepo, "for-each-ref", "refs/heads").includes(DEFAULT_WORK_BRANCH));
    // The resolver maps the worktree back to the main tree, which is the one on main.
    const res = run("resolve-repo-root.ts", root, wt);
    check("W8 resolver unwraps the worktree to the main tree", res.json?.targetRoot === wtRepo, res.stdout);
    check("W8 the main tree's branch (main) is what gets protected", wb(wtRepo, "check", res.json?.targetRoot).json?.protected === true);
    check("W8 inspection-state refuses the worktree path itself", run("inspection-state.ts", root, "sync", wt).code === 1);
  }

  // --- W9: direct helper invocation on protected branches -> refused, nothing written ---
  {
    for (const state of ["main", "master", "detached"] as const) {
      const repo = repoOn(root, state === "detached" ? "main" : state);
      if (state === "detached") git(repo, "switch", "-q", "--detach");
      write(repo, "CLAUDE.md", "# CLAUDE.md\n");
      write(repo, "AUDIT.md", "# AUDIT.md\n\n| # | Status | Topic | Priority | File | Notes |\n|---|---|---|---|---|---|\n");
      const before = gitSnapshot(repo);
      const calls: Array<[string, string[]]> = [
        ["inspection-state.ts", ["init", repo]],
        ["inspection-state.ts", ["sync", repo]],
        ["inspection-state.ts", ["set-stage", repo, "project-analysis", "complete"]],
        ["inspection-state.ts", ["record-knowledge", repo, "project-analysis"]],
        ["inspection-state.ts", ["migrate", repo]],
        ["repo-knowledge.ts", ["emit", repo]],
        ["knowledge-refresh-guard.ts", ["snapshot", repo]],
        ["knowledge-refresh-guard.ts", ["verify", repo]],
        ["verify-artifacts.ts", [repo, "CLAUDE.md", "AUDIT.md"]],
      ];
      for (const [script, args] of calls) {
        const r = run(script, repo, ...args);
        check(`W9 ${state}: ${script} ${args[0] === repo ? "" : args[0]} -> exit ${EXIT_PROTECTED}`, r.code === EXIT_PROTECTED, `${r.code} ${r.stderr}`);
        check(`W9 ${state}: ${script} ${args[0] === repo ? "" : args[0]} explains the refusal`, /REFUSED/.test(r.stderr) && /Nothing was written/.test(r.stderr), r.stderr);
      }
      check(`W9 ${state}: no .ono output at all (no partial writes)`, !existsSync(join(repo, ".ono")));
      check(`W9 ${state}: Git state unchanged`, JSON.stringify(gitSnapshot(repo)) === JSON.stringify(before));
      // Read-only operations still work on the protected branch.
      const det = run("inspection-state.ts", repo, "detect", repo);
      check(`W9 ${state}: detect still works (read-only)`, det.code === 0 && det.json?.inspected === false, det.stderr);
      check(`W9 ${state}: repo-knowledge validate/show still run (read-only, exit 2 = no manifest)`, run("repo-knowledge.ts", repo, "validate", repo).code === 2 && run("repo-knowledge.ts", repo, "show", repo).code === 2);
      check(`W9 ${state}: knowledge-evidence verify still runs`, run("knowledge-evidence.ts", repo, "verify", repo, "surfaces").code !== EXIT_PROTECTED);
      check(`W9 ${state}: resolver still runs`, run("resolve-repo-root.ts", repo, repo).code === 0);
    }

    // Existing Inspector output on a protected branch is never rewritten.
    const repo = repoOn(root, "inspector/test-work");
    write(repo, "CLAUDE.md", "# CLAUDE.md\n");
    write(repo, "AUDIT.md", "# AUDIT.md\n\n| # | Status | Topic | Priority | File | Notes |\n|---|---|---|---|---|---|\n");
    check("W9 working branch: init + emit succeed", run("inspection-state.ts", repo, "init", repo).code === 0 && run("repo-knowledge.ts", repo, "emit", repo).code === 0);
    commitAll(repo, "inspection");
    git(repo, "switch", "-q", "-c", "main");
    const stateBytes = readFileSync(join(repo, ".ono", "state.json"), "utf-8");
    const manifestBytes = readFileSync(join(repo, ".ono", "repo-knowledge.json"), "utf-8");
    check("W9 main with existing output: sync refused", run("inspection-state.ts", repo, "sync", repo).code === EXIT_PROTECTED);
    check("W9 main with existing output: emit refused", run("repo-knowledge.ts", repo, "emit", repo).code === EXIT_PROTECTED);
    check("W9 main with existing output: files byte-identical", readFileSync(join(repo, ".ono", "state.json"), "utf-8") === stateBytes && readFileSync(join(repo, ".ono", "repo-knowledge.json"), "utf-8") === manifestBytes);
    check("W9 main with existing output: no snapshot file left behind", run("knowledge-refresh-guard.ts", repo, "snapshot", repo).code === EXIT_PROTECTED && !existsSync(join(repo, ".ono", "knowledge-refresh-snapshot.json")));
  }

  // --- W10: no remote operations, no commits, schemas unchanged -------------------------
  {
    const repo = repoOn(root, "main");
    git(repo, "remote", "add", "origin", join(root, "does-not-exist.git")); // any fetch/push would fail
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    const remoteRefs = git(repo, "for-each-ref", "refs/remotes");
    const commits = git(repo, "rev-list", "--all", "--count");
    const r = wb(repo, "create", repo, DEFAULT_WORK_BRANCH);
    check("W10 create works with an unreachable remote (nothing contacted)", r.code === 0, r.stderr);
    check("W10 no FETCH_HEAD, remote-tracking refs unchanged", !existsSync(join(repo, ".git", "FETCH_HEAD")) && git(repo, "for-each-ref", "refs/remotes") === remoteRefs);
    check("W10 no upstream set for the new branch", !git(repo, "config", "--local", "--list").includes(`branch.${DEFAULT_WORK_BRANCH}.remote`));
    write(repo, "CLAUDE.md", "# CLAUDE.md\n");
    write(repo, "AUDIT.md", "# AUDIT.md\n\n| # | Status | Topic | Priority | File | Notes |\n|---|---|---|---|---|---|\n");
    check("W10 helpers write on the working branch", run("inspection-state.ts", repo, "init", repo).code === 0 && run("inspection-state.ts", repo, "sync", repo).code === 0 && run("repo-knowledge.ts", repo, "emit", repo).code === 0);
    check("W10 the Inspector made no commit", git(repo, "rev-list", "--all", "--count") === commits);
    check("W10 results are uncommitted local changes", /\?\? \.ono\//.test(git(repo, "status", "--porcelain=v1", "--untracked-files=all")));
    check("W10 still on the working branch at the end", current(repo) === DEFAULT_WORK_BRANCH);
    const state = JSON.parse(readFileSync(join(repo, ".ono", "state.json"), "utf-8"));
    const manifest = JSON.parse(readFileSync(join(repo, ".ono", "repo-knowledge.json"), "utf-8"));
    check("W10 state.json schema unchanged (stateSchemaVersion 1)", state.stateSchemaVersion === 1);
    check("W10 manifest schema unchanged (repoKnowledgeSchemaVersion 1)", manifest.repoKnowledgeSchemaVersion === 1 && REPO_KNOWLEDGE_SCHEMA_VERSION === 1);
    check("W10 manifest validates", run("repo-knowledge.ts", repo, "validate", repo).code === 0);
  }

  // --- W11: usage ----------------------------------------------------------------------
  {
    check("W11 no arguments -> exit 1", wb(root).code === 1);
    check("W11 create without a name -> exit 1", wb(root, "create", root).code === 1);
    check("W11 missing directory -> exit 1", wb(root, "check", join(root, "nope")).code === 1);
    const plain = join(root, "plain-create");
    write(plain, "a.txt", "x\n");
    check("W11 create in a non-Git directory -> exit 1, no repository created", wb(plain, "create", plain, DEFAULT_WORK_BRANCH).code === 1 && !existsSync(join(plain, ".git")));
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
