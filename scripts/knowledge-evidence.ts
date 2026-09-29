/**
 * knowledge-evidence.ts
 *
 * Deterministic source-evidence gate for generic Project Knowledge. Every fact
 * the Inspector persists about surfaces, surface-scoped conventions,
 * inventory scoping, capabilities and capability relationships must answer
 * "where in THIS repository did this come from?" This helper proves it
 * against the repository's *current* source:
 *
 * - every evidence ref (`path` or `path::token`) names an existing,
 *   non-Inspector-owned path, and the token literally occurs in that file;
 * - every surface, shared-code root and capability is grounded in evidence
 *   and in source roots that exist;
 * - every relationship's evidence is a concrete source edge located on its
 *   endpoints (shared-* kinds on BOTH endpoints, sharing a token) — naming or
 *   semantic similarity is never accepted;
 * - overrides and inventory rows only name declared surfaces, overrides sit
 *   under their own shared section and never merely repeat it, and the same
 *   code is never represented as two capabilities.
 *
 * It is a check, not a repair. The project-inspector agent runs it from the
 * after-hooks of the source-backed stages, before record-knowledge certifies
 * the knowledge; a violation stops the stage.
 *
 * Usage:
 *   bun scripts/knowledge-evidence.ts verify <repo-root> [surfaces|docs|all]
 *
 * Exit codes:
 *   0 - every checked fact is grounded
 *   1 - usage error, missing repo root, or a .claude/worktrees path
 *   3 - violations found (JSON `errors[]` on stdout)
 * Never writes anything.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "fs";
import { join, sep } from "path";
import {
  CAPABILITIES_DOC,
  GENERIC_PATTERN_SECTIONS,
  SHARED_EVIDENCE_KINDS,
  directBody,
  headingIndex,
  inventoryTables,
  isUnder,
  overrideHeading,
  parseCapabilityMap,
  parseEvidenceRef,
  parseInventory,
  parseSurfaceModel,
  Capability,
} from "./knowledge-model";
import { isInspectorOwned } from "./inspection-state";

const WORKTREE_MARKER = `${sep}.claude${sep}worktrees${sep}`;

/** Inventory sections whose tables must carry a Surface column. */
const SCOPED_INVENTORY: Array<[string, string[]]> = [
  ["docs/project/components.md", ["Screens", "Reusable UI Components", "Shared Hooks / Utilities"]],
  ["docs/project/integrations.md", ["Backend Services / APIs", "Third-Party SDKs"]],
];

interface Violation {
  code: string;
  where: string;
  message: string;
}

export function verify(repoRoot: string, scope: "surfaces" | "docs" | "all"): Violation[] {
  const errors: Violation[] = [];
  const fail = (code: string, where: string, message: string) => errors.push({ code, where, message });
  const read = (rel: string): string | null => {
    const p = join(repoRoot, rel);
    return existsSync(p) && statSync(p).isFile() ? readFileSync(p, "utf-8") : null;
  };

  const pathOk = (rel: string): boolean =>
    rel.length > 0 && !rel.startsWith("/") && !rel.split("/").includes("..") && existsSync(join(repoRoot, rel));

  /** Resolve one evidence ref against current source; report and return false on failure. */
  const resolve = (ref: string, where: string): boolean => {
    const { path, token } = parseEvidenceRef(ref);
    if (isInspectorOwned(path)) {
      fail("evidence-inspector-owned", where, `"${ref}" is an Inspector artifact, not repository evidence`);
      return false;
    }
    if (!pathOk(path)) {
      fail("evidence-unresolved", where, `"${path}" does not exist`);
      return false;
    }
    if (token === null) return true;
    const body = read(path);
    if (body === null || !body.includes(token)) {
      fail("evidence-unresolved", where, `"${token}" does not occur in ${path}`);
      return false;
    }
    return true;
  };

  const claudeMd = read("CLAUDE.md");
  const model = parseSurfaceModel(claudeMd);
  const surfaceIds = model.surfaces.map((s) => s.id);
  const known = new Set(surfaceIds);

  if (!model.present || model.surfaces.length === 0) {
    fail("surfaces-missing", "CLAUDE.md#targets-and-surfaces", "no Targets and Surfaces table (at least one surface row is required)");
  }

  // --- surfaces -------------------------------------------------------------
  if (scope !== "docs") {
    for (const issue of model.issues) {
      fail(/form factor/.test(issue) ? "surface-form-factor" : "surface-invalid", `surface: ${issue}`, issue);
    }
    const seen = new Set<string>();
    for (const s of model.surfaces) {
      const where = `surface:${s.id}`;
      if (seen.has(s.id)) fail("surface-duplicate-id", where, `surface "${s.id}" is declared more than once`);
      seen.add(s.id);
      if (!s.formFactor && !model.issues.some((i) => i.includes(`"${s.id}"`))) fail("surface-form-factor", where, "form factor is missing");
      if (!s.platform) fail("surface-invalid", where, "platform is missing");
      if (s.sourceRoots.length === 0) fail("surface-root-missing", where, "no source roots");
      for (const r of s.sourceRoots) {
        if (isInspectorOwned(r) || !pathOk(r)) fail("surface-root-missing", `${where} root ${r}`, `source root "${r}" does not exist`);
      }
      for (const other of s.sharedWith) {
        if (other === s.id || !known.has(other)) fail("shared-with-unknown", where, `"${other}" is not another declared surface`);
      }
      if (s.evidence.length === 0) fail("surface-evidence-missing", where, "no repository evidence (build/project file) for this surface");
      for (const ref of s.evidence) resolve(ref, `${where} evidence`);
    }
    for (const c of model.sharedCode) {
      const where = `shared-code:${c.root}`;
      if (!pathOk(c.root) || isInspectorOwned(c.root)) fail("shared-code-invalid", where, `"${c.root}" does not exist`);
      if (c.sharedBy.length < 2 || c.sharedBy.some((id) => !known.has(id))) {
        fail("shared-code-invalid", where, `shared by must name at least two declared surfaces (got ${c.sharedBy.join(", ") || "none"})`);
      }
      if (c.evidence.length === 0) fail("shared-code-invalid", where, "no repository evidence for the sharing mechanism");
      for (const ref of c.evidence) resolve(ref, `${where} evidence`);
    }
  }

  if (scope === "surfaces") return errors;

  // --- generic patterns + per-surface overrides --------------------------------
  const patterns = read("docs/project/patterns.md") ?? "";
  const pHeadings = headingIndex(patterns);
  const sectionNames = new Set(pHeadings.filter((h) => h.level === 2).map((h) => h.text));
  for (const name of GENERIC_PATTERN_SECTIONS) {
    if (!sectionNames.has(name)) fail("pattern-section-missing", `docs/project/patterns.md: ${name}`, `missing "## ${name}"`);
  }
  const overrides = new Set<string>();
  for (const h of pHeadings) {
    const o = overrideHeading(h);
    if (!o || !sectionNames.has(o.section)) continue;
    const where = `docs/project/patterns.md${h.anchor}`;
    const parent = pHeadings.find((p) => p.anchor === h.parent);
    if (!parent || parent.text !== o.section) {
      fail("override-orphan", where, `"${h.text}" is not under "## ${o.section}"`);
      continue;
    }
    if (!known.has(o.surface)) fail("override-unknown-surface", `${where} (${o.surface})`, `"${o.surface}" is not a declared surface`);
    const key = `${o.section}|${o.surface}`;
    if (overrides.has(key)) fail("override-duplicate", where, `"${h.text}" appears more than once`);
    overrides.add(key);
    const norm = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();
    if (norm(directBody(patterns, h)) === norm(directBody(patterns, parent))) {
      fail("override-duplicates-shared", where, "an override must state only how this surface differs; it repeats the shared convention");
    }
  }

  // --- inventory scoping ---------------------------------------------------------
  for (const [doc, sections] of SCOPED_INVENTORY) {
    const md = read(doc);
    for (const t of inventoryTables(md)) {
      if (sections.includes(t.section) && !t.hasSurfaceColumn) {
        fail("inventory-surface-missing", `${doc}${t.anchor} (${t.section})`, "table has no Surface column");
      }
    }
    for (const row of parseInventory(md)) {
      if (!sections.includes(row.section) || !row.hasSurfaceColumn) continue;
      const where = `${doc}${row.anchor} ${row.name}`;
      if (row.surfaceScope === "unknown") fail("inventory-surface-missing", where, "Surface is empty (use `all` or surface ids)");
      for (const id of row.surfaces) if (!known.has(id)) fail("inventory-surface-unknown", where, `"${id}" is not a declared surface`);
    }
  }

  // --- capabilities ---------------------------------------------------------------
  const map = parseCapabilityMap(read(CAPABILITIES_DOC));
  if (!map.present || map.capabilities.length === 0) {
    fail("capabilities-missing", CAPABILITIES_DOC, "no capabilities declared");
    return errors;
  }
  for (const issue of map.issues) fail(issue.startsWith("relationship") ? "relationship-invalid" : "capability-invalid", `${CAPABILITIES_DOC}: ${issue}`, issue);

  const components = new Set(parseInventory(read("docs/project/components.md")).map((r) => r.name));
  const integrations = new Set(parseInventory(read("docs/project/integrations.md")).map((r) => r.name));
  const rootOwner = new Map<string, string>();
  const byId = new Map<string, Capability>();

  for (const c of map.capabilities) {
    byId.set(c.id, c);
    const where = `capability:${c.id}`;
    if (!c.name) fail("capability-invalid", where, "name is missing");
    for (const s of c.surfaces) if (!known.has(s)) fail("capability-surface-unknown", where, `"${s}" is not a declared surface`);
    if (c.sourceRoots.length === 0) fail("capability-root-missing", where, "no source roots");
    for (const r of c.sourceRoots) {
      if (isInspectorOwned(r.path) || !pathOk(r.path)) fail("capability-root-missing", `${where} root ${r.path}`, `source root "${r.path}" does not exist`);
      if (r.surface && (!known.has(r.surface) || (c.surfaceScope === "subset" && !c.surfaces.includes(r.surface)))) {
        fail("capability-surface-unknown", `${where} root ${r.path}`, `"${r.surface}" is not one of this capability's surfaces`);
      }
      const owner = rootOwner.get(r.path);
      if (owner && owner !== c.id) {
        fail("capability-root-shared", `${where} root ${r.path}`, `"${r.path}" already belongs to capability "${owner}"; represent shared code once`);
      } else rootOwner.set(r.path, c.id);
    }
    if (c.evidence.length === 0) fail("capability-no-evidence", where, "no repository evidence for this capability");
    for (const ref of c.evidence) resolve(ref, `${where} evidence`);
    for (const [field, list] of [
      ["entry points", c.entryPoints], ["services", c.services], ["routes", c.routes], ["state", c.stateOwnership], ["tests", c.tests],
    ] as Array<[string, string[]]>) {
      for (const ref of list) resolve(ref, `${where} ${field}`);
    }
    for (const name of c.components) {
      if (!components.has(name)) fail("capability-component-unresolved", `${where} component ${name}`, `"${name}" is not in docs/project/components.md`);
    }
    for (const dep of c.dataDependencies) {
      if (integrations.has(dep)) continue;
      if (dep.includes("/") && resolve(dep, `${where} data ${dep}`)) continue;
      if (!dep.includes("/")) fail("capability-data-unresolved", `${where} data ${dep}`, `"${dep}" is neither in docs/project/integrations.md nor a repository path`);
    }
  }

  // --- relationships: grounded first-degree edges ------------------------------------
  const scopeOf = (c: Capability): string[] => [...c.sourceRoots.map((r) => r.path), ...c.tests.map((t) => parseEvidenceRef(t).path)];
  const on = (ref: string, c: Capability) => scopeOf(c).some((root) => isUnder(parseEvidenceRef(ref).path, root));

  for (const r of map.relationships) {
    const where = `relationship:${r.id}`;
    const resolved = r.evidence.map((ref) => resolve(ref, where)).every(Boolean);
    if (!resolved) continue;
    const from = byId.get(r.from) as Capability;
    const to = byId.get(r.to) as Capability;
    let grounded: boolean;
    if (SHARED_EVIDENCE_KINDS.has(r.evidenceKind)) {
      const tokens = (c: Capability) => new Set(r.evidence.filter((e) => on(e, c)).map((e) => parseEvidenceRef(e).token).filter((t): t is string => !!t));
      const a = tokens(from);
      grounded = [...tokens(to)].some((t) => a.has(t));
    } else if (r.evidenceKind === "test") {
      const perFile = new Map<string, Set<string>>();
      for (const e of r.evidence.filter((e) => on(e, from) || on(e, to))) {
        const { path, token } = parseEvidenceRef(e);
        if (token) (perFile.get(path) ?? perFile.set(path, new Set()).get(path)!).add(token);
      }
      grounded = [...perFile.values()].some((set) => set.size >= 2);
    } else if (r.evidenceKind === "repository-doc") {
      grounded = r.evidence.every((e) => parseEvidenceRef(e).token !== null);
    } else {
      grounded = r.evidence.some((e) => on(e, from) || on(e, to));
    }
    if (!grounded) {
      fail("relationship-ungrounded", where,
        SHARED_EVIDENCE_KINDS.has(r.evidenceKind)
          ? "shared-* evidence must show the same token used inside BOTH capabilities' source roots"
          : r.evidenceKind === "test"
            ? "test evidence must show one test file (in either capability) exercising both capabilities"
            : r.evidenceKind === "repository-doc"
              ? "repository-doc evidence must quote the statement (path::token)"
              : "evidence must be located inside one of the two capabilities' source roots");
    }
  }
  return errors;
}

function main(): void {
  const [, , command, repoRoot, scopeArg = "all"] = process.argv;
  if (command !== "verify" || !repoRoot) {
    console.error("Usage: knowledge-evidence.ts verify <repo-root> [surfaces|docs|all]");
    process.exit(1);
  }
  if (!["surfaces", "docs", "all"].includes(scopeArg)) {
    console.error(`Unknown scope "${scopeArg}" (expected surfaces, docs, or all).`);
    process.exit(1);
  }
  if (!existsSync(repoRoot)) {
    console.error(`Repository root not found: ${repoRoot}`);
    process.exit(1);
  }
  if (realpathSync(repoRoot).includes(WORKTREE_MARKER)) {
    console.error(`Refusing to operate on a Claude agent worktree: ${repoRoot}\nPass the resolved main repository root (scripts/resolve-repo-root.ts).`);
    process.exit(1);
  }
  const scope = scopeArg as "surfaces" | "docs" | "all";
  const errors = verify(realpathSync(repoRoot), scope);
  console.log(JSON.stringify({ ok: errors.length === 0, scope, errors }, null, 2));
  process.exit(errors.length === 0 ? 0 : 3);
}

if (require.main === module) {
  main();
}
