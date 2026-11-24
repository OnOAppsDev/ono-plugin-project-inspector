/**
 * work-branch.ts — protected-branch guard and working-branch creation (0.11.3).
 *
 * The Inspector never writes inspection results while the repository is on a
 * protected branch: `main`, `master`, or a detached HEAD. This file is both
 *
 *   - the library every filesystem-mutating helper calls before its first
 *     write (`assertWritable` / `guardWrite`) — the mechanical backstop, which
 *     does not depend on agent instructions, on the Dev Plugin, or on any
 *     other component; and
 *   - the CLI the agent uses to inspect the branch state and, after ONE
 *     explicit developer approval, create a local working branch.
 *
 * Local Git only: no fetch, pull, push, commit, merge, reset, stash, restore or
 * clean, and no hosting-provider API. A branch is created from the current
 * local HEAD with `git switch -c`, which carries every staged, unstaged and
 * untracked change over untouched; HEAD, the working tree and the index are
 * verified unchanged afterwards. An existing branch is never reused, moved,
 * reset or deleted.
 *
 * Usage:
 *   node --no-warnings scripts/work-branch.ts check  <TARGET_ROOT> [name]   read-only state + suggestion
 *   node --no-warnings scripts/work-branch.ts assert <TARGET_ROOT>          exit 0 if writable, 5 if protected
 *   node --no-warnings scripts/work-branch.ts create <TARGET_ROOT> <name>   create + switch (after approval)
 *
 * Exit codes:
 *   0 - ok (check always 0; assert writable; create succeeded)
 *   1 - usage error / path not found / create on a non-Git directory
 *   3 - create refused: already on a working branch (no branch is needed)
 *   5 - assert: protected — writing is refused (same code the writer helpers use)
 *   6 - create refused: invalid or already-taken name (JSON carries suggestedName)
 *   7 - create failed or could not be verified — STOP; nothing was written
 */

import { execFileSync, spawnSync } from "child_process";
import { existsSync, realpathSync, statSync } from "fs";
import { dirname, join, sep } from "path";
import { isEntryPoint, useBlockingOutput } from "./entrypoint.ts";

export const PROTECTED_BRANCHES = ["main", "master"] as const;
export const DEFAULT_WORK_BRANCH = "chore/project-inspection";
/** Exit code every Inspector helper uses when it refuses to write on a protected branch. */
export const EXIT_PROTECTED = 5;

const HERE = import.meta.dirname;
const SELF = join(HERE, "work-branch.ts");

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).replace(/\n$/, "");
  } catch {
    return null;
  }
}

export interface BranchState {
  /** The directory is inside a Git working tree. */
  isGit: boolean;
  gitRoot: string | null;
  /** Current branch name; null when detached (or unknown). */
  branch: string | null;
  detached: boolean;
  /** The current branch has no commit yet. */
  unborn: boolean;
  /** Current commit, or null when unborn. */
  head: string | null;
  /** Writing inspection results is refused in this state. */
  protected: boolean;
  /** Why it is protected: "main" | "master" | "detached" | "unknown"; null when writable. */
  reason: string | null;
}

/** True when `dir` or an ancestor holds a `.git` entry (used to fail closed if Git cannot answer). */
function looksLikeGit(dir: string): boolean {
  let cur = dir;
  for (;;) {
    if (existsSync(join(cur, ".git"))) return true;
    const parent = dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

export function branchState(dir: string): BranchState {
  const top = git(dir, ["rev-parse", "--show-toplevel"]);
  if (top === null) {
    // Not a Git repository: there is no branch to protect. If it looks like one
    // but Git cannot answer, fail closed — never allow more than can be proven.
    if (looksLikeGit(dir)) {
      return { isGit: true, gitRoot: null, branch: null, detached: false, unborn: false, head: null, protected: true, reason: "unknown" };
    }
    return { isGit: false, gitRoot: null, branch: null, detached: false, unborn: false, head: null, protected: false, reason: null };
  }
  const gitRoot = realpathSync(top);
  const head = git(dir, ["rev-parse", "-q", "--verify", "HEAD^{commit}"]) || null;
  const branch = git(dir, ["symbolic-ref", "-q", "--short", "HEAD"]) || null;
  const detached = branch === null;
  const reason = detached ? "detached" : (PROTECTED_BRANCHES as readonly string[]).includes(branch!) ? branch : null;
  return { isGit: true, gitRoot, branch, detached, unborn: head === null, head, protected: reason !== null, reason };
}

export class ProtectedBranchError extends Error {
  readonly state: BranchState;
  readonly action: string;
  constructor(state: BranchState, action: string) {
    super(refusalMessage(state, action));
    this.state = state;
    this.action = action;
    this.name = "ProtectedBranchError";
  }
}

function describe(state: BranchState): string {
  if (state.reason === "detached") return `a detached HEAD${state.head ? ` (${state.head.slice(0, 7)})` : ""}`;
  if (state.reason === "unknown") return "a branch that could not be determined";
  return `the protected branch '${state.branch}'`;
}

export function refusalMessage(state: BranchState, action: string): string {
  const where = state.gitRoot ?? "the repository";
  return [
    `REFUSED: ${action} would write Inspector output while ${where} is on ${describe(state)}.`,
    `Inspection results are never written to main, master, or a detached HEAD. Nothing was written.`,
    `Create a local working branch from the current checkout first (one developer approval), then re-run:`,
    `  node --no-warnings "${SELF}" check "<TARGET_ROOT>"`,
    `  node --no-warnings "${SELF}" create "<TARGET_ROOT>" "<branch-name>"    (suggested: ${DEFAULT_WORK_BRANCH})`,
  ].join("\n");
}

/** Throws ProtectedBranchError when writing under `dir` is refused. Call before the first mutation. */
export function assertWritable(dir: string, action: string): void {
  const state = branchState(dir);
  if (state.protected) throw new ProtectedBranchError(state, action);
}

/** CLI form of assertWritable: prints the refusal and exits with EXIT_PROTECTED. */
export function guardWrite(dir: string, action: string): void {
  try {
    assertWritable(dir, action);
  } catch (err) {
    if (err instanceof ProtectedBranchError) {
      console.error(err.message);
      process.exit(EXIT_PROTECTED);
    }
    throw err;
  }
}

// --- branch names -----------------------------------------------------------

function refList(dir: string, prefix: string): string[] {
  const out = git(dir, ["for-each-ref", "--format=%(refname)", prefix]);
  return out ? out.split("\n").filter(Boolean) : [];
}

/**
 * A name is taken when a local branch has it, when it collides with a local
 * branch as a path (`a` vs `a/b`), or when any locally known remote-tracking
 * ref ends with it (pushing would land on an existing remote branch). No fetch.
 */
export function isTaken(dir: string, name: string): boolean {
  const locals = refList(dir, "refs/heads").map((r) => r.slice("refs/heads/".length));
  if (locals.some((n) => n === name || name.startsWith(n + "/") || n.startsWith(name + "/"))) return true;
  return refList(dir, "refs/remotes").some((r) => r.endsWith("/" + name));
}

/** Null when valid, otherwise why the name cannot be used. */
export function nameError(dir: string, name: string): string | null {
  if (!name || name.trim() !== name) return "the name is empty or has surrounding whitespace";
  if ((PROTECTED_BRANCHES as readonly string[]).includes(name)) return `'${name}' is a protected branch`;
  if (name === "HEAD" || name.startsWith("-")) return `'${name}' is not a valid branch name`;
  const r = spawnSync("git", ["check-ref-format", "--branch", name], { cwd: dir, encoding: "utf-8" });
  // `--branch` expands shorthands such as @{-1}; anything that is not echoed back verbatim is rejected.
  if (r.status !== 0 || r.stdout.trim() !== name) return `'${name}' is not a valid Git branch name`;
  return null;
}

/**
 * Used only when no `chore/project-inspection[-n]` name can exist — a local
 * branch named `chore` makes every `chore/…` name impossible in Git.
 */
export const FALLBACK_WORK_BRANCH = "project-inspection";

/**
 * The first free name: `chore/project-inspection`, then `-2`, `-3`, …; the
 * fallback family only when the default one cannot be created at all. Null if
 * nothing is free (the developer is then asked for a name).
 */
export function suggestName(dir: string): string | null {
  for (const base of [DEFAULT_WORK_BRANCH, FALLBACK_WORK_BRANCH]) {
    if (!isTaken(dir, base)) return base;
    for (let i = 2; i <= 100; i++) {
      const candidate = `${base}-${i}`;
      if (!isTaken(dir, candidate)) return candidate;
    }
  }
  return null;
}

// --- working tree snapshot --------------------------------------------------

function statusSnapshot(dir: string): string | null {
  return git(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"]);
}

function dirtySummary(dir: string): { count: number; staged: number; unstaged: number; untracked: number } {
  const raw = git(dir, ["status", "--porcelain=v1", "--untracked-files=all"]) ?? "";
  const lines = raw.split("\n").filter(Boolean);
  let staged = 0, unstaged = 0, untracked = 0;
  for (const l of lines) {
    if (l.startsWith("??")) { untracked++; continue; }
    if (l[0] !== " ") staged++;
    if (l[1] !== " ") unstaged++;
  }
  return { count: lines.length, staged, unstaged, untracked };
}

// --- CLI --------------------------------------------------------------------

function out(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function cmdCheck(dir: string, requested: string | undefined): void {
  const state = branchState(dir);
  const result: Record<string, unknown> = { ...state, dirty: state.isGit ? dirtySummary(dir) : null };
  if (state.isGit && state.gitRoot) {
    result.suggestedName = suggestName(dir);
    if (requested !== undefined) {
      const error = nameError(dir, requested);
      const taken = error === null && isTaken(dir, requested);
      result.requested = { name: requested, valid: error === null && !taken, error: error ?? (taken ? `'${requested}' already exists (or would collide with an existing branch); it is never reused` : null) };
    }
  }
  out(result);
  process.exit(0);
}

function cmdAssert(dir: string): void {
  guardWrite(dir, "This operation");
  out({ writable: true, ...branchState(dir) });
  process.exit(0);
}

function cmdCreate(dir: string, name: string): void {
  const before = branchState(dir);
  if (!before.isGit || !before.gitRoot) {
    console.error(before.isGit ? "The current branch could not be determined; no branch was created." : `Not a Git repository: ${dir}. No branch is needed.`);
    process.exit(before.isGit ? 7 : 1);
  }
  if (!before.protected) {
    out({ created: false, reason: "already-on-working-branch", branch: before.branch });
    console.error(`Already on the working branch '${before.branch}'. No new branch was created.`);
    process.exit(3);
  }
  const error = nameError(dir, name);
  if (error) {
    out({ created: false, reason: "invalid-name", name, error, suggestedName: suggestName(dir) });
    process.exit(6);
  }
  if (isTaken(dir, name)) {
    out({ created: false, reason: "name-taken", name, error: `'${name}' already exists (or would collide with an existing branch); it is never reused, reset or deleted`, suggestedName: suggestName(dir) });
    process.exit(6);
  }

  const statusBefore = statusSnapshot(dir);
  const r = spawnSync("git", ["switch", "-c", name], { cwd: dir, encoding: "utf-8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const after = branchState(dir);
  const statusAfter = statusSnapshot(dir);
  const branchExists = git(dir, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]) !== null;

  const problems: string[] = [];
  if (r.status !== 0) problems.push(`git switch -c failed: ${(r.stderr || r.stdout || "").trim() || `exit ${r.status}`}`);
  if (after.branch !== name) problems.push(`the current branch is '${after.branch ?? "detached HEAD"}', not '${name}'`);
  if (after.head !== before.head) problems.push(`HEAD moved from ${before.head ?? "(unborn)"} to ${after.head ?? "(unborn)"}`);
  if (statusAfter !== statusBefore) problems.push("the working tree or index changed");

  if (problems.length) {
    out({
      created: false,
      reason: "switch-failed",
      name,
      branchExists,
      currentBranch: after.branch,
      head: after.head,
      problems,
    });
    console.error(
      `Could not safely create and switch to '${name}':\n- ${problems.join("\n- ")}\n` +
        `STOP: nothing was inspected or written. ` +
        (branchExists && after.branch !== name ? `The branch '${name}' exists but is not checked out; it was left as is (never deleted). ` : "") +
        `Resolve the Git problem, then re-run the command.`
    );
    process.exit(7);
  }
  out({
    created: true,
    branch: name,
    from: before.detached ? "detached HEAD" : before.branch,
    head: after.head,
    unborn: after.unborn,
    gitRoot: after.gitRoot,
    localChangesKept: dirtySummary(dir).count,
  });
  process.exit(0);
}

function main(): void {
  const [, , command, target, name] = process.argv;
  if (!command || !target || !["check", "assert", "create"].includes(command) || (command === "create" && name === undefined)) {
    console.error("Usage: work-branch.ts <check <TARGET_ROOT> [name] | assert <TARGET_ROOT> | create <TARGET_ROOT> <name>>");
    process.exit(1);
  }
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    console.error(`Directory not found: ${target}`);
    process.exit(1);
  }
  const dir = realpathSync(target);
  if (dir.includes(`${sep}.claude${sep}worktrees${sep}`)) {
    console.error(`Refusing to operate on a Claude agent worktree: ${dir}\nPass the resolved main repository root (scripts/resolve-repo-root.ts).`);
    process.exit(1);
  }
  if (command === "check") return cmdCheck(dir, name);
  if (command === "assert") return cmdAssert(dir);
  return cmdCreate(dir, name!);
}

if (isEntryPoint(import.meta.url)) {
  useBlockingOutput();
  main();
}
