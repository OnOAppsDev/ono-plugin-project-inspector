/**
 * knowledge-templates.test.ts
 *
 * Contract test between the LLM-facing templates embedded in the
 * project-analysis / project-docs SKILL.md files and the deterministic side
 * (scripts/knowledge-model.ts, skills/registry.json `knowledgeModel`, the
 * after-hooks, docs/repo-knowledge-contract.md). The skills write documents
 * in exactly the shapes the parsers index, so any drift between them would
 * silently turn knowledge into `unknown`. Reads files only.
 *
 * No external test framework. Run with:
 *   bun scripts/knowledge-templates.test.ts
 */

import { readFileSync } from "fs";
import { join } from "path";
import {
  headingAnchors,
  GENERIC_PATTERN_SECTIONS,
  CAPABILITY_FIELDS,
  RELATIONSHIP_TYPES,
  EVIDENCE_KINDS,
  FORM_FACTORS,
  SURFACES_HEADER,
  SHARED_CODE_HEADER,
  RELATIONSHIPS_HEADER,
} from "./knowledge-model";

const HERE = typeof __dirname !== "undefined" ? __dirname : ".";
const ROOT = join(HERE, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf-8");

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ""}`); }
}

/**
 * Text of one embedded template: from its `### <name> Template` heading to the
 * next template heading or the next `## Step` heading. (Templates themselves
 * contain `##` headings, so a generic "next heading" boundary would cut them.)
 */
function template(md: string, name: string): string {
  const start = md.indexOf(`### ${name} Template`);
  if (start < 0) return "";
  const rest = md.slice(start + 1);
  const next = rest.search(/\n### [^\n]* Template\n|\n## Step /);
  return next < 0 ? rest : rest.slice(0, next);
}

const analysis = read("skills/project-analysis/SKILL.md");
const docs = read("skills/project-docs/SKILL.md");
const registry = JSON.parse(read("skills/registry.json"));
const contract = read("docs/repo-knowledge-contract.md");
const afterAnalysis = read("hooks/after-project-analysis.md");
const afterDocs = read("hooks/after-project-docs.md");

const claudeTpl = template(analysis, "CLAUDE.md");
const patternsTpl = template(docs, "patterns.md");
const componentsTpl = template(docs, "components.md");
const integrationsTpl = template(docs, "integrations.md");
const capabilitiesTpl = template(docs, "capabilities.md");

// --- C1: CLAUDE.md template carries the fixed-column surfaces model ---
check("C1 surfaces table header matches the parser", claudeTpl.includes(SURFACES_HEADER), SURFACES_HEADER);
check("C1 shared-code table header matches the parser", claudeTpl.includes("### Shared Code") && claudeTpl.includes(SHARED_CODE_HEADER));
check("C1 form factor vocabulary documented verbatim", FORM_FACTORS.every((f: string) => analysis.includes(`\`${f}\``)));
check("C1 form factor explicitly not device_type", /not.{0,40}device_type/i.test(analysis));
{
  const block = claudeTpl.match(/repo-knowledge:facts:start -->([\s\S]*?)<!-- repo-knowledge:facts:end/);
  const keys = (block?.[1] ?? "").split("\n").filter((l) => /^[a-z_]+:/.test(l.trim()));
  check("C1 facts block unchanged: still exactly nine keys", keys.length === 9, JSON.stringify(keys));
}

// --- C2: patterns.md template carries the generic sections + override rule ---
for (const s of GENERIC_PATTERN_SECTIONS) check(`C2 patterns template has "## ${s}"`, patternsTpl.includes(`\n## ${s}\n`));
check("C2 override heading rule documented", docs.includes("### <Section> (<surface-id>)"));
check("C2 no TV-specific heading in the generic patterns template",
  !patternsTpl.split("\n").some((l) => /^#{2,3} .*(\bTV\b|Focus|Remote|Leanback|tvOS)/i.test(l)));

// --- C3: inventory scoping columns ---
for (const [label, tpl, heads] of [
  ["components", componentsTpl, ["| Screen |", "| Component |", "| Name |"]],
  ["integrations", integrationsTpl, ["| Service / API |", "| SDK |"]],
] as Array<[string, string, string[]]>) {
  for (const h of heads) {
    const line = tpl.split("\n").find((l) => l.startsWith(h)) ?? "";
    check(`C3 ${label} table "${h}" has a Surface column`, /\|\s*Surface\s*\|/.test(line), line);
  }
}

// --- C4: capabilities.md template matches the parser ---
check("C4 capabilities template exists", capabilitiesTpl.length > 0);
check("C4 capability heading form", capabilitiesTpl.includes("### Capability: {{CAPABILITY_ID}}"));
check("C4 capability fields match the parser", CAPABILITY_FIELDS.every((f: string) => capabilitiesTpl.includes(`| ${f} |`)), JSON.stringify(CAPABILITY_FIELDS));
check("C4 relationships header matches the parser", capabilitiesTpl.includes(RELATIONSHIPS_HEADER));
check("C4 relationship vocabulary documented", RELATIONSHIP_TYPES.every((t: string) => docs.includes(`\`${t}\``)));
check("C4 evidence kinds documented", EVIDENCE_KINDS.every((k: string) => docs.includes(`\`${k}\``)));
check("C4 name similarity explicitly insufficient", /naming|name similarity/i.test(docs) && /never|not enough|insufficient/i.test(docs));

// --- C5: registry knowledgeModel is satisfiable by the templates ---
const stage = (id: string) => registry.skills.find((s: any) => s.id === id);
check("C5 project-docs produces capabilities.md", stage("project-docs").produces.includes("docs/project/capabilities.md"));
const templateFor: Record<string, string> = {
  "CLAUDE.md": claudeTpl,
  "docs/project/patterns.md": patternsTpl,
  "docs/project/capabilities.md": capabilitiesTpl,
};
for (const id of ["project-analysis", "project-docs"]) {
  const model: string[] = stage(id).knowledgeModel ?? [];
  check(`C5 ${id} declares a knowledgeModel`, model.length > 0);
  for (const req of model) {
    const [path, anchor] = req.split("#");
    check(`C5 ${id}: "${req}" is produced by the stage`, stage(id).produces.includes(path), JSON.stringify(stage(id).produces));
    if (anchor) check(`C5 ${id}: "${req}" anchor exists in the template`, headingAnchors(templateFor[path] ?? "").includes(`#${anchor}`));
  }
}

// --- C6: evidence discipline and the volatile-knowledge boundary are in both skills ---
for (const [label, md] of [["project-analysis", analysis], ["project-docs", docs]] as Array<[string, string]>) {
  check(`C6 ${label}: evidence ref syntax documented`, md.includes("`path::token`"));
  check(`C6 ${label}: volatile platform knowledge excluded`, /volatile/i.test(md) && /workaround/i.test(md));
}
check("C6 project-docs output contract lists five files", /five/.test(docs) && docs.includes("docs/project/capabilities.md"));

// --- C7: after-hooks gate on evidence before certifying knowledge ---
{
  const a = afterAnalysis.indexOf("knowledge-evidence.ts verify <TARGET_ROOT> surfaces");
  const aRec = afterAnalysis.indexOf("record-knowledge <TARGET_ROOT> project-analysis");
  check("C7 after-project-analysis verifies surfaces evidence before record-knowledge", a > 0 && aRec > a);
  const d = afterDocs.indexOf("knowledge-evidence.ts verify <TARGET_ROOT> docs");
  const dRec = afterDocs.indexOf("record-knowledge <TARGET_ROOT> project-docs");
  check("C7 after-project-docs verifies docs evidence before record-knowledge", d > 0 && dRec > d);
  check("C7 after-project-docs verifies capabilities.md exists", afterDocs.includes("docs/project/capabilities.md"));
}

// --- C8: the contract documents the extension and its limits ---
for (const term of ["`surfaces`", "`sharedCode`", "`surfaceAnchors`", "`capabilities`", "`capabilityRelationships`", "`knowledgeModel`"]) {
  check(`C8 contract documents ${term}`, contract.includes(term));
}
check("C8 contract: current source is authoritative", /current (repository )?source[^.]*authoritative/i.test(contract));
check("C8 contract: Project Knowledge never decides routing", /never[^.]*(routing|device_type)/i.test(contract));
check("C8 contract: schema stays v1", contract.includes("**Schema version: 1**"));

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures > 0 ? 1 : 0);
