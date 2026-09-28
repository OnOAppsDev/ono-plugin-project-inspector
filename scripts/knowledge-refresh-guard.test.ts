/**
 * knowledge-refresh-guard.test.ts
 *
 * Self-contained tests for scripts/knowledge-refresh-guard.ts — the
 * preservation guard that wraps a Project Knowledge refresh so it can never
 * destroy previously approved inspection work (AUDIT.md topic rows/statuses,
 * approval metadata, and CLAUDE.md audit-sync managed blocks).
 *
 * No external test framework. Run with:
 *   bun scripts/knowledge-refresh-guard.test.ts
 */

import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";

const HERE = typeof __dirname !== "undefined" ? __dirname : ".";
const HELPER = join(HERE, "knowledge-refresh-guard.ts");
const RUNTIME = process.execPath;

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ""}`); }
}

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(RUNTIME, [HELPER, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout, stderr: "" };
  } catch (err: any) {
    return { code: typeof err.status === "number" ? err.status : 1, stdout: err.stdout?.toString() ?? "", stderr: err.stderr?.toString() ?? "" };
  }
}

function write(root: string, rel: string, body: string): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body, "utf-8");
}

const AUDIT = `# AUDIT.md — Demo

## Project Overview

Old overview.

## Audit Topics

| # | Status | Topic | Priority | File | Notes |
|---|--------|-------|----------|------|-------|
| 1 | Approved | Architecture | High | audits/architecture/architecture-audit.md | ok. Approved 2026-09-01 |
| 2 | Approved | Player / Media | Medium | audits/player-media/player-media-audit.md | fine |
`;

const CAUTION = `<!-- audit-sync:caution-areas:start -->
- **Architecture** (HIGH): god object in AppManager — see audits/architecture/architecture-audit.md
<!-- audit-sync:caution-areas:end -->`;

const IMPORTANT = `<!-- audit-sync:important-files:start -->
| src/AppManager.ts | Central coordinator (Architecture audit) |
<!-- audit-sync:important-files:end -->`;

function claudeMd(intro: string, caution = CAUTION, important = IMPORTANT): string {
  return `# CLAUDE.md — Demo\n\n${intro}\n\n## Important Files\n\n${important}\n\n## Caution Areas\n\n${caution}\n`;
}

function fixture(dir: string): string {
  mkdirSync(dir, { recursive: true });
  write(dir, "AUDIT.md", AUDIT);
  write(dir, "CLAUDE.md", claudeMd("Old intro."));
  return dir;
}

const SNAPSHOT = join(".ono", "knowledge-refresh-snapshot.json");

const root = mkdtempSync(join(realpathSync(tmpdir()), "krg-"));
try {
  // --- G1: a refresh that rewrites prose but preserves approved work passes ---
  {
    const repo = fixture(join(root, "g1"));
    const s = run(["snapshot", repo]);
    check("G1 snapshot exit 0", s.code === 0, `code=${s.code} stderr=${s.stderr}`);
    check("G1 snapshot written under .ono/", existsSync(join(repo, SNAPSHOT)));

    // Update mode: overview prose refreshed, a NEW topic appended, notes extended.
    write(repo, "AUDIT.md", AUDIT
      .replace("Old overview.", "Refreshed overview.")
      .replace("| ok. Approved 2026-09-01 |", "| ok, refreshed. Approved 2026-09-01 |")
      + "| 3 | Pending Breakdown | Networking | Low | Not created yet | new since refresh |\n");
    write(repo, "CLAUDE.md", claudeMd("Refreshed intro with new modules."));
    const v = run(["verify", repo]);
    check("G1 verify exit 0 when approved work preserved", v.code === 0, `code=${v.code} stdout=${v.stdout} stderr=${v.stderr}`);
    check("G1 snapshot removed after a clean verify", !existsSync(join(repo, SNAPSHOT)));
  }

  // --- G2: a reset topic status is caught ---
  {
    const repo = fixture(join(root, "g2"));
    run(["snapshot", repo]);
    write(repo, "AUDIT.md", AUDIT.replace("| 1 | Approved | Architecture", "| 1 | Pending Breakdown | Architecture"));
    const v = run(["verify", repo]);
    check("G2 status reset -> exit 3", v.code === 3, `code=${v.code}`);
    check("G2 names the topic", (v.stdout + v.stderr).includes("Architecture"));
    check("G2 snapshot kept for recovery", existsSync(join(repo, SNAPSHOT)));
  }

  // --- G3: a removed topic row and a changed file reference are caught ---
  {
    const repo = fixture(join(root, "g3"));
    run(["snapshot", repo]);
    write(repo, "AUDIT.md", AUDIT
      .replace(/\| 2 \| Approved \| Player \/ Media[^\n]*\n/, "")
      .replace("audits/architecture/architecture-audit.md", "Not created yet"));
    const v = run(["verify", repo]);
    check("G3 removed row + file change -> exit 3", v.code === 3, `code=${v.code}`);
    const out = v.stdout + v.stderr;
    check("G3 reports removed topic", out.includes("Player / Media"));
    check("G3 reports file reference change", out.includes("audits/architecture/architecture-audit.md"));
  }

  // --- G4: dropped approval metadata is caught ---
  {
    const repo = fixture(join(root, "g4"));
    run(["snapshot", repo]);
    write(repo, "AUDIT.md", AUDIT.replace(" Approved 2026-09-01", ""));
    check("G4 dropped 'Approved <date>' note -> exit 3", run(["verify", repo]).code === 3);
  }

  // --- G5: altered or removed managed blocks are caught ---
  {
    const repo = fixture(join(root, "g5"));
    run(["snapshot", repo]);
    write(repo, "CLAUDE.md", claudeMd("Refreshed.", CAUTION.replace("god object", "nothing to see")));
    const v = run(["verify", repo]);
    check("G5 managed block content changed -> exit 3", v.code === 3, `code=${v.code}`);
    check("G5 names the block", (v.stdout + v.stderr).includes("audit-sync:caution-areas"));

    const repo2 = fixture(join(root, "g5b"));
    run(["snapshot", repo2]);
    write(repo2, "CLAUDE.md", "# CLAUDE.md — regenerated from template\n");
    const v2 = run(["verify", repo2]);
    check("G5 managed block markers removed -> exit 3", v2.code === 3, `code=${v2.code}`);
  }

  // --- G6: docs-only refresh (CLAUDE.md/AUDIT.md untouched) passes ---
  {
    const repo = fixture(join(root, "g6"));
    run(["snapshot", repo]);
    write(repo, "docs/project/patterns.md", "# patterns\n\n## New\n");
    check("G6 untouched artifacts -> exit 0", run(["verify", repo]).code === 0);
  }

  // --- G7: verify without a snapshot, usage, worktree refusal ---
  {
    const repo = fixture(join(root, "g7"));
    check("G7 verify with no snapshot -> exit 2", run(["verify", repo]).code === 2);
    check("G7 no args -> exit 1", run([]).code === 1);
    check("G7 unknown command -> exit 1", run(["frobnicate", repo]).code === 1);
    const wt = join(root, "host", ".claude", "worktrees", "agent-1");
    fixture(wt);
    check("G7 worktree path refused -> exit 1", run(["snapshot", wt]).code === 1);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures > 0 ? 1 : 0);
