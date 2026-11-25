/**
 * fixtures/line-endings.ts — CRLF fixtures for the 0.14.0 line-ending suites.
 *
 * Every CRLF fixture is produced at test time with explicit "\r\n" bytes, never committed
 * to this plugin, so the plugin's own `.gitattributes` (`* text=auto eol=lf`) cannot
 * normalize it away. The employee scenario is reproduced the way it happens: an origin
 * repository with LF blobs and NO .gitattributes, cloned with `core.autocrlf=true` set in
 * the clone's own config (never the global one), so Git itself writes CRLF working files.
 * `checkout()` proves those conditions instead of assuming them.
 */

import { execFileSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export const GIT_ID: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Inspector Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Inspector Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

/** git with an explicit line-ending policy for this one call (never global config). */
export function gitEol(cwd: string, autocrlf: "true" | "false", ...args: string[]): string {
  return execFileSync("git", ["-c", `core.autocrlf=${autocrlf}`, "-c", "core.safecrlf=false", "-c", "commit.gpgsign=false", ...args], {
    cwd, env: GIT_ID, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
  }).replace(/\n$/, "");
}

/** Every line ending of `text` as CRLF (LF and CRLF input alike). */
export const crlf = (text: string): string => text.replace(/\r?\n/g, "\r\n");
/** Every line ending of `text` as LF. */
export const lf = (text: string): string => text.replace(/\r\n/g, "\n");

/** Rewrite a file of `dir` with CRLF (or LF) endings, in place. */
export function rewriteEol(dir: string, rel: string, to: "crlf" | "lf"): void {
  const p = join(dir, rel);
  const t = readFileSync(p, "utf-8");
  writeFileSync(p, to === "crlf" ? crlf(t) : lf(t));
}

/** Counts of CRLF and bare-LF line endings in a file (byte level). */
export function eolCounts(path: string): { crlf: number; bareLf: number } {
  const t = readFileSync(path, "latin1");
  return { crlf: (t.match(/\r\n/g) ?? []).length, bareLf: (t.match(/(?<!\r)\n/g) ?? []).length };
}

/** An origin repository: commits the files of `dir` with LF blobs on `branch`, no .gitattributes. */
export function commitOrigin(dir: string, branch: string, message = "origin"): string {
  if (existsSync(join(dir, ".gitattributes"))) throw new Error("fixture: the origin must not carry .gitattributes");
  gitEol(dir, "false", "init", "-q", "-b", branch);
  gitEol(dir, "false", "add", "-A");
  gitEol(dir, "false", "commit", "-q", "-m", message);
  return gitEol(dir, "false", "rev-parse", "HEAD");
}

export interface Checkout { dir: string; crlfInWorktree: boolean; lfInBlob: boolean; clean: boolean; localAutocrlf: string }

/**
 * Clone `origin` into `dest` with core.autocrlf=true in the clone's own config, optionally
 * switching to a new branch. Returns the evidence that the checkout really is the employee
 * scenario for `probe` (a Markdown file): CRLF on disk, LF in the blob, a clean status.
 */
export function employeeClone(origin: string, dest: string, probe = "CLAUDE.md", newBranch?: string): Checkout {
  execFileSync("git", ["-c", "core.autocrlf=true", "clone", "-q", "-c", "core.autocrlf=true", "--no-hardlinks", origin, dest], { env: GIT_ID, stdio: ["ignore", "pipe", "pipe"] });
  if (newBranch) gitEol(dest, "true", "switch", "-q", "-c", newBranch);
  return checkout(dest, probe);
}

/** Clone `origin` into `dest` with core.autocrlf=false (an LF checkout, as on macOS / Linux). */
export function lfClone(origin: string, dest: string): void {
  execFileSync("git", ["-c", "core.autocrlf=false", "clone", "-q", "-c", "core.autocrlf=false", "--no-hardlinks", origin, dest], { env: GIT_ID, stdio: ["ignore", "pipe", "pipe"] });
}

export function checkout(dir: string, probe: string): Checkout {
  const blob = execFileSync("git", ["cat-file", "blob", `HEAD:${probe}`], { cwd: dir });
  return {
    dir,
    crlfInWorktree: readFileSync(join(dir, probe), "latin1").includes("\r\n"),
    lfInBlob: !blob.includes(0x0d),
    clean: gitEol(dir, "true", "status", "--porcelain") === "",
    localAutocrlf: gitEol(dir, "true", "config", "--local", "--get", "core.autocrlf"),
  };
}
