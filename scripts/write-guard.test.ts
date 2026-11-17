/**
 * write-guard.test.ts
 *
 * Regression tests for the Inspector write guard (0.11.3): the PreToolUse hook
 * in hooks/hooks.json -> scripts/write-guard.sh -> scripts/write-guard.ts.
 * Every case runs the REAL hook command (`sh write-guard.sh`) with synthetic
 * hook input on stdin, as Claude Code does, against throwaway repositories.
 *
 * The live run that established the agent_type (`ono-project-inspector:project-inspector`
 * for the Inspector subagent, none for the main session) is recorded in CHANGELOG 0.11.3.
 *
 * No external test framework. Run with:
 *   bun scripts/write-guard.test.ts
 */

import { execFileSync, spawnSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { commitAll, git, initGit, write } from "./fixtures/knowledge-fixtures";
import { INSPECTOR_AGENT_TYPES, GUARDED_TOOLS } from "./write-guard";

const HERE = typeof __dirname !== "undefined" ? __dirname : ".";
const PLUGIN = realpathSync(join(HERE, ".."));
const HOOK = join(PLUGIN, "scripts", "write-guard.sh");
const INSPECTOR = "ono-project-inspector:project-inspector";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ""}`); }
}

const which = (cmd: string) => execFileSync("/bin/sh", ["-c", `command -v ${cmd}`], { encoding: "utf-8" }).trim();
const root = realpathSync(mkdtempSync(join(tmpdir(), "inspector-guard-")));

// PATHs: the normal one (Bun + system tools), and one with every tool the hook needs except Bun.
const NORMAL_PATH = `${dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}`;
const noBun = join(root, "no-bun-bin");
mkdirSync(noBun);
for (const t of ["cat", "grep", "dirname", "git"]) symlinkSync(which(t), join(noBun, t));
// Bun present but no git: the branch cannot be determined.
const noGit = join(root, "no-git-bin");
mkdirSync(noGit);
for (const t of ["cat", "grep", "dirname"]) symlinkSync(which(t), join(noGit, t));
symlinkSync(process.execPath, join(noGit, "bun"));
// A Bun that crashes.
const crashBin = join(root, "crash-bin");
mkdirSync(crashBin);
for (const t of ["cat", "grep", "dirname", "git"]) symlinkSync(which(t), join(crashBin, t));
writeFileSync(join(crashBin, "bun"), "#!/bin/sh\nexit 1\n");
chmodSync(join(crashBin, "bun"), 0o755);

function hookRaw(stdin: string, path = NORMAL_PATH): { code: number; stderr: string } {
  const r = spawnSync("/bin/sh", [HOOK], { input: stdin, encoding: "utf-8", env: { PATH: path } });
  return { code: r.status ?? -1, stderr: r.stderr ?? "" };
}
function payload(o: { agent?: string | null; tool?: string; file?: string; notebook?: string; cwd?: string; content?: string }): string {
  const input: Record<string, unknown> = {};
  if (o.notebook !== undefined) input.notebook_path = o.notebook;
  else if (o.file !== undefined) input.file_path = o.file;
  if (o.content !== undefined) input.content = o.content;
  const p: Record<string, unknown> = { session_id: "s", hook_event_name: "PreToolUse", tool_name: o.tool ?? "Write", tool_input: input, tool_use_id: "toolu_x" };
  if (o.cwd !== undefined) p.cwd = o.cwd;
  if (o.agent) { p.agent_type = o.agent; p.agent_id = "a01"; }
  return JSON.stringify(p);
}
const hook = (o: Parameters<typeof payload>[0], path?: string) => hookRaw(payload(o), path);
const denied = (r: { code: number; stderr: string }) => r.code === 2 && /REFUSED/.test(r.stderr) && /nothing was written/i.test(r.stderr);

function repoOn(name: string, branch: string): string {
  const repo = join(root, name);
  initGit(repo, branch);
  write(repo, "README.md", "hello\n");
  write(repo, "nb.ipynb", "{}\n");
  commitAll(repo, "init");
  return repo;
}

try {
  const main = repoOn("main-repo", "main");
  const master = repoOn("master-repo", "master");
  const detached = repoOn("detached-repo", "main");
  git(detached, "switch", "-q", "--detach");
  const work = repoOn("work-repo", "chore/project-inspection");
  const plain = join(root, "plain");
  write(plain, "x.md", "x\n");
  const target = (repo: string, tool: string) => (tool === "NotebookEdit" ? { notebook: join(repo, "nb.ipynb") } : { file: join(repo, tool === "Write" ? "CLAUDE.md" : "README.md") });

  // --- G1: ordinary developer edits (main session: no agent_type) ---------------------
  for (const tool of GUARDED_TOOLS) {
    for (const [label, repo] of [["main", main], ["master", master], ["detached HEAD", detached]] as const) {
      check(`G1 developer ${tool} on ${label} -> allowed`, hook({ tool, ...target(repo, tool) }).code === 0);
    }
  }
  check("G1 developer edit needs no Bun (fast path)", hook({ tool: "Write", file: join(main, "CLAUDE.md") }, noBun).code === 0);
  check("G1 developer edit is silent", hook({ tool: "Edit", file: join(main, "README.md") }).stderr === "");
  // File content that mentions the Inspector cannot forge the metadata.
  const forged = payload({ tool: "Write", file: join(main, "CLAUDE.md"), content: `{"agent_type":"${INSPECTOR}"}` });
  check("G1 content quoting the Inspector's agent_type is not identification", hookRaw(forged, noBun).code === 0, forged);
  check("G1 Inspector artifact paths alone are not identification", hook({ tool: "Write", file: join(main, ".ono", "state.json") }, noBun).code === 0);

  // --- G2: other agents -----------------------------------------------------------------
  for (const agent of ["Explore", "general-purpose", "ono-mobile-dev-plugin:feature-implementer", "project-inspector", "other-plugin:project-inspector", "ono-project-inspector:other-agent"]) {
    check(`G2 agent ${agent} writing on main -> allowed`, hook({ agent, tool: "Write", file: join(main, "CLAUDE.md") }).code === 0);
  }

  // --- G3: Inspector on protected branches -> denied, every tool -----------------------
  for (const tool of GUARDED_TOOLS) {
    for (const [label, repo] of [["main", main], ["master", master], ["detached HEAD", detached]] as const) {
      const r = hook({ agent: INSPECTOR, tool, ...target(repo, tool) });
      check(`G3 Inspector ${tool} on ${label} -> denied`, denied(r), `${r.code} ${r.stderr}`);
    }
  }
  const msg = hook({ agent: INSPECTOR, tool: "Write", file: join(main, "CLAUDE.md") }).stderr;
  check("G3 refusal names the branch and the way forward", /protected branch 'main'/.test(msg) && msg.includes("work-branch.ts\" create") && msg.includes("chore/project-inspection"));
  check("G3 detached refusal says detached HEAD", /detached HEAD/.test(hook({ agent: INSPECTOR, tool: "Write", file: join(detached, "CLAUDE.md") }).stderr));
  check("G3 the hook itself writes nothing", !existsSync(join(main, "CLAUDE.md")) && !existsSync(join(main, ".ono")));

  // --- G4: Inspector on a working branch / outside Git -> allowed ------------------------
  for (const tool of GUARDED_TOOLS) {
    check(`G4 Inspector ${tool} on a working branch -> allowed`, hook({ agent: INSPECTOR, tool, ...target(work, tool) }).code === 0);
  }
  check("G4 Inspector write outside any Git repository -> allowed", hook({ agent: INSPECTOR, tool: "Write", file: join(plain, "notes.md") }).code === 0);
  // The same repository before and after the approved branch is created.
  const flip = repoOn("flip-repo", "main");
  check("G4 before the branch: denied", hook({ agent: INSPECTOR, tool: "Write", file: join(flip, "CLAUDE.md") }).code === 2);
  execFileSync(process.execPath, [join(PLUGIN, "scripts", "work-branch.ts"), "create", flip, "chore/project-inspection"], { stdio: "ignore" });
  check("G4 after work-branch.ts create: allowed", hook({ agent: INSPECTOR, tool: "Write", file: join(flip, "CLAUDE.md") }).code === 0);

  // --- G5: nested project roots and nonexistent targets ---------------------------------
  const nested = repoOn("nested-repo", "main");
  write(nested, "YesTVOS/package.json", "{}\n");
  const proj = join(nested, "YesTVOS");
  for (const rel of ["CLAUDE.md", "docs/project/capabilities.md", "audits/architecture/architecture-audit.md", ".ono/state.json"]) {
    check(`G5 nested project on main, new ${rel} -> denied`, hook({ agent: INSPECTOR, tool: "Write", file: join(proj, rel) }).code === 2);
  }
  check("G5 relative target resolved against cwd -> denied on main", hook({ agent: INSPECTOR, tool: "Write", file: "docs/project/overview.md", cwd: proj }).code === 2);
  git(nested, "switch", "-q", "-c", "chore/project-inspection");
  check("G5 nested project on a working branch, new deep path -> allowed", hook({ agent: INSPECTOR, tool: "Write", file: join(proj, "audits/a/b/c.md") }).code === 0);
  check("G5 relative target on a working branch -> allowed", hook({ agent: INSPECTOR, tool: "Write", file: "docs/project/overview.md", cwd: proj }).code === 0);
  check("G5 relative target with no cwd -> denied (cannot place it)", hook({ agent: INSPECTOR, tool: "Write", file: "CLAUDE.md" }).code === 2);

  // --- G6: symlinks -------------------------------------------------------------------------
  // A link in a working-branch repo pointing at a file inside a repo on main: the write lands on main.
  symlinkSync(join(main, "README.md"), join(work, "linked-readme.md"));
  check("G6 symlinked file into a repo on main -> denied", hook({ agent: INSPECTOR, tool: "Edit", file: join(work, "linked-readme.md") }).code === 2);
  // A symlinked directory outside Git pointing into a repo on main.
  symlinkSync(main, join(plain, "main-link"));
  check("G6 new file under a symlinked directory into main -> denied", hook({ agent: INSPECTOR, tool: "Write", file: join(plain, "main-link", "docs", "x.md") }).code === 2);
  // A symlink from a repo on main pointing outside Git: the write lands outside any repository.
  mkdirSync(join(root, "outside"));
  symlinkSync(join(root, "outside"), join(main, "out-link"));
  check("G6 symlinked directory from main to outside Git -> allowed (write lands outside)", hook({ agent: INSPECTOR, tool: "Write", file: join(main, "out-link", "x.md") }).code === 0);
  symlinkSync(join(root, "missing-target"), join(work, "dangling.md"));
  check("G6 dangling symlink target -> denied (cannot place it)", hook({ agent: INSPECTOR, tool: "Write", file: join(work, "dangling.md") }).code === 2);
  symlinkSync(join(root, "missing-dir"), join(work, "dangling-dir"));
  check("G6 new file under a dangling directory symlink -> denied", hook({ agent: INSPECTOR, tool: "Write", file: join(work, "dangling-dir", "x.md") }).code === 2);

  // --- G7: missing Bun, crashes, unknown branch ----------------------------------------------
  check("G7 Inspector call with Bun missing -> denied (never fails open)", denied(hook({ agent: INSPECTOR, tool: "Write", file: join(work, "CLAUDE.md") }, noBun)));
  check("G7 Inspector call with Bun missing explains why", /needs Bun/.test(hook({ agent: INSPECTOR, tool: "Write", file: join(work, "CLAUDE.md") }, noBun).stderr));
  check("G7 a crashing guard -> denied", denied(hook({ agent: INSPECTOR, tool: "Write", file: join(work, "CLAUDE.md") }, crashBin)));
  check("G7 git unavailable inside a repository -> branch unknown -> denied", denied(hook({ agent: INSPECTOR, tool: "Write", file: join(work, "CLAUDE.md") }, noGit)));
  const broken = join(root, "broken-repo");
  mkdirSync(broken);
  writeFileSync(join(broken, ".git"), "gitdir: /nonexistent/broken\n");
  check("G7 unreadable repository metadata -> branch unknown -> denied", denied(hook({ agent: INSPECTOR, tool: "Write", file: join(broken, "CLAUDE.md") })));
  check("G7 developer edit in that broken repository -> allowed", hook({ tool: "Write", file: join(broken, "CLAUDE.md") }).code === 0);

  // --- G8: malformed hook input -----------------------------------------------------------------
  check("G8 empty input -> not identifiable -> allowed", hookRaw("").code === 0);
  check("G8 non-JSON without metadata -> allowed (nothing guessed)", hookRaw("not json at all").code === 0);
  check("G8 JSON without agent_type (metadata missing) -> allowed", hookRaw(JSON.stringify({ tool_name: "Write", tool_input: { file_path: join(main, "CLAUDE.md") } })).code === 0);
  const truncated = payload({ agent: INSPECTOR, tool: "Write", file: join(work, "CLAUDE.md") }).slice(0, -12);
  check("G8 truncated JSON that names the Inspector -> denied", denied(hookRaw(truncated)));
  check("G8 Inspector call without tool_input -> denied", denied(hookRaw(JSON.stringify({ agent_type: INSPECTOR, tool_name: "Write" }))));
  check("G8 Inspector call with a non-string path -> denied", denied(hookRaw(JSON.stringify({ agent_type: INSPECTOR, tool_name: "Edit", tool_input: { file_path: 42 } }))));
  check("G8 Inspector call with an unexpected tool -> denied", denied(hookRaw(JSON.stringify({ agent_type: INSPECTOR, tool_name: "Bash", tool_input: { command: "ls" } }))));
  check("G8 whitespace in the JSON still identifies the Inspector", denied(hookRaw(`{ "tool_name": "Write", "agent_type" : "${INSPECTOR}", "tool_input": { "file_path": "${join(main, "CLAUDE.md")}" } }`)));

  // --- G9: registration and scope ---------------------------------------------------------------
  const hooksJson = JSON.parse(readFileSync(join(PLUGIN, "hooks", "hooks.json"), "utf-8"));
  const events = Object.keys(hooksJson.hooks ?? {});
  check("G9 hooks/hooks.json registers only PreToolUse", JSON.stringify(events) === JSON.stringify(["PreToolUse"]), events.join(","));
  const entries = hooksJson.hooks.PreToolUse;
  check("G9 exactly one matcher, for the four editing tools only (no Bash)", entries.length === 1 && entries[0].matcher === "Write|Edit|MultiEdit|NotebookEdit" && !/Bash/.test(entries[0].matcher));
  check("G9 matcher tools = GUARDED_TOOLS", entries[0].matcher.split("|").join(",") === GUARDED_TOOLS.join(","));
  check("G9 one command hook, run from the plugin root", entries[0].hooks.length === 1 && entries[0].hooks[0].type === "command" && entries[0].hooks[0].command === 'sh "${CLAUDE_PLUGIN_ROOT}/scripts/write-guard.sh"');
  const manifest = JSON.parse(readFileSync(join(PLUGIN, ".claude-plugin", "plugin.json"), "utf-8"));
  check("G9 plugin.json does not re-register the default hooks file", manifest.hooks === undefined);
  const agentName = /^name:\s*(\S+)/m.exec(readFileSync(join(PLUGIN, "agents", "project-inspector.md"), "utf-8"))?.[1];
  check("G9 the guarded agent_type is exactly <plugin>:<agent>", JSON.stringify(INSPECTOR_AGENT_TYPES) === JSON.stringify([`${manifest.name}:${agentName}`]), JSON.stringify(INSPECTOR_AGENT_TYPES));
  check("G9 identification uses metadata, not paths or content", !/CLAUDE\.md|AUDIT\.md|docs\/project|\.ono/.test(readFileSync(HOOK, "utf-8").split("\n").filter((l) => !l.startsWith("#")).join("\n")));
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
