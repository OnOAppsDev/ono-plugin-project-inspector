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
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures > 0 ? 1 : 0);
