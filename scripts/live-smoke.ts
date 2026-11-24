/**
 * live-smoke.ts — REAL Claude Code smoke test for the Inspector (0.11.2; Node.js since 0.12.0).
 *
 * Not part of the regular suite (it is not a *.test.ts file): it drives a real,
 * logged-in `claude` CLI, uses model credits, and takes several minutes. Run it
 * before a release:
 *
 *   node --no-warnings scripts/live-smoke.ts [--keep]
 *
 * What it does — exactly what a developer does, one CLI turn per developer message:
 *   1. Builds a throwaway repository whose application lives in a NESTED project
 *      directory (`yestvos/YesTVOS`), on a feature branch.
 *   2. Loads THIS checkout with `--plugin-dir` (the installed marketplace copy is
 *      disabled via inline --settings; no user config is modified).
 *   3. Turn 1  `/ono-project-inspector:inspect <project>`        -> status + choices
 *      Turn 2  "start a new inspection"                         -> project-analysis
 *      Turn 3  `/ono-project-inspector:inspect-approve <project>` -> project-docs
 *
 * What it asserts (from the stream-json transcript and the disk):
 *   - the project-inspector SUBAGENT runs the Node.js preflight and every helper by
 *     absolute plugin path (so ${CLAUDE_PLUGIN_ROOT} was substituted) and writes
 *     the artifacts itself;
 *   - the MAIN session never writes, edits, or runs a helper (no manual
 *     compensation for missing agent capabilities);
 *   - every artifact, capabilities.md included, lands at the Project Root and
 *     none at the Git Root; the evidence gate and manifest validation pass.
 *
 * Bash is limited to the plugin's read-only shell policy plus node/sh.
 */

import { execFileSync, spawnSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { APP_SOURCE, commitAll, git, initGit, write } from "./fixtures/knowledge-fixtures.ts";
import { isEntryPoint } from "./entrypoint.ts";

// This file starts a real, paid Claude Code session at load time. Importing it (a module
// load check, a test runner sweeping scripts/) must never do that: only an explicit
// `node --no-warnings scripts/live-smoke.ts` runs it.
if (!isEntryPoint(import.meta.url)) {
  throw new Error("live-smoke.ts is an on-demand CLI (a paid live Claude Code run); run it directly, never import it.");
}

const PLUGIN_ROOT = realpathSync(join(import.meta.dirname, ".."));
const KEEP = process.argv.includes("--keep");
const ALLOWED = [
  "Read", "Write", "Edit", "Glob", "Grep", "Skill", "Agent", "SendMessage",
  "Bash(node:*)", "Bash(sh:*)", "Bash(ls:*)", "Bash(find:*)", "Bash(cat:*)", "Bash(head:*)", "Bash(tail:*)",
  "Bash(grep:*)", "Bash(rg:*)", "Bash(wc:*)", "Bash(tree:*)", "Bash(file:*)", "Bash(pwd)",
  "Bash(git status:*)", "Bash(git log:*)", "Bash(git show:*)", "Bash(git branch:*)", "Bash(git rev-parse:*)",
];

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ""}`); }
}

interface Call { who: "MAIN" | "SUB"; name: string; input: any; error: boolean }
interface Turn { calls: Call[]; result: string; cost: number }

function turn(cwd: string, sessionId: string, first: boolean, prompt: string, log: string): Turn {
  const args = [
    "-p", prompt,
    ...(first ? ["--session-id", sessionId] : ["--resume", sessionId]),
    "--plugin-dir", PLUGIN_ROOT,
    "--settings", JSON.stringify({ enabledPlugins: { "ono-project-inspector@ono-plugin-marketplace": false } }),
    "--output-format", "stream-json", "--verbose",
    "--permission-mode", "acceptEdits",
    "--allowedTools", ...ALLOWED,
  ];
  const r = spawnSync("claude", args, { cwd, encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
  writeFileSync(log, r.stdout ?? "");
  const calls: Call[] = [];
  const errors = new Set<string>();
  const byId = new Map<string, Call>();
  let result = "", cost = 0;
  for (const line of (r.stdout ?? "").split("\n")) {
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === "assistant") {
      for (const c of ev.message?.content ?? []) {
        if (c.type !== "tool_use") continue;
        const call: Call = { who: ev.parent_tool_use_id ? "SUB" : "MAIN", name: c.name, input: c.input ?? {}, error: false };
        calls.push(call); byId.set(c.id, call);
      }
    } else if (ev.type === "user" && Array.isArray(ev.message?.content)) {
      for (const c of ev.message.content) if (c.type === "tool_result" && c.is_error) errors.add(c.tool_use_id);
    } else if (ev.type === "result") {
      result = ev.result ?? ""; cost = ev.total_cost_usd ?? 0;
    }
  }
  for (const [id, call] of byId) if (errors.has(id)) call.error = true;
  return { calls, result, cost };
}

const workdir = realpathSync(mkdtempSync(join(tmpdir(), "inspector-live-")));
const gitRoot = join(workdir, "yestvos");
const project = join(gitRoot, "YesTVOS");
try {
  try {
    execFileSync("claude", ["--version"], { stdio: "ignore" });
  } catch {
    console.error("The `claude` CLI is not available; the live smoke test cannot run.");
    process.exit(2);
  }
  initGit(gitRoot);
  for (const [rel, body] of Object.entries(APP_SOURCE)) write(project, rel, body);
  write(project, "package.json", JSON.stringify({ name: "yes-tv", private: true, scripts: { start: "vite", build: "vite build", test: "vitest" }, dependencies: { react: "18.3.1" }, devDependencies: { vite: "5.4.0", vitest: "2.0.5" } }, null, 2));
  write(project, "tizen/config.xml", "<?xml version=\"1.0\"?><widget xmlns=\"http://www.w3.org/ns/widgets\" id=\"yes.tv\"><name>YesTV</name></widget>\n");
  write(gitRoot, "README.md", "# yestvos umbrella repository\n");
  commitAll(gitRoot, "initial");
  git(gitRoot, "switch", "-q", "-c", "inspector/live-smoke"); // repos commonly guard writes on main

  const sid = randomUUID();
  const turns: Turn[] = [];
  const t = (first: boolean, prompt: string) => {
    const n = turns.length + 1;
    console.log(`\n--- turn ${n}: ${prompt.slice(0, 80)}`);
    const res = turn(gitRoot, sid, first, prompt, join(workdir, `turn${n}.jsonl`));
    for (const c of res.calls) console.log(`  ${c.who} ${c.name} ${String(c.input.command ?? c.input.file_path ?? c.input.skill ?? c.input.subagent_type ?? "").slice(0, 140)}${c.error ? "  [error]" : ""}`);
    turns.push(res);
    return res;
  };
  t(true, `/ono-project-inspector:inspect ${project}`);
  t(false, "1 — start a new inspection. For any setup questions the skill asks, use its defaults.");
  t(false, `/ono-project-inspector:inspect-approve ${project}`);

  const all = turns.flatMap((x) => x.calls);
  const sub = all.filter((c) => c.who === "SUB");
  const main = all.filter((c) => c.who === "MAIN");
  const subBash = sub.filter((c) => c.name === "Bash").map((c) => String(c.input.command));
  const pluginCall = (script: string) => subBash.some((cmd) => cmd.includes(`${PLUGIN_ROOT}/scripts/${script}`));

  check("L1 the main session delegated to the project-inspector agent", main.some((c) => c.name === "Agent" && String(c.input.subagent_type).includes("project-inspector")));
  check("L2 subagent ran the Node.js preflight by absolute plugin path", pluginCall("node-preflight.mjs"));
  for (const s of ["resolve-repo-root.ts", "inspection-state.ts", "verify-artifacts.ts", "knowledge-evidence.ts", "repo-knowledge.ts"]) {
    check(`L3 subagent ran ${s} by absolute plugin path`, pluginCall(s));
  }
  check("L4 no helper call used an unsubstituted variable or a relative path",
    !all.some((c) => c.name === "Bash" && /\$\{?CLAUDE_PLUGIN_ROOT|<PLUGIN_ROOT>|(^|\s)node (--no-warnings )?scripts\//.test(String(c.input.command))));
  check("L5 subagent wrote the artifacts itself",
    ["CLAUDE.md", "AUDIT.md", "docs/project/capabilities.md"].every((f) => sub.some((c) => (c.name === "Write" || c.name === "Edit") && c.input.file_path === join(project, f) && !c.error)));
  check("L6 main session never wrote, edited, or ran a helper",
    !main.some((c) => c.name === "Write" || c.name === "Edit" || (c.name === "Bash" && /scripts\/[a-z-]+\.(ts|mjs)/.test(String(c.input.command)))),
    main.map((c) => `${c.name}:${String(c.input.command ?? c.input.file_path ?? "")}`).join(" | "));
  check("L7 no tool was unavailable to the subagent", !sub.some((c) => c.error && /No such tool|not available/i.test(JSON.stringify(c.input))));

  const artifacts = ["CLAUDE.md", "AUDIT.md", ".ono/state.json", ".ono/repo-knowledge.json",
    "docs/project/overview.md", "docs/project/components.md", "docs/project/patterns.md", "docs/project/integrations.md", "docs/project/capabilities.md"];
  check("L8 every artifact at the Project Root", artifacts.every((f) => existsSync(join(project, f))), artifacts.filter((f) => !existsSync(join(project, f))).join(","));
  check("L9 no Inspector artifact at the Git Root", ["CLAUDE.md", "AUDIT.md", ".ono", "docs"].every((f) => !existsSync(join(gitRoot, f))));
  const node = process.execPath;
  const ev = spawnSync(node, ["--no-warnings", join(PLUGIN_ROOT, "scripts", "knowledge-evidence.ts"), "verify", project, "all"], { encoding: "utf-8" });
  check("L10 evidence gate passes on the generated knowledge", ev.status === 0, ev.stdout);
  const val = spawnSync(node, ["--no-warnings", join(PLUGIN_ROOT, "scripts", "repo-knowledge.ts"), "validate", project], { encoding: "utf-8" });
  check("L11 manifest validates", val.status === 0, val.stdout + val.stderr);
  const manifest = existsSync(join(project, ".ono", "repo-knowledge.json")) ? JSON.parse(readFileSync(join(project, ".ono", "repo-knowledge.json"), "utf-8")) : {};
  check("L12 capabilities indexed", manifest.coverage?.capabilities === "populated" && (manifest.capabilities ?? []).length > 0, JSON.stringify(manifest.coverage));

  console.log(`\nCLI-reported cost: $${turns.reduce((a, x) => a + x.cost, 0).toFixed(2)}`);
} finally {
  if (KEEP) console.log(`Kept: ${workdir}`);
  else rmSync(workdir, { recursive: true, force: true });
}
console.log(failures === 0 ? "\nLIVE SMOKE PASSED" : `\n${failures} LIVE CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
