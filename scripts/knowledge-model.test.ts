/**
 * knowledge-model.test.ts
 *
 * Unit tests for scripts/knowledge-model.ts — the single deterministic parser
 * of the generic Project Knowledge model (surfaces, surface-scoped anchors,
 * capabilities, capability relationships). Pure functions, no filesystem.
 *
 * No external test framework. Run with:
 *   bun scripts/knowledge-model.test.ts
 */

import {
  headingAnchors,
  surfaceAnchors,
  parseSurfaceModel,
  parseCapabilityMap,
  parseRefs,
  parseEvidenceRef,
  parseInventory,
  relationshipId,
  FORM_FACTORS,
  RELATIONSHIP_TYPES,
  EVIDENCE_KINDS,
  GENERIC_PATTERN_SECTIONS as MODEL_SECTIONS,
} from "./knowledge-model";
import {
  surfacesSection,
  claudeMd,
  patternsMd,
  capabilitiesMd,
  componentsMd,
  integrationsMd,
  FAMILIES,
  APP_SURFACES,
  APP_SHARED,
  APP_CAPABILITIES,
  APP_RELATIONSHIPS,
  APP_SCREENS,
  APP_COMPONENTS,
  APP_SERVICES,
  GENERIC_PATTERN_SECTIONS,
} from "./fixtures/knowledge-fixtures";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ""}`); }
}
const j = (v: unknown) => JSON.stringify(v);

// --- A1: duplicate headings never silently lose an anchor (Part K) ---
{
  const md = "# T\n\n## Setup\n\n### Notes\n\n## Usage\n\n### Notes\n\n### Notes\n\n## Notes 1\n";
  const a = headingAnchors(md);
  check("A1 first occurrence keeps its plain anchor", a[0] === "#setup" && a[1] === "#notes", j(a));
  check("A1 duplicates get deterministic -1/-2 suffixes", a.includes("#notes-1") && a.includes("#notes-2"), j(a));
  check("A1 every heading has an anchor (none dropped)", a.length === 6, j(a));
  check("A1 a suffix never collides with a real heading", new Set(a).size === a.length, j(a));
  check("A1 unique anchors unchanged (existing behaviour)", j(headingAnchors("## State Management\n## Testing Patterns\n")) === j(["#state-management", "#testing-patterns"]));
  check("A1 deterministic across calls", j(headingAnchors(md)) === j(a));
}

// --- A2: per-surface overrides are indexed under their shared section ---
{
  const md = patternsMd({
    "Input and Interaction": { tvos: "Focus engine.", ios: "Touch." },
    "App Lifecycle and State": { tvos: "Top shelf resume." },
  });
  const anchors = headingAnchors(md);
  check("A2 shared section anchor present once", anchors.filter((x) => x === "#input-and-interaction").length === 1, j(anchors));
  check("A2 override anchor is <section>-<surface>", anchors.includes("#input-and-interaction-tvos"), j(anchors));
  const sa = surfaceAnchors(md, ["ios", "tvos"]);
  check("A2 surfaceAnchors keyed by surface id", j(Object.keys(sa).sort()) === j(["ios", "tvos"]), j(sa));
  check("A2 tvos overrides carry their parent section",
    j(sa.tvos) === j([
      { section: "#input-and-interaction", anchor: "#input-and-interaction-tvos" },
      { section: "#app-lifecycle-and-state", anchor: "#app-lifecycle-and-state-tvos" },
    ]), j(sa.tvos));
  check("A2 a surface without overrides inherits (absent key)", !("android" in surfaceAnchors(md, ["ios", "tvos", "android"])));
  check("A2 unknown parenthetical is not a surface override", j(surfaceAnchors("## Localization / RTL\n\n### Localization (RTL)\n", ["ios"])) === j({}));
  check("A2 no surface model -> no overrides indexed", j(surfaceAnchors(md, [])) === j({}));
}

// --- A3: the fixture's generic sections equal the model's (single definition) ---
check("A3 generic pattern sections match the model", j(MODEL_SECTIONS) === j(GENERIC_PATTERN_SECTIONS), j(MODEL_SECTIONS));
check("A3 no TV-specific section in the generic model", !MODEL_SECTIONS.some((s: string) => /\btv\b|focus|remote/i.test(s)));
check("A3 form factors are Inspector-neutral", j(FORM_FACTORS) === j(["handheld", "desktop", "tv", "wearable", "other"]));
check("A3 relationship vocabulary is small and closed", RELATIONSHIP_TYPES.length === 10 && RELATIONSHIP_TYPES.includes("navigates_to"));
check("A3 no name-similarity evidence kind exists", !EVIDENCE_KINDS.some((k: string) => /name|semantic|similar/i.test(k)));

// --- A4: refs and evidence refs ---
{
  const r = parseRefs("`src/a/`, `tv/b/` (tvos), plain text");
  check("A4 backticked refs parsed", j(r) === j([{ ref: "src/a/", surface: null }, { ref: "tv/b/", surface: "tvos" }]), j(r));
  check("A4 None/Unknown/Not applicable -> []", parseRefs("None").length === 0 && parseRefs("Unknown").length === 0 && parseRefs("Not applicable — x").length === 0);
  check("A4 evidence path::token", j(parseEvidenceRef("a/b.ts::navigate(\"X\")")) === j({ path: "a/b.ts", token: "navigate(\"X\")" }));
  check("A4 evidence bare path", j(parseEvidenceRef("a/b.ts")) === j({ path: "a/b.ts", token: null }));
}

// --- A5: every supported family yields separate, unflattened surfaces (Part M) ---
for (const f of FAMILIES) {
  const m = parseSurfaceModel(claudeMd(surfacesSection(f.surfaces, f.shared)));
  check(`A5 ${f.name}: section present`, m.present === true);
  check(`A5 ${f.name}: one entry per surface`, m.surfaces.length === f.surfaces.length, j(m.surfaces.map((s) => s.id)));
  check(`A5 ${f.name}: ids preserved in document order`, j(m.surfaces.map((s) => s.id)) === j(f.surfaces.map((s) => s.id)));
  check(`A5 ${f.name}: no parse issues`, m.issues.length === 0, j(m.issues));
  if (f.surfaces.length > 1) {
    const [a, b] = m.surfaces;
    check(`A5 ${f.name}: conflicting facts kept per surface`,
      a.buildSelector !== b.buildSelector && j(a.sourceRoots) !== j(b.sourceRoots), j([a, b]));
    check(`A5 ${f.name}: shared code represented once`, m.sharedCode.length === 1 && m.sharedCode[0].sharedBy.length === 2, j(m.sharedCode));
  } else {
    check(`A5 ${f.name}: single surface has no shared code`, m.sharedCode.length === 0, j(m.sharedCode));
  }
}
{
  const ios = parseSurfaceModel(claudeMd(surfacesSection(FAMILIES[1].surfaces, FAMILIES[1].shared)));
  const tv = ios.surfaces.find((s) => s.id === "tvos");
  check("A5 surface fields structured", tv?.platform === "tvOS" && tv?.formFactor === "tv" && tv?.minimumRuntime === "tvOS 17.0" && tv?.packaging === "IPA", j(tv));
  check("A5 build selector stripped of markdown", tv?.buildSelector === "scheme AppTV", j(tv?.buildSelector));
  check("A5 evidence refs carried", tv?.evidence[0] === "App.xcodeproj/project.pbxproj::TVOS_DEPLOYMENT_TARGET = 17.0", j(tv?.evidence));
  check("A5 'Not declared' minimum -> null", parseSurfaceModel(claudeMd(surfacesSection(FAMILIES[0].surfaces))).surfaces[0].minimumRuntime === null);
}
{
  const bad = parseSurfaceModel(claudeMd(surfacesSection([{ ...FAMILIES[0].surfaces[0], formFactor: "phone" }])));
  check("A5 non-neutral form factor is flagged, never passed through", bad.surfaces[0].formFactor === null && bad.issues.length > 0, j(bad));
  const legacy = parseSurfaceModel("# CLAUDE.md\n\n## Tech Stack\n\n- Platform(s): iOS, tvOS\n");
  check("A5 legacy CLAUDE.md: section absent, no surfaces invented from platformHints", legacy.present === false && legacy.surfaces.length === 0, j(legacy));
}

// --- A6: capabilities and relationships ---
{
  const md = capabilitiesMd(APP_CAPABILITIES, APP_RELATIONSHIPS);
  const m = parseCapabilityMap(md);
  check("A6 map present", m.present === true);
  check("A6 all capabilities parsed", j(m.capabilities.map((c) => c.id)) === j(APP_CAPABILITIES.map((c) => c.id)), j(m.capabilities.map((c) => c.id)));
  const player = m.capabilities.find((c) => c.id === "player");
  check("A6 capability anchor derived from id", player?.anchor === "#capability-player", j(player?.anchor));
  check("A6 shared capability is one entry with a surface-specific root",
    j(player?.sourceRoots) === j([{ path: "src/features/player/", surface: null }, { path: "src/tv/player/", surface: "tizen" }]), j(player?.sourceRoots));
  check("A6 'all' surface scope", player?.surfaceScope === "all" && player?.surfaces.length === 0, j(player));
  const search = m.capabilities.find((c) => c.id === "search");
  check("A6 subset surface scope", search?.surfaceScope === "subset" && j(search?.surfaces) === j(["web"]), j(search));
  check("A6 component names parsed for inventory resolution", j(m.capabilities[0].components) === j(["EpgScreen", "ChannelTile"]));
  check("A6 relationships parsed", m.relationships.length === 4, j(m.relationships));
  const nav = m.relationships.find((r) => r.type === "navigates_to");
  check("A6 directional relationship keeps direction", nav?.from === "epg" && nav?.to === "player" && nav?.id === "epg:navigates_to:player", j(nav));
  const state = m.relationships.find((r) => r.type === "shares_state_with");
  check("A6 symmetric relationship normalized (from < to)", state?.from === "channels" && state?.to === "epg", j(state));
  check("A6 relationshipId is order-independent for symmetric types",
    relationshipId("epg", "shares_state_with", "channels") === relationshipId("channels", "shares_state_with", "epg"));
  check("A6 relationshipId keeps direction for directional types",
    relationshipId("epg", "navigates_to", "player") !== relationshipId("player", "navigates_to", "epg"));
  const reordered = parseCapabilityMap(capabilitiesMd([...APP_CAPABILITIES].reverse(), [...APP_RELATIONSHIPS].reverse()));
  check("A6 relationship ids deterministic under reordering (refresh)",
    j(reordered.relationships.map((r) => r.id).sort()) === j(m.relationships.map((r) => r.id).sort()));
  check("A6 evidence kind carried", nav?.evidenceKind === "navigation-route");
  check("A6 no parse issues", m.issues.length === 0, j(m.issues));

  const bogus = parseCapabilityMap(capabilitiesMd(APP_CAPABILITIES, [
    { from: "search", type: "related_to", to: "search-history", kind: "naming", evidence: ["src/features/search/SearchScreen.tsx"] },
    { from: "search", type: "is_similar_to", to: "search-history", kind: "shared-service", evidence: ["src/a.ts::x"] },
    { from: "search", type: "related_to", to: "ghost", kind: "shared-service", evidence: ["src/a.ts::x"] },
    { from: "search", type: "related_to", to: "channels", kind: "shared-service", evidence: [] },
  ]));
  check("A6 name-only / unknown vocabulary / dangling / evidence-less rows are never indexed", bogus.relationships.length === 0, j(bogus.relationships));
  check("A6 each rejected row is reported", bogus.issues.length === 4, j(bogus.issues));

  check("A6 absent map -> present false", parseCapabilityMap(null).present === false);
}

// --- A7: inventory rows resolve to their section anchors, with surface scope ---
{
  const inv = parseInventory(componentsMd(APP_SCREENS, APP_COMPONENTS));
  const tile = inv.find((r) => r.name === "ChannelTile");
  const focus = inv.find((r) => r.name === "FocusRow");
  check("A7 shared component scoped to all", tile?.anchor === "#reusable-ui-components" && tile?.surfaceScope === "all", j(tile));
  check("A7 target-specific component scoped to its surface", focus?.surfaceScope === "subset" && j(focus?.surfaces) === j(["tizen"]), j(focus));
  const svc = parseInventory(integrationsMd(APP_SERVICES)).find((r) => r.name === "Catalog API");
  check("A7 integration row resolves to its section", svc?.anchor === "#backend-services-apis", j(svc));
  const legacy = parseInventory("## Screens\n\n| Screen | Path | Purpose | Notes |\n|---|---|---|---|\n| `Home` | `a` | b | |\n");
  check("A7 legacy table without a Surface column -> surfaceScope unknown", legacy[0]?.surfaceScope === "unknown", j(legacy));
}

// --- A8: surfaces fixture used by the app is internally consistent ---
{
  const m = parseSurfaceModel(claudeMd(surfacesSection(APP_SURFACES, APP_SHARED)));
  check("A8 app fixture: two surfaces, one tv form factor", m.surfaces.length === 2 && m.surfaces.filter((s) => s.formFactor === "tv").length === 1, j(m.surfaces));
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures > 0 ? 1 : 0);
