/**
 * resolve-repo-root.ts
 *
 * Deterministic helper that resolves the inspection target for the Ono Project
 * Inspector. It distinguishes two roots:
 *
 *   - Git Root     — `git rev-parse --show-toplevel` (main working tree). Where
 *                    Git operates; never where Inspector artifacts are written
 *                    unless the project itself lives there.
 *   - Project Root — the project directory selected for inspection. All Inspector
 *                    artifacts (CLAUDE.md, AUDIT.md, docs/project/, audits/, .ono/)
 *                    live here and every skill analyzes it. It may sit below the
 *                    Git Root (e.g. yestvos/ is the Git Root, yestvos/YesTVOS/ the
 *                    project). `targetRoot` in the output is the Project Root.
 *
 * Rules (never guesses, never descends into a subproject on its own, never
 * migrates anything, never writes anything):
 *
 *   1. An explicitly passed path is the Project Root, exactly as given.
 *   2. With no path, the current working directory is only a starting point:
 *      walk UP from it to the Git Root and take the nearest directory that holds
 *      Inspector artifacts or a project manifest. If that is the Git Root (or
 *      nothing is found), the Git Root is the Project Root — the pre-0.11.2
 *      behavior. If it is a nested directory, ask the developer to confirm it.
 *   3. With no path at the Git Root, if the Git Root itself has no project
 *      manifest and no Inspector artifacts, look at its immediate
 *      subdirectories only (no recursive scan): if two or more are projects, or
 *      one already holds an inspection, ask the developer which one to inspect.
 *      A nearest nested project that already holds an inspection (rule 2) is
 *      continued without asking.
 *   4. For a nested Project Root without its own inspection, if Inspector
 *      artifacts exist in any ancestor up to the Git Root, ask for confirmation
 *      before another inspection is created (`--confirm-nested` records it).
 *
 * Claude Code may run an agent inside an isolated git worktree at
 *   <repo>/.claude/worktrees/agent-<id>/
 * which is itself a legitimate git root. Writing artifacts there strands them in
 * a throwaway copy, so the worktree is unwrapped to the main working tree,
 * preserving the selected subdirectory.
 *
 * Usage:
 *   node --no-warnings scripts/resolve-repo-root.ts [project-path] [--confirm-nested]
 *
 * Exit codes:
 *   0 - resolved a safe Project Root (read `targetRoot` from the JSON stdout)
 *   1 - candidate path does not exist / usage error
 *   3 - candidate is a Claude worktree that could not be unwrapped (unsafe)
 *   4 - a developer decision is required (see `decision`); nothing may run yet
 */

import { existsSync, readdirSync, realpathSync, statSync } from "fs";
import { execFileSync } from "child_process";
import { dirname, join, relative, resolve, sep } from "path";
import { isEntryPoint, useBlockingOutput } from "./entrypoint.ts";

const CLAUDE_WORKTREE_MARKER = `${sep}.claude${sep}worktrees${sep}`;

/** Files/dirs whose presence marks a directory as an application/project root. */
const PROJECT_MANIFEST_FILES = [
  "package.json",
  "Package.swift",
  "Podfile",
  "project.yml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "app.json",
  "pubspec.yaml",
  "config.xml",
  "appinfo.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
];
const PROJECT_MANIFEST_SUFFIXES = [".xcodeproj", ".xcworkspace"];
const SKIP_CHILD_DIRS = new Set(["node_modules", "Pods", "build", "dist", "vendor", "DerivedData"]);

export type DecisionKind = "select-project" | "confirm-project" | "confirm-nested";

export interface Decision {
  kind: DecisionKind;
  message: string;
  /** Project Root candidates, relative to the Git Root ("." = the Git Root). */
  options: string[];
}

export interface Resolution {
  candidate: string;
  selection: "explicit" | "cwd";
  gitRoot: string | null;
  projectRoot: string;
  /** Project Root relative to the Git Root ("." when they are the same; null outside Git). */
  projectPath: string | null;
  nested: boolean;
  /** Same as projectRoot — kept for pre-0.11.2 callers. */
  targetRoot: string;
  isGit: boolean;
  isClaudeWorktree: boolean;
  unwrapped: boolean;
  mainWorktree: string | null;
  targetIsWorktree: boolean;
  /** Ancestors of a nested Project Root (up to the Git Root) holding Inspector artifacts, relative to the Git Root. */
  ancestorInspections: string[];
  /** Immediate subdirectories of the Git Root that are projects or hold an inspection (only examined for a cwd selection resolving to a Git Root with no project of its own). */
  childProjects: string[];
  decision: Decision | null;
  ok: boolean;
  warning: string | null;
}

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** The first `worktree <path>` line of `git worktree list --porcelain` is always the main working tree. */
function mainWorktree(cwd: string): string | null {
  const out = git(["worktree", "list", "--porcelain"], cwd);
  if (!out) return null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) return line.slice("worktree ".length).trim();
  }
  return null;
}

/** A directory already holds an Inspector inspection (state file, or the CLAUDE.md + AUDIT.md pair). */
export function hasInspectorArtifacts(dir: string): boolean {
  return (
    existsSync(join(dir, ".ono", "state.json")) ||
    (existsSync(join(dir, "AUDIT.md")) && existsSync(join(dir, "CLAUDE.md")))
  );
}

/** A directory holds a project/build manifest of a supported (or common) project family. */
export function hasProjectManifest(dir: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  return entries.some((e) => PROJECT_MANIFEST_FILES.includes(e) || PROJECT_MANIFEST_SUFFIXES.some((s) => e.endsWith(s)));
}

function isProject(dir: string): boolean {
  return hasInspectorArtifacts(dir) || hasProjectManifest(dir);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function rel(gitRoot: string, p: string): string {
  const r = relative(gitRoot, p).split(sep).join("/");
  return r === "" ? "." : r;
}

/** Directories strictly above `dir`, up to and including `top`. */
function ancestorsUpTo(dir: string, top: string): string[] {
  const out: string[] = [];
  let cur = dir;
  while (cur !== top) {
    const parent = dirname(cur);
    if (parent === cur) break;
    out.push(parent);
    cur = parent;
  }
  return out;
}

export function resolveTarget(rawCandidate: string | undefined, cwd: string, confirmNested: boolean): Resolution | { error: string } {
  const selection: "explicit" | "cwd" = rawCandidate ? "explicit" : "cwd";
  const candidateAbs = resolve(cwd, rawCandidate ?? ".");
  if (!existsSync(candidateAbs) || !isDir(candidateAbs)) return { error: `Candidate path not found (or not a directory): ${candidateAbs}` };
  const candidate = realpathSync(candidateAbs);

  const toplevel = git(["rev-parse", "--show-toplevel"], candidate);
  const isGit = toplevel !== null;
  const isClaudeWorktree = candidate.includes(CLAUDE_WORKTREE_MARKER);
  const main = isGit ? mainWorktree(candidate) : null;

  let gitRoot: string | null = toplevel ? realpathSync(toplevel) : null;
  let start = candidate; // the selected directory, in the tree we will actually operate on
  let unwrapped = false;
  let warning: string | null = null;

  if (isClaudeWorktree) {
    if (main && existsSync(main) && !main.includes(CLAUDE_WORKTREE_MARKER)) {
      // Keep the selected subdirectory: main tree + the candidate's path inside its worktree.
      const prefix = git(["rev-parse", "--show-prefix"], candidate) ?? "";
      gitRoot = realpathSync(main);
      const mapped = join(gitRoot, prefix);
      start = existsSync(mapped) ? realpathSync(mapped) : gitRoot;
      unwrapped = true;
    } else {
      warning =
        "Candidate is inside .claude/worktrees but the main working tree could not be resolved; refusing to treat the worktree as the target.";
    }
  }

  let projectRoot = start;
  let decision: Decision | null = null;
  let childProjects: string[] = [];

  if (gitRoot && !warning) {
    if (selection === "cwd") {
      // Walk UP only: the nearest project at or above the working directory.
      const chain = [start, ...ancestorsUpTo(start, gitRoot)];
      const nearest = chain.find((d) => isProject(d));
      if (!nearest || nearest === gitRoot) {
        projectRoot = gitRoot; // pre-0.11.2 behavior
      } else if (hasInspectorArtifacts(nearest)) {
        projectRoot = nearest; // an existing inspection the developer is working inside: continue it
      } else {
        projectRoot = nearest;
        decision = {
          kind: "confirm-project",
          message:
            `No project path was given. The working directory is inside "${rel(gitRoot, nearest)}", a project below the Git Root. ` +
            `Confirm which directory to inspect by passing its path explicitly.`,
          options: [rel(gitRoot, nearest), "."],
        };
      }
      if (projectRoot === gitRoot && !hasProjectManifest(gitRoot) && !hasInspectorArtifacts(gitRoot)) {
        let entries: string[] = [];
        try {
          entries = readdirSync(gitRoot);
        } catch {
          entries = [];
        }
        childProjects = entries
          .filter((e) => !e.startsWith(".") && !SKIP_CHILD_DIRS.has(e))
          .map((e) => join(gitRoot as string, e))
          .filter((p) => isDir(p) && isProject(p))
          .map((p) => rel(gitRoot as string, p))
          .sort();
        const inspected = childProjects.filter((c) => hasInspectorArtifacts(join(gitRoot as string, c)));
        if (childProjects.length >= 2 || inspected.length > 0) {
          decision = {
            kind: "select-project",
            message:
              (childProjects.length >= 2
                ? `No project path was given and the Git Root contains ${childProjects.length} projects (${childProjects.join(", ")}). `
                : `No project path was given; the Git Root has no project of its own, and "${inspected[0]}" already holds an inspection. `) +
              `Choose which one to inspect by passing its path explicitly (or pass the Git Root itself to inspect it as one project).`,
            options: [...childProjects, "."],
          };
        }
      }
    }

    if (!decision && projectRoot !== gitRoot && !hasInspectorArtifacts(projectRoot)) {
      const ancestors = ancestorsUpTo(projectRoot, gitRoot).filter((d) => hasInspectorArtifacts(d));
      if (ancestors.length > 0 && !confirmNested) {
        decision = {
          kind: "confirm-nested",
          message:
            `"${rel(gitRoot, projectRoot)}" is nested below the Git Root, and Inspector artifacts already exist at ` +
            `${ancestors.map((a) => `"${rel(gitRoot as string, a)}"`).join(", ")}. Inspecting "${rel(gitRoot, projectRoot)}" creates a second, ` +
            `separate inspection; nothing is migrated. Confirm (re-run with --confirm-nested) or inspect the existing location instead.`,
          options: [rel(gitRoot, projectRoot), ...ancestors.map((a) => rel(gitRoot as string, a))],
        };
      }
    }
  }

  const ancestorInspections =
    gitRoot && projectRoot !== gitRoot
      ? ancestorsUpTo(projectRoot, gitRoot).filter((d) => hasInspectorArtifacts(d)).map((d) => rel(gitRoot as string, d))
      : [];
  const targetIsWorktree = projectRoot.includes(CLAUDE_WORKTREE_MARKER);
  const ok = !targetIsWorktree && !warning && !decision;

  return {
    candidate,
    selection,
    gitRoot,
    projectRoot,
    projectPath: gitRoot ? rel(gitRoot, projectRoot) : null,
    nested: gitRoot !== null && projectRoot !== gitRoot,
    targetRoot: projectRoot,
    isGit,
    isClaudeWorktree,
    unwrapped,
    mainWorktree: main,
    targetIsWorktree,
    ancestorInspections,
    childProjects,
    decision,
    ok,
    warning,
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const confirmNested = args.includes("--confirm-nested");
  const positional = args.filter((a) => !a.startsWith("--"));
  if (positional.length > 1) {
    console.error("Usage: resolve-repo-root.ts [project-path] [--confirm-nested]");
    process.exit(1);
  }
  const result = resolveTarget(positional[0], process.cwd(), confirmNested);
  if ("error" in result) {
    console.error(result.error);
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.warning || result.targetIsWorktree) process.exit(3);
  if (result.decision) process.exit(4);
  process.exit(0);
}

if (isEntryPoint(import.meta.url)) {
  useBlockingOutput();
  main();
}
