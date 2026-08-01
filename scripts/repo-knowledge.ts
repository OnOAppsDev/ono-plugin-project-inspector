/**
 * repo-knowledge.ts
 *
 * Deterministic helper that owns the repository-knowledge manifest at
 * `<repo>/.ono/repo-knowledge.json`. Invoked by the internal `repo-knowledge`
 * skill (skills/repo-knowledge/SKILL.md), which the project-inspector agent
 * calls automatically whenever repository knowledge changes.
 *
 * Design contract:
 * - DERIVED, NEVER AUTHORED. It reads only artifacts the workflow has already
 *   produced and a human has already approved: CLAUDE.md, AUDIT.md, and
 *   docs/project/*.md. It never reads repository source, so it introduces no
 *   new analysis and no new approval gate.
 * - POINTERS, NOT COPIES. Prose stays in the approved artifact; the manifest
 *   carries paths plus heading anchors so consumers can cite a section.
 * - PORTABLE. Only repo-relative paths, hashes, and the git SHA are persisted.
 * - DETERMINISTIC. Same inputs produce a byte-identical file except for
 *   `generatedAt`. Every array is explicitly sorted.
 * - The `.ono/` directory is the shared Ono infrastructure directory; this
 *   plugin owns `state.json` and `repo-knowledge.json` within it.
 *
 * Usage:
 *   bun scripts/repo-knowledge.ts <emit|validate|show> <repo-root>
 *
 * Exit codes:
 *   0 - success
 *   1 - usage error, missing repo root, or a .claude/worktrees path
 *   2 - manifest absent (validate) or present but invalid
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync } from "fs";
import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { join, sep } from "path";
import { slugify } from "./slugify";

/** Bump only for a breaking shape change; additive fields keep version 1. */
export const REPO_KNOWLEDGE_SCHEMA_VERSION = 1;

const WORKTREE_MARKER = `${sep}.claude${sep}worktrees${sep}`;

/** Every artifact the manifest derives from, in fingerprint order. */
const SOURCE_ARTIFACTS = [
  "CLAUDE.md",
  "AUDIT.md",
  "docs/project/overview.md",
  "docs/project/components.md",
  "docs/project/patterns.md",
  "docs/project/integrations.md",
] as const;

/** documents[] key -> repo-relative path. */
const DOCUMENT_MAP: Array<[string, string]> = [
  ["claudeMd", "CLAUDE.md"],
  ["auditMd", "AUDIT.md"],
  ["overview", "docs/project/overview.md"],
  ["inventory", "docs/project/components.md"],
  ["conventions", "docs/project/patterns.md"],
  ["integrations", "docs/project/integrations.md"],
];

type Coverage = "populated" | "partial" | "unknown";

interface DocumentRef {
  path: string;
  exists: boolean;
  anchors: string[];
}

interface AuditTopicRef {
  topic: string;
  slug: string;
  status: string;
  file: string;
}

export interface RepoKnowledge {
  repoKnowledgeSchemaVersion: number;
  producedBy: { plugin: string; version: string };
  generatedAt: string;
  fingerprint: { gitHead: string | null; artifacts: Record<string, string | null> };
  coverage: Record<string, Coverage>;
  stack: {
    languages: string[];
    frameworks: string[];
    platformHints: string[];
    runtimeTooling: string[];
    packageManagers: string[];
  };
  commands: { install: string | null; run: string | null; test: string | null; build: string | null };
  structure: { repositoryTree: string | null; keyModules: string | null; entryPoints: string | null };
  documents: Record<string, DocumentRef>;
  auditTopics: AuditTopicRef[];
}

function manifestPath(repoRoot: string): string {
  return join(repoRoot, ".ono", "repo-knowledge.json");
}

function readIfExists(repoRoot: string, rel: string): string | null {
  const p = join(repoRoot, rel);
  return existsSync(p) ? readFileSync(p, "utf-8") : null;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

function gitHead(repoRoot: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

/** Current plugin identity, read from the plugin's own manifest (portable, relative to this script). */
function currentPlugin(): { plugin: string; version: string } {
  try {
    const m = JSON.parse(readFileSync(join(__dirname, "..", ".claude-plugin", "plugin.json"), "utf-8"));
    return { plugin: m.name ?? "ono-project-inspector", version: m.version ?? "0.0.0" };
  } catch {
    return { plugin: "ono-project-inspector", version: "0.0.0" };
  }
}

/**
 * GitHub-style anchors for every `##`/`###` heading. Re-derived on every emit
 * from live headings so an anchor can never be stale relative to the document.
 */
export function headingAnchors(md: string): string[] {
  const out: string[] = [];
  for (const line of md.split("\n")) {
    if (!/^#{2,3}\s+/.test(line)) continue;
    const anchor =
      "#" +
      line
        .replace(/^#{2,3}\s+/, "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-");
    if (anchor.length > 1 && !out.includes(anchor)) out.push(anchor);
  }
  return out;
}

/**
 * Parse AUDIT.md's `## Audit Topics` table. Identical row-shape logic to
 * scripts/inspection-state.ts so the two never disagree about the table.
 */
export function parseAuditTopics(md: string | null): AuditTopicRef[] {
  if (!md) return [];
  const rows: AuditTopicRef[] = [];
  let inTable = false;
  for (const line of md.split("\n")) {
    if (/^\|\s*#\s*\|\s*Status\s*\|\s*Topic\s*\|/i.test(line)) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (!line.trim().startsWith("|")) break;
    if (/^\|\s*-+\s*\|/.test(line)) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 6) continue;
    rows.push({ topic: cells[2], slug: slugify(cells[2]), status: cells[1], file: cells[4] });
  }
  return rows;
}

/**
 * Parse the `<!-- repo-knowledge:facts:start/end -->` block that
 * project-analysis emits in CLAUDE.md. Deliberately a strict, tiny subset of
 * YAML — `key: scalar` and `key: [a, b, c]` — so no dependency is needed and
 * so anything unexpected yields no value rather than a wrong one.
 * Returns null when the block is absent (every pre-0.9.0 CLAUDE.md).
 */
export function parseFactsBlock(md: string): Record<string, string | string[]> | null {
  const m = md.match(
    /<!--\s*repo-knowledge:facts:start\s*-->([\s\S]*?)<!--\s*repo-knowledge:facts:end\s*-->/
  );
  if (!m) return null;
  const body = m[1].replace(/```[a-z]*/gi, "");
  const out: Record<string, string | string[]> = {};
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const kv = line.match(/^([a-z0-9_]+)\s*:\s*(.*)$/i);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const value = kv[2].trim();
    if (!value || value.startsWith("{{")) continue;
    if (value.startsWith("[")) {
      // An unterminated list (no closing `]`) is unparseable, not a scalar —
      // skip the key entirely rather than falling through and mangling it.
      if (!value.endsWith("]")) continue;
      const items = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter((s) => s.length > 0 && !/^unknown$/i.test(s));
      if (items.length) out[key] = items;
    } else {
      const scalar = value.replace(/^["']|["']$/g, "");
      if (!/^unknown$/i.test(scalar)) out[key] = scalar;
    }
  }
  return out;
}

/** Normalize an extracted value to a sorted, de-duplicated string list. */
function toList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const items = Array.isArray(value) ? value : value.split(/,\s*/);
  return Array.from(
    new Set(
      items
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !/^unknown$/i.test(s) && !s.startsWith("{{"))
    )
  ).sort();
}

/**
 * Fallback extraction from the fixed `## Tech Stack` bullet labels in
 * project-analysis's CLAUDE.md template. This is what lets an
 * already-inspected repository produce a useful manifest without re-running
 * the analysis stage.
 */
export function extractStackFromProse(md: string): Partial<RepoKnowledge["stack"]> {
  const labels: Array<[string, keyof RepoKnowledge["stack"]]> = [
    ["Language\\(s\\)", "languages"],
    ["Framework\\(s\\)", "frameworks"],
    ["Platform\\(s\\)", "platformHints"],
    ["Runtime / Tooling", "runtimeTooling"],
    ["Package manager\\(s\\)", "packageManagers"],
  ];
  const out: Partial<RepoKnowledge["stack"]> = {};
  for (const [label, key] of labels) {
    const m = md.match(new RegExp(`^-\\s*${label}\\s*:[ \\t]*([^\\n]+)$`, "im"));
    if (!m) continue;
    const list = toList(m[1]);
    if (list.length) out[key] = list;
  }
  return out;
}

/**
 * Fallback extraction from the fixed fenced bash block under
 * `## Build, Run, and Test Commands`. Each command sits on the line after a
 * known comment. "Unknown" is treated as absent, per the template's own rule.
 */
export function extractCommandsFromProse(md: string): RepoKnowledge["commands"] {
  const result: RepoKnowledge["commands"] = { install: null, run: null, test: null, build: null };
  const block = md.match(/##\s*Build, Run, and Test Commands[\s\S]*?```bash\n([\s\S]*?)```/i);
  if (!block) return result;
  const pairs: Array<[RegExp, keyof RepoKnowledge["commands"]]> = [
    [/#\s*Install dependencies\s*\n([^\n]*)/i, "install"],
    [/#\s*Run \/ develop\s*\n([^\n]*)/i, "run"],
    [/#\s*Test\s*\n([^\n]*)/i, "test"],
    [/#\s*Build\s*\n([^\n]*)/i, "build"],
  ];
  for (const [re, key] of pairs) {
    const found = block[1].match(re);
    const value = found?.[1]?.trim();
    if (!value || /^unknown$/i.test(value) || value.startsWith("{{") || value.startsWith("#")) continue;
    result[key] = value;
  }
  return result;
}

/**
 * Resolve structured facts from CLAUDE.md. The facts block wins where present;
 * the prose fallback fills the rest. A field that cannot be resolved is left
 * empty, which drives its `coverage` to "unknown" so the consumer derives it
 * live rather than trusting a guess.
 */
function extractFacts(claudeMd: string | null): {
  stack: RepoKnowledge["stack"];
  commands: RepoKnowledge["commands"];
} {
  const empty = {
    stack: { languages: [], frameworks: [], platformHints: [], runtimeTooling: [], packageManagers: [] },
    commands: { install: null, run: null, test: null, build: null },
  };
  if (!claudeMd) return empty;

  const prose = extractStackFromProse(claudeMd);
  const block = parseFactsBlock(claudeMd) ?? {};

  // Block keys are snake_case; map them onto the manifest's camelCase fields.
  const pick = (blockKey: string, proseValue: string[] | undefined): string[] => {
    const fromBlock = toList(block[blockKey]);
    return fromBlock.length ? fromBlock : proseValue ?? [];
  };

  const stack: RepoKnowledge["stack"] = {
    languages: pick("languages", prose.languages),
    frameworks: pick("frameworks", prose.frameworks),
    platformHints: pick("platform_hints", prose.platformHints),
    runtimeTooling: pick("runtime_tooling", prose.runtimeTooling),
    packageManagers: pick("package_managers", prose.packageManagers),
  };

  const proseCommands = extractCommandsFromProse(claudeMd);
  const scalar = (blockKey: string, fallback: string | null): string | null => {
    const v = block[blockKey];
    if (typeof v === "string" && v.length) return v;
    return fallback;
  };

  const commands: RepoKnowledge["commands"] = {
    install: scalar("install_command", proseCommands.install),
    run: scalar("run_command", proseCommands.run),
    test: scalar("test_command", proseCommands.test),
    build: scalar("build_command", proseCommands.build),
  };

  return { stack, commands };
}

function coverageForList(values: string[][]): Coverage {
  const filled = values.filter((v) => v.length > 0).length;
  if (filled === 0) return "unknown";
  return filled === values.length ? "populated" : "partial";
}

function coverageForNullable(values: Array<string | null>): Coverage {
  const filled = values.filter((v) => v !== null && v !== "").length;
  if (filled === 0) return "unknown";
  return filled === values.length ? "populated" : "partial";
}

export function buildManifest(repoRoot: string): RepoKnowledge {
  const claudeMd = readIfExists(repoRoot, "CLAUDE.md");
  const auditMd = readIfExists(repoRoot, "AUDIT.md");

  const artifacts: Record<string, string | null> = {};
  for (const rel of SOURCE_ARTIFACTS) {
    const body = readIfExists(repoRoot, rel);
    artifacts[rel] = body === null ? null : sha256(body);
  }

  const documents: Record<string, DocumentRef> = {};
  for (const [key, rel] of DOCUMENT_MAP) {
    const body = readIfExists(repoRoot, rel);
    documents[key] = {
      path: rel,
      exists: body !== null,
      // Anchors are only useful for the docs/project knowledge base; CLAUDE.md
      // and AUDIT.md are referenced by fixed section pointers instead.
      anchors: body !== null && rel.startsWith("docs/project/") ? headingAnchors(body) : [],
    };
  }

  const auditTopics = parseAuditTopics(auditMd);
  const { stack, commands } = extractFacts(claudeMd);

  // Computed locally for structure resolution only — documents.claudeMd.anchors
  // stays [] per contract (CLAUDE.md is cited through structure's fixed
  // pointers, not through a generic anchors list).
  const claudeMdAnchors = claudeMd ? headingAnchors(claudeMd) : [];
  const structure = {
    repositoryTree: claudeMdAnchors.includes("#repository-structure") ? "CLAUDE.md#repository-structure" : null,
    keyModules: claudeMdAnchors.includes("#key-modules") ? "CLAUDE.md#key-modules" : null,
    entryPoints: claudeMdAnchors.includes("#entry-points") ? "CLAUDE.md#entry-points" : null,
  };

  const coverage: Record<string, Coverage> = {
    stack: coverageForList([
      stack.languages,
      stack.frameworks,
      stack.platformHints,
      stack.runtimeTooling,
      stack.packageManagers,
    ]),
    commands: coverageForNullable([commands.install, commands.run, commands.test, commands.build]),
    structure: coverageForNullable([structure.repositoryTree, structure.keyModules, structure.entryPoints]),
    inventory: documents.inventory.exists && documents.inventory.anchors.length > 0 ? "populated" : "unknown",
    conventions: documents.conventions.exists && documents.conventions.anchors.length > 0 ? "populated" : "unknown",
    integrations: documents.integrations.exists && documents.integrations.anchors.length > 0 ? "populated" : "unknown",
    auditTopics: auditTopics.length > 0 ? "populated" : "unknown",
  };

  return {
    repoKnowledgeSchemaVersion: REPO_KNOWLEDGE_SCHEMA_VERSION,
    producedBy: currentPlugin(),
    generatedAt: new Date().toISOString(),
    fingerprint: { gitHead: gitHead(repoRoot), artifacts },
    coverage,
    stack,
    commands,
    structure,
    documents,
    auditTopics,
  };
}

/** Structural validation. Deliberately shallow: this guards shape, not content quality. */
export function validateManifest(value: unknown): string[] {
  const errors: string[] = [];
  const m = value as Partial<RepoKnowledge> | null;
  if (!m || typeof m !== "object") return ["manifest is not an object"];
  if (m.repoKnowledgeSchemaVersion !== REPO_KNOWLEDGE_SCHEMA_VERSION) {
    errors.push(`repoKnowledgeSchemaVersion is ${String(m.repoKnowledgeSchemaVersion)}, expected ${REPO_KNOWLEDGE_SCHEMA_VERSION}`);
  }
  if (!m.producedBy?.plugin) errors.push("producedBy.plugin missing");
  if (typeof m.generatedAt !== "string") errors.push("generatedAt missing");
  if (!m.fingerprint || typeof m.fingerprint.artifacts !== "object") errors.push("fingerprint.artifacts missing");
  if (!m.coverage || typeof m.coverage !== "object") errors.push("coverage missing");
  if (!m.documents || typeof m.documents !== "object") errors.push("documents missing");
  if (!Array.isArray(m.auditTopics)) errors.push("auditTopics is not an array");
  return errors;
}

function writeManifest(repoRoot: string, manifest: RepoKnowledge): void {
  const dir = join(repoRoot, ".ono");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(manifestPath(repoRoot), JSON.stringify(manifest, null, 2) + "\n", "utf-8");
}

function cmdEmit(repoRoot: string): void {
  const manifest = buildManifest(repoRoot);
  writeManifest(repoRoot, manifest);
  const unknown = Object.entries(manifest.coverage)
    .filter(([, v]) => v === "unknown")
    .map(([k]) => k);
  console.log(
    `Emitted ${join(".ono", "repo-knowledge.json")} (schema v${REPO_KNOWLEDGE_SCHEMA_VERSION}, ` +
      `${manifest.auditTopics.length} audit topic(s))` +
      (unknown.length ? `; coverage unknown: ${unknown.join(", ")}` : "; full coverage")
  );
  process.exit(0);
}

function cmdValidate(repoRoot: string): void {
  const p = manifestPath(repoRoot);
  if (!existsSync(p)) {
    console.error(`No manifest at ${join(".ono", "repo-knowledge.json")}. Run this skill's emit step.`);
    process.exit(2);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(p, "utf-8"));
  } catch (err) {
    console.error(`repo-knowledge.json is not valid JSON: ${(err as Error).message}`);
    process.exit(2);
  }
  const errors = validateManifest(parsed);
  if (errors.length) {
    console.error(`repo-knowledge.json failed validation:\n- ${errors.join("\n- ")}`);
    process.exit(2);
  }
  const m = parsed as RepoKnowledge;
  const unknown = Object.entries(m.coverage).filter(([, v]) => v === "unknown").map(([k]) => k);
  console.log(
    `repo-knowledge.json is valid (schema v${m.repoKnowledgeSchemaVersion}, produced by ${m.producedBy.plugin} ${m.producedBy.version})` +
      (unknown.length ? `; coverage unknown: ${unknown.join(", ")}` : "; full coverage")
  );
  process.exit(0);
}

function cmdShow(repoRoot: string): void {
  const p = manifestPath(repoRoot);
  if (!existsSync(p)) {
    console.error(`No manifest at ${join(".ono", "repo-knowledge.json")}.`);
    process.exit(2);
  }
  console.log(readFileSync(p, "utf-8").trimEnd());
  process.exit(0);
}

function main(): void {
  const [, , command, repoRoot] = process.argv;
  if (!command || !repoRoot) {
    console.error("Usage: repo-knowledge.ts <emit|validate|show> <repo-root>");
    process.exit(1);
  }
  if (!existsSync(repoRoot)) {
    console.error(`Repository root not found: ${repoRoot}`);
    process.exit(1);
  }
  // Worktree safety: a Claude agent worktree is an ephemeral execution copy,
  // not the developer's repository. Callers must pass the resolved main-tree
  // root (scripts/resolve-repo-root.ts). Guard reads too, since a manifest
  // read from a worktree would mislead every consumer.
  if (realpathSync(repoRoot).includes(WORKTREE_MARKER)) {
    console.error(
      `Refusing to operate on a Claude agent worktree: ${repoRoot}\n` +
        `Pass the resolved main repository root (scripts/resolve-repo-root.ts).`
    );
    process.exit(1);
  }
  switch (command) {
    case "emit":
      return cmdEmit(repoRoot);
    case "validate":
      return cmdValidate(repoRoot);
    case "show":
      return cmdShow(repoRoot);
    default:
      console.error(`Unknown command "${command}".`);
      process.exit(1);
  }
}

if (require.main === module) {
  main();
}
