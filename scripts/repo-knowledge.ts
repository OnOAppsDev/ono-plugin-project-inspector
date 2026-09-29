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
 *   docs/project/*.md — plus the knowledge-authoring HEAD from the plugin's own
 *   .ono/state.json. It never reads repository source, so it introduces no
 *   new analysis and no new approval gate.
 * - EMIT NEVER REFRESHES KNOWLEDGE. Re-emitting only re-indexes the artifacts;
 *   `fingerprint.knowledgeHead` is carried, never advanced, by an emit.
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
import {
  CAPABILITIES_DOC,
  EVIDENCE_KINDS,
  FORM_FACTORS,
  RELATIONSHIP_TYPES,
  SURFACES_ANCHOR,
  headingAnchors,
  parseCapabilityMap,
  parseInventory,
  parseSurfaceModel,
  surfaceAnchors,
} from "./knowledge-model";

// Re-exported: the anchor rule lives in knowledge-model.ts so every helper shares it.
export { headingAnchors };

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
  "docs/project/capabilities.md",
] as const;

/** documents[] key -> repo-relative path. */
const DOCUMENT_MAP: Array<[string, string]> = [
  ["claudeMd", "CLAUDE.md"],
  ["auditMd", "AUDIT.md"],
  ["overview", "docs/project/overview.md"],
  ["inventory", "docs/project/components.md"],
  ["conventions", "docs/project/patterns.md"],
  ["integrations", "docs/project/integrations.md"],
  ["capabilities", "docs/project/capabilities.md"],
];

type Coverage = "populated" | "partial" | "unknown";

interface DocumentRef {
  path: string;
  exists: boolean;
  anchors: string[];
  /** Per-surface override anchors `{ surfaceId: [{ section, anchor }] }`; `{}` = every surface inherits. */
  surfaceAnchors: Record<string, Array<{ section: string; anchor: string }>>;
}

/** One declared surface (CLAUDE.md `## Targets and Surfaces`). Repository facts only. */
interface SurfaceRef {
  id: string;
  platform: string | null;
  formFactor: string | null;
  buildSelector: string | null;
  sourceRoots: string[];
  sharedWith: string[];
  packaging: string | null;
  minimumRuntime: string | null;
  evidence: string[];
}

interface SharedCodeRef {
  root: string;
  sharedBy: string[];
  mechanism: string | null;
  evidence: string[];
}

/** A named `{name, anchor}` pointer into components.md / integrations.md (anchor null = unresolved). */
interface NamedRef {
  name: string;
  anchor: string | null;
}

interface CapabilityRef {
  id: string;
  name: string | null;
  anchor: string;
  surfaceScope: "all" | "subset";
  surfaces: string[];
  sourceRoots: Array<{ path: string; surface: string | null }>;
  entryPoints: string[];
  components: NamedRef[];
  services: string[];
  routes: string[];
  dataDependencies: NamedRef[];
  stateOwnership: string[];
  tests: string[];
  evidence: string[];
  /** Ids of every first-degree relationship this capability is an endpoint of. */
  relationships: string[];
}

interface CapabilityRelationshipRef {
  id: string;
  from: string;
  type: string;
  to: string;
  evidenceKind: string;
  evidence: string[];
  anchor: string;
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
  fingerprint: {
    /** HEAD at emit time. Advances on every emit, including a metadata-only re-emit. */
    gitHead: string | null;
    /**
     * HEAD at which source-backed Project Knowledge was last actually generated.
     * Mirrored from `.ono/state.json` `repository.knowledgeHead`, which only
     * `inspection-state.ts record-knowledge` writes — so an emit never advances
     * it. Optional: absent in manifests produced before 0.10.0; `null` = unknown.
     */
    knowledgeHead?: string | null;
    artifacts: Record<string, string | null>;
  };
  coverage: Record<string, Coverage>;
  stack: {
    languages: string[];
    frameworks: string[];
    platformHints: string[];
    runtimeTooling: string[];
    packageManagers: string[];
  };
  commands: { install: string | null; run: string | null; test: string | null; build: string | null };
  structure: {
    repositoryTree: string | null;
    keyModules: string | null;
    entryPoints: string | null;
    /** Additive: pointer to CLAUDE.md's surfaces section; absent when the section is. Not part of structure coverage. */
    surfaces?: string;
  };
  documents: Record<string, DocumentRef>;
  auditTopics: AuditTopicRef[];
  /** Additive (optional in v1): absent in manifests produced before 0.11.0. */
  surfaces?: SurfaceRef[];
  sharedCode?: SharedCodeRef[];
  capabilities?: CapabilityRef[];
  capabilityRelationships?: CapabilityRelationshipRef[];
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

function readJson(p: string): any {
  try {
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : null;
  } catch {
    return null;
  }
}

/**
 * The knowledge-authoring HEAD. Inspection state is authoritative; the prior
 * manifest's value is carried forward only if state has none (e.g. state.json
 * was lost). It is never derived from the current HEAD — that is exactly the
 * value that would make stale knowledge look fresh.
 */
function knowledgeHead(repoRoot: string): string | null {
  const fromState = readJson(join(repoRoot, ".ono", "state.json"))?.repository?.knowledgeHead;
  if (typeof fromState === "string" && fromState.length) return fromState;
  const fromManifest = readJson(manifestPath(repoRoot))?.fingerprint?.knowledgeHead;
  if (typeof fromManifest === "string" && fromManifest.length) return fromManifest;
  return null;
}

const sorted = (xs: string[]): string[] => Array.from(new Set(xs)).sort();

/**
 * Surfaces, shared code, capabilities and relationships — an index over the
 * documents, never a copy: ids, short repository facts, evidence refs and
 * `path#anchor` pointers only. Arrays are sorted (surfaces keep declaration
 * order), so a regenerated document that lists the same facts in a different
 * order indexes identically.
 */
function knowledgeModel(claudeMd: string | null, docs: Record<string, string | null>) {
  const surfaceModel = parseSurfaceModel(claudeMd);
  const surfaceIds = surfaceModel.surfaces.map((s) => s.id);
  const surfaces: SurfaceRef[] = surfaceModel.surfaces.map((s) => ({
    ...s,
    sourceRoots: sorted(s.sourceRoots),
    sharedWith: sorted(s.sharedWith),
    evidence: sorted(s.evidence),
  }));
  const sharedCode: SharedCodeRef[] = surfaceModel.sharedCode
    .map((c) => ({ ...c, sharedBy: sorted(c.sharedBy), evidence: sorted(c.evidence) }))
    .sort((a, b) => a.root.localeCompare(b.root));

  const map = parseCapabilityMap(docs[CAPABILITIES_DOC]);
  const pointer = (doc: string, rows: ReturnType<typeof parseInventory>) => (name: string): NamedRef => {
    const row = rows.find((r) => r.name === name);
    return { name, anchor: row ? `${doc}${row.anchor}` : null };
  };
  const component = pointer("docs/project/components.md", parseInventory(docs["docs/project/components.md"]));
  const integration = pointer("docs/project/integrations.md", parseInventory(docs["docs/project/integrations.md"]));
  const byName = (a: NamedRef, b: NamedRef) => a.name.localeCompare(b.name);

  const capabilityRelationships: CapabilityRelationshipRef[] = map.relationships
    .map((r) => ({ ...r, evidence: sorted(r.evidence), anchor: `${CAPABILITIES_DOC}#relationships` }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const capabilities: CapabilityRef[] = map.capabilities
    .map((c) => ({
      id: c.id,
      name: c.name,
      anchor: `${CAPABILITIES_DOC}${c.anchor}`,
      surfaceScope: c.surfaceScope,
      surfaces: sorted(c.surfaceScope === "all" ? surfaceIds : c.surfaces),
      sourceRoots: [...c.sourceRoots].sort((a, b) => a.path.localeCompare(b.path) || String(a.surface).localeCompare(String(b.surface))),
      entryPoints: sorted(c.entryPoints),
      components: c.components.map(component).sort(byName),
      services: sorted(c.services),
      routes: sorted(c.routes),
      dataDependencies: c.dataDependencies.map(integration).sort(byName),
      stateOwnership: sorted(c.stateOwnership),
      tests: sorted(c.tests),
      evidence: sorted(c.evidence),
      relationships: capabilityRelationships.filter((r) => r.from === c.id || r.to === c.id).map((r) => r.id),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const coverage = (present: boolean, count: number, issues: number): Coverage =>
    !present || count === 0 ? "unknown" : issues > 0 ? "partial" : "populated";

  return {
    surfaceIds,
    surfacesPointer: surfaceModel.present ? `CLAUDE.md${SURFACES_ANCHOR}` : null,
    surfaces,
    sharedCode,
    capabilities,
    capabilityRelationships,
    surfacesCoverage: coverage(surfaceModel.present, surfaces.length, surfaceModel.issues.length),
    capabilitiesCoverage: coverage(map.present, capabilities.length, map.issues.length),
  };
}

export function buildManifest(repoRoot: string): RepoKnowledge {
  const claudeMd = readIfExists(repoRoot, "CLAUDE.md");
  const auditMd = readIfExists(repoRoot, "AUDIT.md");
  const bodies: Record<string, string | null> = {};
  for (const rel of SOURCE_ARTIFACTS) bodies[rel] = readIfExists(repoRoot, rel);
  const model = knowledgeModel(claudeMd, bodies);

  const artifacts: Record<string, string | null> = {};
  for (const rel of SOURCE_ARTIFACTS) {
    const body = bodies[rel];
    artifacts[rel] = body === null ? null : sha256(body);
  }

  const documents: Record<string, DocumentRef> = {};
  for (const [key, rel] of DOCUMENT_MAP) {
    const body = bodies[rel] ?? null;
    const indexed = body !== null && rel.startsWith("docs/project/");
    documents[key] = {
      path: rel,
      exists: body !== null,
      // Anchors are only useful for the docs/project knowledge base; CLAUDE.md
      // and AUDIT.md are referenced by fixed section pointers instead.
      anchors: indexed ? headingAnchors(body as string) : [],
      surfaceAnchors: indexed ? surfaceAnchors(body as string, model.surfaceIds) : {},
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
  // Structure coverage stays defined over the three original pointers.
  const structureCoverage = coverageForNullable([structure.repositoryTree, structure.keyModules, structure.entryPoints]);

  const coverage: Record<string, Coverage> = {
    stack: coverageForList([
      stack.languages,
      stack.frameworks,
      stack.platformHints,
      stack.runtimeTooling,
      stack.packageManagers,
    ]),
    commands: coverageForNullable([commands.install, commands.run, commands.test, commands.build]),
    structure: structureCoverage,
    inventory: documents.inventory.exists && documents.inventory.anchors.length > 0 ? "populated" : "unknown",
    conventions: documents.conventions.exists && documents.conventions.anchors.length > 0 ? "populated" : "unknown",
    integrations: documents.integrations.exists && documents.integrations.anchors.length > 0 ? "populated" : "unknown",
    auditTopics: auditTopics.length > 0 ? "populated" : "unknown",
    surfaces: model.surfacesCoverage,
    capabilities: model.capabilitiesCoverage,
  };

  return {
    repoKnowledgeSchemaVersion: REPO_KNOWLEDGE_SCHEMA_VERSION,
    producedBy: currentPlugin(),
    generatedAt: new Date().toISOString(),
    fingerprint: { gitHead: gitHead(repoRoot), knowledgeHead: knowledgeHead(repoRoot), artifacts },
    coverage,
    stack,
    commands,
    // The pointer is added only when the section exists, so a repository without
    // it keeps a byte-identical `structure` object (coverage.surfaces says unknown).
    structure: model.surfacesPointer ? { ...structure, surfaces: model.surfacesPointer } : structure,
    documents,
    auditTopics,
    surfaces: model.surfaces,
    sharedCode: model.sharedCode,
    capabilities: model.capabilities,
    capabilityRelationships: model.capabilityRelationships,
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
  // Optional (additive in schema v1): absent is valid; present must be sha or null.
  const kh = (m.fingerprint as { knowledgeHead?: unknown } | undefined)?.knowledgeHead;
  if (kh !== undefined && kh !== null && typeof kh !== "string") errors.push("fingerprint.knowledgeHead must be a string or null");
  if (!m.coverage || typeof m.coverage !== "object") errors.push("coverage missing");
  if (!m.documents || typeof m.documents !== "object") errors.push("documents missing");
  if (!Array.isArray(m.auditTopics)) errors.push("auditTopics is not an array");

  // Additive in schema v1: each field may be absent (older producer); present must be well-formed.
  const optionalArray = (key: keyof RepoKnowledge): any[] | null => {
    const v = (m as any)[key];
    if (v === undefined) return null;
    if (!Array.isArray(v)) {
      errors.push(`${String(key)} must be an array when present`);
      return null;
    }
    return v;
  };
  for (const s of optionalArray("surfaces") ?? []) {
    if (typeof s?.id !== "string") errors.push("surfaces[].id must be a string");
    if (s?.formFactor !== null && !(FORM_FACTORS as readonly string[]).includes(s?.formFactor)) errors.push(`surface "${s?.id}" has an invalid formFactor`);
  }
  optionalArray("sharedCode");
  const caps = optionalArray("capabilities");
  const capIds = new Set((caps ?? []).map((c: any) => c?.id));
  for (const c of caps ?? []) {
    if (typeof c?.id !== "string" || typeof c?.anchor !== "string") errors.push("capabilities[] needs a string id and anchor");
  }
  for (const r of optionalArray("capabilityRelationships") ?? []) {
    const label = String(r?.id);
    if (!(RELATIONSHIP_TYPES as readonly string[]).includes(r?.type)) errors.push(`relationship ${label}: type outside the vocabulary`);
    if (!(EVIDENCE_KINDS as readonly string[]).includes(r?.evidenceKind)) errors.push(`relationship ${label}: evidenceKind not accepted`);
    if (!Array.isArray(r?.evidence) || r.evidence.length === 0) errors.push(`relationship ${label}: evidence missing`);
    if (!capIds.has(r?.from) || !capIds.has(r?.to)) errors.push(`relationship ${label}: endpoint is not a listed capability`);
  }
  for (const [key, doc] of Object.entries(m.documents ?? {})) {
    const sa = (doc as any)?.surfaceAnchors;
    if (sa !== undefined && (sa === null || typeof sa !== "object" || Array.isArray(sa))) errors.push(`documents.${key}.surfaceAnchors must be an object`);
  }
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
