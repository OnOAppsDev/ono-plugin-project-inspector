/**
 * entrypoint.test.ts
 *
 * Every Inspector helper must actually run when Node.js is asked to run it — never
 * exit 0 silently — however the plugin is installed and however it is invoked
 * (0.12.0). This is the regression suite for the `import.meta.main` /
 * `require.main` defect found in the Node.js migration investigation, where the
 * resolver, the branch check and the write guard exited 0 with no output.
 *
 *   E1  each helper, run directly by absolute path, produces its output
 *   E2  the same from a plugin copy whose path has spaces and Unicode, through a
 *       symlinked (or, on Windows, junctioned) install, by a relative path, and on
 *       Windows with a lower-case drive letter
 *   E3  importing a helper runs nothing (library use stays side-effect free)
 *   E4  isEntryPoint() edge cases
 *   E5  a large result is written completely before process.exit() (pipe safety)
 *   E6  every helper runs with Bun unavailable on PATH
 *
 * No external test framework. Run with:
 *   node --no-warnings scripts/entrypoint.test.ts
 */

import { spawnSync } from "child_process";
import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, delimiter, dirname, join, relative } from "path";
import { pathToFileURL } from "url";
import { commitAll, initGit, write } from "./fixtures/knowledge-fixtures.ts";
import { childEnv, IS_WINDOWS, linkOrJunction, pathList, realTool, SH } from "./fixtures/platform.ts";
import { isEntryPoint } from "./entrypoint.ts";

const HERE = import.meta.dirname;
const PLUGIN = realpathSync(join(HERE, ".."));
const NODE = process.execPath;
const INSPECTOR = "ono-project-inspector:project-inspector";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ""}`); }
}
const skip = (name: string, why: string) => console.log(`SKIP  ${name}  — ${why}`);

const root = realpathSync(mkdtempSync(join(tmpdir(), "inspector-entry-")));
try {
  const repo = join(root, "work repo");
  initGit(repo, "chore/project-inspection");
  write(repo, "a.txt", "a\n");
  commitAll(repo, "init");

  /** Each helper with arguments that make it produce output, and what that output must contain. */
  const CASES: Array<{ script: string; args: string[]; stdin?: string; expect: (r: { code: number; out: string }) => boolean }> = [
    { script: "resolve-repo-root.ts", args: [repo], expect: (r) => r.code === 0 && /"projectRoot"/.test(r.out) },
    { script: "work-branch.ts", args: ["check", repo], expect: (r) => r.code === 0 && /"protected": false/.test(r.out) },
    { script: "inspection-state.ts", args: ["detect", repo], expect: (r) => r.code === 0 && /"inspected": false/.test(r.out) },
    { script: "repo-knowledge.ts", args: ["validate", repo], expect: (r) => r.code === 2 && /No manifest/.test(r.out) },
    { script: "knowledge-evidence.ts", args: ["verify", repo, "all"], expect: (r) => r.code !== 0 && /"ok": false/.test(r.out) },
    { script: "knowledge-refresh-guard.ts", args: ["verify", repo], expect: (r) => r.code === 2 && /No snapshot/.test(r.out) },
    { script: "verify-artifacts.ts", args: [repo, "a.txt"], expect: (r) => r.code === 0 && /"ok": true/.test(r.out) },
    { script: "update-audit-index.ts", args: [], expect: (r) => r.code === 1 && /Usage: update-audit-index/.test(r.out) },
    { script: "slugify.ts", args: [], expect: (r) => r.code === 0 && /"Architecture" -> "architecture"/.test(r.out) },
    { script: "node-preflight.mjs", args: [], expect: (r) => r.code === 0 && /"supported":true/.test(r.out) },
    {
      script: "write-guard.ts", args: [],
      stdin: JSON.stringify({ agent_type: INSPECTOR, tool_name: "Write", tool_input: { file_path: join(repo, "CLAUDE.md") } }),
      expect: (r) => r.code === 0 && r.out === "ONO-INSPECTOR-WRITE-GUARD:ALLOW\n",
    },
  ];
  const run = (scriptPath: string, args: string[], stdin?: string, opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => {
    const r = spawnSync(NODE, ["--no-warnings", scriptPath, ...args], { input: stdin ?? "", encoding: "utf-8", cwd: opts.cwd, env: opts.env });
    return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
  };
  const runAll = (label: string, scriptsDir: string, opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => {
    for (const c of CASES) {
      const path = opts.cwd ? relative(opts.cwd, join(scriptsDir, c.script)) : join(scriptsDir, c.script);
      const r = run(path, c.args, c.stdin, opts);
      check(`${label}: ${c.script} runs and produces its output`, c.expect(r), JSON.stringify(r).slice(0, 300));
    }
  };

  // --- E1: direct execution by absolute path ---------------------------------------------
  runAll("E1 absolute path", join(PLUGIN, "scripts"));

  // --- E2: install paths ---------------------------------------------------------------------
  const odd = join(root, "plugins cache", "ono project inspector – תוסף ü", "0.12.0");
  cpSync(PLUGIN, odd, { recursive: true, filter: (src) => !/[\\/]\.git([\\/]|$)/.test(src) });
  runAll("E2 spaces + Unicode in the install path", join(odd, "scripts"));
  const linked = join(root, "linked install");
  if (linkOrJunction(odd, linked, "dir")) runAll("E2 symlinked install", join(linked, "scripts"));
  else skip("E2 symlinked install", "no directory link could be created");
  runAll("E2 relative path from the plugin root", join(odd, "scripts"), { cwd: odd });
  if (IS_WINDOWS && /^[A-Z]:/.test(odd)) {
    const lower = odd[0].toLowerCase() + odd.slice(1);
    runAll("E2 lower-case drive letter", join(lower, "scripts"));
  } else if (IS_WINDOWS) {
    skip("E2 lower-case drive letter", `install path has no upper-case drive letter: ${odd}`);
  }

  // --- E3: importing runs nothing -------------------------------------------------------------
  for (const c of CASES) {
    const url = pathToFileURL(join(PLUGIN, "scripts", c.script)).href;
    const r = spawnSync(NODE, ["--no-warnings", "--input-type=module", "-e", `await import(${JSON.stringify(url)});`], { input: "", encoding: "utf-8", cwd: repo });
    check(`E3 importing ${c.script} runs nothing`, r.status === 0 && r.stdout === "" && r.stderr === "", `${r.status} ${r.stdout}${r.stderr}`.slice(0, 200));
  }
  const smoke = spawnSync(NODE, ["--no-warnings", "--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(join(PLUGIN, "scripts", "live-smoke.ts")).href)});`], { encoding: "utf-8" });
  check("E3 importing live-smoke.ts (a paid live run) is refused, never started", smoke.status !== 0 && /on-demand CLI/.test(smoke.stderr), smoke.stderr.slice(0, 200));

  // --- E4: isEntryPoint edge cases -------------------------------------------------------------
  const saved = process.argv[1];
  try {
    process.argv[1] = "";
    check("E4 no script path -> false", isEntryPoint(pathToFileURL(join(HERE, "entrypoint.ts")).href) === false);
    process.argv[1] = join(root, "does-not-exist.ts");
    check("E4 a script path that does not exist -> false", isEntryPoint(pathToFileURL(join(HERE, "entrypoint.ts")).href) === false);
    process.argv[1] = join(HERE, "entrypoint.test.ts");
    check("E4 a different module -> false", isEntryPoint(pathToFileURL(join(HERE, "entrypoint.ts")).href) === false);
    check("E4 the same module -> true", isEntryPoint(pathToFileURL(join(HERE, "entrypoint.test.ts")).href) === true);
    process.argv[1] = join(HERE, "..", basename(HERE), ".", "entrypoint.test.ts");
    check("E4 the same module through `..` and `.` segments -> true", isEntryPoint(pathToFileURL(join(HERE, "entrypoint.test.ts")).href) === true);
  } finally {
    process.argv[1] = saved;
  }

  // --- E5: large output survives process.exit() -------------------------------------------------
  const big = join(odd, "scripts", "big-output.ts");
  writeFileSync(big, [
    'import { isEntryPoint, useBlockingOutput } from "./entrypoint.ts";',
    "if (isEntryPoint(import.meta.url)) {",
    "  useBlockingOutput();",
    '  console.log(JSON.stringify({ data: "x".repeat(2 * 1024 * 1024) }));',
    "  process.exit(0);",
    "}",
  ].join("\n") + "\n");
  // Through a real pipe to a shell reader, as the Bash tool reads the helpers.
  const piped = spawnSync(SH, ["-c", `"$0" --no-warnings "$1" | wc -c`, NODE, big], { encoding: "utf-8", env: childEnv(pathList(dirname(realTool("wc")), dirname(NODE))) });
  const bytes = Number(piped.stdout.trim());
  const expected = JSON.stringify({ data: "x".repeat(2 * 1024 * 1024) }).length + 1;
  check("E5 a 2 MiB result printed just before process.exit() arrives complete through a pipe", bytes === expected, `${bytes} of ${expected} ${piped.stderr}`);

  // --- E6: no Bun needed ------------------------------------------------------------------------------
  // The normal PATH minus every directory holding a bun executable — GitHub runners may ship Bun.
  const noBunPath = withoutBun(pathList(dirname(NODE), process.env.PATH ?? ""));
  const bunVisible = spawnSync(SH, ["-c", "command -v bun"], { encoding: "utf-8", env: childEnv(noBunPath) });
  check("E6 bun is not visible on the PATH used below", bunVisible.status !== 0 && bunVisible.stdout.trim() === "", bunVisible.stdout);
  runAll("E6 Bun unavailable on PATH", join(PLUGIN, "scripts"), { env: childEnv(noBunPath) });
} finally {
  rmSync(root, { recursive: true, force: true });
}

/** `path` without every directory that contains a bun executable (bun, bun.exe, bun.cmd). */
function withoutBun(path: string): string {
  return path.split(delimiter).filter((d) => d && !["bun", "bun.exe", "bun.cmd"].some((b) => existsSync(join(d, b)))).join(delimiter);
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
