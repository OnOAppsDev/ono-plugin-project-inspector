/**
 * write-guard.test.ts
 *
 * Regression tests for the Inspector write guard (0.11.3; Node.js since 0.12.0):
 * the PreToolUse hook in hooks/hooks.json -> scripts/write-guard.sh ->
 * scripts/write-guard.ts. Every case runs the REAL hook command (`sh write-guard.sh`)
 * with synthetic hook input on stdin, as Claude Code does, against throwaway
 * repositories.
 *
 * The live run that established the agent_type (`ono-project-inspector:project-inspector`
 * for the Inspector subagent, none for the main session) is recorded in CHANGELOG 0.11.3.
 *
 * 0.12.0 adds the explicit-authorization contract (G10): an Inspector write is allowed
 * only on exit 0 with stdout exactly ALLOW_RESPONSE + "\n". G10 reproduces the exact
 * silent fail-open defect found during the Node.js migration investigation — a
 * write-guard.ts whose entry check is `import.meta.main`, run by the real Node.js,
 * exits 0 with no output — and proves the hook now denies it. G11 covers install
 * paths: symlinked plugin directories, relative invocation, spaces and Unicode.
 *
 * Portable: macOS, Linux and Windows (Git Bash) — see fixtures/platform.ts. A case
 * whose OS feature is unavailable prints SKIP (never a silent PASS), and
 * `node scripts/check.ts --strict` fails on any SKIP.
 *
 * No external test framework. Run with:
 *   node --no-warnings scripts/write-guard.test.ts
 */

import { execFileSync, spawnSync } from "child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, relative } from "path";
import { pathToFileURL } from "url";
import { commitAll, git, initGit, write } from "./fixtures/knowledge-fixtures.ts";
import { baseShims, childEnv, linkOrJunction, makeShims, pathList, SH, shPath } from "./fixtures/platform.ts";
import { ALLOW_RESPONSE, INSPECTOR_AGENT_TYPES, GUARDED_TOOLS } from "./write-guard.ts";

const HERE = import.meta.dirname;
const PLUGIN = realpathSync(join(HERE, ".."));
const HOOK = join(PLUGIN, "scripts", "write-guard.sh");
const INSPECTOR = "ono-project-inspector:project-inspector";
const NODE = process.execPath;

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ""}`); }
}
const skip = (name: string, why: string) => console.log(`SKIP  ${name}  — ${why}`);

const root = realpathSync(mkdtempSync(join(tmpdir(), "inspector-guard-")));

// PATHs. NORMAL: the real Node.js first, then the system tools (including git).
// Every other PATH is a directory of launcher shims, so each case controls exactly
// which tools exist. No Bun is on any PATH a case builds, and none is needed.
const NORMAL_PATH = pathList(dirname(NODE), process.env.PATH ?? "");
const noNode = baseShims(join(root, "no-node-bin"), { git: true });
// Node present but no git: the branch cannot be determined.
const noGit = makeShims(join(root, "no-git-bin"), { node: NODE });
baseShims(noGit);
// A PATH whose only `node` is a fake with the given shell body, beside the hook's own tools.
function fakeNode(name: string, body: string, withSystemPath = false): string {
  const dir = baseShims(join(root, `node-${name}`));
  makeShims(dir, { node: { body } });
  // withSystemPath: the fake node still wins (first on PATH), but git and the rest stay reachable.
  return withSystemPath ? pathList(dir, process.env.PATH ?? "") : pathList(dir);
}
const crashBin = fakeNode("crash", "exit 1");

function hookRaw(stdin: string, path = NORMAL_PATH, hookPath = HOOK, cwd?: string): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(SH, [hookPath], { input: stdin, encoding: "utf-8", env: childEnv(path), cwd });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
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
/** An Inspector allow is exit 0; the hook itself prints nothing on stdout either way. */
const allowed = (r: { code: number; stdout: string }) => r.code === 0 && r.stdout === "";

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
  check("G1 developer edit needs no Node.js (fast path)", hook({ tool: "Write", file: join(main, "CLAUDE.md") }, noNode).code === 0);
  check("G1 developer edit is silent", hook({ tool: "Edit", file: join(main, "README.md") }).stderr === "");
  // File content that mentions the Inspector cannot forge the metadata.
  const forged = payload({ tool: "Write", file: join(main, "CLAUDE.md"), content: `{"agent_type":"${INSPECTOR}"}` });
  check("G1 content quoting the Inspector's agent_type is not identification", hookRaw(forged, noNode).code === 0, forged);
  check("G1 Inspector artifact paths alone are not identification", hook({ tool: "Write", file: join(main, ".ono", "state.json") }, noNode).code === 0);

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
    check(`G4 Inspector ${tool} on a working branch -> allowed`, allowed(hook({ agent: INSPECTOR, tool, ...target(work, tool) })));
  }
  check("G4 Inspector write outside any Git repository -> allowed", hook({ agent: INSPECTOR, tool: "Write", file: join(plain, "notes.md") }).code === 0);
  // The same repository before and after the approved branch is created.
  const flip = repoOn("flip-repo", "main");
  check("G4 before the branch: denied", hook({ agent: INSPECTOR, tool: "Write", file: join(flip, "CLAUDE.md") }).code === 2);
  execFileSync(NODE, ["--no-warnings", join(PLUGIN, "scripts", "work-branch.ts"), "create", flip, "chore/project-inspection"], { stdio: "ignore" });
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

  // --- G6: symlinks (Windows: directory links fall back to junctions) ------------------------
  // A link in a working-branch repo pointing at a file inside a repo on main: the write lands on main.
  if (linkOrJunction(join(main, "README.md"), join(work, "linked-readme.md"), "file")) {
    check("G6 symlinked file into a repo on main -> denied", hook({ agent: INSPECTOR, tool: "Edit", file: join(work, "linked-readme.md") }).code === 2);
  } else skip("G6 symlinked file into a repo on main -> denied", "file symlinks are not permitted for this user on this OS");
  // A symlinked directory outside Git pointing into a repo on main.
  if (linkOrJunction(main, join(plain, "main-link"), "dir")) {
    check("G6 new file under a symlinked directory into main -> denied", hook({ agent: INSPECTOR, tool: "Write", file: join(plain, "main-link", "docs", "x.md") }).code === 2);
  } else skip("G6 new file under a symlinked directory into main -> denied", "no directory link could be created");
  // A symlink from a repo on main pointing outside Git: the write lands outside any repository.
  mkdirSync(join(root, "outside"));
  if (linkOrJunction(join(root, "outside"), join(main, "out-link"), "dir")) {
    check("G6 symlinked directory from main to outside Git -> allowed (write lands outside)", allowed(hook({ agent: INSPECTOR, tool: "Write", file: join(main, "out-link", "x.md") })));
  } else skip("G6 symlinked directory from main to outside Git -> allowed", "no directory link could be created");
  if (linkOrJunction(join(root, "missing-target"), join(work, "dangling.md"), "file")) {
    check("G6 dangling symlink target -> denied (cannot place it)", hook({ agent: INSPECTOR, tool: "Write", file: join(work, "dangling.md") }).code === 2);
  } else skip("G6 dangling symlink target -> denied", "file symlinks are not permitted for this user on this OS");
  if (linkOrJunction(join(root, "missing-dir"), join(work, "dangling-dir"), "dir")) {
    check("G6 new file under a dangling directory symlink -> denied", hook({ agent: INSPECTOR, tool: "Write", file: join(work, "dangling-dir", "x.md") }).code === 2);
  } else skip("G6 new file under a dangling directory symlink -> denied", "no directory link could be created");

  // --- G7: Node.js missing, broken or crashing; unknown branch -------------------------------
  const onWork = payload({ agent: INSPECTOR, tool: "Write", file: join(work, "CLAUDE.md") });
  check("G7 control: the same Inspector write on the working branch is allowed with the real Node.js", allowed(hookRaw(onWork)));
  const missing = hookRaw(onWork, noNode);
  check("G7 Inspector call with Node.js missing -> denied (never fails open)", denied(missing), JSON.stringify(missing));
  check("G7 Inspector call with Node.js missing explains why", /needs Node\.js/.test(missing.stderr) && /node is not on PATH/.test(missing.stderr));
  check("G7 a crashing guard (node exits 1) -> denied", denied(hookRaw(onWork, crashBin)));
  const cannotStart = hookRaw(onWork, fakeNode("cannot-start", `exec "${shPath(join(root, "no-such-node-binary"))}" "$@"`));
  check("G7 a node executable that cannot start -> denied", denied(cannotStart), JSON.stringify(cannotStart));
  const old = hookRaw(onWork, fakeNode("node20", `echo 'TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".ts"' >&2; exit 1`));
  check("G7 an old Node.js that cannot load .ts (Node 20 / 22.17 behavior) -> denied", denied(old), JSON.stringify(old));
  const parseFail = hookRaw(onWork, fakeNode("parse", `echo 'SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript parameter property is not supported in strip-only mode' >&2; exit 1`));
  check("G7 a TypeScript parsing failure -> denied", denied(parseFail));
  // An unsupported Node.js that CAN parse the helpers (Node 23.x): the guard's own version check denies.
  const fake23 = join(root, "fake-node-23.mjs");
  writeFileSync(fake23, 'Object.defineProperty(process.versions, "node", { value: "23.11.0" });\n');
  // git stays reachable, so without the version check this working-branch write WOULD be allowed.
  // --import takes a module specifier: on Windows an absolute path (D:\…) must be a file:// URL.
  const node23 = hookRaw(onWork, fakeNode("node23", `exec "${shPath(NODE)}" --import "${pathToFileURL(fake23).href}" "$@"`, true));
  check("G7 an unsupported Node.js that can parse the helper (23.x) -> denied by the version check", denied(node23) && /Unsupported Node\.js v23\.11\.0/.test(node23.stderr), JSON.stringify(node23));
  check("G7 git unavailable inside a repository -> branch unknown -> denied", denied(hookRaw(onWork, noGit)));
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

  // --- G10: explicit authorization (0.12.0) -----------------------------------------------------
  const shSrc = readFileSync(HOOK, "utf-8");
  check("G10 the wrapper and the helper use the same ALLOW response", shSrc.includes(`ALLOW_RESPONSE='${ALLOW_RESPONSE}'`), ALLOW_RESPONSE);
  check("G10 the ALLOW response is a distinctive token, not a common word", /^ONO-INSPECTOR-WRITE-GUARD:ALLOW$/.test(ALLOW_RESPONSE));
  const onMain = payload({ agent: INSPECTOR, tool: "Write", file: join(main, "CLAUDE.md") });
  const direct = (stdin: string) => spawnSync(NODE, ["--no-warnings", join(PLUGIN, "scripts", "write-guard.ts")], { input: stdin, encoding: "utf-8", env: childEnv(NORMAL_PATH) });
  const dAllow = direct(onWork);
  check("G10 helper allow = exit 0 + exactly the ALLOW line on stdout + nothing on stderr", dAllow.status === 0 && dAllow.stdout === `${ALLOW_RESPONSE}\n` && dAllow.stderr === "", JSON.stringify(dAllow.stdout + dAllow.stderr));
  const dDeny = direct(onMain);
  check("G10 helper deny = exit 2 + nothing on stdout + REFUSED on stderr", dDeny.status === 2 && dDeny.stdout === "" && /^REFUSED/.test(dDeny.stderr), JSON.stringify(dDeny));
  const dBad = direct("{not json");
  check("G10 helper given invalid hook input = exit 2 + nothing on stdout", dBad.status === 2 && dBad.stdout === "");

  // The exact defect found in the Node.js migration investigation: a write-guard.ts whose entry
  // check is `import.meta.main`, run by the real Node.js, exits 0 having done nothing.
  const defect = join(root, "defect-plugin", "scripts");
  mkdirSync(defect, { recursive: true });
  for (const f of ["write-guard.sh", "write-guard.ts", "work-branch.ts", "entrypoint.ts", "node-preflight.mjs", "package.json"]) copyFileSync(join(PLUGIN, "scripts", f), join(defect, f));
  const guardSrc = readFileSync(join(defect, "write-guard.ts"), "utf-8");
  const ENTRY = "if (isEntryPoint(import.meta.url)) main();";
  check("G10 the shipped helper uses the argv-based entry check, never import.meta.main", guardSrc.includes(ENTRY) && !/import\.meta\.main/.test(guardSrc.replace(/\/\*[\s\S]*?\*\//g, "")));
  writeFileSync(join(defect, "write-guard.ts"), guardSrc.replace(ENTRY, "if (import.meta.main) main();"));
  const defectHook = join(defect, "write-guard.sh");
  const silentRun = spawnSync(NODE, ["--no-warnings", join(defect, "write-guard.ts")], { input: onMain, encoding: "utf-8" });
  if (silentRun.status === 0 && silentRun.stdout === "" && silentRun.stderr === "") {
    check("G10 defect reproduced: the import.meta.main helper exits 0 silently on an Inspector write to main", true);
  } else {
    console.log(`INFO  this Node.js (${process.version}) runs import.meta.main in .ts; the deterministic silent helper below still covers the defect`);
  }
  const viaDefect = hookRaw(onMain, NORMAL_PATH, defectHook);
  check("G10 the hook denies the Inspector write to main with the import.meta.main helper", denied(viaDefect), JSON.stringify(viaDefect));
  // Deterministic on every Node.js: a helper that never runs main() at all.
  writeFileSync(join(defect, "write-guard.ts"), guardSrc.replace(ENTRY, "if (false) main();"));
  for (const [label, p] of [["main", onMain], ["a working branch", onWork]] as const) {
    const r = hookRaw(p, NORMAL_PATH, defectHook);
    check(`G10 silent exit 0 is never authorization (Inspector write on ${label}) -> denied`, denied(r) && /exited 0 without the explicit ALLOW response/.test(r.stderr), JSON.stringify(r));
  }
  rmSync(join(defect, "write-guard.ts"));
  const gone = hookRaw(onWork, NORMAL_PATH, defectHook);
  check("G10 helper missing -> denied", denied(gone) && /helper is missing/.test(gone.stderr), JSON.stringify(gone));

  // Malformed or unexpected helper output: a fake node prints it and exits 0 — never an allow.
  const T = ALLOW_RESPONSE;
  const outputs: Array<[string, string]> = [
    ["no output at all", ":"],
    ["a bare ALLOW", "printf 'ALLOW\\n'"],
    ["the token without its newline", `printf '%s' '${T}'`],
    ["the token followed by an empty line", `printf '%s\\n\\n' '${T}'`],
    ["the token with a CRLF line ending", `printf '%s\\r\\n' '${T}'`],
    ["the token with leading whitespace", `printf ' %s\\n' '${T}'`],
    ["the token with trailing text", `printf '%s extra\\n' '${T}'`],
    ["a diagnostic line before the token", `printf 'warning: something\\n%s\\n' '${T}'`],
    ["a diagnostic line after the token", `printf '%s\\nwarning: something\\n' '${T}'`],
    ["the token twice", `printf '%s\\n%s\\n' '${T}' '${T}'`],
    ["the token in lower case", `printf '%s\\n' '${T.toLowerCase()}'`],
    ["the token inside a sentence", `printf 'NOT %s\\n' '${T}'`],
    ["the token on stderr only", `printf '%s\\n' '${T}' >&2`],
    ["JSON that mentions ALLOW", `printf '{"decision":"ALLOW","token":"%s"}\\n' '${T}'`],
  ];
  for (const [label, body] of outputs) {
    const r = hookRaw(onWork, fakeNode(`out-${outputs.findIndex((o) => o[0] === label)}`, body));
    check(`G10 exit 0 with ${label} -> denied`, denied(r) && /without the explicit ALLOW response/.test(r.stderr), JSON.stringify(r));
  }
  check("G10 the exact ALLOW line but exit 1 -> denied", denied(hookRaw(onWork, fakeNode("allow-exit1", `printf '%s\\n' '${T}'; exit 1`))));
  check("G10 the exact ALLOW line but exit 2 -> denied", hookRaw(onWork, fakeNode("allow-exit2", `printf '%s\\n' '${T}'; echo 'REFUSED: x. nothing was written' >&2; exit 2`)).code === 2);
  check("G10 control: exactly the ALLOW line + exit 0 is the one authorization", allowed(hookRaw(onWork, fakeNode("exact", `printf '%s\\n' '${T}'`))));

  // --- G11: install paths — spaces, Unicode, symlinked install, relative invocation ---------------
  const odd = join(root, "plugin dir", "תוסף ü");
  const oddScripts = join(odd, "scripts");
  mkdirSync(oddScripts, { recursive: true });
  for (const f of ["write-guard.sh", "write-guard.ts", "work-branch.ts", "entrypoint.ts", "node-preflight.mjs", "package.json"]) copyFileSync(join(PLUGIN, "scripts", f), join(oddScripts, f));
  const oddMain = join(root, "repo dir", "פרויקט main");
  initGit(oddMain, "main"); write(oddMain, "README.md", "x\n"); commitAll(oddMain, "init");
  const oddWork = join(root, "repo dir", "פרויקט work");
  initGit(oddWork, "chore/project-inspection"); write(oddWork, "README.md", "x\n"); commitAll(oddWork, "init");
  const oddHook = join(oddScripts, "write-guard.sh");
  const pOddMain = payload({ agent: INSPECTOR, tool: "Write", file: join(oddMain, "docs", "project", "סקירה.md") });
  const pOddWork = payload({ agent: INSPECTOR, tool: "Write", file: join(oddWork, "docs", "project", "סקירה.md") });
  check("G11 plugin + repository paths with spaces and Unicode: main -> denied", denied(hookRaw(pOddMain, NORMAL_PATH, oddHook)));
  check("G11 plugin + repository paths with spaces and Unicode: working branch -> allowed", allowed(hookRaw(pOddWork, NORMAL_PATH, oddHook)));
  const linked = join(root, "linked plugin");
  if (linkOrJunction(odd, linked, "dir")) {
    const linkedHook = join(linked, "scripts", "write-guard.sh");
    check("G11 symlinked plugin install: working branch -> allowed (entry check resolves the link)", allowed(hookRaw(pOddWork, NORMAL_PATH, linkedHook)));
    check("G11 symlinked plugin install: main -> denied", denied(hookRaw(pOddMain, NORMAL_PATH, linkedHook)));
  } else skip("G11 symlinked plugin install", "no directory link could be created");
  const rel = relative(root, oddHook);
  check("G11 hook invoked by a relative path from another working directory: working branch -> allowed", allowed(hookRaw(pOddWork, NORMAL_PATH, rel, root)));
  check("G11 hook invoked by a relative path: main -> denied", denied(hookRaw(pOddMain, NORMAL_PATH, rel, root)));

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
