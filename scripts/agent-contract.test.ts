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
 *  - the Bun preflight precedes the first Bun call, and no other runtime is offered.
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
check("A3 every mode resolves the root through before-inspect steps 0–1", /Every mode — including `status` — first runs `hooks\/before-inspect.md` steps 0–1/.test(agent));
check("A3 preflight script exists", existsSync(join(PLUGIN, "scripts", "check-bun.sh")));

// --- A4: Project Root contract ---------------------------------------------------
check("A4 agent distinguishes Project Root and Git Root", /\*\*Project Root\*\*/.test(agent) && /\*\*Git Root\*\*/.test(agent));
check("A4 agent never descends into a subproject on its own", /never descend into a subproject on your own/.test(agent));
for (const kind of ["select-project", "confirm-project", "confirm-nested"]) {
  check(`A4 before-inspect handles the ${kind} decision`, before.includes(`\`${kind}\``));
}
check("A4 decisions stop before anything is written", /Exit 4 \/ `decision` set — a developer decision is required\. STOP/.test(before));
check("A4 nothing is migrated", /never move, copy, or merge existing Inspector artifacts/.test(before));

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
