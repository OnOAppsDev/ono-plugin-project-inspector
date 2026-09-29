/**
 * repo-knowledge.test.ts
 *
 * Self-contained tests for scripts/repo-knowledge.ts. Builds throwaway
 * repositories in a temp dir with fixture CLAUDE.md / AUDIT.md / docs/project
 * files and exercises the CLI end-to-end (stdout JSON + exit code).
 *
 * No external test framework. Run with:
 *   bun scripts/repo-knowledge.test.ts
 */

import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import {
  writeApp,
  writeKnowledge,
  writeFamily,
  surfacesSection,
  capabilitiesMd,
  FAMILIES,
  APP_CAPABILITIES,
  APP_RELATIONSHIPS,
  REL_NAVIGATES,
} from "./fixtures/knowledge-fixtures";

const HERE = typeof __dirname !== "undefined" ? __dirname : ".";
const HELPER = join(HERE, "repo-knowledge.ts");
const RUNTIME = process.execPath;

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ""}`); }
}

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(RUNTIME, [HELPER, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout, stderr: "" };
  } catch (err: any) {
    return { code: typeof err.status === "number" ? err.status : 1, stdout: err.stdout?.toString() ?? "", stderr: err.stderr?.toString() ?? "" };
  }
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function write(root: string, rel: string, body: string): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body, "utf-8");
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  write(dir, "README.md", "# test\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
}

const AUDIT_MD = `# AUDIT.md — Demo

## Audit Topics

| # | Status | Topic | Priority | File | Notes |
|---|--------|-------|----------|------|-------|
| 1 | Approved | Architecture | High | audits/architecture/architecture-audit.md | ok |
| 2 | Pending Breakdown | Player / Media | Medium | Not created yet | later |
`;

const PATTERNS_MD = `# Patterns and Conventions — Demo

## State Management
Redux Toolkit.

## Testing Patterns
Jest.
`;

const root = mkdtempSync(join(realpathSync(tmpdir()), "rk-"));
try {
  // --- Scenario 1: full artifact set -> manifest with fingerprint, documents, audit index ---
  const repo = join(root, "full");
  initRepo(repo);
  write(repo, "CLAUDE.md", "# CLAUDE.md — Demo\n");
  write(repo, "AUDIT.md", AUDIT_MD);
  write(repo, "docs/project/patterns.md", PATTERNS_MD);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "artifacts");

  {
    const r = run(["emit", repo]);
    check("1 emit: exit 0", r.code === 0, `code=${r.code} stderr=${r.stderr}`);
    const p = join(repo, ".ono", "repo-knowledge.json");
    check("1 emit: manifest written", existsSync(p));
    const m = JSON.parse(readFileSync(p, "utf-8"));

    check("1 schema version is 1", m.repoKnowledgeSchemaVersion === 1);
    check("1 producedBy names the inspector", m.producedBy?.plugin === "ono-project-inspector");
    check("1 gitHead is a 40-char sha", typeof m.fingerprint?.gitHead === "string" && m.fingerprint.gitHead.length === 40);
    check("1 CLAUDE.md hashed", typeof m.fingerprint?.artifacts?.["CLAUDE.md"] === "string");
    check("1 missing artifact hashes to null", m.fingerprint?.artifacts?.["docs/project/components.md"] === null);

    check("1 documents: patterns exists", m.documents?.conventions?.exists === true);
    check("1 documents: components missing", m.documents?.inventory?.exists === false);
    check("1 anchors derived from headings",
      Array.isArray(m.documents?.conventions?.anchors) &&
      m.documents.conventions.anchors.includes("#state-management") &&
      m.documents.conventions.anchors.includes("#testing-patterns"),
      JSON.stringify(m.documents?.conventions?.anchors));

    check("1 auditTopics: 2 rows", m.auditTopics?.length === 2, JSON.stringify(m.auditTopics));
    check("1 auditTopics: slug via slugify", m.auditTopics?.[1]?.slug === "player-media", m.auditTopics?.[1]?.slug);
    check("1 auditTopics: status carried", m.auditTopics?.[0]?.status === "Approved");
    check("1 coverage.auditTopics populated", m.coverage?.auditTopics === "populated");

    // Out-of-scope guard (K8): review inheritance is NOT part of schema v1.
    check("1 no cautions key in v1", !("cautions" in m));
    // Portability (K10).
    check("1 no absolute paths persisted", !JSON.stringify(m).includes(realpathSync(repo)));
  }

  // --- Scenario 2: determinism — two emits differ only in generatedAt (K9) ---
  {
    const p = join(repo, ".ono", "repo-knowledge.json");
    const first = JSON.parse(readFileSync(p, "utf-8"));
    run(["emit", repo]);
    const second = JSON.parse(readFileSync(p, "utf-8"));
    delete first.generatedAt;
    delete second.generatedAt;
    check("2 determinism: byte-identical ignoring generatedAt",
      JSON.stringify(first) === JSON.stringify(second));
  }

  // --- Scenario 3: no artifacts at all -> emits, everything unknown ---
  {
    const bare = join(root, "bare");
    initRepo(bare);
    const r = run(["emit", bare]);
    check("3 bare: exit 0", r.code === 0, `code=${r.code} stderr=${r.stderr}`);
    const m = JSON.parse(readFileSync(join(bare, ".ono", "repo-knowledge.json"), "utf-8"));
    check("3 bare: coverage.stack unknown", m.coverage?.stack === "unknown");
    check("3 bare: coverage.auditTopics unknown", m.coverage?.auditTopics === "unknown");
    check("3 bare: auditTopics empty", Array.isArray(m.auditTopics) && m.auditTopics.length === 0);
    check("3 bare: claudeMd exists false", m.documents?.claudeMd?.exists === false);
  }

  // --- Scenario 4: validate ---
  {
    const ok = run(["validate", repo]);
    check("4 validate: exit 0 on good manifest", ok.code === 0, `code=${ok.code} stderr=${ok.stderr}`);

    const broken = join(root, "broken");
    initRepo(broken);
    write(broken, ".ono/repo-knowledge.json", "{ not json");
    const bad = run(["validate", broken]);
    check("4 validate: exit 2 on malformed", bad.code === 2, `code=${bad.code}`);

    const none = join(root, "none");
    initRepo(none);
    check("4 validate: exit 2 when absent", run(["validate", none]).code === 2);
  }

  // --- Scenario 5: worktree refusal (K6) ---
  {
    const wt = join(repo, ".claude", "worktrees", "agent-1");
    git(repo, "worktree", "add", "-q", wt);
    const r = run(["emit", wt]);
    check("5 worktree: exit 1", r.code === 1, `code=${r.code}`);
    check("5 worktree: no manifest written there", !existsSync(join(wt, ".ono", "repo-knowledge.json")));
  }

  // --- Scenario 6: usage errors ---
  {
    check("6 usage: no args -> exit 1", run([]).code === 1);
    check("6 usage: unknown command -> exit 1", run(["frobnicate", repo]).code === 1);
    check("6 usage: missing root -> exit 1", run(["emit", join(root, "nope")]).code === 1);
  }

  // --- Scenario 7: prose fallback (an already-inspected repo, no facts block) ---
  {
    const legacy = join(root, "legacy");
    initRepo(legacy);
    write(legacy, "CLAUDE.md", `# CLAUDE.md — Legacy

## Tech Stack

- Language(s): TypeScript, Kotlin
- Framework(s): React Native
- Platform(s): iOS, Android
- Runtime / Tooling: Metro
- Package manager(s): yarn

## Build, Run, and Test Commands

\`\`\`bash
# Install dependencies
yarn

# Run / develop
yarn ios

# Test
yarn test

# Build
Unknown
\`\`\`
`);
    run(["emit", legacy]);
    const m = JSON.parse(readFileSync(join(legacy, ".ono", "repo-knowledge.json"), "utf-8"));
    check("7 prose: languages extracted", JSON.stringify(m.stack.languages) === JSON.stringify(["Kotlin", "TypeScript"]), JSON.stringify(m.stack.languages));
    check("7 prose: frameworks extracted", JSON.stringify(m.stack.frameworks) === JSON.stringify(["React Native"]));
    check("7 prose: platformHints extracted", JSON.stringify(m.stack.platformHints) === JSON.stringify(["Android", "iOS"]));
    check("7 prose: packageManagers extracted", JSON.stringify(m.stack.packageManagers) === JSON.stringify(["yarn"]));
    check("7 prose: coverage.stack populated", m.coverage.stack === "populated", m.coverage.stack);
    check("7 prose: install command", m.commands.install === "yarn", String(m.commands.install));
    check("7 prose: run command", m.commands.run === "yarn ios", String(m.commands.run));
    check("7 prose: test command", m.commands.test === "yarn test", String(m.commands.test));
    check("7 prose: 'Unknown' build is null", m.commands.build === null, String(m.commands.build));
    check("7 prose: coverage.commands partial", m.coverage.commands === "partial", m.coverage.commands);
  }

  // --- Scenario 8: facts block overrides prose ---
  {
    const marked = join(root, "marked");
    initRepo(marked);
    write(marked, "CLAUDE.md", `# CLAUDE.md — Marked

## Tech Stack

- Language(s): WRONG
- Framework(s): WRONG

<!-- repo-knowledge:facts:start -->
\`\`\`yaml
languages: [Swift]
frameworks: [SwiftUI]
platform_hints: [iOS]
runtime_tooling: [Xcode]
package_managers: [SPM]
install_command: xcodebuild -resolvePackageDependencies
run_command: xcodebuild -scheme App
test_command: xcodebuild test
build_command: xcodebuild archive
\`\`\`
<!-- repo-knowledge:facts:end -->
`);
    run(["emit", marked]);
    const m = JSON.parse(readFileSync(join(marked, ".ono", "repo-knowledge.json"), "utf-8"));
    check("8 block: overrides prose languages", JSON.stringify(m.stack.languages) === JSON.stringify(["Swift"]), JSON.stringify(m.stack.languages));
    check("8 block: frameworks from block", JSON.stringify(m.stack.frameworks) === JSON.stringify(["SwiftUI"]));
    check("8 block: snake_case key maps to platformHints", JSON.stringify(m.stack.platformHints) === JSON.stringify(["iOS"]));
    check("8 block: scalar command parsed", m.commands.run === "xcodebuild -scheme App", String(m.commands.run));
    check("8 block: coverage.commands populated", m.coverage.commands === "populated", m.coverage.commands);
    check("8 block: coverage.stack populated", m.coverage.stack === "populated");
  }

  // --- Scenario 9: malformed input degrades to unknown, never to a wrong value (K1) ---
  {
    const messy = join(root, "messy");
    initRepo(messy);
    write(messy, "CLAUDE.md", `# CLAUDE.md — Messy

## Tech Stack

The stack is described in prose rather than the template bullets.

<!-- repo-knowledge:facts:start -->
this is not parseable at all
<!-- repo-knowledge:facts:end -->
`);
    const r = run(["emit", messy]);
    check("9 messy: still exits 0", r.code === 0, `code=${r.code} stderr=${r.stderr}`);
    const m = JSON.parse(readFileSync(join(messy, ".ono", "repo-knowledge.json"), "utf-8"));
    check("9 messy: coverage.stack unknown", m.coverage.stack === "unknown", m.coverage.stack);
    check("9 messy: coverage.commands unknown", m.coverage.commands === "unknown", m.coverage.commands);
    check("9 messy: languages empty, not guessed", JSON.stringify(m.stack.languages) === JSON.stringify([]));
    check("9 messy: unparsed placeholder not persisted", !JSON.stringify(m).includes("{{"));
  }

  // --- Scenario 10: unreplaced template placeholders are ignored ---
  {
    const tmpl = join(root, "tmpl");
    initRepo(tmpl);
    write(tmpl, "CLAUDE.md", `# CLAUDE.md

## Tech Stack

- Language(s): {{LANGUAGES}}
- Framework(s): {{FRAMEWORKS}}
`);
    run(["emit", tmpl]);
    const m = JSON.parse(readFileSync(join(tmpl, ".ono", "repo-knowledge.json"), "utf-8"));
    check("10 placeholder: languages empty", JSON.stringify(m.stack.languages) === JSON.stringify([]));
    check("10 placeholder: coverage.stack unknown", m.coverage.stack === "unknown");
  }

  // --- Scenario 11: empty-valued bullet must not swallow the next line ---
  {
    const emptyBullet = join(root, "empty-bullet");
    initRepo(emptyBullet);
    write(emptyBullet, "CLAUDE.md", `# CLAUDE.md

## Tech Stack

- Language(s):
- Framework(s): React Native
`);
    run(["emit", emptyBullet]);
    const m = JSON.parse(readFileSync(join(emptyBullet, ".ono", "repo-knowledge.json"), "utf-8"));
    check("11 empty bullet: languages is empty, not swallowed from next line", JSON.stringify(m.stack.languages) === JSON.stringify([]), JSON.stringify(m.stack.languages));
    check("11 empty bullet: frameworks extracted correctly", JSON.stringify(m.stack.frameworks) === JSON.stringify(["React Native"]), JSON.stringify(m.stack.frameworks));
    check("11 empty bullet: manifest does not contain 'Framework(s)'", !JSON.stringify(m).includes("Framework(s)"));
  }

  // --- Scenario 12: unterminated list must be skipped, prose must survive ---
  {
    const unterminated = join(root, "unterminated");
    initRepo(unterminated);
    write(unterminated, "CLAUDE.md", `# CLAUDE.md

## Tech Stack

- Language(s): TypeScript

<!-- repo-knowledge:facts:start -->
\`\`\`yaml
languages: [Swift, Kotlin
\`\`\`
<!-- repo-knowledge:facts:end -->
`);
    run(["emit", unterminated]);
    const m = JSON.parse(readFileSync(join(unterminated, ".ono", "repo-knowledge.json"), "utf-8"));
    check("12 unterminated list: prose languages survive", JSON.stringify(m.stack.languages) === JSON.stringify(["TypeScript"]), JSON.stringify(m.stack.languages));
    check("12 unterminated list: no '[Swift' fragment persisted", !JSON.stringify(m).includes("[Swift"));
    check("12 unterminated list: no 'Kotlin' fragment persisted", !JSON.stringify(m).includes("Kotlin"));
  }

  // --- Scenario 13: structure coverage is honest, never guessed from mere existence ---
  {
    const allHeadings = join(root, "structure-all");
    initRepo(allHeadings);
    write(allHeadings, "CLAUDE.md", `# CLAUDE.md

## Repository Structure

Tree goes here.

## Key Modules

Modules go here.

## Entry Points

Entry points go here.
`);
    run(["emit", allHeadings]);
    const mAll = JSON.parse(readFileSync(join(allHeadings, ".ono", "repo-knowledge.json"), "utf-8"));
    check("13 all headings: coverage.structure populated", mAll.coverage.structure === "populated", mAll.coverage.structure);
    check("13 all headings: repositoryTree pointer", mAll.structure.repositoryTree === "CLAUDE.md#repository-structure", JSON.stringify(mAll.structure));
    check("13 all headings: keyModules pointer", mAll.structure.keyModules === "CLAUDE.md#key-modules", JSON.stringify(mAll.structure));
    check("13 all headings: entryPoints pointer", mAll.structure.entryPoints === "CLAUDE.md#entry-points", JSON.stringify(mAll.structure));
    check("13 all headings: claudeMd anchors stay empty", JSON.stringify(mAll.documents?.claudeMd?.anchors) === JSON.stringify([]), JSON.stringify(mAll.documents?.claudeMd?.anchors));

    const partialHeadings = join(root, "structure-partial");
    initRepo(partialHeadings);
    write(partialHeadings, "CLAUDE.md", `# CLAUDE.md

## Key Modules

Modules go here.
`);
    run(["emit", partialHeadings]);
    const mPartial = JSON.parse(readFileSync(join(partialHeadings, ".ono", "repo-knowledge.json"), "utf-8"));
    check("13 partial headings: coverage.structure partial", mPartial.coverage.structure === "partial", mPartial.coverage.structure);
    check("13 partial headings: keyModules set", mPartial.structure.keyModules === "CLAUDE.md#key-modules", JSON.stringify(mPartial.structure));
    check("13 partial headings: repositoryTree null", mPartial.structure.repositoryTree === null, JSON.stringify(mPartial.structure));
    check("13 partial headings: entryPoints null", mPartial.structure.entryPoints === null, JSON.stringify(mPartial.structure));

    const noHeadings = join(root, "structure-none");
    initRepo(noHeadings);
    write(noHeadings, "CLAUDE.md", `# CLAUDE.md

Just prose, no structure headings at all.
`);
    run(["emit", noHeadings]);
    const mNone = JSON.parse(readFileSync(join(noHeadings, ".ono", "repo-knowledge.json"), "utf-8"));
    check("13 no headings: coverage.structure unknown", mNone.coverage.structure === "unknown", mNone.coverage.structure);
    check("13 no headings: all three pointers null", JSON.stringify(mNone.structure) === JSON.stringify({ repositoryTree: null, keyModules: null, entryPoints: null }), JSON.stringify(mNone.structure));
  }

  // --- Scenario 14: knowledgeHead — only regeneration advances it, never a re-emit ---
  {
    const kh = join(root, "knowledge-head");
    initRepo(kh);
    write(kh, "src/app.ts", "export const app = 1;\n");
    // record-knowledge only certifies a stage whose output satisfies the
    // current knowledge model, so the fixture carries the full model.
    writeApp(kh);
    write(kh, "AUDIT.md", AUDIT_MD);
    git(kh, "add", "-A");
    git(kh, "commit", "-qm", "source + artifacts");
    const p = join(kh, ".ono", "repo-knowledge.json");

    run(["emit", kh]);
    const m0 = JSON.parse(readFileSync(p, "utf-8"));
    check("14 no recorded regeneration: knowledgeHead null", m0.fingerprint.knowledgeHead === null, JSON.stringify(m0.fingerprint));

    // Both source-backed stages regenerated knowledge at H1 (recorded through inspection-state).
    const h1 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: kh, encoding: "utf-8" }).trim();
    for (const stage of ["project-analysis", "project-docs"]) {
      execFileSync(RUNTIME, [join(HERE, "inspection-state.ts"), "record-knowledge", kh, stage], { stdio: "ignore" });
    }
    run(["emit", kh]);
    const m1 = JSON.parse(readFileSync(p, "utf-8"));
    check("14 after regeneration: knowledgeHead = H1", m1.fingerprint.knowledgeHead === h1, `${m1.fingerprint.knowledgeHead} vs ${h1}`);

    // Source moves to H2; a routine re-emit (what /inspect-sync does) must not advance it.
    write(kh, "src/app.ts", "export const app = 2;\n");
    git(kh, "add", "-A");
    git(kh, "commit", "-qm", "change source");
    const h2 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: kh, encoding: "utf-8" }).trim();
    run(["emit", kh]);
    const m2 = JSON.parse(readFileSync(p, "utf-8"));
    check("14 re-emit: gitHead follows HEAD (emit time)", m2.fingerprint.gitHead === h2);
    check("14 re-emit: knowledgeHead NOT advanced", m2.fingerprint.knowledgeHead === h1, `${m2.fingerprint.knowledgeHead}`);

    // Determinism still holds with the new field.
    const again = JSON.parse((run(["emit", kh]), readFileSync(p, "utf-8")));
    delete again.generatedAt;
    delete m2.generatedAt;
    check("14 determinism with knowledgeHead", JSON.stringify(again) === JSON.stringify(m2));

    // A lost state file must never make stale knowledge look fresh: the prior
    // manifest's knowledgeHead is carried forward, never replaced by HEAD.
    rmSync(join(kh, ".ono", "state.json"));
    run(["emit", kh]);
    const m3 = JSON.parse(readFileSync(p, "utf-8"));
    check("14 state lost: knowledgeHead carried from prior manifest", m3.fingerprint.knowledgeHead === h1, `${m3.fingerprint.knowledgeHead}`);
  }

  // --- Scenario 15: old manifests without knowledgeHead remain valid ---
  {
    const old = join(root, "old-manifest");
    initRepo(old);
    run(["emit", old]);
    const p = join(old, ".ono", "repo-knowledge.json");
    const m = JSON.parse(readFileSync(p, "utf-8"));
    delete m.fingerprint.knowledgeHead;
    writeFileSync(p, JSON.stringify(m, null, 2) + "\n", "utf-8");
    const r = run(["validate", old]);
    check("15 old manifest (no knowledgeHead) validates", r.code === 0, `code=${r.code} stderr=${r.stderr}`);

    m.fingerprint.knowledgeHead = 42;
    writeFileSync(p, JSON.stringify(m, null, 2) + "\n", "utf-8");
    check("15 non-string knowledgeHead is rejected", run(["validate", old]).code === 2);

    // Re-emitting over an old manifest yields null, never HEAD.
    delete m.fingerprint.knowledgeHead;
    writeFileSync(p, JSON.stringify(m, null, 2) + "\n", "utf-8");
    run(["emit", old]);
    const re = JSON.parse(readFileSync(p, "utf-8"));
    check("15 re-emit over old manifest: knowledgeHead null", re.fingerprint.knowledgeHead === null, JSON.stringify(re.fingerprint));
  }
  // --- Scenario 16: surfaces, surface-scoped anchors, capabilities and relationships are indexed ---
  const appRepo = join(root, "app");
  initRepo(appRepo);
  writeApp(appRepo);
  git(appRepo, "add", "-A");
  git(appRepo, "commit", "-qm", "app");
  {
    const r = run(["emit", appRepo]);
    check("16 emit: exit 0", r.code === 0, `code=${r.code} stderr=${r.stderr}`);
    const m = JSON.parse(readFileSync(join(appRepo, ".ono", "repo-knowledge.json"), "utf-8"));
    check("16 schema stays v1 (additive)", m.repoKnowledgeSchemaVersion === 1);
    check("16 surfaces[] structural, document order", JSON.stringify(m.surfaces?.map((s: any) => s.id)) === JSON.stringify(["web", "tizen"]), JSON.stringify(m.surfaces));
    const tv = m.surfaces?.find((s: any) => s.id === "tizen");
    check("16 surface fields", tv?.formFactor === "tv" && tv?.platform === "Samsung Tizen (React)" && tv?.packaging === ".wgt widget" && tv?.minimumRuntime === "Tizen 6.0", JSON.stringify(tv));
    check("16 surface source roots + sharedWith", JSON.stringify(tv?.sourceRoots) === JSON.stringify(["src/tv/", "tizen/"]) && JSON.stringify(tv?.sharedWith) === JSON.stringify(["web"]), JSON.stringify(tv));
    check("16 surface evidence carried as refs", JSON.stringify(tv?.evidence) === JSON.stringify(["tizen/config.xml::required_version=\"6.0\""]), JSON.stringify(tv?.evidence));
    check("16 sharedCode[] represented once", m.sharedCode?.length === 1 && JSON.stringify(m.sharedCode[0].sharedBy) === JSON.stringify(["tizen", "web"]), JSON.stringify(m.sharedCode));
    check("16 stable surfaces pointer", m.structure?.surfaces === "CLAUDE.md#targets-and-surfaces", JSON.stringify(m.structure));
    check("16 structure coverage unaffected by the new pointer", m.coverage?.structure === "populated", m.coverage?.structure);
    check("16 coverage.surfaces populated", m.coverage?.surfaces === "populated", JSON.stringify(m.coverage));
    check("16 coverage.capabilities populated", m.coverage?.capabilities === "populated", JSON.stringify(m.coverage));

    check("16 capabilities document indexed", m.documents?.capabilities?.path === "docs/project/capabilities.md" && m.documents.capabilities.exists === true);
    check("16 capability anchors indexed", m.documents?.capabilities?.anchors?.includes("#capability-epg") && m.documents.capabilities.anchors.includes("#relationships"), JSON.stringify(m.documents?.capabilities?.anchors));
    check("16 capabilities.md fingerprinted", typeof m.fingerprint?.artifacts?.["docs/project/capabilities.md"] === "string");

    check("16 surface-aware anchors on conventions",
      JSON.stringify(m.documents?.conventions?.surfaceAnchors) === JSON.stringify({ tizen: [{ section: "#input-and-interaction", anchor: "#input-and-interaction-tizen" }] }),
      JSON.stringify(m.documents?.conventions?.surfaceAnchors));
    check("16 shared convention indexed once", m.documents.conventions.anchors.filter((a: string) => a === "#input-and-interaction").length === 1);
    check("16 surfaceAnchors present (empty) on docs without overrides", JSON.stringify(m.documents?.inventory?.surfaceAnchors) === "{}", JSON.stringify(m.documents?.inventory));

    const ids = m.capabilities?.map((c: any) => c.id);
    check("16 capabilities[] sorted by id", JSON.stringify(ids) === JSON.stringify(["channels", "epg", "player", "search", "search-history"]), JSON.stringify(ids));
    const player = m.capabilities.find((c: any) => c.id === "player");
    check("16 capability anchor is a document pointer", player?.anchor === "docs/project/capabilities.md#capability-player", player?.anchor);
    check("16 shared capability once, with all declared surfaces", player?.surfaceScope === "all" && JSON.stringify(player?.surfaces) === JSON.stringify(["tizen", "web"]), JSON.stringify(player));
    check("16 surface-specific root on a shared capability",
      JSON.stringify(player?.sourceRoots) === JSON.stringify([{ path: "src/features/player/", surface: null }, { path: "src/tv/player/", surface: "tizen" }]), JSON.stringify(player?.sourceRoots));
    const search = m.capabilities.find((c: any) => c.id === "search");
    check("16 capability present on one surface only", search?.surfaceScope === "subset" && JSON.stringify(search?.surfaces) === JSON.stringify(["web"]), JSON.stringify(search));
    const epg = m.capabilities.find((c: any) => c.id === "epg");
    check("16 components are references into components.md, not copies",
      JSON.stringify(epg?.components) === JSON.stringify([
        { name: "ChannelTile", anchor: "docs/project/components.md#reusable-ui-components" },
        { name: "EpgScreen", anchor: "docs/project/components.md#screens" },
      ]), JSON.stringify(epg?.components));
    const channels = m.capabilities.find((c: any) => c.id === "channels");
    check("16 data dependencies reference integrations.md", JSON.stringify(channels?.dataDependencies) === JSON.stringify([{ name: "Catalog API", anchor: "docs/project/integrations.md#backend-services-apis" }]), JSON.stringify(channels?.dataDependencies));
    check("16 grounded fields carried as evidence refs", JSON.stringify(epg?.routes) === JSON.stringify(["src/features/epg/EpgScreen.tsx::navigate(\"Player\")"]) && JSON.stringify(epg?.stateOwnership) === JSON.stringify(["src/store/guideStore.ts::useGuideStore"]), JSON.stringify(epg));

    const rels = m.capabilityRelationships;
    check("16 relationships indexed, sorted by id",
      JSON.stringify(rels?.map((r: any) => r.id)) === JSON.stringify(["channels:related_to:search", "channels:shares_component_with:epg", "channels:shares_state_with:epg", "epg:navigates_to:player"]),
      JSON.stringify(rels?.map((r: any) => r.id)));
    const nav = rels?.find((r: any) => r.type === "navigates_to");
    check("16 relationship carries kind, evidence and anchor",
      nav?.evidenceKind === "navigation-route" && nav?.anchor === "docs/project/capabilities.md#relationships" && nav?.evidence?.length === 1, JSON.stringify(nav));
    check("16 first-degree relationships listed on each capability",
      JSON.stringify(epg?.relationships) === JSON.stringify(["channels:shares_component_with:epg", "channels:shares_state_with:epg", "epg:navigates_to:player"]), JSON.stringify(epg?.relationships));
    check("16 no relationship from naming similarity", !rels.some((r: any) => r.from.startsWith("search") && r.to.startsWith("search")), JSON.stringify(rels));
    check("16 no prose copied into the manifest", !JSON.stringify(m).includes("Arrow-key focus") && !JSON.stringify(m).includes("Shared convention for"));
    check("16 platformHints still advisory prose list, not surfaces", JSON.stringify(m.stack.platformHints) === JSON.stringify(["React web", "Tizen"]), JSON.stringify(m.stack.platformHints));
    check("16 validate passes", run(["validate", appRepo]).code === 0);
    check("16 no device_type routing value is emitted", !JSON.stringify(m).includes("device_type") && !JSON.stringify(m).includes("deviceType"));
  }

  // --- Scenario 17: every supported family indexes its surfaces separately ---
  for (const f of FAMILIES) {
    const dir = join(root, `family-${f.name}`);
    initRepo(dir);
    writeFamily(dir, f);
    run(["emit", dir]);
    const m = JSON.parse(readFileSync(join(dir, ".ono", "repo-knowledge.json"), "utf-8"));
    check(`17 ${f.name}: surfaces`, JSON.stringify(m.surfaces.map((s: any) => s.id)) === JSON.stringify(f.surfaces.map((s) => s.id)), JSON.stringify(m.surfaces));
    check(`17 ${f.name}: coverage.surfaces populated`, m.coverage.surfaces === "populated", m.coverage.surfaces);
    if (f.surfaces.length > 1) {
      const second = f.surfaces[1].id;
      check(`17 ${f.name}: override indexed for ${second} only`,
        JSON.stringify(Object.keys(m.documents.conventions.surfaceAnchors)) === JSON.stringify([second]), JSON.stringify(m.documents.conventions.surfaceAnchors));
      check(`17 ${f.name}: minimum runtimes not merged`, m.surfaces[0].minimumRuntime !== m.surfaces[1].minimumRuntime || m.surfaces[0].minimumRuntime === null, JSON.stringify(m.surfaces));
    } else {
      check(`17 ${f.name}: single surface, no overrides`, JSON.stringify(m.documents.conventions.surfaceAnchors) === "{}");
    }
  }

  // --- Scenario 18: an already-inspected repository without the new sections degrades to unknown ---
  {
    const legacy = join(root, "legacy-model");
    initRepo(legacy);
    write(legacy, "CLAUDE.md", "# CLAUDE.md — Legacy\n\n## Tech Stack\n\n- Platform(s): iOS, tvOS\n\n## Repository Structure\n\ntree\n\n## Key Modules\n\nm\n\n## Entry Points\n\ne\n");
    write(legacy, "AUDIT.md", AUDIT_MD);
    write(legacy, "docs/project/patterns.md", PATTERNS_MD);
    write(legacy, "docs/project/components.md", "# C\n\n## Screens\n\n| Screen | Path | Purpose | Notes |\n|---|---|---|---|\n| `Home` | `a` | b | |\n");
    const r = run(["emit", legacy]);
    check("18 legacy: emit exit 0", r.code === 0, r.stderr);
    const m = JSON.parse(readFileSync(join(legacy, ".ono", "repo-knowledge.json"), "utf-8"));
    check("18 legacy: coverage.surfaces unknown", m.coverage.surfaces === "unknown");
    check("18 legacy: coverage.capabilities unknown", m.coverage.capabilities === "unknown");
    check("18 legacy: no surfaces invented from platformHints", Array.isArray(m.surfaces) && m.surfaces.length === 0 && JSON.stringify(m.stack.platformHints) === JSON.stringify(["iOS", "tvOS"]));
    check("18 legacy: capabilities/relationships empty", m.capabilities.length === 0 && m.capabilityRelationships.length === 0 && m.sharedCode.length === 0);
    check("18 legacy: no surfaces pointer; structure shape unchanged", !("surfaces" in m.structure), JSON.stringify(m.structure));
    check("18 legacy: capabilities document absent", m.documents.capabilities.exists === false && m.fingerprint.artifacts["docs/project/capabilities.md"] === null);
    check("18 legacy: existing categories unchanged", m.coverage.structure === "populated" && m.coverage.conventions === "populated" && m.coverage.inventory === "populated", JSON.stringify(m.coverage));
    check("18 legacy: validate passes", run(["validate", legacy]).code === 0);
  }

  // --- Scenario 19: old manifests without surfaces/capabilities remain valid; malformed new fields do not ---
  {
    const p = join(appRepo, ".ono", "repo-knowledge.json");
    run(["emit", appRepo]);
    const fresh = JSON.parse(readFileSync(p, "utf-8"));
    const old = JSON.parse(JSON.stringify(fresh));
    delete old.surfaces; delete old.sharedCode; delete old.capabilities; delete old.capabilityRelationships;
    delete old.structure.surfaces; delete old.coverage.surfaces; delete old.coverage.capabilities; delete old.documents.capabilities;
    for (const d of Object.values(old.documents) as any[]) delete d.surfaceAnchors;
    delete old.fingerprint.artifacts["docs/project/capabilities.md"];
    writeFileSync(p, JSON.stringify(old, null, 2) + "\n");
    check("19 pre-Stage-A manifest validates", run(["validate", appRepo]).code === 0);

    const badSurfaces = { ...fresh, surfaces: "web" };
    writeFileSync(p, JSON.stringify(badSurfaces, null, 2) + "\n");
    check("19 surfaces must be an array when present", run(["validate", appRepo]).code === 2);

    const dangling = JSON.parse(JSON.stringify(fresh));
    dangling.capabilityRelationships.push({ id: "epg:depends_on:ghost", from: "epg", type: "depends_on", to: "ghost", evidenceKind: "import", evidence: ["x"], anchor: "docs/project/capabilities.md#relationships" });
    writeFileSync(p, JSON.stringify(dangling, null, 2) + "\n");
    check("19 dangling relationship endpoint rejected", run(["validate", appRepo]).code === 2);

    const vocab = JSON.parse(JSON.stringify(fresh));
    vocab.capabilityRelationships[0].type = "is_similar_to";
    writeFileSync(p, JSON.stringify(vocab, null, 2) + "\n");
    check("19 relationship outside the vocabulary rejected", run(["validate", appRepo]).code === 2);

    const noEvidence = JSON.parse(JSON.stringify(fresh));
    noEvidence.capabilityRelationships[0].evidence = [];
    writeFileSync(p, JSON.stringify(noEvidence, null, 2) + "\n");
    check("19 relationship without evidence rejected", run(["validate", appRepo]).code === 2);
    run(["emit", appRepo]);
  }

  // --- Scenario 20: a removed source edge disappears on refresh; remaining ids are stable ---
  {
    const p = join(appRepo, ".ono", "repo-knowledge.json");
    run(["emit", appRepo]);
    const before = JSON.parse(readFileSync(p, "utf-8"));
    writeKnowledge(appRepo, {
      relationships: APP_RELATIONSHIPS.filter((r) => r !== REL_NAVIGATES),
      capabilities: APP_CAPABILITIES.map((c) => (c.id === "epg" ? { ...c, routes: [] } : c)),
    });
    run(["emit", appRepo]);
    const after = JSON.parse(readFileSync(p, "utf-8"));
    check("20 removed relationship gone", !after.capabilityRelationships.some((r: any) => r.id === "epg:navigates_to:player"), JSON.stringify(after.capabilityRelationships));
    check("20 removed from capability first-degree lists", !after.capabilities.find((c: any) => c.id === "epg").relationships.includes("epg:navigates_to:player"));
    check("20 remaining relationship ids unchanged",
      JSON.stringify(after.capabilityRelationships.map((r: any) => r.id)) === JSON.stringify(before.capabilityRelationships.map((r: any) => r.id).filter((id: string) => id !== "epg:navigates_to:player")));
    writeKnowledge(appRepo);
    run(["emit", appRepo]);
  }

  // --- Scenario 21: regenerated documents in a different order produce the same index ---
  {
    const p = join(appRepo, ".ono", "repo-knowledge.json");
    run(["emit", appRepo]);
    const a = JSON.parse(readFileSync(p, "utf-8"));
    write(appRepo, "docs/project/capabilities.md", capabilitiesMd([...APP_CAPABILITIES].reverse(), [...APP_RELATIONSHIPS].reverse()));
    run(["emit", appRepo]);
    const b = JSON.parse(readFileSync(p, "utf-8"));
    check("21 capabilities identical after reordered refresh", JSON.stringify(a.capabilities) === JSON.stringify(b.capabilities));
    check("21 relationships identical after reordered refresh", JSON.stringify(a.capabilityRelationships) === JSON.stringify(b.capabilityRelationships));
    check("21 capability anchors identical after reordered refresh", JSON.stringify([...a.documents.capabilities.anchors].sort()) === JSON.stringify([...b.documents.capabilities.anchors].sort()));
    writeKnowledge(appRepo);
    run(["emit", appRepo]);
  }

  // --- Scenario 22: malformed capability rows are never indexed; coverage is honest ---
  {
    const dir = join(root, "malformed-caps");
    initRepo(dir);
    writeApp(dir, {
      relationships: [...APP_RELATIONSHIPS, { from: "search", type: "related_to", to: "search-history", kind: "naming", evidence: ["src/features/search/SearchScreen.tsx"] }],
    });
    run(["emit", dir]);
    const m = JSON.parse(readFileSync(join(dir, ".ono", "repo-knowledge.json"), "utf-8"));
    check("22 name-only relationship not indexed", m.capabilityRelationships.length === 4, JSON.stringify(m.capabilityRelationships.map((r: any) => r.id)));
    check("22 coverage.capabilities partial when rows were rejected", m.coverage.capabilities === "partial", m.coverage.capabilities);

    const bad = join(root, "bad-surface");
    initRepo(bad);
    writeApp(bad, { surfaces: surfacesSection([{ ...FAMILIES[0].surfaces[0], formFactor: "phone" }]) });
    run(["emit", bad]);
    const mb = JSON.parse(readFileSync(join(bad, ".ono", "repo-knowledge.json"), "utf-8"));
    check("22 invalid form factor -> null + coverage.surfaces partial", mb.surfaces[0].formFactor === null && mb.coverage.surfaces === "partial", JSON.stringify(mb.surfaces));
  }

  // --- Scenario 23: duplicate headings keep their anchors (Part K) ---
  {
    const dir = join(root, "dup-headings");
    initRepo(dir);
    write(dir, "docs/project/components.md", "# C\n\n## Screens\n\n### Notes\n\n## Reusable UI Components\n\n### Notes\n");
    run(["emit", dir]);
    const m = JSON.parse(readFileSync(join(dir, ".ono", "repo-knowledge.json"), "utf-8"));
    check("23 duplicate heading suffixed, not dropped",
      JSON.stringify(m.documents.inventory.anchors) === JSON.stringify(["#screens", "#notes", "#reusable-ui-components", "#notes-1"]), JSON.stringify(m.documents.inventory.anchors));
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures > 0 ? 1 : 0);
