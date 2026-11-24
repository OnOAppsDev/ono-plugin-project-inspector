/**
 * node-preflight.test.ts
 *
 * The Inspector's helpers are TypeScript run directly by `node`, so they need Node.js
 * 22.18+ on the 22 line, or 24+ — the same policy as the Ono Mobile Dev Plugin.
 * scripts/node-preflight.mjs is the plain-JavaScript check that runs — and explains —
 * on the Node versions that cannot run them. This suite holds:
 *
 *   P1  the version rule, at every boundary;
 *   P2  the verdict and its message: the version found, where it is, what is required;
 *   P3  the CLI contract (one JSON line on stdout, nothing on stderr, exit 0 / 1) on the
 *       running Node.js and on unsupported versions (simulated by overriding
 *       process.versions.node at startup, since a real Node 20 / 23 is not installed);
 *       that importing it runs nothing; that a missing `node` can never look like success;
 *   P4  that the file stays runnable on old Node (plain .mjs, no new syntax, no dependency);
 *   P5  that the write guard applies the same rule.
 *
 * Real Node 22.18.0 and Node 24 are exercised by the CI matrix (.github/workflows/check.yml).
 *
 * No external test framework. Run with:
 *   node --no-warnings scripts/node-preflight.test.ts
 */

import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
import { REQUIRED, isSupported, preflight } from "./node-preflight.mjs";
import { baseShims, childEnv, pathList, SH, shPath } from "./fixtures/platform.ts";

const HERE = import.meta.dirname;
const SCRIPT = join(HERE, "node-preflight.mjs");

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ""}`); }
}

/* ── P1. the version rule ─────────────────────────────────────────────────── */
{
  const UNSUPPORTED = ["18.20.8", "20.0.0", "20.19.5", "21.7.3", "22.0.0", "22.6.0", "22.12.0", "22.17.1", "23.0.0", "23.6.0", "23.11.1"];
  const SUPPORTED = ["22.18.0", "22.18.1", "22.21.1", "22.99.0", "24.0.0", "24.2.0", "25.1.0", "26.0.0", "30.0.0"];
  for (const v of UNSUPPORTED) check(`P1 Node.js ${v} is unsupported`, isSupported(v) === false);
  for (const v of SUPPORTED) check(`P1 Node.js ${v} is supported`, isSupported(v) === true);
  check("P1 boundary: 22.17.x is the last unsupported Node 22", !isSupported("22.17.99") && isSupported("22.18.0"));
  check("P1 boundary: no Node 23 release is supported, however late", !isSupported("23.99.99"));
  check("P1 boundary: 24.0.0 is supported", isSupported("24.0.0"));
  check("P1 a leading v is accepted, as in `node -v`", isSupported("v22.18.0") && !isSupported("v20.19.5"));
  check("P1 a pre-release of a supported line is supported", isSupported("24.0.0-rc.1") && isSupported("22.18.0-nightly2025"));
  for (const v of ["", "garbage", "22", "22.18", "x22.18.0"]) check(`P1 an unreadable version (${JSON.stringify(v)}) is unsupported`, isSupported(v) === false);
}

/* ── P2. the verdict and its message ──────────────────────────────────────── */
{
  const bad = preflight("v20.19.5", "/opt/node-20/bin/node");
  check("P2 unsupported: supported is false", bad.supported === false);
  check("P2 unsupported: the version is reported without the v", bad.version === "20.19.5");
  check("P2 unsupported: the resolved executable is reported", bad.execPath === "/opt/node-20/bin/node" && bad.message.includes("/opt/node-20/bin/node"));
  check("P2 unsupported: the message names the version found", bad.message.includes("v20.19.5"));
  check("P2 unsupported: the message names the minimum supported versions", bad.required === REQUIRED && bad.message.includes(REQUIRED) && /22\.18\.0/.test(REQUIRED) && /24/.test(REQUIRED));
  check("P2 unsupported: the message says what is not supported", /Node 20/.test(bad.message) && /Node 23/.test(bad.message));
  check("P2 unsupported: the message names the Inspector and says nothing was modified", /Ono Project Inspector/.test(bad.message) && /Nothing was inspected and no project files were modified/.test(bad.message));
  check("P2 unsupported: actionable — upgrade, restart, check inside Claude Code", /Upgrade/.test(bad.message) && /restart Claude Code/.test(bad.message) && bad.message.includes("`! node -v`") && bad.message.includes("`! which node`"));
  check("P2 unsupported: no install instruction for any other software", !/\bbun\b|npm i|npm install|npx|brew install|winget|curl /i.test(bad.message));
  const odd = preflight("22.17.1", "C:\\Program Files\\nodejs\\node.exe");
  check("P2 unsupported: 22.17.1 is refused with the same guidance (Windows path kept verbatim)", odd.supported === false && odd.message.includes("v22.17.1") && odd.message.includes("C:\\Program Files\\nodejs\\node.exe"));
  const good = preflight("22.18.0", "/usr/local/bin/node");
  check("P2 supported: a plain confirmation", good.supported === true && good.message === "Node.js v22.18.0 (/usr/local/bin/node) is supported.");
  check("P2 the verdict has exactly the documented fields", JSON.stringify(Object.keys(bad).sort()) === JSON.stringify(["execPath", "message", "required", "supported", "version"]));
}

/* ── P3. the CLI contract ─────────────────────────────────────────────────── */
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "inspector-preflight-")));
try {
  const run = (pre: string[] = []) => spawnSync(process.execPath, [...pre, SCRIPT], { encoding: "utf-8" });
  const parse = (s: string) => { try { return JSON.parse(s); } catch { return null; } };
  const r = run();
  const out = parse(r.stdout);
  check("P3 the CLI prints exactly one JSON line", out !== null && r.stdout.endsWith("\n") && r.stdout.trim().split("\n").length === 1, r.stdout + r.stderr);
  check("P3 the CLI reports the Node.js actually running it", out?.version === process.versions.node && out?.execPath === process.execPath, r.stdout);
  check("P3 on this (supported) Node.js it exits 0 and says supported", r.status === 0 && out?.supported === true, `${r.status} ${r.stdout}`);
  check("P3 it prints nothing on stderr", r.stderr === "", r.stderr);
  for (const v of ["20.19.5", "22.17.1", "23.11.0"]) {
    const fake = join(tmp, `fake-${v}.mjs`);
    writeFileSync(fake, `Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(v)} });\n`);
    const u = run(["--import", fake]);
    const j = parse(u.stdout);
    check(`P3 reported Node.js ${v}: exit 1, supported false, one JSON line, nothing on stderr`, u.status === 1 && j?.supported === false && j?.version === v && u.stdout.trim().split("\n").length === 1 && u.stderr === "", `${u.status} ${u.stdout} ${u.stderr}`);
  }
  const viaShell = spawnSync(SH, ["-c", `node "${shPath(SCRIPT)}"`], { encoding: "utf-8", env: childEnv(pathList(join(process.execPath, ".."), process.env.PATH ?? "")) });
  check("P3 run as `node \"<path>\"` through the shell, as the agent runs it", viaShell.status === 0 && parse(viaShell.stdout)?.supported === true, viaShell.stdout + viaShell.stderr);
  const noNode = baseShims(join(tmp, "no-node"));
  const missing = spawnSync(SH, ["-c", `node "${shPath(SCRIPT)}"`], { encoding: "utf-8", env: childEnv(pathList(noNode)) });
  check("P3 with no node on PATH the step fails (127, no JSON) — it can never read as supported", missing.status !== 0 && parse(missing.stdout) === null, `${missing.status} ${missing.stdout}`);
  const imported = spawnSync(process.execPath, ["--input-type=module", "-e", `import(${JSON.stringify(pathToFileURL(SCRIPT).href)}).then((m) => { if (typeof m.preflight !== "function") process.exit(9); })`], { encoding: "utf-8" });
  check("P3 importing it runs no check and prints nothing", imported.status === 0 && imported.stdout === "", `${imported.status} ${imported.stdout} ${imported.stderr}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

/* ── P4. runnable where the TypeScript helpers are not ────────────────────── */
{
  const src = readFileSync(SCRIPT, "utf-8");
  const code = src.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("P4 it is plain JavaScript (.mjs), not TypeScript", SCRIPT.endsWith(".mjs") && !/:\s*(string|boolean|number|any)\b|\binterface\s|\btype\s+\w+\s*=/.test(code));
  check("P4 it imports only Node built-ins", [...code.matchAll(/^import .* from "([^"]+)";$/gm)].every((m) => ["fs", "url"].includes(m[1])));
  check("P4 no syntax newer Node needs: no ?. no ?? no top-level await", !/\?\.|\?\?|^await\s/m.test(code));
  check("P4 it sets process.exitCode instead of calling process.exit", /process\.exitCode =/.test(code) && !/process\.exit\(/.test(code));
  check("P4 it does not depend on the Dev Plugin", !/mobile-dev|ono-mobile/.test(code));
}

/* ── P5. the write guard applies the same rule ────────────────────────────── */
{
  const guard = readFileSync(join(HERE, "write-guard.ts"), "utf-8");
  check("P5 write-guard.ts imports this preflight", /from "\.\/node-preflight\.mjs"/.test(guard));
  check("P5 write-guard.ts denies on an unsupported Node.js before deciding", /if \(!runtime\.supported\) decision = deny\(/.test(guard));
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
