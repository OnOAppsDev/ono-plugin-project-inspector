/**
 * knowledge-fixtures.ts
 *
 * Shared fixture builders for the generic Project Knowledge suites
 * (knowledge-model, knowledge-evidence, repo-knowledge, inspection-state).
 * Each builder writes a throwaway repository containing real "source" files
 * plus Inspector artifacts in the exact shapes the project-analysis and
 * project-docs templates prescribe, so every test exercises the same formats
 * the skills are told to produce.
 *
 * Nothing here is product knowledge: surface ids, capability names and paths
 * are illustrative fixtures only.
 */

import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";

export function write(root: string, rel: string, body: string): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body, "utf-8");
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

export function initGit(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
}

export function commitAll(repo: string, msg: string): void {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "--allow-empty", "-m", msg);
}

// --- CLAUDE.md -------------------------------------------------------------

export interface SurfaceRow {
  id: string;
  platform: string;
  formFactor: string;
  buildSelector: string;
  sourceRoots: string[];
  sharedWith: string[];
  packaging: string;
  minimum: string;
  evidence: string[];
}

export interface SharedRow {
  root: string;
  sharedBy: string[];
  mechanism: string;
  evidence: string[];
}

/** Render refs as the templates do: `` `path` `` or `` `path` (surface-id) `` for a surface-specific ref. */
const refs = (xs: string[]): string =>
  xs.length
    ? xs.map((x) => { const m = x.match(/^(.*) \(([a-z0-9-]+)\)$/); return m ? `\`${m[1]}\` (${m[2]})` : `\`${x}\``; }).join(", ")
    : "None";

export function surfacesSection(rows: SurfaceRow[], shared: SharedRow[] = []): string {
  const surfaceRows = rows
    .map(
      (r) =>
        `| \`${r.id}\` | ${r.platform} | ${r.formFactor} | ${r.buildSelector} | ${refs(r.sourceRoots)} | ` +
        `${r.sharedWith.length ? r.sharedWith.map((s) => `\`${s}\``).join(", ") : "None"} | ${r.packaging} | ${r.minimum} | ${refs(r.evidence)} |`
    )
    .join("\n");
  const sharedBody = shared.length
    ? `| Source root | Shared by | Mechanism | Evidence |
|-------------|-----------|-----------|----------|
${shared.map((s) => `| \`${s.root}\` | ${s.sharedBy.map((x) => `\`${x}\``).join(", ")} | ${s.mechanism} | ${refs(s.evidence)} |`).join("\n")}`
    : "Not applicable — single surface.";
  return `## Targets and Surfaces

| Surface | Platform | Form factor | Build selector | Source roots | Shared with | Packaging | Minimum OS / runtime | Evidence |
|---------|----------|-------------|----------------|--------------|-------------|-----------|----------------------|----------|
${surfaceRows}

### Shared Code

${sharedBody}
`;
}

export function claudeMd(surfaces: string, platforms = "Unknown"): string {
  return `# CLAUDE.md — Demo

## Project Overview

Demo.

## Tech Stack

- Language(s): TypeScript
- Framework(s): React
- Platform(s): ${platforms}
- Runtime / Tooling: Node
- Package manager(s): npm

${surfaces}
## Repository Structure

\`\`\`text
src/
\`\`\`

## Key Modules

| Module / Folder | Responsibility |
|-----------------|----------------|
| src | app |

## Entry Points

src/index.ts

<!-- audit-sync:important-files:start -->
_No approved audits yet._
<!-- audit-sync:important-files:end -->
`;
}

// --- docs/project ----------------------------------------------------------

/** The seven generic sections project-docs must always emit in patterns.md. */
export const GENERIC_PATTERN_SECTIONS = [
  "Architecture and Composition",
  "Input and Interaction",
  "App Lifecycle and State",
  "Media and Playback",
  "Platform Adapters",
  "Accessibility",
  "Performance Constraints",
];

/** `overrides` maps a section name to { surfaceId: body }. */
export function patternsMd(overrides: Record<string, Record<string, string>> = {}, shared: Record<string, string> = {}): string {
  const base = ["State Management", "Data Fetching / API Conventions", "Navigation Patterns", "Testing Patterns"];
  const parts = ["# Patterns and Conventions — Demo\n"];
  for (const name of [...base, ...GENERIC_PATTERN_SECTIONS]) {
    parts.push(`## ${name}\n\n${shared[name] ?? `Shared convention for ${name.toLowerCase()}. Evidence: \`src/index.ts\`.`}\n`);
    for (const [surface, body] of Object.entries(overrides[name] ?? {})) {
      parts.push(`### ${name} (${surface})\n\n${body}\n`);
    }
  }
  parts.push("## Unknowns\n\nNone.\n");
  return parts.join("\n");
}

export interface InventoryRow {
  name: string;
  path: string;
  surface: string;
}

export function componentsMd(screens: InventoryRow[], components: InventoryRow[], hooks: InventoryRow[] = []): string {
  const table = (head: string, rows: InventoryRow[]) =>
    `| ${head} | Path | Purpose | Surface | Notes |\n|---|---|---|---|---|\n` +
    rows.map((r) => `| \`${r.name}\` | \`${r.path}\` | purpose | ${r.surface} | |`).join("\n");
  return `# Component Inventory — Demo

## Screens

${table("Screen", screens)}

## Reusable UI Components

${table("Component", components)}

## Shared Hooks / Utilities

${hooks.length ? table("Name", hooks) : "Not applicable — none found."}

## Navigation Map

Stack navigator.
`;
}

export function integrationsMd(services: InventoryRow[], sdks: InventoryRow[] = []): string {
  const table = (head: string, rows: InventoryRow[]) =>
    `| ${head} | Used for | Where in code | Surface |\n|---|---|---|---|\n` +
    rows.map((r) => `| ${r.name} | purpose | \`${r.path}\` | ${r.surface} |`).join("\n");
  return `# External Integrations — Demo

## Backend Services / APIs

${services.length ? table("Service / API", services) : "Not applicable — none found."}

## Third-Party SDKs

${sdks.length ? table("SDK", sdks) : "Not applicable — none found."}
`;
}

export interface CapabilityFixture {
  id: string;
  name: string;
  surfaces: string;
  sourceRoots: string[];
  entryPoints?: string[];
  components?: string[];
  services?: string[];
  routes?: string[];
  data?: string[];
  state?: string[];
  tests?: string[];
  evidence: string[];
}

export interface RelationshipFixture {
  from: string;
  type: string;
  to: string;
  kind: string;
  evidence: string[];
}

export function capabilitiesMd(caps: CapabilityFixture[], rels: RelationshipFixture[]): string {
  const cap = (c: CapabilityFixture) => `### Capability: ${c.id}

| Field | Value |
|-------|-------|
| Name | ${c.name} |
| Surfaces | ${c.surfaces} |
| Source roots | ${refs(c.sourceRoots)} |
| Entry points | ${refs(c.entryPoints ?? [])} |
| Screens and components | ${refs(c.components ?? [])} |
| Services and modules | ${refs(c.services ?? [])} |
| Navigation routes | ${refs(c.routes ?? [])} |
| Data dependencies | ${refs(c.data ?? [])} |
| State ownership | ${refs(c.state ?? [])} |
| Tests | ${refs(c.tests ?? [])} |
| Evidence | ${refs(c.evidence)} |
`;
  const relRows = rels.length
    ? `| From | Relationship | To | Evidence kind | Evidence |
|------|--------------|----|---------------|----------|
${rels.map((r) => `| \`${r.from}\` | ${r.type} | \`${r.to}\` | ${r.kind} | ${refs(r.evidence)} |`).join("\n")}`
    : "None found — no evidence-backed relationships.";
  return `# Capability Map — Demo

## How to Use This File

Index of capabilities.

## Capabilities

${caps.map(cap).join("\n")}
## Relationships

${relRows}

## Unknowns

None.
`;
}

// --- a complete, evidence-consistent multi-capability repository -------------

/**
 * A React web + Smart TV repository with five capabilities and four
 * evidence-backed relationship kinds (shared component, navigation, shared
 * state, shared service). `search-history` is deliberately name-similar to
 * `search` with no source edge between them.
 */
export const APP_SOURCE: Record<string, string> = {
  "package.json": '{"name":"demo"}\n',
  "vite.config.ts": "export default {};\n",
  "tizen/config.xml": '<widget><tizen:application required_version="6.0"/></widget>\n',
  "src/index.ts": "export * from './features/epg/EpgScreen';\n",
  "src/components/ChannelTile.tsx": "export const ChannelTile = () => null;\n",
  "src/tv/FocusRow.tsx": "export const FocusRow = () => null;\n",
  "src/store/guideStore.ts": "export const useGuideStore = () => ({});\n",
  "src/services/CatalogService.ts": "export class CatalogService {}\n",
  "src/services/PlaybackService.ts": "export class PlaybackService {}\n",
  "src/features/epg/EpgScreen.tsx":
    "import { ChannelTile } from '../../components/ChannelTile';\n" +
    "import { useGuideStore } from '../../store/guideStore';\n" +
    "export const EpgScreen = () => { navigate(\"Player\"); return ChannelTile; };\n",
  "src/features/channels/ChannelsScreen.tsx":
    "import { ChannelTile } from '../../components/ChannelTile';\n" +
    "import { useGuideStore } from '../../store/guideStore';\n" +
    "import { CatalogService } from '../../services/CatalogService';\n" +
    "export const ChannelsScreen = () => ChannelTile;\n",
  "src/features/player/PlayerScreen.tsx":
    "import { PlaybackService } from '../../services/PlaybackService';\nexport const PlayerScreen = () => null;\n",
  "src/features/search/SearchScreen.tsx":
    "import { CatalogService } from '../../services/CatalogService';\nexport const SearchScreen = () => null;\n",
  "src/features/search-history/SearchHistoryScreen.tsx": "export const SearchHistoryScreen = () => null;\n",
  "src/tv/player/TvPlayerControls.tsx": "export const TvPlayerControls = () => null;\n",
  "src/features/epg/__tests__/epg.test.tsx": "import { EpgScreen } from '../EpgScreen';\nimport { PlayerScreen } from '../../player/PlayerScreen';\n",
};

export const APP_SURFACES: SurfaceRow[] = [
  {
    id: "web", platform: "React web", formFactor: "desktop", buildSelector: "`vite build`",
    sourceRoots: ["src/"], sharedWith: ["tizen"], packaging: "static bundle", minimum: "Not declared",
    evidence: ["vite.config.ts"],
  },
  {
    id: "tizen", platform: "Samsung Tizen (React)", formFactor: "tv", buildSelector: "`tizen package`",
    sourceRoots: ["src/tv/", "tizen/"], sharedWith: ["web"], packaging: ".wgt widget", minimum: "Tizen 6.0",
    evidence: ["tizen/config.xml::required_version=\"6.0\""],
  },
];

export const APP_SHARED: SharedRow[] = [
  { root: "src/components/", sharedBy: ["web", "tizen"], mechanism: "single bundle import", evidence: ["src/features/epg/EpgScreen.tsx::ChannelTile"] },
];

export const APP_CAPABILITIES: CapabilityFixture[] = [
  {
    id: "epg", name: "EPG", surfaces: "all", sourceRoots: ["src/features/epg/"],
    entryPoints: ["src/features/epg/EpgScreen.tsx::EpgScreen"], components: ["EpgScreen", "ChannelTile"],
    routes: ["src/features/epg/EpgScreen.tsx::navigate(\"Player\")"], state: ["src/store/guideStore.ts::useGuideStore"],
    tests: ["src/features/epg/__tests__/"], evidence: ["src/features/epg/EpgScreen.tsx::EpgScreen"],
  },
  {
    id: "channels", name: "Channels", surfaces: "all", sourceRoots: ["src/features/channels/"],
    components: ["ChannelsScreen", "ChannelTile"], services: ["src/services/CatalogService.ts::CatalogService"],
    data: ["Catalog API"], evidence: ["src/features/channels/ChannelsScreen.tsx::ChannelsScreen"],
  },
  {
    id: "player", name: "Player", surfaces: "all", sourceRoots: ["src/features/player/", "src/tv/player/ (tizen)"],
    components: ["PlayerScreen"], services: ["src/services/PlaybackService.ts::PlaybackService"],
    evidence: ["src/features/player/PlayerScreen.tsx::PlayerScreen"],
  },
  {
    id: "search", name: "Search", surfaces: "`web`", sourceRoots: ["src/features/search/"],
    services: ["src/services/CatalogService.ts::CatalogService"], data: ["Catalog API"],
    evidence: ["src/features/search/SearchScreen.tsx::SearchScreen"],
  },
  {
    id: "search-history", name: "Search History", surfaces: "`web`", sourceRoots: ["src/features/search-history/"],
    evidence: ["src/features/search-history/SearchHistoryScreen.tsx::SearchHistoryScreen"],
  },
];

export const REL_SHARED_COMPONENT: RelationshipFixture = {
  from: "epg", type: "shares_component_with", to: "channels", kind: "shared-component",
  evidence: ["src/features/epg/EpgScreen.tsx::ChannelTile", "src/features/channels/ChannelsScreen.tsx::ChannelTile"],
};
export const REL_NAVIGATES: RelationshipFixture = {
  from: "epg", type: "navigates_to", to: "player", kind: "navigation-route",
  evidence: ["src/features/epg/EpgScreen.tsx::navigate(\"Player\")"],
};
export const REL_SHARED_STATE: RelationshipFixture = {
  from: "channels", type: "shares_state_with", to: "epg", kind: "shared-state",
  evidence: ["src/features/epg/EpgScreen.tsx::useGuideStore", "src/features/channels/ChannelsScreen.tsx::useGuideStore"],
};
export const REL_SHARED_SERVICE: RelationshipFixture = {
  from: "channels", type: "related_to", to: "search", kind: "shared-service",
  evidence: ["src/features/channels/ChannelsScreen.tsx::CatalogService", "src/features/search/SearchScreen.tsx::CatalogService"],
};
export const APP_RELATIONSHIPS = [REL_SHARED_COMPONENT, REL_NAVIGATES, REL_SHARED_STATE, REL_SHARED_SERVICE];

export const APP_SCREENS: InventoryRow[] = [
  { name: "EpgScreen", path: "src/features/epg/EpgScreen.tsx", surface: "all" },
  { name: "ChannelsScreen", path: "src/features/channels/ChannelsScreen.tsx", surface: "all" },
  { name: "PlayerScreen", path: "src/features/player/PlayerScreen.tsx", surface: "all" },
  { name: "SearchScreen", path: "src/features/search/SearchScreen.tsx", surface: "`web`" },
];
export const APP_COMPONENTS: InventoryRow[] = [
  { name: "ChannelTile", path: "src/components/ChannelTile.tsx", surface: "all" },
  { name: "FocusRow", path: "src/tv/FocusRow.tsx", surface: "`tizen`" },
];
export const APP_SERVICES: InventoryRow[] = [
  { name: "Catalog API", path: "src/services/CatalogService.ts", surface: "all" },
];

export interface AppOptions {
  capabilities?: CapabilityFixture[];
  relationships?: RelationshipFixture[];
  patterns?: string;
  surfaces?: string;
  components?: string;
  source?: Record<string, string>;
}

/** Write source + a full, evidence-consistent Project Knowledge set. Does not commit. */
export function writeApp(repo: string, opts: AppOptions = {}): void {
  for (const [rel, body] of Object.entries(opts.source ?? APP_SOURCE)) write(repo, rel, body);
  writeKnowledge(repo, opts);
}

/** Write (or rewrite) only the Inspector artifacts. */
export function writeKnowledge(repo: string, opts: AppOptions = {}): void {
  write(repo, "CLAUDE.md", claudeMd(opts.surfaces ?? surfacesSection(APP_SURFACES, APP_SHARED), "React web, Tizen"));
  write(repo, "docs/project/overview.md", "# Project Overview — Demo\n\n## What This Project Is\n\nDemo.\n");
  write(repo, "docs/project/patterns.md", opts.patterns ?? patternsMd({ "Input and Interaction": { tizen: "Arrow-key focus via `src/tv/FocusRow.tsx`." } }));
  write(repo, "docs/project/components.md", opts.components ?? componentsMd(APP_SCREENS, APP_COMPONENTS));
  write(repo, "docs/project/integrations.md", integrationsMd(APP_SERVICES));
  write(repo, "docs/project/capabilities.md", capabilitiesMd(opts.capabilities ?? APP_CAPABILITIES, opts.relationships ?? APP_RELATIONSHIPS));
}

// --- per-family surface presets (Part M) -------------------------------------

export interface FamilyPreset {
  name: string;
  source: Record<string, string>;
  surfaces: SurfaceRow[];
  shared: SharedRow[];
}

export const FAMILIES: FamilyPreset[] = [
  {
    name: "single-surface",
    source: { "package.json": '{"name":"one"}\n', "src/index.ts": "export {};\n" },
    surfaces: [
      { id: "web", platform: "React web", formFactor: "desktop", buildSelector: "`npm run build`", sourceRoots: ["src/"], sharedWith: [], packaging: "static bundle", minimum: "Not declared", evidence: ["package.json"] },
    ],
    shared: [],
  },
  {
    name: "ios-tvos",
    source: {
      "App.xcodeproj/project.pbxproj": "IPHONEOS_DEPLOYMENT_TARGET = 16.0;\nTVOS_DEPLOYMENT_TARGET = 17.0;\nSDKROOT = appletvos;\n",
      "App.xcodeproj/xcshareddata/xcschemes/App.xcscheme": "<Scheme/>\n",
      "App.xcodeproj/xcshareddata/xcschemes/AppTV.xcscheme": "<Scheme/>\n",
      "App/AppDelegate.swift": "import UIKit\n",
      "TVApp/TVAppDelegate.swift": "import UIKit\n",
      "Shared/PlayerCoordinator.swift": "final class PlayerCoordinator {}\n",
    },
    surfaces: [
      { id: "ios", platform: "iOS", formFactor: "handheld", buildSelector: "scheme `App`", sourceRoots: ["App/"], sharedWith: ["tvos"], packaging: "IPA", minimum: "iOS 16.0", evidence: ["App.xcodeproj/project.pbxproj::IPHONEOS_DEPLOYMENT_TARGET = 16.0", "App.xcodeproj/xcshareddata/xcschemes/App.xcscheme"] },
      { id: "tvos", platform: "tvOS", formFactor: "tv", buildSelector: "scheme `AppTV`", sourceRoots: ["TVApp/"], sharedWith: ["ios"], packaging: "IPA", minimum: "tvOS 17.0", evidence: ["App.xcodeproj/project.pbxproj::TVOS_DEPLOYMENT_TARGET = 17.0", "App.xcodeproj/xcshareddata/xcschemes/AppTV.xcscheme"] },
    ],
    shared: [{ root: "Shared/", sharedBy: ["ios", "tvos"], mechanism: "target membership", evidence: ["Shared/PlayerCoordinator.swift::PlayerCoordinator"] }],
  },
  {
    name: "android-mobile-tv",
    source: {
      "settings.gradle.kts": 'include(":mobile", ":tv", ":core")\n',
      "mobile/build.gradle.kts": "android { defaultConfig { minSdk = 24 } }\n",
      "tv/build.gradle.kts": "android { defaultConfig { minSdk = 26 } }\n",
      "mobile/src/main/AndroidManifest.xml": '<manifest><category android:name="android.intent.category.LAUNCHER"/></manifest>\n',
      "tv/src/main/AndroidManifest.xml": '<manifest><uses-feature android:name="android.software.leanback"/><category android:name="android.intent.category.LEANBACK_LAUNCHER"/></manifest>\n',
      "core/src/main/kotlin/Player.kt": "class Player\n",
    },
    surfaces: [
      { id: "android-mobile", platform: "Android", formFactor: "handheld", buildSelector: "module `:mobile`", sourceRoots: ["mobile/"], sharedWith: ["android-tv"], packaging: "AAB", minimum: "minSdk 24", evidence: ["mobile/build.gradle.kts::minSdk = 24", "mobile/src/main/AndroidManifest.xml::LAUNCHER"] },
      { id: "android-tv", platform: "Android TV", formFactor: "tv", buildSelector: "module `:tv`", sourceRoots: ["tv/"], sharedWith: ["android-mobile"], packaging: "AAB", minimum: "minSdk 26", evidence: ["tv/build.gradle.kts::minSdk = 26", "tv/src/main/AndroidManifest.xml::LEANBACK_LAUNCHER"] },
    ],
    shared: [{ root: "core/", sharedBy: ["android-mobile", "android-tv"], mechanism: "Gradle module dependency", evidence: ["settings.gradle.kts::\":core\""] }],
  },
  {
    name: "web-smarttv",
    source: {
      "package.json": '{"name":"web-tv"}\n',
      "vite.config.ts": "export default {};\n",
      "webos/appinfo.json": '{"id":"com.demo.app"}\n',
      "src/shared/api.ts": "export const api = 1;\n",
      "src/web/main.tsx": "export {};\n",
      "src/tv/main.tsx": "export {};\n",
    },
    surfaces: [
      { id: "web", platform: "React web", formFactor: "desktop", buildSelector: "`vite build`", sourceRoots: ["src/web/"], sharedWith: ["webos"], packaging: "static bundle", minimum: "Not declared", evidence: ["vite.config.ts"] },
      { id: "webos", platform: "LG webOS (React)", formFactor: "tv", buildSelector: "`vite build --mode tv`", sourceRoots: ["src/tv/", "webos/"], sharedWith: ["web"], packaging: ".ipk", minimum: "Not declared", evidence: ["webos/appinfo.json::com.demo.app"] },
    ],
    shared: [{ root: "src/shared/", sharedBy: ["web", "webos"], mechanism: "shared source folder", evidence: ["src/shared/api.ts::api"] }],
  },
  {
    name: "rn-ios-android",
    source: {
      "package.json": '{"name":"rn"}\n',
      "ios/App.xcodeproj/project.pbxproj": "IPHONEOS_DEPLOYMENT_TARGET = 15.1;\n",
      "android/app/build.gradle": "minSdkVersion 23\n",
      "src/App.tsx": "export {};\n",
      "src/native/Haptics.ios.ts": "export {};\n",
      "src/native/Haptics.android.ts": "export {};\n",
    },
    surfaces: [
      { id: "ios", platform: "React Native iOS", formFactor: "handheld", buildSelector: "`npx react-native run-ios`", sourceRoots: ["ios/", "src/native/Haptics.ios.ts"], sharedWith: ["android"], packaging: "IPA", minimum: "iOS 15.1", evidence: ["ios/App.xcodeproj/project.pbxproj::IPHONEOS_DEPLOYMENT_TARGET = 15.1"] },
      { id: "android", platform: "React Native Android", formFactor: "handheld", buildSelector: "`npx react-native run-android`", sourceRoots: ["android/", "src/native/Haptics.android.ts"], sharedWith: ["ios"], packaging: "AAB", minimum: "minSdk 23", evidence: ["android/app/build.gradle::minSdkVersion 23"] },
    ],
    shared: [{ root: "src/", sharedBy: ["ios", "android"], mechanism: "single JS bundle; platform file extensions", evidence: ["src/App.tsx"] }],
  },
];

/** Write a family preset's source and surface-aware knowledge (one capability over its shared root). */
export function writeFamily(repo: string, f: FamilyPreset): void {
  for (const [rel, body] of Object.entries(f.source)) write(repo, rel, body);
  const firstSourceFile = Object.keys(f.source).find((p) => p.includes("/") && !p.endsWith(".json") && !p.includes("gradle") && !p.includes("pbxproj") && !p.includes("xcscheme") && !p.includes("Manifest")) as string;
  const root = firstSourceFile.slice(0, firstSourceFile.lastIndexOf("/") + 1);
  write(repo, "CLAUDE.md", claudeMd(surfacesSection(f.surfaces, f.shared)));
  write(repo, "docs/project/overview.md", "# Project Overview\n\n## What This Project Is\n\nDemo.\n");
  const second = f.surfaces[1]?.id;
  write(repo, "docs/project/patterns.md", patternsMd(second ? { "Input and Interaction": { [second]: `Differs on ${second}.` } } : {}));
  write(repo, "docs/project/components.md", componentsMd([], []));
  write(repo, "docs/project/integrations.md", integrationsMd([]));
  write(
    repo,
    "docs/project/capabilities.md",
    capabilitiesMd(
      [{ id: "core", name: "Core", surfaces: "all", sourceRoots: [root], evidence: [firstSourceFile] }],
      []
    )
  );
}
