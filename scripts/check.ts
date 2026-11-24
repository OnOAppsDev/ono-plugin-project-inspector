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

const HERE = import.meta.dirname;
const REPO_ROOT = dirname(HERE);

interface Phase { name: string; why: string; suites: string[] }

const PHASES: Phase[] = [
  { name: "Runtime", why: "Node.js version policy and helper entry points", suites: ["node-preflight", "entrypoint"] },
  {
    name: "Helpers",
    why: "the deterministic code the workflow calls",
    suites: [
      "knowledge-model", "inspection-state", "repo-knowledge", "knowledge-evidence", "knowledge-refresh-guard", "resolve-repo-root", "work-branch",
      "git-paths", "freshness-contract", "doc-header", "audit-recheck", "session-cost",
    ],
  },
  { name: "Safety", why: "the hook that gates every Inspector write", suites: ["write-guard"] },
  { name: "Contracts", why: "instructions and code cannot drift apart", suites: ["agent-contract", "knowledge-templates"] },
  { name: "Integration", why: "full pipelines, and repositories inspected by 0.11.x", suites: ["e2e-smoke", "compat-0.11"] },
];

const NOT_PROVEN = [
  "that the agent, skills and commands behave correctly when Claude runs them — prose, executed by Claude",
  "a live Claude Code session (scripts/live-smoke.ts is a separate, paid, on-demand run)",
];

interface SuiteResult {
  suite: string; pass: number; fail: number; skip: number; exitCode: number; failLines: string[]; skipLines: string[]; missing: boolean;
}

function runSuite(suite: string): SuiteResult {
  const path = join(HERE, `${suite}.test.ts`);
  const empty: SuiteResult = { suite, pass: 0, fail: 0, skip: 0, exitCode: 0, failLines: [], skipLines: [], missing: false };
  if (!existsSync(path)) return { ...empty, missing: true, exitCode: 1 };
  const proc = spawnSync(process.execPath, ["--no-warnings", path], { encoding: "utf-8", cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 });
  const lines = `${proc.stdout ?? ""}${proc.stderr ?? ""}`.split(/\r?\n/);
  return {
    suite,
    pass: lines.filter((l) => l.startsWith("PASS ")).length,
    fail: lines.filter((l) => l.startsWith("FAIL ")).length,
    skip: lines.filter((l) => l.startsWith("SKIP ")).length,
    exitCode: proc.status ?? 1,
    failLines: lines.filter((l) => l.startsWith("FAIL ")),
    skipLines: lines.filter((l) => l.startsWith("SKIP ")),
    missing: false,
  };
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
      const r = runSuite(suite);
      results.push(r);
      if (r.missing) { console.log(`  ${pad("MISSING", 7)} ${pad(suite, 26)} suite file not found`); continue; }
      const verdict = r.fail > 0 || r.exitCode !== 0 ? "FAIL" : "PASS";
      console.log(`  ${pad(verdict, 7)} ${pad(suite, 26)} ${String(r.pass).padStart(4, " ")} assertions${r.skip > 0 ? `, ${r.skip} skipped` : ""}`);
      for (const line of [...r.failLines, ...r.skipLines]) console.log(`          ${line}`);
      if (r.exitCode !== 0 && r.fail === 0) console.log(`          exited ${r.exitCode} without a FAIL line`);
    }
  }

  const totalPass = results.reduce((n, r) => n + r.pass, 0);
  const totalFail = results.reduce((n, r) => n + r.fail, 0);
  const totalSkip = results.reduce((n, r) => n + r.skip, 0);
  const missing = results.filter((r) => r.missing);
  const broken = results.filter((r) => !r.missing && (r.fail > 0 || r.exitCode !== 0));
  const ran = results.length - missing.length;

  console.log(`\n${"─".repeat(63)}`);
  console.log(`${ran} suites · ${totalPass} assertions · ${totalFail} failures · ${totalSkip} skipped`);

  if (unregistered.length > 0) {
    console.log(`\nUNREGISTERED suite(s) on disk, not run: ${unregistered.join(", ")}`);
    console.log("Add them to a phase in scripts/check.ts — a suite nobody runs is a suite nobody trusts.");
  }
  const emptyRun = results.length === 0;
  if (emptyRun) console.log(only === null ? "No suites are registered." : `No suite name contains "${only}". Registered: ${registered.join(", ")}`);

  const incomplete = totalSkip > 0;
  const failed = broken.length > 0 || missing.length > 0 || unregistered.length > 0 || emptyRun || (strict && incomplete);
  if (failed) {
    const names = [...broken.map((r) => `${r.suite} (${r.fail || "exit " + r.exitCode})`), ...missing.map((r) => `${r.suite} (missing)`)];
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

main();
