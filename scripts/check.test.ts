/**
 * check.test.ts
 *
 * The suite runner (scripts/check.ts, 0.13.0): every outcome is counted accurately and a
 * suite that crashes — exits non-zero or is killed without printing a FAIL line — is always
 * a failed suite, reported with actionable diagnostics (exit code or signal, the error, the
 * tail of its stderr and stdout).
 *
 *   K1  a passing suite: counts, PASS verdict, no diagnostics
 *   K2  FAIL lines + exit 1: FAIL verdict, counted failures, not a crash
 *   K3  an uncaught exception after some PASS lines: CRASH, the error and stack shown
 *   K4  a silent non-zero exit: CRASH with its exit code
 *   K5  killed by a signal (POSIX) / forcibly terminated (Windows equivalent): CRASH
 *   K6  SKIP lines are counted (strict mode fails on them)
 *   K7  stderr noise from a successful suite is not a failure
 *   K8  a missing suite file is MISSING, never PASS
 *
 * No external test framework. Run with:
 *   node --no-warnings scripts/check.test.ts
 */

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runSuite, verdictOf } from "./check.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ""}`); }
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "inspector-check-")));
// Suite bodies print markers with a prefix so THIS suite's own output is not miscounted.
const suite = (name: string, body: string) => { const p = join(root, `${name}.test.ts`); writeFileSync(p, body); return p; };
const P = 'console.log("PA" + "SS  ok");';
const F = 'console.log("FA" + "IL  bad");';
const S = 'console.log("SK" + "IP  n/a");';

try {
  const ok = runSuite(suite("ok", `${P}\n${P}\n${P}\n`), "ok", root);
  check("K1 passing suite: 3 assertions, PASS, no diagnostics", ok.pass === 3 && ok.fail === 0 && verdictOf(ok) === "PASS" && !ok.crashed && ok.diagnostics.length === 0, JSON.stringify(ok));

  const failing = runSuite(suite("failing", `${P}\n${F}\n${F}\nprocess.exitCode = 1;\n`), "failing", root);
  check("K2 FAIL lines: counted, FAIL verdict, not a crash", failing.fail === 2 && failing.pass === 1 && verdictOf(failing) === "FAIL" && !failing.crashed, JSON.stringify(failing));

  const thrown = runSuite(suite("thrown", `${P}\n${P}\nthrow new Error("fixture setup exploded: git refused the path");\n`), "thrown", root);
  const td = thrown.diagnostics.join("\n");
  check("K3 an exception with no FAIL line is a CRASH (a failed suite)", thrown.crashed && verdictOf(thrown) === "CRASH" && thrown.pass === 2 && thrown.fail === 0, JSON.stringify(thrown));
  check("K3 diagnostics show the exit code, the error and its stack", /exit code 1/.test(td) && /crashed/.test(td) && /fixture setup exploded: git refused the path/.test(td) && /thrown\.test\.ts/.test(td), td);
  check("K3 diagnostics include the stdout tail", /stdout \(last lines\)/.test(td) && /PASS  ok/.test(td));

  const silent = runSuite(suite("silent", `${P}\nprocess.exit(7);\n`), "silent", root);
  check("K4 a silent non-zero exit is a CRASH with its exit code", silent.crashed && silent.exitCode === 7 && verdictOf(silent) === "CRASH" && /exit code 7/.test(silent.diagnostics.join("\n")), JSON.stringify(silent));

  if (process.platform !== "win32") {
    const killed = runSuite(suite("killed", `${P}\nprocess.kill(process.pid, "SIGKILL");\n`), "killed", root);
    check("K5 a suite killed by a signal is a CRASH naming the signal", killed.crashed && killed.signal === "SIGKILL" && verdictOf(killed) === "CRASH" && killed.exitCode !== 0 && /terminated by SIGKILL/.test(killed.diagnostics.join("\n")), JSON.stringify(killed));
  } else {
    // Windows has no POSIX signals: a forced self-termination is the equivalent.
    const killed = runSuite(suite("killed", `${P}\nprocess.kill(process.pid);\n`), "killed", root);
    check("K5 a forcibly terminated suite is a CRASH (Windows)", killed.crashed && verdictOf(killed) === "CRASH" && killed.exitCode !== 0, JSON.stringify(killed));
  }

  const skipped = runSuite(suite("skipped", `${P}\n${S}\n${S}\n`), "skipped", root);
  check("K6 SKIP lines are counted; the suite itself passed", skipped.skip === 2 && skipped.pass === 1 && verdictOf(skipped) === "PASS", JSON.stringify(skipped));

  const noisy = runSuite(suite("noisy", `${P}\nconsole.error("a warning on stderr");\n`), "noisy", root);
  check("K7 stderr from a successful suite is not a failure", verdictOf(noisy) === "PASS" && !noisy.crashed && noisy.diagnostics.length === 0);

  const missing = runSuite(join(root, "absent.test.ts"), "absent", root);
  check("K8 a missing suite file is MISSING, never PASS", missing.missing && verdictOf(missing) === "MISSING" && missing.exitCode !== 0);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
