/**
 * compat-0.11.test.ts
 *
 * Existing repositories inspected with 0.11.x keep working after the Node.js
 * runtime migration (0.12.0), without a re-inspection.
 *
 * The baseline is scripts/fixtures/inspected-0.11.3/tree: a repository fully
 * inspected by the unmodified Inspector 0.11.3 helpers running under Bun (see the
 * fixture's README). This suite recreates that repository with the same history
 * (deterministic commits, so the stored `knowledgeHead` is a real commit again),
 * then runs the 0.12.0 helpers under Node.js against it, as the agent does:
 *
 *   C1  history reproduced: the source commit has the recorded knowledgeHead ID
 *   C2  detect: inspected, every stage complete, knowledge COMPLETE, resume at
 *       stage3-complete — no re-inspection; the version change is reported
 *       (versionMismatch 0.11.3 -> 0.12.0), the schema needs no migration
 *   C3  the stored 0.11.3 manifest validates; evidence and artifact gates pass
 *   C4  output parity: re-emitting the manifest and re-syncing the state under
 *       Node.js reproduces the stored 0.11.3 (Bun) files exactly, apart from the
 *       expected volatile fields — timestamps, the producing plugin version, and
 *       the Git commit the manifest was generated at
 *   C5  Refresh Project Knowledge and Inspect Sync style runs work on it
 *   C6  the same repository on `main`: read-only commands work, writes refuse
 *
 * No external test framework. Run with:
 *   node --no-warnings scripts/compat-0.11.test.ts
 */

import { execFileSync } from "child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const HERE = import.meta.dirname;
const PLUGIN = realpathSync(join(HERE, ".."));
const FIXTURE = join(HERE, "fixtures", "inspected-0.11.3", "tree");
const SOURCE_COMMIT = "d7335feb9de91547775e044197e9b80644189fd5";
const CURRENT_VERSION = JSON.parse(readFileSync(join(PLUGIN, ".claude-plugin", "plugin.json"), "utf-8")).version as string;
const INSPECTOR_PATHS = [".ono", "CLAUDE.md", "AUDIT.md", "docs", "audits"];

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ""}`); }
}

// The exact identity and dates the fixture was committed with.
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Inspector Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Inspector Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_AUTHOR_DATE: "2026-11-01T12:00:00Z", GIT_COMMITTER_DATE: "2026-11-01T12:00:00Z",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", "-c", "core.safecrlf=false", ...args], { cwd, env: GIT_ENV, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();

interface Run { code: number; stdout: string; stderr: string; json: any }
function helper(cwd: string, script: string, ...args: string[]): Run {
  let code = 0, stdout = "", stderr = "";
  try {
    stdout = execFileSync(process.execPath, ["--no-warnings", join(PLUGIN, "scripts", script), ...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err: any) {
    code = typeof err.status === "number" ? err.status : 1;
    stdout = err.stdout?.toString() ?? "";
    stderr = err.stderr?.toString() ?? "";
  }
  let json: any = null;
  try { json = JSON.parse(stdout); } catch { json = null; }
  return { code, stdout, stderr, json };
}

/** Recreates the inspected repository: commit 1 = source (the recorded knowledgeHead), commit 2 = artifacts. */
function materialize(dir: string, branch: string): string {
  cpSync(FIXTURE, dir, { recursive: true });
  git(dir, "init", "-q", "-b", branch);
  git(dir, "add", "-A", "--", ".", ...INSPECTOR_PATHS.map((p) => `:(exclude)${p}`));
  git(dir, "commit", "-q", "-m", "source");
  const source = git(dir, "rev-parse", "HEAD");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "inspector artifacts (0.11.3)");
  return source;
}

/** Removes the fields that legitimately differ between two runs. */
const TIMESTAMP_KEYS = /At$/; // createdAt, updatedAt, completedAt, generatedAt, draftedAt, approvedAt, knowledgeRegeneratedAt, …
function normalize(value: any): any {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) out[k] = TIMESTAMP_KEYS.test(k) && typeof v === "string" ? "<timestamp>" : normalize(v);
    return out;
  }
  return value;
}
function normalizeManifest(m: any): any {
  const n = normalize(m);
  if (n?.producedBy) n.producedBy.version = "<plugin version>";
  if (n?.fingerprint) n.fingerprint.gitHead = "<commit the manifest was generated at>";
  // Additive (0.14.0): the artifact hash algorithm marker; checked separately below.
  if (n?.fingerprint) delete n.fingerprint.artifactHash;
  return n;
}
/** Keys 0.13.0 adds to state.json (additive, schema v1); compared separately below. */
const ADDITIVE_013 = ["knowledge", "documents", "audits"];
function normalizeState(s: any): any {
  const n = normalize(s);
  if (n?.plugin) n.plugin.version = "<plugin version>";
  for (const k of ADDITIVE_013) delete n?.[k];
  return n;
}
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf-8"));
const storedManifest = readJson(join(FIXTURE, ".ono", "repo-knowledge.json"));
const storedState = readJson(join(FIXTURE, ".ono", "state.json"));

const root = realpathSync(mkdtempSync(join(tmpdir(), "inspector-compat-")));
try {
  // --- C1: the recorded history ---------------------------------------------------------
  check("C1 the fixture really is 0.11.3 output", storedState.plugin?.version === "0.11.3" && storedManifest.producedBy?.version === "0.11.3");
  check("C1 this suite runs a newer plugin version", CURRENT_VERSION !== "0.11.3", CURRENT_VERSION);
  const repo = join(root, "inspected repo");
  const source = materialize(repo, "chore/project-inspection");
  check("C1 the source commit reproduces the recorded knowledgeHead", source === SOURCE_COMMIT && storedState.repository?.knowledgeHead === SOURCE_COMMIT && storedManifest.fingerprint?.knowledgeHead === SOURCE_COMMIT, source);

  // --- C2: detect continues the inspection ------------------------------------------------
  const d = helper(repo, "inspection-state.ts", "detect", repo);
  check("C2 detect exits 0 with JSON", d.code === 0 && d.json !== null, d.stdout + d.stderr);
  check("C2 the repository is recognised as inspected", d.json?.inspected === true);
  check("C2 every stage is complete", d.json?.stage3Complete === true && d.json?.resume?.nextAction === "stage3-complete", JSON.stringify(d.json?.resume));
  check("C2 Project Knowledge is COMPLETE — no re-inspection needed", d.json?.knowledge?.status === "COMPLETE", JSON.stringify(d.json?.knowledge));
  check("C2 the plugin version change is reported, not hidden", d.json?.versionMismatch === true && d.json?.storedPluginVersion === "0.11.3" && d.json?.currentPluginVersion === CURRENT_VERSION, JSON.stringify({ stored: d.json?.storedPluginVersion, current: d.json?.currentPluginVersion, mismatch: d.json?.versionMismatch, migrate: d.json?.needsMigration }));
  check("C2 the state schema needs no migration", d.json?.needsMigration === false, JSON.stringify({ stored: d.json?.storedPluginVersion, current: d.json?.currentPluginVersion, mismatch: d.json?.versionMismatch, migrate: d.json?.needsMigration }));
  check("C2 detect wrote nothing", git(repo, "status", "--porcelain") === "");
  const mig = helper(repo, "inspection-state.ts", "migrate", repo);
  check("C2 migrate: already current, nothing to migrate", mig.code === 0 && /nothing to migrate/.test(mig.stdout), mig.stdout + mig.stderr);

  // --- C3: the stored artifacts pass every gate under Node.js -------------------------------
  const val = helper(repo, "repo-knowledge.ts", "validate", repo);
  check("C3 the stored 0.11.3 manifest validates", val.code === 0, val.stdout + val.stderr);
  const ev = helper(repo, "knowledge-evidence.ts", "verify", repo, "all");
  check("C3 evidence gate passes on the 0.11.3 knowledge", ev.code === 0, ev.stdout);
  const va = helper(repo, "verify-artifacts.ts", repo, "CLAUDE.md", "AUDIT.md", "docs/project/overview.md", "docs/project/components.md", "docs/project/patterns.md", "docs/project/integrations.md", "docs/project/capabilities.md", "audits/architecture/architecture-audit.md", ".ono/state.json", ".ono/repo-knowledge.json");
  check("C3 every artifact verifies at the Project Root", va.code === 0, va.stdout);
  const show = helper(repo, "repo-knowledge.ts", "show", repo);
  check("C3 show prints the stored manifest completely", show.code === 0 && JSON.stringify(show.json) === JSON.stringify(storedManifest), show.stdout.slice(0, 200));

  // --- C4: output parity with the stored 0.11.3 (Bun) output --------------------------------
  const emit = helper(repo, "repo-knowledge.ts", "emit", repo);
  check("C4 emit under Node.js exits 0", emit.code === 0, emit.stdout + emit.stderr);
  const emitted = readJson(join(repo, ".ono", "repo-knowledge.json"));
  check("C4 the re-emitted manifest equals the 0.11.3 manifest (volatile fields aside)", JSON.stringify(normalizeManifest(emitted)) === JSON.stringify(normalizeManifest(storedManifest)));
  check("C4 the volatile fields are exactly the expected ones", emitted.producedBy.version === CURRENT_VERSION && emitted.fingerprint.gitHead === git(repo, "rev-parse", "HEAD") && emitted.fingerprint.knowledgeHead === SOURCE_COMMIT);
  check("C4 content fingerprints (sha256 of every artifact) are byte-identical", JSON.stringify(emitted.fingerprint.artifacts) === JSON.stringify(storedManifest.fingerprint.artifacts));
  check("C4 the only manifest addition is the 0.14.0 hash marker: canonical sha256-lf, equal to the 0.11.3 LF hashes above", emitted.fingerprint.artifactHash === "sha256-lf" && storedManifest.fingerprint.artifactHash === undefined);
  const sync = helper(repo, "inspection-state.ts", "sync", repo);
  check("C4 state sync under Node.js exits 0", sync.code === 0, sync.stdout + sync.stderr);
  const synced = readJson(join(repo, ".ono", "state.json"));
  check("C4 the re-synced state equals the 0.11.3 state (volatile fields aside)", JSON.stringify(normalizeState(synced)) === JSON.stringify(normalizeState(storedState)));
  check("C4 the state now records the current plugin version", synced.plugin.version === CURRENT_VERSION && synced.repository.knowledgeHead === SOURCE_COMMIT);
  check("C4 the only additions are the additive 0.13.0 keys", Object.keys(synced).filter((k) => !(k in storedState)).every((k) => ADDITIVE_013.includes(k)), Object.keys(synced).join(","));
  check("C4 the 0.13.0 freshness snapshot describes the 0.11.3 knowledge truthfully", synced.knowledge?.status === "COMPLETE" && synced.knowledge?.knowledgeHead === SOURCE_COMMIT && synced.knowledge?.checkedHead === git(repo, "rev-parse", "HEAD") && synced.knowledge?.changedSourceCount === 0, JSON.stringify(synced.knowledge));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "inspector state refreshed by 0.12.0");
  const after = helper(repo, "inspection-state.ts", "detect", repo).json;
  check("C4 after the first 0.12.0 write: still COMPLETE, no version mismatch left", after?.knowledge?.status === "COMPLETE" && after?.versionMismatch === false, JSON.stringify(after?.versionMismatch));

  // --- C5: Refresh Project Knowledge and Inspect Sync on a 0.11.x repository ------------------
  // A real source change that keeps the recorded evidence valid (appending, not rewriting).
  const epg = join(repo, "src", "features", "epg", "EpgScreen.tsx");
  write(epg, readFileSync(epg, "utf-8") + "export const EPG_REFRESH_SECONDS = 60;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "a source change");
  const stale = helper(repo, "inspection-state.ts", "detect", repo).json;
  check("C5 a later source change is detected against the 0.11.3 knowledgeHead", stale?.knowledge?.status !== "COMPLETE" && stale?.knowledge?.status !== undefined, JSON.stringify(stale?.knowledge));
  check("C5 refresh: preservation snapshot", helper(repo, "knowledge-refresh-guard.ts", "snapshot", repo).code === 0);
  const guard = helper(repo, "knowledge-refresh-guard.ts", "verify", repo);
  check("C5 refresh: preservation guard passes on the 0.11.3 audit rows and managed blocks", guard.code === 0, guard.stdout + guard.stderr);
  for (const stage of ["project-analysis", "project-docs"]) {
    const ev2 = helper(repo, "knowledge-evidence.ts", "verify", repo, stage === "project-analysis" ? "surfaces" : "docs");
    check(`C5 refresh ${stage}: evidence gate`, ev2.code === 0, ev2.stdout);
    check(`C5 refresh ${stage}: record-knowledge`, helper(repo, "inspection-state.ts", "record-knowledge", repo, stage).code === 0);
  }
  check("C5 refresh: sync + emit + validate", helper(repo, "inspection-state.ts", "sync", repo).code === 0 && helper(repo, "repo-knowledge.ts", "emit", repo).code === 0 && helper(repo, "repo-knowledge.ts", "validate", repo).code === 0);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "refreshed");
  check("C5 after the refresh: knowledge COMPLETE again", helper(repo, "inspection-state.ts", "detect", repo).json?.knowledge?.status === "COMPLETE");
  check("C5 inspect-sync style check: AUDIT.md verifies and the manifest re-emits", helper(repo, "verify-artifacts.ts", repo, "AUDIT.md", "CLAUDE.md").code === 0 && helper(repo, "repo-knowledge.ts", "emit", repo).code === 0);

  // --- C6: the same 0.11.x repository on main ------------------------------------------------
  const onMain = join(root, "inspected on main");
  materialize(onMain, "main");
  const dm = helper(onMain, "inspection-state.ts", "detect", onMain);
  check("C6 on main: detect (read-only) still works", dm.code === 0 && dm.json?.knowledge?.status === "COMPLETE");
  check("C6 on main: validate (read-only) still works", helper(onMain, "repo-knowledge.ts", "validate", onMain).code === 0);
  check("C6 on main: emit refuses with exit 5", helper(onMain, "repo-knowledge.ts", "emit", onMain).code === 5);
  check("C6 on main: sync refuses with exit 5", helper(onMain, "inspection-state.ts", "sync", onMain).code === 5);
  check("C6 on main: verify-artifacts refuses with exit 5", helper(onMain, "verify-artifacts.ts", onMain, "CLAUDE.md").code === 5);
  check("C6 on main: nothing was written", git(onMain, "status", "--porcelain") === "");
} finally {
  rmSync(root, { recursive: true, force: true });
}

function write(path: string, body: string): void {
  writeFileSync(path, body);
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
