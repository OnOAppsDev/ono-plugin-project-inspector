/**
 * check.ts — the entry point for the Inspector's deterministic test suites (0.12.0).
 *
 *   node scripts/check.ts            run every suite, from the repository root
 *   node scripts/check.ts --strict   same, but any skipped assertion is a FAILURE
 *   node scripts/check.ts --only ts  run suites whose name contains "ts"
 *
 * Modeled on the Ono Mobile Dev Plugin's aggregator (same report shape and --strict
 * semantics); the Inspector keeps its own copy so the plugins stay independent.
 *
 * This is an aggregator, not a test framework. Every suite owns its assertions,
 * prints `PASS `/`FAIL `/`SKIP ` lines and exits non-zero on failure; this script
 * spawns each one with `node --no-warnings`, adds up the lines and reports. Suites
 * are registered explicitly, in foundational-to-integration order, so the topmost
 * failure is the root cause; an unregistered `*.test.ts` on disk is a failure.
 *
 * SKIP is never folded into PASS. A suite skips an assertion only when the OS lacks
 * the feature it needs (for example, symbolic links without privilege on Windows);
 * `--strict` — what CI runs — turns any skip into a failed run.
 *
 * live-smoke.ts is deliberately NOT a suite: it drives a real, paid Claude Code session.
 */

import { spawnSync } from "child_process";
import { existsSync, readdirSync } from "fs";
import { dirname, join } from "path";
import { isEntryPoint } from "./entrypoint.ts";

const HERE = import.meta.dirname;
const REPO_ROOT = dirname(HERE);

interface Phase { name: string; why: string; suites: string[] }

const PHASES: Phase[] = [
  { name: "Runtime", why: "Node.js version policy, helper entry points and the suite runner", suites: ["node-preflight", "entrypoint", "check"] },
  {
    name: "Helpers",
    why: "the deterministic code the workflow calls",
    suites: [
      "knowledge-model", "inspection-state", "repo-knowledge", "knowledge-evidence", "knowledge-refresh-guard", "resolve-repo-root", "work-branch",
      "git-paths", "freshness-contract", "doc-header", "audit-recheck", "session-cost",
      "line-endings", "document-preservation", "audit-line-endings", "freshness-ref",
    ],
  },
  { name: "Safety", why: "the hook that gates every Inspector write", suites: ["write-guard"] },
  { name: "Contracts", why: "instructions and code cannot drift apart", suites: ["agent-contract", "knowledge-templates"] },
  { name: "Integration", why: "full pipelines, repositories inspected by 0.11.x, and the documented CRLF recovery", suites: ["e2e-smoke", "compat-0.11", "recovery"] },
];

const NOT_PROVEN = [
  "that the agent, skills and commands behave correctly when Claude runs them — prose, executed by Claude",
  "a live Claude Code session (scripts/live-smoke.ts is a separate, paid, on-demand run)",
];

export interface SuiteResult {
  suite: string; pass: number; fail: number; skip: number; exitCode: number; failLines: string[]; skipLines: string[]; missing: boolean;
  /** The terminating signal, when the suite was killed. */
  signal: string | null;
  /** True when the suite ended unsuccessfully without reporting a FAIL line: it crashed or was killed. */
  crashed: boolean;
  /** For a failed or crashed suite: why, from the process itself (spawn error, signal, stderr / stdout tail). */
  diagnostics: string[];
}

const tail = (text: string, n: number) => text.split(/\r?\n/).filter((l) => l.trim() !== "").slice(-n);

/** Run one suite file with `node --no-warnings` and count its PASS / FAIL / SKIP lines. */
export function runSuite(path: string, suite: string, cwd = REPO_ROOT): SuiteResult {
  const empty: SuiteResult = { suite, pass: 0, fail: 0, skip: 0, exitCode: 0, failLines: [], skipLines: [], missing: false, signal: null, crashed: false, diagnostics: [] };
  if (!existsSync(path)) return { ...empty, missing: true, exitCode: 1, diagnostics: [`suite file not found: ${path}`] };
  const proc = spawnSync(process.execPath, ["--no-warnings", path], { encoding: "utf-8", cwd, maxBuffer: 64 * 1024 * 1024 });
  const stdout = proc.stdout ?? "", stderr = proc.stderr ?? "";
  const lines = `${stdout}\n${stderr}`.split(/\r?\n/);
  const fail = lines.filter((l) => l.startsWith("FAIL ")).length;
  const exitCode = proc.status ?? 1;
  const signal = proc.signal ?? null;
  const unsuccessful = exitCode !== 0 || signal !== null || proc.error !== undefined;
  const crashed = unsuccessful && fail === 0;
  const diagnostics: string[] = [];
  if (unsuccessful) {
    diagnostics.push(`exit code ${proc.status === null ? "none" : proc.status}${signal ? `, terminated by ${signal}` : ""}${crashed ? " — ended without a FAIL line (crashed)" : ""}`);
    if (proc.error) diagnostics.push(`spawn error: ${proc.error.message}`);
    const err = tail(stderr, 30);
    if (err.length) diagnostics.push("stderr (last lines):", ...err.map((l) => `  ${l}`));
    if (crashed) {
      const out = tail(stdout, 10);
      if (out.length) diagnostics.push("stdout (last lines):", ...out.map((l) => `  ${l}`));
    }
  }
  return {
    suite,
    pass: lines.filter((l) => l.startsWith("PASS ")).length,
    fail,
    skip: lines.filter((l) => l.startsWith("SKIP ")).length,
    exitCode: signal !== null && exitCode === 0 ? 1 : exitCode,
    failLines: lines.filter((l) => l.startsWith("FAIL ")),
    skipLines: lines.filter((l) => l.startsWith("SKIP ")),
    missing: false,
    signal,
    crashed,
    diagnostics,
  };
}

/** PASS only when the suite exited 0, unsignalled, with no FAIL line. A crash is always a failure. */
export function verdictOf(r: SuiteResult): "PASS" | "FAIL" | "CRASH" | "MISSING" {
  if (r.missing) return "MISSING";
  if (r.crashed) return "CRASH";
  return r.fail > 0 || r.exitCode !== 0 || r.signal !== null ? "FAIL" : "PASS";
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));

function main(): void {
  const onlyIdx = process.argv.indexOf("--only");
  const only = onlyIdx === -1 ? null : process.argv[onlyIdx + 1];
  const strict = process.argv.includes("--strict");

  const registered = PHASES.flatMap((p) => p.suites);
  const onDisk = readdirSync(HERE).filter((f) => f.endsWith(".test.ts")).map((f) => f.replace(/\.test\.ts$/, ""));
  const unregistered = onDisk.filter((s) => !registered.includes(s));

  console.log("ono-project-inspector · deterministic check");
  console.log(`node scripts/check.ts${strict ? " --strict" : ""}${only ? ` --only ${only}` : ""}`);
  console.log(`Node.js ${process.version} (${process.execPath}) on ${process.platform}`);

  const results: SuiteResult[] = [];
  for (const phase of PHASES) {
    const suites = phase.suites.filter((s) => only === null || s.includes(only));
    if (suites.length === 0) continue;
    console.log(`\nPhase ${PHASES.indexOf(phase) + 1} · ${phase.name} — ${phase.why}`);
    for (const suite of suites) {
      const r = runSuite(join(HERE, `${suite}.test.ts`), suite);
      results.push(r);
      if (r.missing) { console.log(`  ${pad("MISSING", 7)} ${pad(suite, 26)} suite file not found`); continue; }
      const verdict = verdictOf(r);
      console.log(`  ${pad(verdict, 7)} ${pad(suite, 26)} ${String(r.pass).padStart(4, " ")} assertions${r.skip > 0 ? `, ${r.skip} skipped` : ""}`);
      for (const line of [...r.failLines, ...r.skipLines]) console.log(`          ${line}`);
      for (const line of r.diagnostics) console.log(`          ${line}`);
    }
  }

  const totalPass = results.reduce((n, r) => n + r.pass, 0);
  const totalFail = results.reduce((n, r) => n + r.fail, 0);
  const totalSkip = results.reduce((n, r) => n + r.skip, 0);
  const missing = results.filter((r) => r.missing);
  const broken = results.filter((r) => verdictOf(r) === "FAIL" || verdictOf(r) === "CRASH");
  const crashedCount = results.filter((r) => r.crashed).length;
  const ran = results.length - missing.length;

  console.log(`\n${"─".repeat(63)}`);
  console.log(`${ran} suites · ${totalPass} assertions · ${totalFail} failures · ${totalSkip} skipped${crashedCount ? ` · ${crashedCount} suite(s) crashed` : ""}`);

  if (unregistered.length > 0) {
    console.log(`\nUNREGISTERED suite(s) on disk, not run: ${unregistered.join(", ")}`);
    console.log("Add them to a phase in scripts/check.ts — a suite nobody runs is a suite nobody trusts.");
  }
  const emptyRun = results.length === 0;
  if (emptyRun) console.log(only === null ? "No suites are registered." : `No suite name contains "${only}". Registered: ${registered.join(", ")}`);

  const incomplete = totalSkip > 0;
  const failed = broken.length > 0 || missing.length > 0 || unregistered.length > 0 || emptyRun || (strict && incomplete);
  if (failed) {
    const names = [...broken.map((r) => `${r.suite} (${r.crashed ? `crashed: ${r.signal ?? "exit " + r.exitCode}` : r.fail || "exit " + r.exitCode})`), ...missing.map((r) => `${r.suite} (missing)`)];
    if (strict && incomplete) names.push(`--strict: run incomplete (${totalSkip} skipped assertion(s))`);
    if (names.length > 0) console.log(`FAILED: ${names.join(", ")}`);
  } else if (incomplete) {
    console.log("All suites passed, but the run was INCOMPLETE — see the skipped assertions above. Re-run with --strict to fail on skips.");
  } else {
    console.log(`All suites passed.${strict ? " Nothing was skipped." : ""}`);
  }

  console.log("\nNOT covered by this run:");
  for (const item of NOT_PROVEN) console.log(`  ${item}`);
  process.exitCode = failed ? 1 : 0;
}

if (isEntryPoint(import.meta.url)) main();
