/**
 * resolve-repo-root.test.ts
 *
 * Regression tests for the Git Root / Project Root split (0.11.2). Builds
 * throwaway git repositories and runs the real CLI exactly as the agent does,
 * from a chosen working directory, with or without an explicit path.
 *
 * No external test framework. Run with:
 *   node --no-warnings scripts/resolve-repo-root.test.ts
 */

import { execFileSync } from "child_process";
import { mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { commitAll, git, initGit, write } from "./fixtures/knowledge-fixtures.ts";

const HERE = import.meta.dirname;
const RESOLVER = join(HERE, "resolve-repo-root.ts");
const RUNTIME = process.execPath;

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ""}`); }
}

function resolveAt(cwd: string, ...args: string[]): { code: number; json: any; stderr: string } {
  let code = 0, stdout = "", stderr = "";
  try {
    stdout = execFileSync(RUNTIME, ["--no-warnings", RESOLVER, ...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err: any) {
    code = typeof err.status === "number" ? err.status : 1;
    stdout = err.stdout?.toString() ?? "";
    stderr = err.stderr?.toString() ?? "";
  }
  let json: any = null;
  try { json = JSON.parse(stdout); } catch { json = null; }
  return { code, json, stderr };
}

const INSPECTION = (dir: string) => {
  write(dir, "CLAUDE.md", "# CLAUDE.md\n");
  write(dir, "AUDIT.md", "# AUDIT.md\n");
  write(dir, ".ono/state.json", "{}\n");
};

const root = realpathSync(mkdtempSync(join(tmpdir(), "inspector-root-")));
try {
  // --- R1: project at the Git Root — pre-0.11.2 behavior preserved ---
  {
    const repo = join(root, "r1");
    initGit(repo);
    write(repo, "package.json", "{}\n");
    write(repo, "src/deep/x.ts", "export {};\n");
    commitAll(repo, "init");
    const explicit = resolveAt(root, repo);
    check("R1 explicit Git Root -> exit 0", explicit.code === 0, JSON.stringify(explicit));
    check("R1 projectRoot = gitRoot = targetRoot", explicit.json?.projectRoot === repo && explicit.json?.gitRoot === repo && explicit.json?.targetRoot === repo);
    check("R1 not nested, projectPath '.'", explicit.json?.nested === false && explicit.json?.projectPath === ".");
    const fromSub = resolveAt(join(repo, "src", "deep"));
    check("R1 cwd deep inside a root project -> Git Root (unchanged behavior)", fromSub.code === 0 && fromSub.json?.targetRoot === repo, JSON.stringify(fromSub.json));
    check("R1 cwd selection recorded", fromSub.json?.selection === "cwd");
    const fromRoot = resolveAt(repo);
    check("R1 cwd at Git Root -> Git Root", fromRoot.code === 0 && fromRoot.json?.targetRoot === repo && fromRoot.json?.decision === null);
  }

  // --- R2: nested project selected explicitly (yestvos/YesTVOS) ---
  {
    const repo = join(root, "yestvos");
    initGit(repo);
    write(repo, "README.md", "# umbrella\n");
    write(repo, "YesTVOS/YesTVOS.xcodeproj/project.pbxproj", "// pbx\n");
    write(repo, "YesTVOS/Sources/App.swift", "struct App {}\n");
    commitAll(repo, "init");
    const nested = join(repo, "YesTVOS");
    const r = resolveAt(root, nested);
    check("R2 explicit nested path -> exit 0", r.code === 0, JSON.stringify(r));
    check("R2 projectRoot is the selected directory", r.json?.projectRoot === nested && r.json?.targetRoot === nested);
    check("R2 gitRoot preserved", r.json?.gitRoot === repo);
    check("R2 nested + projectPath", r.json?.nested === true && r.json?.projectPath === "YesTVOS", JSON.stringify(r.json));
    check("R2 no ancestor inspections", JSON.stringify(r.json?.ancestorInspections) === "[]");

    // cwd inside the nested project, no path: never auto-selected -> confirm.
    const fromCwd = resolveAt(join(nested, "Sources"));
    check("R2 cwd inside nested project -> decision required (exit 4)", fromCwd.code === 4 && fromCwd.json?.decision?.kind === "confirm-project", JSON.stringify(fromCwd.json));
    check("R2 confirm-project offers the project and the Git Root", JSON.stringify(fromCwd.json?.decision?.options) === JSON.stringify(["YesTVOS", "."]));
    check("R2 decision means not ok", fromCwd.json?.ok === false);

    // cwd at the Git Root, single subproject, no root manifest: Git Root (never descends), child reported.
    const atRoot = resolveAt(repo);
    check("R2 cwd at Git Root with one subproject -> Git Root, no auto-descend", atRoot.code === 0 && atRoot.json?.projectRoot === repo, JSON.stringify(atRoot.json));
    check("R2 the subproject is reported for the startup summary", JSON.stringify(atRoot.json?.childProjects) === JSON.stringify(["YesTVOS"]));
  }

  // --- R3: nested project selected while an inspection exists at the Git Root ---
  {
    const repo = join(root, "r3");
    initGit(repo);
    write(repo, "package.json", "{}\n");
    write(repo, "apps/tv/package.json", "{}\n");
    INSPECTION(repo);
    commitAll(repo, "init");
    const tv = join(repo, "apps", "tv");
    const r = resolveAt(root, tv);
    check("R3 nested selection with a Git Root inspection -> confirm-nested (exit 4)", r.code === 4 && r.json?.decision?.kind === "confirm-nested", JSON.stringify(r.json));
    check("R3 ancestor inspection listed", JSON.stringify(r.json?.ancestorInspections) === JSON.stringify(["."]));
    check("R3 options: the nested project or the existing inspection", JSON.stringify(r.json?.decision?.options) === JSON.stringify(["apps/tv", "."]));
    const confirmed = resolveAt(root, tv, "--confirm-nested");
    check("R3 --confirm-nested -> exit 0, nested target", confirmed.code === 0 && confirmed.json?.targetRoot === tv && confirmed.json?.decision === null, JSON.stringify(confirmed.json));
    check("R3 confirmation still reports the ancestor inspection", JSON.stringify(confirmed.json?.ancestorInspections) === JSON.stringify(["."]));
    const middle = join(repo, "apps");
    INSPECTION(middle);
    const both = resolveAt(root, tv);
    check("R3 every inspected ancestor up to the Git Root is listed", JSON.stringify(both.json?.ancestorInspections) === JSON.stringify(["apps", "."]), JSON.stringify(both.json?.ancestorInspections));
    // A nested project that already has its own inspection is continued, not re-confirmed.
    INSPECTION(tv);
    const own = resolveAt(root, tv);
    check("R3 nested project with its own inspection -> no decision", own.code === 0 && own.json?.decision === null, JSON.stringify(own.json));
    // Explicit Git Root is unaffected by inspections below it (no recursive scan).
    const rootSel = resolveAt(root, repo);
    check("R3 explicit Git Root -> exit 0", rootSel.code === 0 && rootSel.json?.targetRoot === repo);
  }

  // --- R4: several projects at the Git Root, none selected -> clarification ---
  {
    const repo = join(root, "r4");
    initGit(repo);
    write(repo, "README.md", "# mono\n");
    write(repo, "ios/App.xcodeproj/project.pbxproj", "//\n");
    write(repo, "android/settings.gradle", "\n");
    write(repo, "node_modules/pkg/package.json", "{}\n");
    write(repo, "docs/readme.md", "x\n");
    commitAll(repo, "init");
    const r = resolveAt(repo);
    check("R4 cwd at a multi-project Git Root -> select-project (exit 4)", r.code === 4 && r.json?.decision?.kind === "select-project", JSON.stringify(r.json));
    check("R4 options list the projects (node_modules and non-projects ignored) plus the Git Root", JSON.stringify(r.json?.decision?.options) === JSON.stringify(["android", "ios", "."]), JSON.stringify(r.json?.decision));
    check("R4 nothing selected automatically", r.json?.ok === false);
    const pick = resolveAt(repo, join(repo, "ios"));
    check("R4 explicit selection resolves", pick.code === 0 && pick.json?.projectRoot === join(repo, "ios"));
    const whole = resolveAt(repo, repo);
    check("R4 explicitly selecting the Git Root inspects it as one project", whole.code === 0 && whole.json?.projectRoot === repo);
  }

  // --- R5: a subproject already holds an inspection, run from the Git Root with no path ---
  {
    const repo = join(root, "r5");
    initGit(repo);
    write(repo, "README.md", "# umbrella\n");
    write(repo, "App/package.json", "{}\n");
    INSPECTION(join(repo, "App"));
    commitAll(repo, "init");
    const r = resolveAt(repo);
    check("R5 inspected subproject + cwd at bare Git Root -> select-project (avoid a duplicate root inspection)", r.code === 4 && r.json?.decision?.kind === "select-project", JSON.stringify(r.json));
    const inside = resolveAt(join(repo, "App"));
    check("R5 cwd inside the inspected subproject -> continue it without asking", inside.code === 0 && inside.json?.projectRoot === join(repo, "App"), JSON.stringify(inside.json));
  }

  // --- R6: Claude worktree unwrapping keeps the selected subdirectory ---
  {
    const repo = join(root, "r6");
    initGit(repo);
    write(repo, "README.md", "x\n");
    write(repo, "YesTVOS/Package.swift", "// swift\n");
    commitAll(repo, "init");
    const wt = join(repo, ".claude", "worktrees", "agent-1");
    git(repo, "worktree", "add", "-q", wt);
    const r = resolveAt(root, join(wt, "YesTVOS"));
    check("R6 worktree nested selection -> unwrapped", r.code === 0 && r.json?.unwrapped === true, JSON.stringify(r.json));
    check("R6 Project Root mapped onto the main tree", r.json?.projectRoot === join(repo, "YesTVOS"), r.json?.projectRoot);
    check("R6 Git Root is the main tree", r.json?.gitRoot === repo && r.json?.targetIsWorktree === false);
    const top = resolveAt(root, wt);
    check("R6 worktree root -> main tree root (pre-0.11.2 behavior)", top.code === 0 && top.json?.projectRoot === repo);
  }

  // --- R7: non-git directory and bad input ---
  {
    const plain = join(root, "plain");
    write(plain, "package.json", "{}\n");
    const r = resolveAt(root, plain);
    check("R7 non-git directory -> itself, gitRoot null", r.code === 0 && r.json?.projectRoot === plain && r.json?.gitRoot === null && r.json?.isGit === false, JSON.stringify(r.json));
    const missing = resolveAt(root, join(root, "nope"));
    check("R7 missing path -> exit 1", missing.code === 1 && /not found/i.test(missing.stderr));
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
