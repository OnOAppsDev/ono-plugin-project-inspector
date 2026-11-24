/**
 * entrypoint.ts — CLI plumbing shared by every Inspector helper (0.12.0).
 *
 * 1. isEntryPoint(import.meta.url): "is this module the script Node was asked to run?"
 *
 *    Every helper is both a CLI and a library (tests and other helpers import it), so
 *    each one runs its `main()` only when it is the entry point. Under Node.js that
 *    cannot be answered with `import.meta.main` (missing on Node 22, and `false` for
 *    type-stripped `.ts` files on the Node 24 release tried) or with
 *    `require.main === module` (undefined in an ES module): both made helpers exit 0
 *    silently without doing anything. This compares the real path of the script Node
 *    was started with (`process.argv[1]`) with the real path of the calling module.
 *
 *    Both sides go through realpathSync, so a symlinked plugin install, a relative
 *    invocation, `..` segments, spaces and Unicode all compare equal. On Windows the
 *    comparison ignores case, because drive letters and NTFS paths are
 *    case-insensitive (`c:\…` and `C:\…` are the same file).
 *
 *    Anything that cannot be resolved answers false. For the write guard that still
 *    fails closed: no `main()` means no ALLOW response, and the hook wrapper denies.
 *
 * 2. useBlockingOutput(): make console.log / console.error write completely before
 *    they return.
 *
 *    The helpers print one result and then call `process.exit()`. On a pipe — how
 *    Claude Code's Bash tool and the hook read them — Node writes process.stdout
 *    asynchronously on macOS, and `process.exit()` drops whatever is still queued, so
 *    output past the pipe buffer (64 KiB) arrives cut off and is no longer JSON. Bun
 *    did not behave that way. Writing straight to the file descriptor keeps output,
 *    exit codes and control flow exactly as they were. It is installed only when a
 *    helper runs as a CLI, never when it is imported.
 *
 * Runtime: Node.js 22.18+ on the 22 line, or 24+ (scripts/node-preflight.mjs).
 * No dependencies.
 */

import { realpathSync, writeSync } from "fs";
import { fileURLToPath } from "url";
import { format } from "util";

export function isEntryPoint(moduleUrl: string): boolean {
  const started = process.argv[1];
  if (!started) return false;
  try {
    const a = realpathSync(started);
    const b = realpathSync(fileURLToPath(moduleUrl));
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

const pause = new Int32Array(new SharedArrayBuffer(4));

/** Writes all of `text` to `fd` before returning. A reader that went away (EPIPE) ends the write. */
export function writeAll(fd: number, text: string): void {
  const bytes = Buffer.from(text, "utf-8");
  let offset = 0;
  while (offset < bytes.length) {
    try {
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") {
        Atomics.wait(pause, 0, 0, 1); // a full non-blocking pipe: wait for the reader to drain it
        continue;
      }
      if (code === "EPIPE") return;
      throw e;
    }
  }
}

/** Route console.log to fd 1 and console.error to fd 2, synchronously and completely. */
export function useBlockingOutput(): void {
  console.log = (...args: unknown[]) => writeAll(1, format(...args) + "\n");
  console.error = (...args: unknown[]) => writeAll(2, format(...args) + "\n");
}
