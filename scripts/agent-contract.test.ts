/**
 * agent-contract.test.ts
 *
 * Static regression tests for the Inspector agent's execution contract (0.11.2):
 *
 *  - the agent has every tool its own workflow needs (skills run inline in the
 *    agent's context, hooks run Bun helpers, skills write artifacts) and no
 *    unrelated ones;
 *  - every plugin-internal path is resolved from the plugin install directory
 *    (`${CLAUDE_PLUGIN_ROOT}` in substituted markdown, `<PLUGIN_ROOT>` in the
 *    hook files the agent reads as plain files) — never relative to the
 *    developer's repository or the current working directory;
 *  - every referenced plugin file actually exists;
 *  - the Bun preflight precedes the first Bun call, and no other runtime is offered;
 *  - (0.11.3) the protected-branch workflow: a read-only branch check at
 *    startup, a single-approval Working-Branch Gate before the first write in
 *    every writing mode, no remote or history-changing Git instruction, and a
 *    mechanical guard in every helper that writes.
 *
 * No external test framework. Run with:
 *   bun scripts/agent-contract.test.ts
 */

import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

const HERE = typeof __dirname !== "undefined" ? __dirname : ".";
const PLUGIN = join(HERE, "..");

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ""}`); }
}

const read = (rel: string) => readFileSync(join(PLUGIN, rel), "utf-8");
const listMd = (dir: string) => readdirSync(join(PLUGIN, dir)).filter((f) => f.endsWith(".md")).map((f) => `${dir}/${f}`);
const skillFiles = readdirSync(join(PLUGIN, "skills"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => `skills/${d.name}/SKILL.md`);
const hookFiles = listMd("hooks");
const commandFiles = listMd("commands");
const agentFile = "agents/project-inspector.md";
const agent = read(agentFile);
const manifest = JSON.parse(read(".claude-plugin/plugin.json"));
const registry = JSON.parse(read("skills/registry.json"));

// --- A1: tools ---------------------------------------------------------------
const front = agent.split("\n---")[0];
const toolsLine = front.split("\n").find((l) => l.startsWith("tools:")) ?? "";
const tools = toolsLine.replace("tools:", "").split(",").map((t) => t.trim()).filter(Boolean);
for (const t of ["Read", "Skill", "Bash", "Write", "Edit", "Glob", "Grep"]) {
  check(`A1 agent has ${t}`, tools.includes(t), toolsLine);
}
for (const t of ["Agent", "WebFetch", "WebSearch", "NotebookEdit"]) {
  check(`A1 agent does not have ${t}`, !tools.includes(t), toolsLine);
}
check("A1 manifest registers the agent", (manifest.agents ?? []).includes("./agents/project-inspector.md"));
check("A1 agent name matches what the commands invoke", /\nname: project-inspector\n/.test(front) && commandFiles.every((c) => read(c).includes("`project-inspector` agent")));

// Why each tool is needed — derived from the workflow files, so a tool cannot silently become unneeded or required.
const hookText = hookFiles.map(read).join("\n");
const skillText = skillFiles.map(read).join("\n");
check("A1 Bash is required: hooks run Bun helpers", /bun "<PLUGIN_ROOT>\/scripts\//.test(hookText));
check("A1 Write is required: skills write their declared artifacts", registry.skills.some((s: any) => s.type === "workflow" && (s.produces ?? []).length > 0));
check("A1 Edit is required: Update mode / managed blocks edit existing artifacts", /Update/.test(skillText) && /managed block/i.test(skillText));
check("A1 agent explains that skills run inside its own context", /run inside \*\*your\*\* context/.test(agent));

// --- A2: plugin-root resolution ----------------------------------------------
check("A2 agent defines PLUGIN_ROOT from ${CLAUDE_PLUGIN_ROOT}", agent.includes("`PLUGIN_ROOT` is `${CLAUDE_PLUGIN_ROOT}`"));
check("A2 agent defines the <PLUGIN_ROOT> placeholder used by hook files", agent.includes("<PLUGIN_ROOT>") && /not a shell variable/.test(agent));
check("A2 agent reads the registry by absolute plugin path", agent.includes("`${CLAUDE_PLUGIN_ROOT}/skills/registry.json`"));
check("A2 agent reads hooks by absolute plugin path", agent.includes("`${CLAUDE_PLUGIN_ROOT}/hooks/<name>.md`"));

const all = [agentFile, ...hookFiles, ...skillFiles, ...commandFiles];
for (const f of all) {
  const text = read(f);
  check(`A2 ${f}: no bare relative 'bun scripts/' call`, !/bun scripts\//.test(text), (text.match(/.{0,40}bun scripts\/.{0,40}/) ?? [""])[0]);
  // Other runtimes may only appear inside a prohibition ("never … node / npx tsx …").
  const offers = text.split("\n").filter((l) => /TypeScript runner|npx tsx|ts-node|\bdeno\b/.test(l) && !/\b(never|not)\b/i.test(l));
  check(`A2 ${f}: no other-runtime fallback offered`, offers.length === 0, offers.join(" | ").slice(0, 200));
}
for (const f of hookFiles) {
  // Hook files are read with the Read tool: ${CLAUDE_PLUGIN_ROOT} would never be substituted there.
  check(`A2 ${f}: uses <PLUGIN_ROOT>, never an unsubstituted \${CLAUDE_PLUGIN_ROOT}`, !read(f).includes("${CLAUDE_PLUGIN_ROOT}"));
}

// Every referenced plugin path exists.
const refs = new Set<string>();
for (const f of all) {
  for (const m of read(f).matchAll(/(?:\$\{CLAUDE_PLUGIN_ROOT\}|<PLUGIN_ROOT>)\/([A-Za-z0-9_./-]+[A-Za-z0-9_-])/g)) {
    if (!m[1].includes("<")) refs.add(m[1]);
  }
}
check("A2 plugin-root references were found", refs.size >= 10, [...refs].join(", "));
for (const r of [...refs].sort()) check(`A2 referenced plugin file exists: ${r}`, existsSync(join(PLUGIN, r)));
for (const s of registry.skills) {
  for (const h of Object.values(s.hooks ?? {}) as string[]) check(`A2 registry hook file exists: hooks/${h}.md`, existsSync(join(PLUGIN, "hooks", `${h}.md`)));
}
for (const name of ["inspection-state", "repo-knowledge"]) {
  check(`A2 skills/${name}: runs its helper from \${CLAUDE_PLUGIN_ROOT}`, read(`skills/${name}/SKILL.md`).includes(`bun "\${CLAUDE_PLUGIN_ROOT}/scripts/${name}.ts"`));
}

// --- A3: Bun preflight ordering ------------------------------------------------
const before = read("hooks/before-inspect.md");
const preflight = before.indexOf('sh "<PLUGIN_ROOT>/scripts/check-bun.sh"');
const firstBun = before.search(/bun "<PLUGIN_ROOT>\/scripts\/[a-z-]+\.ts"/);
check("A3 before-inspect runs the Bun preflight", preflight > 0);
check("A3 preflight precedes the first Bun helper call", preflight > 0 && firstBun > preflight, `${preflight} vs ${firstBun}`);
check("A3 preflight is step 0, before root resolution", before.indexOf("0. **Bun preflight") > 0 && before.indexOf("0. **Bun preflight") < before.indexOf("1. **Resolve the Project Root"));
check("A3 missing Bun stops without writing and without another runtime", /STOP/.test(before.slice(preflight, firstBun)) && /never run a helper with another runtime/i.test(before));
check("A3 agent runs the preflight in every mode", /Bun preflight .*before the first `bun` call in \*\*every\*\* mode/.test(agent));
check("A3 every mode resolves the root and branch through before-inspect steps 0–2", /Every mode — including `status` — first runs `hooks\/before-inspect.md` steps 0–2/.test(agent));
check("A3 preflight script exists", existsSync(join(PLUGIN, "scripts", "check-bun.sh")));

// --- A4: Project Root contract ---------------------------------------------------
check("A4 agent distinguishes Project Root and Git Root", /\*\*Project Root\*\*/.test(agent) && /\*\*Git Root\*\*/.test(agent));
check("A4 agent never descends into a subproject on its own", /never descend into a subproject on your own/.test(agent));
for (const kind of ["select-project", "confirm-project", "confirm-nested"]) {
  check(`A4 before-inspect handles the ${kind} decision`, before.includes(`\`${kind}\``));
}
check("A4 decisions stop before anything is written", /Exit 4 \/ `decision` set — a developer decision is required\. STOP/.test(before));
check("A4 nothing is migrated", /never move, copy, or merge existing Inspector artifacts/.test(before));

// --- A5: protected-branch workflow (0.11.3) ---------------------------------------
const branchCheck = before.indexOf('bun "<PLUGIN_ROOT>/scripts/work-branch.ts" check <TARGET_ROOT>');
const resolveIdx = before.indexOf("1. **Resolve the Project Root");
const detectIdx = before.indexOf('inspection-state.ts" detect <TARGET_ROOT>');
check("A5 before-inspect runs a read-only branch check after root resolution and before detect", branchCheck > resolveIdx && resolveIdx > 0 && detectIdx > branchCheck, `${resolveIdx} ${branchCheck} ${detectIdx}`);
check("A5 the startup branch check never creates a branch", /2\. \*\*Branch state \(read-only\)\.\*\*[^\n]*never create one in this step/.test(before));
check("A5 startup never migrates (migrate waits for the gate)", /do \*\*not\*\* migrate here/.test(before) && !/invoke `inspection-state` \(`migrate`\) before continuing/.test(before));
check("A5 agent defines the Working-Branch Gate", /^## Working-Branch Gate$/m.test(agent));
const gate = agent.slice(agent.indexOf("## Working-Branch Gate"), agent.indexOf("## Refresh Project Knowledge"));
check("A5 gate runs before the first write in every writing mode", /immediately before its first write of any kind/.test(gate) && /`full` after the developer's choice, `targeted`, `resume`, `maintenance`/.test(gate));
check("A5 gate never runs in status mode or on 'leave unchanged'", /never runs in `status` mode, and never when the developer chose "leave everything unchanged"/.test(gate));
check("A5 gate passes silently on a working branch", /the gate passes silently: no question, no new branch/.test(gate));
check("A5 gate asks exactly once and suggests chore/project-inspection", /Ask once\./.test(gate) && /`chore\/project-inspection`/.test(gate) && /give another branch name/.test(gate));
check("A5 gate creates through the helper by absolute plugin path", gate.includes('bun "${CLAUDE_PLUGIN_ROOT}/scripts/work-branch.ts" create <TARGET_ROOT> <name>'));
check("A5 gate validates custom names through the helper", gate.includes('bun "${CLAUDE_PLUGIN_ROOT}/scripts/work-branch.ts" check <TARGET_ROOT> <name>'));
check("A5 gate stops on a failed creation", /Exit 7 or anything else — STOP/.test(gate));
check("A5 gate never reuses, resets or deletes a branch, nor discards changes", /Never\*\* reuse, reset, move, or delete an existing branch/.test(gate) && /never stash, restore, clean, or discard changes/.test(gate));
check("A5 developer stays on the working branch; no commit/push/PR by the Inspector", /\*\*stays on it\*\*/.test(gate) && /the Inspector never does/.test(gate));
check("A5 the Smart Startup menu choice is the single approval", /Choosing such an option \(with or without a custom name\) \*\*is\*\* the single approval/.test(agent));
check("A5 status mode never creates a branch", /never create a branch in this mode/.test(agent));
check("A5 helper exit 5 is a STOP with no bypass", /exit \*\*5\*\* on a protected branch/.test(agent) && /there is no bypass flag/.test(agent));
for (const f of commandFiles) {
  check(`A5 ${f} documents the protected-branch behavior`, /`main`, `master`, or a detached HEAD/.test(read(f)));
}

// No instruction anywhere tells the agent to run a remote or history-changing Git
// command; every mention must be a prohibition. The read-only shell policy keeps
// forbidding branch switching for skills.
const GIT_WRITE = /\bgit (push|fetch|pull|merge|commit|stash|reset|restore|clean|rebase|checkout|switch)\b/;
const instructionFiles = [agentFile, ...hookFiles, ...commandFiles, ...skillFiles, "README.md"];
const offenders: string[] = [];
for (const f of instructionFiles) {
  read(f).split("\n").forEach((line, i) => {
    if (GIT_WRITE.test(line) && !/\b(never|Never|not|no|refuse|forbid)/.test(line)) offenders.push(`${f}:${i + 1}`);
  });
}
check("A5 no instruction runs a remote or history-changing Git command", offenders.length === 0, offenders.join(", "));
const shellRules = read("docs/shell-execution-rules.md");
check("A5 skills' shell policy still forbids git switch / checkout / stash-free resets", ["git checkout", "git switch", "git reset", "git commit", "git restore", "git clean"].every((c) => shellRules.slice(shellRules.indexOf("Never use:")).includes(c)));

// Mechanical backstop: every non-test helper that mutates the filesystem imports
// the protected-branch guard, so a new write path cannot silently skip it.
const MUTATES = /\b(writeFileSync|appendFileSync|mkdirSync|rmSync|renameSync|unlinkSync|copyFileSync)\(/;
const helpers = readdirSync(join(PLUGIN, "scripts")).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "live-smoke.ts" && f !== "work-branch.ts");
for (const f of helpers) {
  const src = read(`scripts/${f}`);
  if (!MUTATES.test(src)) continue;
  check(`A5 scripts/${f} writes, so it imports the protected-branch guard`, /from "\.\/work-branch"/.test(src) && /(assertWritable|guardWrite)\(/.test(src));
}
check("A5 verify-artifacts refuses to complete a stage on a protected branch", /branchState\(repoRoot\)/.test(read("scripts/verify-artifacts.ts")) && /EXIT_PROTECTED/.test(read("scripts/verify-artifacts.ts")));
check("A5 the guard has no bypass (no env/flag override)", !/process\.env\.[A-Z_]*(ALLOW|BYPASS|FORCE|SKIP)/.test(read("scripts/work-branch.ts")) && !/--force|--allow-protected/.test(read("scripts/work-branch.ts")));

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
