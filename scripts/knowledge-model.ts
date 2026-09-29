/**
 * knowledge-model.ts
 *
 * The single deterministic parser of the generic Project Knowledge model that
 * project-analysis and project-docs write into their documents:
 *
 *   Project
 *   ├─ Surfaces[]        CLAUDE.md `## Targets and Surfaces` (fixed-column table)
 *   │  └─ Shared Code     CLAUDE.md `### Shared Code` (fixed-column table)
 *   ├─ Shared conventions + per-surface overrides
 *   │                    docs/project/patterns.md `## <Section>` / `### <Section> (<surface-id>)`
 *   ├─ Inventory rows scoped by a `Surface` column (components.md, integrations.md)
 *   └─ Capabilities[] + first-degree Relationships[]
 *                        docs/project/capabilities.md
 *
 * Pure functions over document text — no filesystem, no git. Consumed by
 * scripts/repo-knowledge.ts (manifest index), scripts/knowledge-evidence.ts
 * (source-evidence gate) and scripts/inspection-state.ts (drift attribution),
 * so the three never disagree about what a document says.
 *
 * Nothing here is platform- or product-specific: the model is generic, and
 * every name in it (surface ids, capability ids) comes from the repository.
 */

/** Inspector-neutral form factors. Deliberately NOT the Dev Plugin's device_type. */
export const FORM_FACTORS = ["handheld", "desktop", "tv", "wearable", "other"] as const;

/** The small, closed capability relationship vocabulary. */
export const RELATIONSHIP_TYPES = [
  "depends_on",
  "used_by",
  "contains",
  "navigates_to",
  "shares_component_with",
  "shares_state_with",
  "reads_from",
  "writes_to",
  "covered_by",
  "related_to",
] as const;

/** Relationship types with no direction; stored with `from` < `to` so each edge exists once. */
export const SYMMETRIC_TYPES = new Set<string>(["shares_component_with", "shares_state_with", "related_to"]);

/**
 * Accepted evidence kinds. Each names a concrete source edge; there is
 * intentionally no kind for naming or semantic similarity.
 */
export const EVIDENCE_KINDS = [
  "import",
  "navigation-route",
  "shared-component",
  "shared-state",
  "shared-service",
  "shared-data-source",
  "test",
  "repository-doc",
] as const;

/** Kinds whose evidence must be located on both endpoints and share a token. */
export const SHARED_EVIDENCE_KINDS = new Set<string>(["shared-component", "shared-state", "shared-service", "shared-data-source"]);

/** Generic sections every patterns.md carries (in addition to the pre-existing ones). */
export const GENERIC_PATTERN_SECTIONS = [
  "Architecture and Composition",
  "Input and Interaction",
  "App Lifecycle and State",
  "Media and Playback",
  "Platform Adapters",
  "Accessibility",
  "Performance Constraints",
];

/** Fixed field rows of one capability section, in template order. */
export const CAPABILITY_FIELDS = [
  "Name",
  "Surfaces",
  "Source roots",
  "Entry points",
  "Screens and components",
  "Services and modules",
  "Navigation routes",
  "Data dependencies",
  "State ownership",
  "Tests",
  "Evidence",
];

export const SURFACES_HEADER =
  "| Surface | Platform | Form factor | Build selector | Source roots | Shared with | Packaging | Minimum OS / runtime | Evidence |";
export const SHARED_CODE_HEADER = "| Source root | Shared by | Mechanism | Evidence |";
export const RELATIONSHIPS_HEADER = "| From | Relationship | To | Evidence kind | Evidence |";

export const SURFACES_ANCHOR = "#targets-and-surfaces";
export const CAPABILITIES_DOC = "docs/project/capabilities.md";

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

// --- headings and anchors ---------------------------------------------------

export interface Heading {
  level: number;
  text: string;
  anchor: string;
  /** Anchor of the nearest enclosing `##` heading, for a `###` heading. */
  parent: string | null;
  line: number;
}

function slugAnchor(text: string): string {
  return (
    "#" +
    text
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
  );
}

/**
 * Every `##`/`###` heading with a GitHub-style anchor. A repeated heading gets
 * a deterministic `-1`, `-2`, … suffix (never silently dropped), and a suffix
 * never collides with an anchor already taken. Unique headings keep exactly
 * the anchor they always had.
 */
export function headingIndex(md: string): Heading[] {
  const out: Heading[] = [];
  const taken = new Set<string>();
  let parent: string | null = null;
  md.split("\n").forEach((line, i) => {
    const m = line.match(/^(#{2,3})\s+(.*)$/);
    if (!m) return;
    const base = slugAnchor(m[2]);
    if (base.length <= 1) return;
    let anchor = base;
    for (let n = 1; taken.has(anchor); n++) anchor = `${base}-${n}`;
    taken.add(anchor);
    const level = m[1].length;
    if (level === 2) parent = anchor;
    out.push({ level, text: m[2].trim(), anchor, parent: level === 3 ? parent : null, line: i });
  });
  return out;
}

export function headingAnchors(md: string): string[] {
  return headingIndex(md).map((h) => h.anchor);
}

/** Lines of the section a heading opens, up to the next heading of the same or a higher level. */
function sectionLines(md: string, h: Heading): string[] {
  const lines = md.split("\n");
  const out: string[] = [];
  for (let i = h.line + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s/);
    if (m && m[1].length <= h.level) break;
    out.push(lines[i]);
  }
  return out;
}

/** Body text directly under a heading, stopping at the next heading of any level. */
export function directBody(md: string, h: Heading): string {
  const lines = md.split("\n");
  const out: string[] = [];
  for (let i = h.line + 1; i < lines.length && !/^#{1,6}\s/.test(lines[i]); i++) out.push(lines[i]);
  return out.join("\n").trim();
}

const OVERRIDE_RE = /^(.*\S)\s+\(([a-z0-9][a-z0-9-]*)\)$/;

/** A `### <Section> (<id>)` heading, whatever `<id>` is. */
export function overrideHeading(h: Heading): { section: string; surface: string } | null {
  if (h.level !== 3) return null;
  const m = h.text.match(OVERRIDE_RE);
  return m ? { section: m[1], surface: m[2] } : null;
}

/**
 * Per-surface override anchors, keyed by surface id. Only headings whose
 * parenthetical is a declared surface id count, so an ordinary heading such as
 * "Localization (RTL)" is never mistaken for an override. A surface with no
 * key inherits every shared convention.
 */
export function surfaceAnchors(md: string, surfaceIds: string[]): Record<string, Array<{ section: string; anchor: string }>> {
  const known = new Set(surfaceIds);
  const out: Record<string, Array<{ section: string; anchor: string }>> = {};
  const headings = headingIndex(md);
  const text = new Map(headings.map((h) => [h.anchor, h.text]));
  for (const h of headings) {
    const o = overrideHeading(h);
    // An override counts only under its own shared section (a misplaced one is never indexed).
    if (!o || !known.has(o.surface) || !h.parent || text.get(h.parent) !== o.section) continue;
    (out[o.surface] ??= []).push({ section: h.parent, anchor: h.anchor });
  }
  return Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
}

// --- tables and cells -------------------------------------------------------

interface Table {
  header: string[];
  rows: string[][];
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

function tablesIn(lines: string[]): Table[] {
  const tables: Table[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith("|") || !/^\|?\s*:?-{2,}/.test((lines[i + 1] ?? "").trim())) continue;
    const header = splitRow(lines[i]);
    const rows: string[][] = [];
    let k = i + 2;
    for (; k < lines.length && lines[k].trim().startsWith("|"); k++) rows.push(splitRow(lines[k]));
    tables.push({ header, rows });
    i = k - 1;
  }
  return tables;
}

const EMPTY_CELL = /^(|-|—|none|none found.*|unknown|not applicable.*|not declared|n\/a)$/i;

function isEmptyCell(cell: string | undefined): boolean {
  return cell === undefined || EMPTY_CELL.test(cell.trim());
}

/** Plain-text value of a cell, markdown code spans unwrapped; empty markers -> null. */
function textCell(cell: string | undefined): string | null {
  if (isEmptyCell(cell)) return null;
  return (cell as string).replace(/`([^`]*)`/g, "$1").trim() || null;
}

/** Backticked references in a cell, each with an optional trailing `(surface-id)`. */
export function parseRefs(cell: string | undefined): Array<{ ref: string; surface: string | null }> {
  if (isEmptyCell(cell)) return [];
  const out: Array<{ ref: string; surface: string | null }> = [];
  for (const m of (cell as string).matchAll(/`([^`]+)`(?:\s*\(([a-z0-9][a-z0-9-]*)\))?/g)) {
    out.push({ ref: m[1].trim(), surface: m[2] ?? null });
  }
  return out;
}

/** `path::token` → the file (or directory) plus the literal it must contain. */
export function parseEvidenceRef(ref: string): { path: string; token: string | null } {
  const i = ref.indexOf("::");
  return i < 0 ? { path: ref.trim(), token: null } : { path: ref.slice(0, i).trim(), token: ref.slice(i + 2) };
}

/** A comma-separated id list (backticks optional). `all` is returned as ["all"]. */
function idList(cell: string | undefined): string[] {
  if (isEmptyCell(cell)) return [];
  return (cell as string)
    .split(",")
    .map((s) => s.replace(/`/g, "").trim())
    .filter((s) => s.length > 0);
}

function col(header: string[], name: RegExp): number {
  return header.findIndex((h) => name.test(h.trim()));
}

// --- surfaces ----------------------------------------------------------------

export interface Surface {
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

export interface SharedCode {
  root: string;
  sharedBy: string[];
  mechanism: string | null;
  evidence: string[];
}

export interface SurfaceModel {
  present: boolean;
  surfaces: Surface[];
  sharedCode: SharedCode[];
  issues: string[];
}

/** Parse CLAUDE.md's `## Targets and Surfaces` section. Absent section → `present: false`. */
export function parseSurfaceModel(claudeMd: string | null): SurfaceModel {
  const model: SurfaceModel = { present: false, surfaces: [], sharedCode: [], issues: [] };
  if (!claudeMd) return model;
  const h = headingIndex(claudeMd).find((x) => x.level === 2 && x.anchor === SURFACES_ANCHOR);
  if (!h) return model;
  model.present = true;
  const tables = tablesIn(sectionLines(claudeMd, h));
  const surfaceTable = tables.find((t) => /^surface$/i.test(t.header[0] ?? ""));
  if (surfaceTable) {
    const c = (re: RegExp) => col(surfaceTable.header, re);
    const idx = {
      platform: c(/^platform$/i), formFactor: c(/^form factor$/i), build: c(/^build selector$/i),
      roots: c(/^source roots$/i), shared: c(/^shared with$/i), packaging: c(/^packaging$/i),
      minimum: c(/^minimum/i), evidence: c(/^evidence$/i),
    };
    for (const row of surfaceTable.rows) {
      const id = textCell(row[0]);
      if (!id) continue;
      if (!ID_RE.test(id)) {
        model.issues.push(`surface id "${id}" is not a lowercase slug`);
        continue;
      }
      const ff = textCell(row[idx.formFactor]);
      const formFactor = ff && (FORM_FACTORS as readonly string[]).includes(ff) ? ff : null;
      if (ff && !formFactor) model.issues.push(`surface "${id}" has form factor "${ff}" (expected one of ${FORM_FACTORS.join(", ")})`);
      model.surfaces.push({
        id,
        platform: textCell(row[idx.platform]),
        formFactor,
        buildSelector: textCell(row[idx.build]),
        sourceRoots: parseRefs(row[idx.roots]).map((r) => r.ref),
        sharedWith: idList(row[idx.shared]),
        packaging: textCell(row[idx.packaging]),
        minimumRuntime: textCell(row[idx.minimum]),
        evidence: parseRefs(row[idx.evidence]).map((r) => r.ref),
      });
    }
  }
  const sharedTable = tables.find((t) => /^source root$/i.test(t.header[0] ?? ""));
  if (sharedTable) {
    const by = col(sharedTable.header, /^shared by$/i);
    const mech = col(sharedTable.header, /^mechanism$/i);
    const ev = col(sharedTable.header, /^evidence$/i);
    for (const row of sharedTable.rows) {
      const root = parseRefs(row[0])[0]?.ref;
      if (!root) continue;
      model.sharedCode.push({ root, sharedBy: idList(row[by]), mechanism: textCell(row[mech]), evidence: parseRefs(row[ev]).map((r) => r.ref) });
    }
  }
  return model;
}

// --- inventory ---------------------------------------------------------------

export interface InventoryRow {
  name: string;
  /** Anchor of the `##` section holding the row. */
  anchor: string;
  section: string;
  /** `all`, an explicit `subset`, or `unknown` when the table has no Surface column. */
  surfaceScope: "all" | "subset" | "unknown";
  surfaces: string[];
  hasSurfaceColumn: boolean;
}

/** Every row of every table in components.md / integrations.md, with its section anchor. */
export function parseInventory(md: string | null): InventoryRow[] {
  if (!md) return [];
  const out: InventoryRow[] = [];
  for (const h of headingIndex(md).filter((x) => x.level === 2)) {
    for (const t of tablesIn(sectionLines(md, h))) {
      const s = col(t.header, /^surfaces?$/i);
      for (const row of t.rows) {
        const name = textCell(row[0]);
        if (!name) continue;
        const ids = s < 0 ? [] : idList(row[s]);
        const scope = s < 0 || ids.length === 0 ? "unknown" : ids.length === 1 && ids[0] === "all" ? "all" : "subset";
        out.push({ name, anchor: h.anchor, section: h.text, surfaceScope: scope, surfaces: scope === "subset" ? ids : [], hasSurfaceColumn: s >= 0 });
      }
    }
  }
  return out;
}

/** Tables (by section) in an inventory document, and whether each carries a Surface column. */
export function inventoryTables(md: string | null): Array<{ section: string; anchor: string; hasSurfaceColumn: boolean }> {
  if (!md) return [];
  const out: Array<{ section: string; anchor: string; hasSurfaceColumn: boolean }> = [];
  for (const h of headingIndex(md).filter((x) => x.level === 2)) {
    for (const t of tablesIn(sectionLines(md, h))) out.push({ section: h.text, anchor: h.anchor, hasSurfaceColumn: col(t.header, /^surfaces?$/i) >= 0 });
  }
  return out;
}

// --- capabilities and relationships -------------------------------------------

export interface Capability {
  id: string;
  name: string | null;
  anchor: string;
  surfaceScope: "all" | "subset";
  surfaces: string[];
  sourceRoots: Array<{ path: string; surface: string | null }>;
  entryPoints: string[];
  components: string[];
  services: string[];
  routes: string[];
  dataDependencies: string[];
  stateOwnership: string[];
  tests: string[];
  evidence: string[];
}

export interface Relationship {
  id: string;
  from: string;
  type: string;
  to: string;
  evidenceKind: string;
  evidence: string[];
}

export interface CapabilityMap {
  present: boolean;
  capabilities: Capability[];
  relationships: Relationship[];
  issues: string[];
}

/** Stable relationship id. Symmetric types are order-independent. */
export function relationshipId(from: string, type: string, to: string): string {
  const [a, b] = SYMMETRIC_TYPES.has(type) && to < from ? [to, from] : [from, to];
  return `${a}:${type}:${b}`;
}

/**
 * Parse docs/project/capabilities.md. Rows that cannot be a grounded fact —
 * an unknown relationship type or evidence kind, a dangling endpoint, a self
 * edge, no evidence, a duplicate — are reported in `issues` and never
 * returned, so no index built from this can carry an invented relationship.
 */
export function parseCapabilityMap(md: string | null): CapabilityMap {
  const map: CapabilityMap = { present: false, capabilities: [], relationships: [], issues: [] };
  if (!md) return map;
  map.present = true;
  const headings = headingIndex(md);

  for (const h of headings) {
    const m = h.level === 3 ? h.text.match(/^Capability:\s*(.+)$/) : null;
    if (!m) continue;
    const id = m[1].replace(/`/g, "").trim();
    if (!ID_RE.test(id)) {
      map.issues.push(`capability id "${id}" is not a lowercase slug`);
      continue;
    }
    if (map.capabilities.some((c) => c.id === id)) {
      map.issues.push(`capability "${id}" is declared more than once`);
      continue;
    }
    const fields = new Map<string, string>();
    for (const t of tablesIn(sectionLines(md, h))) {
      if (!/^field$/i.test(t.header[0] ?? "")) continue;
      for (const row of t.rows) fields.set((row[0] ?? "").toLowerCase(), row[1] ?? "");
    }
    const f = (name: string) => fields.get(name.toLowerCase());
    const refs = (name: string) => parseRefs(f(name)).map((r) => r.ref);
    const surfaces = idList(f("Surfaces"));
    const all = surfaces.length === 0 || (surfaces.length === 1 && surfaces[0] === "all");
    map.capabilities.push({
      id,
      name: textCell(f("Name")),
      anchor: h.anchor,
      surfaceScope: all ? "all" : "subset",
      surfaces: all ? [] : surfaces,
      sourceRoots: parseRefs(f("Source roots")).map((r) => ({ path: r.ref, surface: r.surface })),
      entryPoints: refs("Entry points"),
      components: refs("Screens and components"),
      services: refs("Services and modules"),
      routes: refs("Navigation routes"),
      dataDependencies: refs("Data dependencies"),
      stateOwnership: refs("State ownership"),
      tests: refs("Tests"),
      evidence: refs("Evidence"),
    });
  }

  const ids = new Set(map.capabilities.map((c) => c.id));
  const relHeading = headings.find((x) => x.level === 2 && x.anchor === "#relationships");
  const relTable = relHeading ? tablesIn(sectionLines(md, relHeading)).find((t) => /^from$/i.test(t.header[0] ?? "")) : undefined;
  for (const row of relTable?.rows ?? []) {
    const from = textCell(row[0]) ?? "";
    const type = textCell(row[1]) ?? "";
    const to = textCell(row[2]) ?? "";
    const kind = textCell(row[3]) ?? "";
    const evidence = parseRefs(row[4]).map((r) => r.ref);
    const label = `${from} ${type} ${to}`;
    if (!(RELATIONSHIP_TYPES as readonly string[]).includes(type)) {
      map.issues.push(`relationship "${label}": type "${type}" is not in the vocabulary`);
      continue;
    }
    if (!(EVIDENCE_KINDS as readonly string[]).includes(kind)) {
      map.issues.push(`relationship "${label}": evidence kind "${kind}" is not accepted (naming/semantic similarity is never evidence)`);
      continue;
    }
    if (!ids.has(from) || !ids.has(to) || from === to) {
      map.issues.push(`relationship "${label}": endpoints must be two different declared capabilities`);
      continue;
    }
    if (evidence.length === 0) {
      map.issues.push(`relationship "${label}": no evidence`);
      continue;
    }
    const id = relationshipId(from, type, to);
    if (map.relationships.some((r) => r.id === id)) {
      map.issues.push(`relationship "${id}" is declared more than once`);
      continue;
    }
    const [a, b] = id.split(`:${type}:`);
    map.relationships.push({ id, from: a, type, to: b, evidenceKind: kind, evidence });
  }
  return map;
}

/** Whether `rel` is `root` itself or inside it (a root ending in `/` is a directory). */
export function isUnder(rel: string, root: string): boolean {
  if (root.endsWith("/")) return rel.startsWith(root);
  return rel === root || rel.startsWith(`${root}/`);
}
