/**
 * fixtures/inspected.ts — throwaway repositories that are already fully inspected (0.13.0).
 *
 * Starts from scripts/fixtures/inspected-0.11.3/tree (real 0.11.3 output), optionally
 * transforms it, commits it, and — on a working branch — records the knowledge-authoring
 * HEAD for both source-backed stages with the CURRENT helpers, so `detect` reports
 * COMPLETE at that HEAD. Every commit uses a fixed identity and fixed dates.
 */

import { execFileSync, spawnSync } from "child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join, resolve, sep } from "path";

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

const NUL = "\u0000";
/** Git for a temporary fixture repository only: NTFS path protection off for this one command. */
function fixtureGit(dir: string, args: string[], input?: string): string {
  return execFileSync("git", ["-c", "core.protectNTFS=false", "-c", "core.precomposeUnicode=false", ...args], {
    cwd: dir, env: GIT_ENV, encoding: "utf-8", input, stdio: ["pipe", "pipe", "pipe"],
  }).replace(/\n$/, "");
}

/** `tree` with `blob` placed at `parts` (creating subtrees as needed); returns the new tree id. */
function treeWith(dir: string, tree: string | null, parts: string[], blob: string): string {
  const entries: Array<{ mode: string; type: string; sha: string; name: string }> = [];
  if (tree) {
    for (const e of fixtureGit(dir, ["ls-tree", "-z", tree]).split(NUL).filter(Boolean)) {
      const tab = e.indexOf("\t");
      const [mode, type, sha] = e.slice(0, tab).split(" ");
      entries.push({ mode, type, sha, name: e.slice(tab + 1) });
    }
  }
  const [head, ...rest] = parts;
  const i = entries.findIndex((e) => e.name === head);
  if (rest.length === 0) {
    const entry = { mode: "100644", type: "blob", sha: blob, name: head };
    if (i === -1) entries.push(entry); else entries[i] = entry;
  } else {
    const sub = treeWith(dir, i !== -1 && entries[i].type === "tree" ? entries[i].sha : null, rest, blob);
    const entry = { mode: "040000", type: "tree", sha: sub, name: head };
    if (i === -1) entries.push(entry); else entries[i] = entry;
  }
  return fixtureGit(dir, ["mktree", "-z"], entries.map((e) => `${e.mode} ${e.type} ${e.sha}\t${e.name}${NUL}`).join(""));
}

/**
 * Commit a blob at an EXACT path by building Git objects directly (hash-object, mktree -z,
 * commit-tree, update-ref) — never through the index or the file system. Names that cannot
 * exist on disk on a platform (Windows: `"`, `\`, tab, newline) or that the platform would
 * rewrite (macOS: NFD -> NFC) are stored exactly, on every OS. The work tree and index are
 * left untouched, so callers inspect commits only (detect / diff), never `git add -A` after.
 */
export function commitIndexPath(dir: string, path: string, body: string, message: string): void {
  const blob = fixtureGit(dir, ["hash-object", "-w", "--stdin"], body);
  const parent = fixtureGit(dir, ["rev-parse", "HEAD"]);
  const tree = treeWith(dir, fixtureGit(dir, ["rev-parse", "HEAD^{tree}"]), path.split("/"), blob);
  const commit = fixtureGit(dir, ["commit-tree", tree, "-p", parent, "-m", message]);
  fixtureGit(dir, ["update-ref", "HEAD", commit, parent]);
  const stored = fixtureGit(dir, ["ls-tree", "-z", "-r", "--name-only", "HEAD"]).split(NUL);
  if (!stored.includes(path)) throw new Error(`fixture: ${JSON.stringify(path)} was not stored exactly`);
}

/**
 * Extract the files under `paths` of an exact commit of THIS plugin repository into `dest`
 * using Git objects only (no tar, no archive tools): `ls-tree -r -z` lists the blobs and
 * `cat-file blob` writes each one byte for byte (binary-safe). Executable modes are kept;
 * any other mode (symlink, submodule) and any path that would leave `dest` is refused.
 * Every git call is checked; an incomplete extraction throws.
 */
export function extractRelease(commit: string, paths: string[], dest: string, repo: string = PLUGIN): { files: number } {
  const run = (args: string[]): Buffer => {
    const r = spawnSync("git", args, { cwd: repo, maxBuffer: 256 * 1024 * 1024 });
    if (r.error || r.status !== 0) throw new Error(`extractRelease: git ${args.join(" ")} failed (${r.error?.message ?? `exit ${r.status}`}): ${r.stderr?.toString().trim()}`);
    return r.stdout;
  };
  run(["cat-file", "-e", `${commit}^{commit}`]);
  const root = resolve(dest);
  mkdirSync(root, { recursive: true });
  const entries = run(["-c", "core.quotePath=false", "ls-tree", "-r", "-z", "--full-tree", commit, "--", ...paths]).toString("utf-8").split(NUL).filter(Boolean);
  if (entries.length === 0) throw new Error(`extractRelease: ${commit} has no files under ${paths.join(", ")}`);
  let files = 0;
  for (const e of entries) {
    const tab = e.indexOf("\t");
    const [mode, type, sha] = e.slice(0, tab).split(" ");
    const rel = e.slice(tab + 1);
    if (type !== "blob" || !["100644", "100755"].includes(mode)) throw new Error(`extractRelease: unsupported entry ${mode} ${type} ${rel}`);
    const target = resolve(root, ...rel.split("/"));
    if (isAbsolute(rel) || rel.split("/").includes("..") || (target !== root && !target.startsWith(root + sep))) throw new Error(`extractRelease: path escapes the destination: ${rel}`);
    const bytes = run(["cat-file", "blob", sha]);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    if (mode === "100755") chmodSync(target, 0o755);
    if (statSync(target).size !== bytes.length) throw new Error(`extractRelease: ${rel} was not written completely`);
    files++;
  }
  return { files };
}
