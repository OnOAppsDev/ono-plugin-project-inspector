/**
 * knowledge-evidence.test.ts
 *
 * End-to-end tests for scripts/knowledge-evidence.ts — the deterministic gate
 * that proves every persisted surface, capability and capability relationship
 * is grounded in the repository's *current* source. Builds throwaway
 * repositories and runs the CLI (stdout JSON + exit code).
 *
 * No external test framework. Run with:
 *   bun scripts/knowledge-evidence.test.ts
 */

import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  write,
  initGit,
  commitAll,
  git,
  writeApp,
  writeKnowledge,
  writeFamily,
  surfacesSection,
  patternsMd,
  componentsMd,
  FAMILIES,
  APP_SOURCE,
  APP_SURFACES,
  APP_SHARED,
  APP_CAPABILITIES,
  APP_RELATIONSHIPS,
  APP_SCREENS,
  APP_COMPONENTS,
  REL_NAVIGATES,
  REL_SHARED_COMPONENT,
  REL_SHARED_STATE,
  REL_SHARED_SERVICE,
  RelationshipFixture,
} from "./fixtures/knowledge-fixtures";

const HERE = typeof __dirname !== "undefined" ? __dirname : ".";
const HELPER = join(HERE, "knowledge-evidence.ts");
const RUNTIME = process.execPath;

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ""}`); }
}

function run(args: string[]): { code: number; out: any; raw: string } {
  let raw = "";
  let code = 0;
  try {
    raw = execFileSync(RUNTIME, [HELPER, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err: any) {
    code = typeof err.status === "number" ? err.status : 1;
    raw = err.stdout?.toString() ?? "";
  }
  let out: any = null;
  try { out = JSON.parse(raw); } catch { /* usage errors print no JSON */ }
  return { code, out, raw };
}

const codes = (r: { out: any }): string[] => (r.out?.errors ?? []).map((e: any) => e.code);
const has = (r: { out: any }, code: string, where?: string): boolean =>
  (r.out?.errors ?? []).some((e: any) => e.code === code && (!where || String(e.where).includes(where)));

const root = mkdtempSync(join(realpathSync(tmpdir()), "ke-"));
let n = 0;
function app(opts: Parameters<typeof writeApp>[1] = {}): string {
  const dir = join(root, `app-${++n}`);
  mkdirSync(dir, { recursive: true });
  writeApp(dir, opts);
  return dir;
}
function withRels(rels: RelationshipFixture[]): string {
  return app({ relationships: rels });
}

try {
  // --- V1: every supported project family verifies cleanly (Part M) ---
  for (const f of FAMILIES) {
    const dir = join(root, `family-${f.name}`);
    mkdirSync(dir, { recursive: true });
    writeFamily(dir, f);
    const r = run(["verify", dir, "all"]);
    check(`V1 ${f.name}: verify passes`, r.code === 0 && r.out?.ok === true, r.raw);
  }

  // --- V2: the evidence-consistent app verifies; each relationship kind alone verifies (Part N 1–4) ---
  {
    const r = run(["verify", app(), "all"]);
    check("V2 app: all scopes pass", r.code === 0 && r.out?.ok === true, r.raw);
    for (const [label, rel] of [
      ["N1 shared component", REL_SHARED_COMPONENT],
      ["N2 navigates_to", REL_NAVIGATES],
      ["N3 shared state/store", REL_SHARED_STATE],
      ["N4 shared service (A and C)", REL_SHARED_SERVICE],
    ] as Array<[string, RelationshipFixture]>) {
      const one = run(["verify", withRels([rel]), "docs"]);
      check(`V2 ${label}: grounded relationship accepted`, one.code === 0, one.raw);
    }
    const covered = run(["verify", withRels([{
      from: "epg", type: "covered_by", to: "player", kind: "test",
      evidence: ["src/features/epg/__tests__/epg.test.tsx::EpgScreen", "src/features/epg/__tests__/epg.test.tsx::PlayerScreen"],
    }]), "docs"]);
    check("V2 a test exercising both capabilities is accepted", covered.code === 0, covered.raw);
  }

  // --- V3 (Part N5): a relationship whose source edge is removed no longer verifies ---
  {
    const dir = app();
    initGit(dir);
    commitAll(dir, "baseline");
    check("V3 baseline verifies", run(["verify", dir, "docs"]).code === 0);
    write(dir, "src/features/epg/EpgScreen.tsx",
      "import { ChannelTile } from '../../components/ChannelTile';\nimport { useGuideStore } from '../../store/guideStore';\nexport const EpgScreen = () => ChannelTile;\n");
    commitAll(dir, "remove navigation edge");
    const stale = run(["verify", dir, "docs"]);
    check("V3 removed edge: verify fails (exit 3)", stale.code === 3, stale.raw);
    check("V3 removed edge: the navigates_to relationship is named", has(stale, "evidence-unresolved", "epg:navigates_to:player"), stale.raw);
    check("V3 removed edge: unaffected relationships are not reported",
      !has(stale, "evidence-unresolved", "epg:shares_component_with:channels"), stale.raw);
    // The refresh regenerates the map without the dead edge -> verifies again.
    writeKnowledge(dir, {
      relationships: APP_RELATIONSHIPS.filter((r) => r !== REL_NAVIGATES),
      capabilities: APP_CAPABILITIES.map((c) => (c.id === "epg" ? { ...c, routes: [] } : c)),
    });
    check("V3 regenerated map without the edge verifies", run(["verify", dir, "docs"]).code === 0);
    check("V3 git HEAD untouched by verify", git(dir, "status", "--porcelain").split("\n").every((l) => !l.startsWith(" M src/")));
  }

  // --- V4 (Part N6): no relationship from naming similarity alone ---
  {
    const naming = run(["verify", withRels([{ from: "search", type: "related_to", to: "search-history", kind: "naming", evidence: ["src/features/search/SearchScreen.tsx"] }]), "docs"]);
    check("V4 'naming' evidence kind rejected", naming.code === 3 && has(naming, "relationship-invalid"), naming.raw);

    const oneSided = run(["verify", withRels([{
      from: "search", type: "related_to", to: "search-history", kind: "shared-service",
      evidence: ["src/features/search/SearchScreen.tsx::CatalogService"],
    }]), "docs"]);
    check("V4 shared-service claimed but only one side uses it -> ungrounded", oneSided.code === 3 && has(oneSided, "relationship-ungrounded", "search:related_to:search-history"), oneSided.raw);

    const elsewhere = run(["verify", withRels([{
      from: "search", type: "depends_on", to: "search-history", kind: "import",
      evidence: ["src/index.ts::EpgScreen"],
    }]), "docs"]);
    check("V4 import evidence outside both capabilities' roots -> ungrounded", has(elsewhere, "relationship-ungrounded"), elsewhere.raw);

    const imagined = run(["verify", withRels([{
      from: "search", type: "depends_on", to: "search-history", kind: "import",
      evidence: ["src/features/search/SearchScreen.tsx::SearchHistoryScreen"],
    }]), "docs"]);
    check("V4 an import that does not exist in source -> unresolved", has(imagined, "evidence-unresolved"), imagined.raw);

    const selfDoc = run(["verify", withRels([{
      from: "search", type: "related_to", to: "search-history", kind: "repository-doc",
      evidence: ["docs/project/overview.md::Demo"],
    }]), "docs"]);
    check("V4 Inspector-owned docs are not repository evidence (no circular proof)", has(selfDoc, "evidence-inspector-owned"), selfDoc.raw);

    const explicit = app({
      source: { ...APP_SOURCE, "docs/architecture.md": "Search History is recorded by Search.\n" },
      relationships: [{ from: "search", type: "writes_to", to: "search-history", kind: "repository-doc", evidence: ["docs/architecture.md::Search History is recorded by Search"] }],
    });
    check("V4 explicit repository documentation is acceptable evidence", run(["verify", explicit, "docs"]).code === 0);
  }

  // --- V5: capabilities must be grounded; shared code represented once (Part N7/N8) ---
  {
    const noEvidence = run(["verify", app({ capabilities: APP_CAPABILITIES.map((c) => (c.id === "search-history" ? { ...c, evidence: [] } : c)) }), "docs"]);
    check("V5 capability without evidence rejected", has(noEvidence, "capability-no-evidence", "search-history"), noEvidence.raw);

    const invented = run(["verify", app({
      capabilities: [...APP_CAPABILITIES, { id: "downloads", name: "Downloads", surfaces: "all", sourceRoots: ["src/features/downloads/"], evidence: ["src/features/downloads/index.ts"] }],
    }), "docs"]);
    check("V5 invented capability (no such source) rejected", has(invented, "capability-root-missing", "downloads") && has(invented, "evidence-unresolved", "downloads"), invented.raw);

    const perSurfaceCopy = run(["verify", app({
      capabilities: [...APP_CAPABILITIES, { id: "player-tv", name: "Player (TV)", surfaces: "`tizen`", sourceRoots: ["src/features/player/"], evidence: ["src/features/player/PlayerScreen.tsx::PlayerScreen"] }],
    }), "docs"]);
    check("V5 same code duplicated as a per-surface capability rejected", has(perSurfaceCopy, "capability-root-shared", "src/features/player/"), perSurfaceCopy.raw);

    const badSurface = run(["verify", app({ capabilities: APP_CAPABILITIES.map((c) => (c.id === "search" ? { ...c, surfaces: "`roku`" } : c)) }), "docs"]);
    check("V5 capability on an undeclared surface rejected", has(badSurface, "capability-surface-unknown", "search"), badSurface.raw);

    const unresolved = run(["verify", app({ capabilities: APP_CAPABILITIES.map((c) => (c.id === "epg" ? { ...c, components: ["GhostGrid"] } : c)) }), "docs"]);
    check("V5 capability component must exist in components.md (reference, not copy)", has(unresolved, "capability-component-unresolved", "GhostGrid"), unresolved.raw);

    const badData = run(["verify", app({ capabilities: APP_CAPABILITIES.map((c) => (c.id === "search" ? { ...c, data: ["Imaginary API"] } : c)) }), "docs"]);
    check("V5 data dependency must resolve to integrations.md or a real path", has(badData, "capability-data-unresolved", "Imaginary API"), badData.raw);
  }

  // --- V6: surfaces are grounded; no volatile claim without repository evidence ---
  {
    const noEvidence = run(["verify", app({ surfaces: surfacesSection([{ ...APP_SURFACES[0], evidence: [] }, APP_SURFACES[1]], APP_SHARED) }), "surfaces"]);
    check("V6 surface without evidence rejected", has(noEvidence, "surface-evidence-missing", "web"), noEvidence.raw);

    const claim = run(["verify", app({ surfaces: surfacesSection([APP_SURFACES[0], { ...APP_SURFACES[1], minimum: "Tizen 9.0", evidence: ["tizen/config.xml::required_version=\"9.0\""] }], APP_SHARED) }), "surfaces"]);
    check("V6 minimum OS not present in the build files rejected", has(claim, "evidence-unresolved", "tizen"), claim.raw);

    const circular = run(["verify", app({ surfaces: surfacesSection([{ ...APP_SURFACES[0], evidence: ["CLAUDE.md"] }, APP_SURFACES[1]], APP_SHARED) }), "surfaces"]);
    check("V6 CLAUDE.md is not evidence for itself", has(circular, "evidence-inspector-owned"), circular.raw);

    const dup = run(["verify", app({ surfaces: surfacesSection([APP_SURFACES[0], { ...APP_SURFACES[1], id: "web" }], []) }), "surfaces"]);
    check("V6 duplicate surface id rejected (would flatten two surfaces)", has(dup, "surface-duplicate-id", "web"), dup.raw);

    const ff = run(["verify", app({ surfaces: surfacesSection([{ ...APP_SURFACES[0], formFactor: "mobile" }, APP_SURFACES[1]], APP_SHARED) }), "surfaces"]);
    check("V6 routing vocabulary ('mobile') is not an Inspector form factor", has(ff, "surface-form-factor", "web"), ff.raw);

    const shared = run(["verify", app({ surfaces: surfacesSection(APP_SURFACES, [{ ...APP_SHARED[0], sharedBy: ["web", "roku"] }]) }), "surfaces"]);
    check("V6 shared code naming an undeclared surface rejected", has(shared, "shared-code-invalid"), shared.raw);

    const legacyDir = app();
    write(legacyDir, "CLAUDE.md", "# CLAUDE.md — Legacy\n\n## Tech Stack\n\n- Platform(s): Web, Tizen\n");
    const legacy = run(["verify", legacyDir, "surfaces"]);
    check("V6 CLAUDE.md without the section -> surfaces-missing", has(legacy, "surfaces-missing"), legacy.raw);
  }

  // --- V7: shared conventions + per-surface overrides ---
  {
    const dupShared = run(["verify", app({ patterns: patternsMd({ "Accessibility": { tizen: "Same as shared." } }, { "Accessibility": "Same as shared." }) }), "docs"]);
    check("V7 override that repeats the shared convention rejected", has(dupShared, "override-duplicates-shared", "accessibility-tizen"), dupShared.raw);

    const unknown = run(["verify", app({ patterns: patternsMd({ "Media and Playback": { roku: "Roku player." } }) }), "docs"]);
    check("V7 override for an undeclared surface rejected", has(unknown, "override-unknown-surface", "roku"), unknown.raw);

    const orphanMd = patternsMd().replace("## Unknowns", "### Media and Playback (tizen)\n\nMisplaced.\n\n## Unknowns");
    const orphan = run(["verify", app({ patterns: orphanMd }), "docs"]);
    check("V7 override outside its shared section rejected", has(orphan, "override-orphan"), orphan.raw);

    const missing = run(["verify", app({ patterns: patternsMd().replace("## Platform Adapters", "## Something Else") }), "docs"]);
    check("V7 missing generic pattern section rejected", has(missing, "pattern-section-missing", "Platform Adapters"), missing.raw);
  }

  // --- V8: inventory scoping ---
  {
    const unknown = run(["verify", app({ components: componentsMd(APP_SCREENS, [...APP_COMPONENTS, { name: "RokuRow", path: "src/tv/FocusRow.tsx", surface: "`roku`" }]) }), "docs"]);
    check("V8 inventory row on an undeclared surface rejected", has(unknown, "inventory-surface-unknown", "RokuRow"), unknown.raw);

    const noColumn = run(["verify", app({ components: "# C\n\n## Screens\n\n| Screen | Path | Purpose | Notes |\n|---|---|---|---|\n| `EpgScreen` | `a` | b | |\n\n## Reusable UI Components\n\nNot applicable — none.\n\n## Shared Hooks / Utilities\n\nNot applicable — none.\n" }), "docs"]);
    check("V8 inventory table without a Surface column rejected", has(noColumn, "inventory-surface-missing", "Screens"), noColumn.raw);
  }

  // --- V9: scopes, usage, worktree ---
  {
    const dir = app();
    const surfacesOnly = run(["verify", dir, "surfaces"]);
    check("V9 surfaces scope passes without reading docs", surfacesOnly.code === 0 && surfacesOnly.out?.scope === "surfaces", surfacesOnly.raw);
    write(dir, "docs/project/capabilities.md", "# nothing\n");
    check("V9 surfaces scope ignores docs problems", run(["verify", dir, "surfaces"]).code === 0);
    const docs = run(["verify", dir, "docs"]);
    check("V9 docs scope reports a map without capabilities", has(docs, "capabilities-missing"), docs.raw);
    check("V9 usage: no args -> exit 1", run([]).code === 1);
    check("V9 usage: bad scope -> exit 1", run(["verify", dir, "everything"]).code === 1);
    check("V9 usage: missing root -> exit 1", run(["verify", join(root, "nope")]).code === 1);

    initGit(dir);
    commitAll(dir, "x");
    const wt = join(dir, ".claude", "worktrees", "agent-1");
    git(dir, "worktree", "add", "-q", wt);
    check("V9 worktree refused (exit 1)", run(["verify", wt, "all"]).code === 1);
    check("V9 error codes are stable strings", codes(docs).every((c) => /^[a-z-]+$/.test(c)), JSON.stringify(codes(docs)));
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures > 0 ? 1 : 0);
