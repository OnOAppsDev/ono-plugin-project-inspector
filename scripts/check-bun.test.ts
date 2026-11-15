/**
 * check-bun.test.ts
 *
 * Regression tests for the Bun preflight (scripts/check-bun.sh, 0.11.2).
 * Runs the real POSIX script under /bin/sh with a controlled PATH, so the
 * "Bun missing" case does not depend on where Bun is installed on this machine.
 *
 * No external test framework. Run with:
 *   bun scripts/check-bun.test.ts
 */

import { execFileSync } from "child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const HERE = typeof __dirname !== "undefined" ? __dirname : ".";
const SCRIPT = join(HERE, "check-bun.sh");
const SH = "/bin/sh";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ""}`); }
}

function runWithPath(pathDirs: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(SH, [SCRIPT], { cwd, env: { PATH: pathDirs.join(":") }, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout, stderr: "" };
  } catch (err: any) {
    return { code: typeof err.status === "number" ? err.status : 1, stdout: err.stdout?.toString() ?? "", stderr: err.stderr?.toString() ?? "" };
  }
}

function which(cmd: string): string {
  return execFileSync(SH, ["-c", `command -v ${cmd}`], { encoding: "utf-8" }).trim();
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "inspector-bun-")));
try {
  // A bin dir with only the utilities the script itself needs (cat for the heredoc) — no bun.
  const baseBin = join(root, "base-bin");
  mkdirSync(baseBin);
  symlinkSync(which("cat"), join(baseBin, "cat"));

  const project = join(root, "project");
  mkdirSync(project);
  writeFileSync(join(project, "package.json"), "{}\n");

  // --- B1: Bun missing ---
  {
    const r = runWithPath([baseBin], project);
    check("B1 missing Bun -> exit 2", r.code === 2, JSON.stringify(r));
    check("B1 clear headline", r.stderr.includes("BUN NOT FOUND"), r.stderr);
    check("B1 actionable: macOS/Linux install command", r.stderr.includes("curl -fsSL https://bun.sh/install | bash"));
    check("B1 actionable: Windows install command", r.stderr.includes("irm bun.sh/install.ps1 | iex"));
    check("B1 actionable: Homebrew install command", r.stderr.includes("brew install oven-sh/bun/bun"));
    check("B1 says how to verify", r.stderr.includes("bun --version"));
    check("B1 states nothing was modified", r.stderr.includes("no project files were modified"));
    check("B1 states no automatic install and no runtime fallback", /does not install Bun/.test(r.stderr) && /does not fall back to Node\.js/.test(r.stderr));
    check("B1 nothing on stdout", r.stdout === "");
    check("B1 nothing written to the project", JSON.stringify(readdirSync(project)) === JSON.stringify(["package.json"]));
  }

  // --- B2: Bun present (shim) ---
  {
    const bin = join(root, "good-bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "bun"), "#!/bin/sh\n[ \"$1\" = \"--version\" ] && echo 9.9.9\n");
    chmodSync(join(bin, "bun"), 0o755);
    const r = runWithPath([bin, baseBin], project);
    check("B2 Bun present -> exit 0", r.code === 0, JSON.stringify(r));
    check("B2 reports version and path", r.stdout.trim() === `bun 9.9.9 (${join(bin, "bun")})`, r.stdout);
  }

  // --- B3: a `bun` on PATH that does not run is treated as missing ---
  {
    const bin = join(root, "broken-bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "bun"), "#!/bin/sh\nexit 127\n");
    chmodSync(join(bin, "bun"), 0o755);
    const r = runWithPath([bin, baseBin], project);
    check("B3 broken Bun -> exit 2 with the same guidance", r.code === 2 && r.stderr.includes("BUN NOT FOUND"), JSON.stringify(r));
  }

  // --- B4: the real Bun running this test passes the preflight ---
  {
    const r = runWithPath([join(process.execPath, ".."), baseBin], project);
    check("B4 real Bun -> exit 0", r.code === 0 && r.stdout.startsWith(`bun ${Bun.version}`), JSON.stringify(r));
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
