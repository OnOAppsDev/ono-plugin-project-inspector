/**
 * fixtures/inspected.ts — throwaway repositories that are already fully inspected (0.13.0).
 *
 * Starts from scripts/fixtures/inspected-0.11.3/tree (real 0.11.3 output), optionally
 * transforms it, commits it, and — on a working branch — records the knowledge-authoring
 * HEAD for both source-backed stages with the CURRENT helpers, so `detect` reports
 * COMPLETE at that HEAD. Every commit uses a fixed identity and fixed dates.
 */

import { execFileSync } from "child_process";
import { cpSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const HERE = import.meta.dirname;
export const PLUGIN = join(HERE, "..", "..");
export const FIXTURE_0113 = join(HERE, "inspected-0.11.3", "tree");

export const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Inspector Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Inspector Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_AUTHOR_DATE: "2026-11-01T12:00:00Z", GIT_COMMITTER_DATE: "2026-11-01T12:00:00Z",
};

export function g(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", "-c", "core.safecrlf=false", ...args], {
    cwd, env: GIT_ENV, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
  }).replace(/\n$/, "");
}

export interface Run { code: number; stdout: string; stderr: string; json: any }
export function helper(cwd: string, script: string, ...args: string[]): Run {
  let code = 0, stdout = "", stderr = "";
  try {
    stdout = execFileSync(process.execPath, ["--no-warnings", join(PLUGIN, "scripts", script), ...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err: any) {
    code = typeof err.status === "number" ? err.status : 1;
    stdout = err.stdout?.toString() ?? "";
    stderr = err.stderr?.toString() ?? "";
  }
  let json: any = null;
  try { json = JSON.parse(stdout); } catch { json = null; }
  return { code, stdout, stderr, json };
}

/** Replace text in a file of the tree (before it is committed). */
export function edit(dir: string, rel: string, from: string | RegExp, to: string): void {
  const p = join(dir, rel);
  writeFileSync(p, readFileSync(p, "utf-8").replace(from, to));
}

/**
 * A fully inspected repository at `dir` on `branch` (a working branch).
 * `transform` may rewrite the tree before the first commit. Returns the knowledge HEAD.
 */
export function inspectedRepo(dir: string, branch = "chore/project-inspection", transform?: (dir: string) => void): string {
  cpSync(FIXTURE_0113, dir, { recursive: true });
  transform?.(dir);
  g(dir, "init", "-q", "-b", branch);
  g(dir, "add", "-A");
  g(dir, "commit", "-q", "-m", "inspected project");
  const head = g(dir, "rev-parse", "HEAD");
  for (const stage of ["project-analysis", "project-docs"]) {
    const r = helper(dir, "inspection-state.ts", "record-knowledge", dir, stage);
    if (r.code !== 0) throw new Error(`record-knowledge ${stage} failed: ${r.stderr}`);
  }
  g(dir, "add", "-A");
  g(dir, "commit", "-q", "-m", "knowledge recorded");
  if (!existsSync(join(dir, ".ono", "state.json"))) throw new Error("no state.json");
  return head;
}

/** Commit a blob at an exact path through the index only (names the OS may not allow on disk). */
export function commitIndexPath(dir: string, path: string, body: string, message: string): void {
  const sha = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: dir, input: body, encoding: "utf-8" }).trim();
  // core.precomposeUnicode=false: Git on macOS would otherwise rewrite an NFD argument to NFC,
  // making it impossible to store the exact (decomposed) path the test needs.
  execFileSync("git", ["-c", "core.precomposeUnicode=false", "update-index", "--add", "--cacheinfo", `100644,${sha},${path}`], { cwd: dir });
  g(dir, "commit", "-q", "-m", message);
}
