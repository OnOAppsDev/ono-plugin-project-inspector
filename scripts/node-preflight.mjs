#!/usr/bin/env node
/**
 * node-preflight.mjs — can the Node.js running this run the Ono Project Inspector's helpers?
 *
 *   node "<PLUGIN_ROOT>/scripts/node-preflight.mjs"
 *
 * Prints exactly one line of JSON on stdout —
 *   { "supported": boolean, "version": "22.18.0", "execPath": "<node path>",
 *     "required": "<policy text>", "message": "<one-paragraph explanation>" }
 * — and exits 0 when supported, 1 when not. Nothing is printed on stderr.
 *
 * The Inspector's helpers are TypeScript files run directly by `node`, which needs
 * built-in type stripping without a flag: Node 22.18+ on the 22 line, or Node 24+. Node 20,
 * earlier Node 22 releases and every Node 23 release are unsupported. This is the same
 * version policy as the Ono Mobile Dev Plugin; the Inspector carries its own copy so it
 * stays independently installable (no runtime dependency between the plugins).
 *
 * The Inspector's write guard applies the same rule (scripts/write-guard.ts), so an Inspector
 * write is never authorized by an unsupported Node.js.
 *
 * This file is plain JavaScript on purpose: it must run, and explain, on exactly the Node
 * versions that cannot run the TypeScript helpers. Keep it dependency-free and keep its
 * syntax old (no optional chaining, no `??`, no top-level await), so a very old Node still
 * reaches the message instead of a syntax error.
 */
import { realpathSync } from "fs";
import { fileURLToPath } from "url";

export const REQUIRED = "Node.js 22.18.0 or later on Node 22, or Node.js 24 or later";

/** Whether `version` ("22.18.0" or "v22.18.0") can run the Inspector's TypeScript helpers. */
export function isSupported(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version));
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major >= 24) return true;
  return major === 22 && minor >= 18;
}

/** The preflight verdict for a Node version and the executable that reported it. */
export function preflight(version, execPath) {
  const v = String(version).replace(/^v/, "");
  const supported = isSupported(v);
  const message = supported
    ? "Node.js v" + v + " (" + execPath + ") is supported."
    : "Unsupported Node.js v" + v + " (" + execPath + "). The Ono Project Inspector's helpers need " +
      REQUIRED + "; Node 20, earlier Node 22 releases and all Node 23 releases cannot run them. " +
      "Nothing was inspected and no project files were modified. " +
      "Upgrade the Node.js that Claude Code uses, then restart Claude Code. It can differ from the one " +
      "in your terminal: check it inside Claude Code with `! node -v` and `! which node`.";
  return { supported: supported, version: v, execPath: execPath, required: REQUIRED, message: message };
}

function invokedDirectly() {
  try {
    var a = realpathSync(process.argv[1]);
    var b = realpathSync(fileURLToPath(import.meta.url));
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch (e) {
    return false;
  }
}

if (invokedDirectly()) {
  const verdict = preflight(process.versions.node, process.execPath);
  console.log(JSON.stringify(verdict));
  process.exitCode = verdict.supported ? 0 : 1;
}
