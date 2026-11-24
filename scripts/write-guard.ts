/**
 * write-guard.ts — decision logic of the Inspector write guard (0.11.3; Node.js since 0.12.0).
 *
 * Invoked by scripts/write-guard.sh (the PreToolUse hook registered in
 * hooks/hooks.json for Write|Edit|MultiEdit|NotebookEdit) only after the raw
 * hook input names the Inspector in its `agent_type` metadata. It reads the
 * hook input JSON on stdin and:
 *
 *   allow - prints exactly ALLOW_RESPONSE plus one newline on stdout, and
 *           nothing else, and exits 0: not the Inspector agent after all, or
 *           the target is on an ordinary working branch, or outside any Git
 *           repository
 *   deny  - prints nothing on stdout, the reason on stderr, and exits 2: an
 *           Inspector write while the target's repository is on main, master,
 *           a detached HEAD, or a branch that cannot be determined; malformed
 *           input; no resolvable target; an unsupported Node.js; any error
 *
 * The wrapper authorizes a write ONLY on exit 0 together with stdout equal to
 * ALLOW_RESPONSE + "\n", byte for byte. Exit 0 alone is never authorization:
 * a helper that silently did nothing (the `import.meta.main` defect found in the
 * 0.12.0 migration) exits 0 with empty stdout, and that is a deny. Nothing is
 * written, and the developer is never asked.
 */

import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "fs";
import { dirname, isAbsolute, resolve } from "path";
import { branchState, refusalMessage } from "./work-branch.ts";
import { isEntryPoint, writeAll } from "./entrypoint.ts";
import { preflight } from "./node-preflight.mjs";

/**
 * The one response that authorizes an Inspector write. scripts/write-guard.sh
 * compares stdout with exactly this line; keep the two in sync (write-guard.test.ts
 * holds them to each other).
 */
export const ALLOW_RESPONSE = "ONO-INSPECTOR-WRITE-GUARD:ALLOW";

/**
 * The `agent_type` Claude Code reports for this plugin's agent: the
 * plugin-scoped name `<plugin>:<agent>`, observed live with Claude Code
 * 2.1.325. A bare `project-inspector` is NOT accepted — that would be some
 * other, unrelated agent with the same short name.
 */
export const INSPECTOR_AGENT_TYPES: readonly string[] = ["ono-project-inspector:project-inspector"];

export const GUARDED_TOOLS: readonly string[] = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

export type Decision = { allow: true; reason: string } | { allow: false; reason: string };

const deny = (reason: string): Decision => ({ allow: false, reason });
const allow = (reason: string): Decision => ({ allow: true, reason });

/** The directory whose repository the write lands in, with symlinks resolved; null if it cannot be established. */
export function targetDirectory(target: string): string | null {
  let probe = target;
  try {
    if (existsSync(probe) || isSymlink(probe)) {
      // An existing target (or a symlink to one): resolve to where the write really lands.
      const real = realpathSync(probe); // throws for a dangling symlink
      return statSync(real).isDirectory() ? real : dirname(real);
    }
    // A new file: the nearest existing ancestor directory decides.
    for (;;) {
      const parent = dirname(probe);
      if (parent === probe) return null;
      probe = parent;
      if (isSymlink(probe) && !existsSync(probe)) return null; // dangling symlink on the way up
      if (existsSync(probe)) {
        const real = realpathSync(probe);
        return statSync(real).isDirectory() ? real : null;
      }
    }
  } catch {
    return null;
  }
}

function isSymlink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

export function decide(input: unknown): Decision {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return deny("the hook input for an Inspector call is not a JSON object");
  }
  const p = input as Record<string, any>;
  if (!INSPECTOR_AGENT_TYPES.includes(p.agent_type)) {
    return allow(`not the Inspector agent (agent_type ${JSON.stringify(p.agent_type ?? null)})`);
  }
  const tool = typeof p.tool_name === "string" ? p.tool_name : "";
  if (!GUARDED_TOOLS.includes(tool)) {
    // Registered only for these tools; anything else from the Inspector is not a file edit we can place.
    return deny(`unexpected tool ${JSON.stringify(p.tool_name ?? null)} for the Inspector write guard`);
  }
  const ti = p.tool_input && typeof p.tool_input === "object" ? p.tool_input : {};
  const raw = typeof ti.file_path === "string" ? ti.file_path : typeof ti.notebook_path === "string" ? ti.notebook_path : "";
  if (!raw) return deny(`${tool} has no target path in its input`);
  let abs = raw;
  if (!isAbsolute(raw)) {
    if (typeof p.cwd !== "string" || !isAbsolute(p.cwd)) return deny(`${tool} target ${raw} is relative and the hook input has no absolute cwd`);
    abs = resolve(p.cwd, raw);
  }
  const dir = targetDirectory(abs);
  if (!dir) return deny(`the repository of ${abs} could not be determined (dangling symlink or no existing parent)`);
  const state = branchState(dir);
  if (!state.isGit) return allow(`${abs} is outside any Git repository`);
  if (state.protected) return deny(refusalMessage(state, `${tool} of ${abs} by the Inspector agent`));
  return allow(`${abs} is on the working branch '${state.branch}'`);
}

function main(): void {
  let decision: Decision | undefined;
  try {
    // An unsupported Node.js never authorizes an Inspector write, even one that can parse this file (Node 23).
    const runtime = preflight(process.versions.node, process.execPath);
    if (!runtime.supported) decision = deny(runtime.message.replace(/\.$/, ""));
    let input: unknown;
    try {
      input = JSON.parse(readFileSync(0, "utf-8"));
    } catch (err) {
      input = undefined;
      decision ??= deny(`the hook input for an Inspector call is not valid JSON (${(err as Error).message})`);
    }
    decision ??= decide(input);
  } catch (err) {
    decision = deny(`the Inspector write guard failed: ${(err as Error).message}`);
  }
  if (decision!.allow) {
    // Written synchronously and completely: the wrapper reads stdout to decide.
    writeAll(1, ALLOW_RESPONSE + "\n");
    process.exitCode = 0;
    return;
  }
  const reason = decision!.reason;
  writeAll(2, (reason.startsWith("REFUSED") ? reason : `REFUSED: ${reason}. The write was blocked; nothing was written.`) + "\n");
  process.exit(2);
}

if (isEntryPoint(import.meta.url)) main();
