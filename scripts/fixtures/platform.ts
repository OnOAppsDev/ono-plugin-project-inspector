/**
 * fixtures/platform.ts — portable process helpers for the test suites (0.12.0).
 *
 * The suites run on macOS, Linux and Windows (Git Bash). These helpers keep the
 * platform differences in one place:
 *
 *   SH            the POSIX shell that runs the hook: /bin/sh, or Git Bash's `sh`
 *                 found on PATH on Windows.
 *   pathList      a PATH value with the platform's delimiter (":" or ";").
 *   childEnv      a minimal child environment: PATH plus the variables Windows
 *                 needs to start processes at all (SYSTEMROOT, …). Nothing else
 *                 leaks in, so a test controls exactly which tools are visible.
 *   realTool      the absolute path of a tool as the shell sees it.
 *   makeShims     a directory of tiny `#!/bin/sh` launcher scripts — the portable
 *                 replacement for symlinking system tools into a fake bin
 *                 directory (Windows needs privileges for symlinks, and an .exe
 *                 copied away from Git's DLLs does not start).
 *   linkOrJunction  a symbolic link; on Windows a directory link falls back to a
 *                 junction (no privilege needed). Returns false if neither works,
 *                 so callers report SKIP explicitly instead of silently passing.
 */

import { execFileSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "fs";
import { delimiter, join } from "path";

export const IS_WINDOWS = process.platform === "win32";

/**
 * The shell that runs hook scripts, as Claude Code does (`sh "<plugin>/scripts/…"`).
 * On Windows it is Git Bash's sh.exe, resolved to an absolute path once from the
 * parent's PATH: a test then gives the child a PATH without sh's directory (only
 * shims) and Windows would otherwise look `sh` up in that child PATH and not find it.
 */
export const SH = IS_WINDOWS ? findOnPath(["sh.exe", "sh"]) ?? "sh" : "/bin/sh";

function findOnPath(names: string[]): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const n of names) if (dir && existsSync(join(dir, n))) return join(dir, n);
  }
  return null;
}

export const pathList = (...dirs: string[]): string => dirs.filter(Boolean).join(delimiter);

/** Inside a `#!/bin/sh` script, a Windows path is safest with forward slashes (C:/…). */
export const shPath = (p: string): string => (IS_WINDOWS ? p.replace(/\\/g, "/") : p);

const WINDOWS_ESSENTIALS = ["SYSTEMROOT", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "MSYSTEM"];

/** A minimal environment for a child process: PATH, plus what Windows needs to start processes. */
export function childEnv(path: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: path };
  if (IS_WINDOWS) for (const k of WINDOWS_ESSENTIALS) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, ...extra };
}

/** Where the shell finds `cmd` (e.g. /usr/bin/grep, or /usr/bin/grep inside Git Bash). */
export function realTool(cmd: string): string {
  return execFileSync(SH, ["-c", `command -v ${cmd}`], { encoding: "utf-8" }).trim();
}

/**
 * Creates `dir` with one launcher per entry: a string value is a real executable to
 * exec with all arguments; an object value is a literal shell body.
 */
export function makeShims(dir: string, tools: Record<string, string | { body: string }>): string {
  mkdirSync(dir, { recursive: true });
  for (const [name, spec] of Object.entries(tools)) {
    const body = typeof spec === "string" ? `exec "${shPath(spec)}" "$@"` : spec.body;
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  }
  return dir;
}

/** The tools write-guard.sh itself needs besides node: cat, grep, dirname (git is node's). */
export function baseShims(dir: string, opts: { git?: boolean } = {}): string {
  const tools: Record<string, string> = { cat: realTool("cat"), grep: realTool("grep"), dirname: realTool("dirname") };
  if (opts.git) tools.git = realTool("git");
  return makeShims(dir, tools);
}

/** symlinkSync, with a junction fallback for directories on Windows. False if no link could be made. */
export function linkOrJunction(target: string, link: string, kind: "file" | "dir"): boolean {
  try {
    symlinkSync(target, link, kind);
    return true;
  } catch {
    if (IS_WINDOWS && kind === "dir") {
      try {
        symlinkSync(target, link, "junction");
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}
