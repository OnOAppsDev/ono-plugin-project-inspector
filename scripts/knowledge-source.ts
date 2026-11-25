/**
 * knowledge-source.ts — where the freshness algorithm reads its inputs (0.14.0).
 *
 * One freshness algorithm (inspection-state.ts computeKnowledgeFreshness), two inputs:
 *
 *   worktreeSource(root)        the checked-out HEAD and the files on disk — exactly what
 *                               `freshness <root>` has always read (no behavior change);
 *   commitSource(root, commit)  one exact commit's Git objects — `freshness <root> --ref <rev>`.
 *                               The working tree, the index and the checked-out branch are
 *                               never consulted, and nothing falls back to them.
 *
 * Commit reads are literal and read-only: each path is resolved by walking the commit's
 * trees entry by entry (`git ls-tree -z --full-tree <tree>`, exact name comparison — no
 * pathspec, no `<rev>:<path>` parsing), then `git cat-file blob <oid>`. A path that is not in
 * the tree is ABSENT (`read` returns null); a tree or blob that cannot be read is UNAVAILABLE
 * (KnowledgeUnavailable is thrown) — never mistaken for absence.
 *
 * No network, no writes: every Git call of a commit source (and of revision resolution) runs
 * with GIT_NO_LAZY_FETCH=1, GIT_OPTIONAL_LOCKS=0 and GIT_TERMINAL_PROMPT=0. Only a partial
 * clone (a promisor remote) can fetch a missing object lazily; there, every call ALSO passes
 * `git --no-lazy-fetch`, so a Git that does not know the option rejects the call and the
 * result fails closed (BASELINE_UNKNOWN) — the guarantee rests on a run-time capability, not
 * on a version number. Ordinary clones get no new requirement (`objectReadPolicy`).
 */

import { execFileSync, spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

export class KnowledgeUnavailable extends Error {}

export interface KnowledgeSource {
  kind: "worktree" | "commit";
  /** The project root: the cwd of every Git call (a nested project root works). */
  root: string;
  /** The commit the knowledge is measured at: the checked-out HEAD, or the resolved commit. */
  head: string | null;
  /** Whether `rel` (project-relative) exists. Throws KnowledgeUnavailable when it cannot be told. */
  exists(rel: string): boolean;
  /** The text of `rel`, or null when it genuinely does not exist. Throws when it cannot be read. */
  read(rel: string): string | null;
  /** A Git command (trimmed stdout), or null when it fails. */
  git(args: string[]): string | null;
  /** A NUL-delimited path-listing Git command (exact, unquoted paths), or null when it fails. */
  gitPaths(args: string[]): string[] | null;
}

// --- Git primitives (shared with inspection-state.ts) ----------------------------------------

/** A Git command's trimmed stdout, or null on any failure. */
export function gitText(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string | null {
  try {
    return execFileSync("git", args, { cwd, env, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/**
 * Path-listing git commands (0.13.0). Git C-quotes non-ASCII and special names in
 * its default output (`"docs/project/\327\241…md"`), and `core.quotePath=false`
 * alone still quotes names containing `"`, `\`, tabs or newlines. NUL-delimited
 * output (`-z`) is never quoted, so each entry is the exact path Git stores —
 * the identity every later comparison and git call uses. Returns null on failure.
 */
export function gitPathList(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string[] | null {
  try {
    const out = execFileSync("git", ["-c", "core.quotePath=false", ...args], { cwd, env, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 });
    return out.split("\0").filter((p) => p.length > 0);
  } catch {
    return null;
  }
}

// --- working tree ----------------------------------------------------------------------------

export function worktreeSource(root: string): KnowledgeSource {
  return {
    kind: "worktree",
    root,
    head: gitText(root, ["rev-parse", "HEAD"]) || null,
    exists: (rel) => existsSync(join(root, rel)),
    read: (rel) => {
      const p = join(root, rel);
      return existsSync(p) ? readFileSync(p, "utf-8") : null;
    },
    git: (args) => gitText(root, args),
    gitPaths: (args) => gitPathList(root, args),
  };
}

// --- one exact commit ------------------------------------------------------------------------

/** How every Git call that reads a commit is made: environment plus global options. */
export interface ObjectReadPolicy { env: NodeJS.ProcessEnv; args: string[]; partialClone: boolean }

/** Whether the repository is a partial clone: a promisor remote, or extensions.partialClone. */
export function isPartialClone(root: string): boolean {
  const promisor = (gitText(root, ["config", "--get-regexp", "^remote\\..*\\.promisor$"]) ?? "").split("\n").some((l) => /\strue$/i.test(l.trim()));
  return promisor || (gitText(root, ["config", "--get", "extensions.partialClone"]) ?? "") !== "";
}

/**
 * The read policy for `root`, or why objects cannot be read without risking the network:
 * a partial clone whose Git does not support `git --no-lazy-fetch` (checked by running it).
 */
export function objectReadPolicy(
  root: string,
  supportsNoLazyFetch: (root: string, env: NodeJS.ProcessEnv) => boolean = (r, e) => gitText(r, ["--no-lazy-fetch", "version"], e) !== null
): { ok: true; policy: ObjectReadPolicy } | { ok: false; reason: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
  if (!isPartialClone(root)) return { ok: true, policy: { env, args: [], partialClone: false } };
  if (!supportsNoLazyFetch(root, env)) {
    return { ok: false, reason: "this is a partial clone and the installed Git does not support `git --no-lazy-fetch`, so reading its objects could access the network" };
  }
  return { ok: true, policy: { env, args: ["--no-lazy-fetch"], partialClone: true } };
}

interface TreeEntry { mode: string; type: string; oid: string }

/**
 * A source reading `commit` (a full object id the caller resolved) through Git objects.
 * Paths are project-relative: the project's own prefix inside the repository is prepended.
 */
export function commitSource(root: string, commit: string, policy: ObjectReadPolicy): KnowledgeSource {
  const { env, args: lazy } = policy;
  const prefix = gitText(root, [...lazy, "rev-parse", "--show-prefix"], env);
  if (prefix === null) throw new KnowledgeUnavailable("the project's location in the repository could not be determined");
  const listings = new Map<string, Map<string, TreeEntry>>();

  const list = (tree: string): Map<string, TreeEntry> => {
    const cached = listings.get(tree);
    if (cached) return cached;
    const r = spawnSync("git", [...lazy, "-c", "core.quotePath=false", "ls-tree", "-z", "--full-tree", tree], { cwd: root, env, maxBuffer: 256 * 1024 * 1024 });
    if (r.error || r.status !== 0) throw new KnowledgeUnavailable(`tree ${tree.slice(0, 12)} of ${commit.slice(0, 12)} is not available locally`);
    const entries = new Map<string, TreeEntry>();
    for (const e of r.stdout.toString("utf-8").split("\0")) {
      if (!e) continue;
      const tab = e.indexOf("\t");
      const [mode, type, oid] = e.slice(0, tab).split(" ");
      entries.set(e.slice(tab + 1), { mode, type, oid });
    }
    listings.set(tree, entries);
    return entries;
  };

  /** The entry at a repository-relative path, or null when the path is not in the commit. */
  const entry = (repoRel: string): TreeEntry | null => {
    const parts = repoRel.split("/").filter((p) => p.length > 0);
    let tree = `${commit}^{tree}`;
    let found: TreeEntry | null = null;
    for (let i = 0; i < parts.length; i++) {
      found = list(tree).get(parts[i]) ?? null;
      if (!found) return null;
      if (i < parts.length - 1) {
        if (found.type !== "tree") return null;
        tree = found.oid;
      }
    }
    return found;
  };

  return {
    kind: "commit",
    root,
    head: commit,
    exists: (rel) => entry(prefix + rel) !== null,
    read: (rel) => {
      const e = entry(prefix + rel);
      if (!e || e.type !== "blob") return null;
      const r = spawnSync("git", [...lazy, "cat-file", "blob", e.oid], { cwd: root, env, maxBuffer: 256 * 1024 * 1024 });
      if (r.error || r.status !== 0) throw new KnowledgeUnavailable(`${rel} at ${commit.slice(0, 12)} is not available locally (object ${e.oid.slice(0, 12)})`);
      return r.stdout.toString("utf-8");
    },
    git: (args) => gitText(root, [...lazy, ...args], env),
    gitPaths: (args) => gitPathList(root, [...lazy, ...args], env),
  };
}

// --- revisions -------------------------------------------------------------------------------

/** Why a `--ref` value is malformed (a usage error), or null when it may be resolved. */
export function malformedRevision(rev: string): string | null {
  if (rev.length === 0) return "the revision is empty";
  if (rev.startsWith("-")) return "a revision may not start with '-'";
  if (/[\u0000-\u001f\u007f]/.test(rev)) return "the revision contains a control character";
  if (rev.length > 1024) return "the revision is too long";
  return null;
}

export type Resolution = { ok: true; commit: string } | { ok: false; reason: string };

const REFNAME_LIKE = /^[A-Za-z0-9._/-]+$/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Resolve `rev` to exactly one commit, read-only. A name that matches more than one ref
 * (e.g. a branch and a tag), or a ref and an abbreviated object id, is ambiguous and is not
 * resolved: Git would pick one silently. Exit status AND output shape are both checked.
 */
export function resolveRevision(root: string, rev: string, policy: ObjectReadPolicy): Resolution {
  const { env, args: lazy } = policy;
  if (REFNAME_LIKE.test(rev)) {
    const candidates = [`refs/${rev}`, `refs/tags/${rev}`, `refs/heads/${rev}`, `refs/remotes/${rev}`, `refs/remotes/${rev}/HEAD`];
    const listed = gitText(root, [...lazy, "for-each-ref", "--format=%(refname)", ...candidates], env);
    if (listed === null) return { ok: false, reason: `the refs matching "${rev}" could not be listed` };
    const refs = new Set(listed.split("\n").filter((r) => candidates.includes(r)));
    if (refs.size > 1) return { ok: false, reason: `"${rev}" is ambiguous (${[...refs].sort().join(", ")}); pass a full ref name or a commit id` };
    if (refs.size === 1 && /^[0-9a-f]{4,63}$/i.test(rev)) {
      const objects = gitText(root, [...lazy, "rev-parse", "--disambiguate=" + rev.toLowerCase()], env);
      if (objects) return { ok: false, reason: `"${rev}" is ambiguous (a ref and an abbreviated object id); pass a full ref name or a full commit id` };
    }
  }
  const r = spawnSync("git", [...lazy, "rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { cwd: root, env, encoding: "utf-8" });
  if (r.error) return { ok: false, reason: `git could not be run (${r.error.message})` };
  const lines = (r.stdout ?? "").split("\n").filter((l) => l.length > 0);
  if (r.status !== 0 || lines.length !== 1 || !OBJECT_ID.test(lines[0])) {
    return { ok: false, reason: `"${rev}" does not name exactly one commit in this repository` };
  }
  return { ok: true, commit: lines[0] };
}
