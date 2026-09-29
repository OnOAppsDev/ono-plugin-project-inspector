/**
 * inspection-state.ts
 *
 * Deterministic helper that owns the Ono Project Inspector orchestration
 * state file at `<repo>/.ono/state.json`. It is invoked by the internal
 * `inspection-state` skill (see skills/inspection-state/SKILL.md), which the
 * project-inspector agent calls automatically at workflow checkpoints.
 *
 * Design contract:
 * - `AUDIT.md` is the human source of truth for topic status. This file only
 *   maintains the plugin's *orchestration* state and a reconciled snapshot of
 *   the AUDIT.md topic table for fast, interruption-safe reads.
 * - PORTABLE: never stores absolute filesystem paths. Repo-relative paths and
 *   the git remote (if provided) are the only location data persisted, so the
 *   committed state file works across machines and clones.
 * - The `.ono/` directory is the shared Ono infrastructure directory; this
 *   plugin owns only `.ono/state.json` within it.
 *
 * Usage:
 *   npx ts-node inspection-state.ts <command> <repo-root> [args...]
 *
 * Commands:
 *   detect  <repo-root>                     Report inspected?/version match/resume, exit 0
 *   init    <repo-root> [gitRemote]         Create state.json if absent (idempotent)
 *   sync    <repo-root> [gitRemote] [gitHead]
 *                                           Reconcile topics/counts/stages/resume from
 *                                           AUDIT.md + on-disk artifacts, then write
 *   set-stage <repo-root> <stage> <status>  Record a stage's status, then write
 *   record-knowledge <repo-root> <stage>    Record that a source-backed stage just
 *                                           (re)generated Project Knowledge at the
 *                                           current git HEAD (the knowledge-authoring
 *                                           HEAD), then write
 *   migrate <repo-root>                     Migrate an older schema to current, then write
 *
 * Exit codes:
 *   0 - success (for `detect`, always 0; read its JSON stdout)
 *   1 - usage error or unreadable/repo problem
 *   2 - state file present but invalid/corrupt JSON
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync } from "fs";
import { execFileSync } from "child_process";
import { join, sep } from "path";
import { slugify } from "./slugify";
import { headingAnchors, isUnder, parseCapabilityMap, parseEvidenceRef, parseSurfaceModel } from "./knowledge-model";

/** Bump when the shape of state.json changes; add a migration in migrateState(). */
const STATE_SCHEMA_VERSION = 1;

type TopicStatus = "Pending Breakdown" | "Draft" | "Approved";

interface TopicState {
  index: string;
  topic: string;
  slug: string;
  status: TopicStatus | string;
  file: string; // repo-relative, exactly as AUDIT.md records it
  draftedAt: string | null;
  approvedAt: string | null;
}

interface StageState {
  status: "pending" | "in-progress" | "complete";
  completedAt: string | null;
  /**
   * Source-backed stages only: git HEAD at which this stage last (re)generated
   * Project Knowledge. Written exclusively by `record-knowledge`; every other
   * command carries it forward unchanged. Absent in pre-0.10.0 state files.
   */
  knowledgeHead?: string | null;
  knowledgeRegeneratedAt?: string | null;
}

interface InspectionState {
  stateSchemaVersion: number;
  plugin: { name: string; version: string };
  /**
   * `gitHead` is the HEAD at the last `sync` (bookkeeping time). `knowledgeHead`
   * is the HEAD at which source-backed Project Knowledge was last actually
   * generated — the only value drift detection trusts. Only `record-knowledge`
   * writes it. Absent in pre-0.10.0 state files.
   */
  repository: { gitRemote: string | null; gitHead: string | null; knowledgeHead?: string | null };
  createdAt: string;
  updatedAt: string;
  inspection: {
    started: boolean;
    completedStages: string[];
    currentStage: string | null;
    stage3Complete: boolean;
  };
  stages: Record<string, StageState>;
  topics: TopicState[];
  counts: { pendingBreakdown: number; draft: number; approved: number; total: number };
  resume: { nextAction: string; topic: string | null; hint: string };
  maintenance: { lastSyncAt: string | null };
  migrations: { history: Array<{ from: number; to: number; at: string }> };
}

type Counts = { pendingBreakdown: number; draft: number; approved: number; total: number };

/** A workflow + inspection stage, as declared in skills/registry.json. */
interface RegistryStage {
  id: string;
  stage: number;
  produces: string[];
  completion: "artifacts" | "topics";
  /** Reads repository source to produce Project Knowledge (e.g. CLAUDE.md, docs/project/). */
  sourceBacked: boolean;
  /** Refresh policy on source drift: always re-run ("default"), or only on analysis signals ("when-signaled"). */
  knowledgeRefresh: "default" | "when-signaled" | null;
  /**
   * Current knowledge-model requirements (`path` or `path#anchor`). Output that
   * lacks one predates the model: that is a refresh signal, never an
   * incomplete stage, and record-knowledge refuses to certify it.
   */
  knowledgeModel: string[];
}

/**
 * Load the ordered linear inspection stages from the registry. This is the
 * single source of truth for stage identity, order, produced artifacts, and
 * how completion is detected — no stage names are hardcoded in this file.
 * Portable: registry.json lives inside the plugin, resolved relative to this
 * script (works in dev and in the installed plugin cache).
 */
function loadInspectionStages(): RegistryStage[] {
  try {
    const reg = JSON.parse(readFileSync(join(__dirname, "..", "skills", "registry.json"), "utf-8"));
    return ((reg.skills ?? []) as any[])
      .filter((s) => s.enabled !== false && s.type === "workflow" && s.workflowRole === "inspection")
      .map((s) => ({
        id: String(s.id),
        stage: typeof s.stage === "number" ? s.stage : 0,
        produces: Array.isArray(s.produces) ? s.produces.map(String) : [],
        completion: s.completion === "topics" ? "topics" : "artifacts",
        sourceBacked: s.sourceBacked === true,
        knowledgeRefresh:
          s.knowledgeRefresh === "default" || s.knowledgeRefresh === "when-signaled" ? s.knowledgeRefresh : null,
        knowledgeModel: Array.isArray(s.knowledgeModel) ? s.knowledgeModel.map(String) : [],
      }) as RegistryStage)
      .sort((a, b) => a.stage - b.stage);
  } catch {
    return [];
  }
}

/** Deterministic completion test for one stage, driven entirely by its registry declaration. */
function isStageComplete(stage: RegistryStage, repoRoot: string, counts: Counts): boolean {
  if (stage.completion === "topics") {
    // Topic-loop stage: complete when every AUDIT.md topic is Approved.
    return counts.total > 0 && counts.pendingBreakdown === 0 && counts.draft === 0;
  }
  // Artifact stage: complete when all concrete produced paths exist. Templated
  // paths (containing "<...>") are dynamic and cannot be existence-checked. An
  // artifact the knowledge model added later (listed in `knowledgeModel`) is a
  // model gap for an older inspection, not a reason to reopen it.
  const concrete = stage.produces.filter((p) => !p.includes("<"));
  if (concrete.length === 0) return false;
  return concrete.filter((rel) => !stage.knowledgeModel.includes(rel)).every((rel) => existsSync(join(repoRoot, rel)));
}

/**
 * Knowledge-model requirements a stage's current output does not meet — a
 * missing artifact or a missing section anchor. Empty = the output is in the
 * current model. Headings, not prose, are checked, so this is deterministic.
 */
export function modelGaps(stage: RegistryStage, repoRoot: string): string[] {
  const gaps: string[] = [];
  for (const req of stage.knowledgeModel) {
    const [rel, anchor] = req.split("#");
    const p = join(repoRoot, rel);
    if (!existsSync(p)) {
      gaps.push(req);
      continue;
    }
    if (anchor && !headingAnchors(readFileSync(p, "utf-8")).includes(`#${anchor}`)) gaps.push(req);
  }
  return gaps;
}

/** In-progress heuristic: partial artifacts on disk, or a topic loop that has started. */
function isStageInProgress(stage: RegistryStage, repoRoot: string, counts: Counts): boolean {
  if (stage.completion === "topics") {
    return counts.total > 0 && (counts.pendingBreakdown > 0 || counts.draft > 0);
  }
  return stage.produces.filter((p) => !p.includes("<")).some((rel) => existsSync(join(repoRoot, rel)));
}

function nowIso(): string {
  return new Date().toISOString();
}

function stateDir(repoRoot: string): string {
  return join(repoRoot, ".ono");
}
function statePath(repoRoot: string): string {
  return join(stateDir(repoRoot), "state.json");
}

/** Current plugin version, read from the plugin's own manifest (portable, relative to this script). */
function currentPluginVersion(): { name: string; version: string } {
  try {
    const manifest = JSON.parse(
      readFileSync(join(__dirname, "..", ".claude-plugin", "plugin.json"), "utf-8")
    );
    return { name: manifest.name ?? "ono-project-inspector", version: manifest.version ?? "0.0.0" };
  } catch {
    return { name: "ono-project-inspector", version: "0.0.0" };
  }
}

function readState(repoRoot: string): InspectionState | null {
  const p = statePath(repoRoot);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as InspectionState;
  } catch (err) {
    console.error(`state.json exists but is not valid JSON: ${(err as Error).message}`);
    process.exit(2);
  }
}

function writeState(repoRoot: string, state: InspectionState): void {
  const dir = stateDir(repoRoot);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  state.updatedAt = nowIso();
  writeFileSync(statePath(repoRoot), JSON.stringify(state, null, 2) + "\n", "utf-8");
}

function firstStageHint(prefix: string): string {
  const first = loadInspectionStages()[0];
  return first ? `${prefix}Run ${first.id} (stage ${first.stage}) to begin.` : `${prefix}Run the first inspection stage to begin.`;
}

function freshState(gitRemote: string | null): InspectionState {
  const ts = nowIso();
  return {
    stateSchemaVersion: STATE_SCHEMA_VERSION,
    plugin: currentPluginVersion(),
    repository: { gitRemote: gitRemote ?? null, gitHead: null, knowledgeHead: null },
    createdAt: ts,
    updatedAt: ts,
    inspection: { started: false, completedStages: [], currentStage: null, stage3Complete: false },
    stages: {},
    topics: [],
    counts: { pendingBreakdown: 0, draft: 0, approved: 0, total: 0 },
    resume: { nextAction: "run-stage", topic: null, hint: firstStageHint("") },
    maintenance: { lastSyncAt: null },
    migrations: { history: [] },
  };
}

// --- AUDIT.md topic table parsing (portable, repo-relative File column) ---

function parseAuditTopics(repoRoot: string): Array<{ index: string; status: string; topic: string; file: string }> {
  const auditPath = join(repoRoot, "AUDIT.md");
  if (!existsSync(auditPath)) return [];
  const md = readFileSync(auditPath, "utf-8");
  const rows: Array<{ index: string; status: string; topic: string; file: string }> = [];
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
    rows.push({ index: cells[0], status: cells[1], topic: cells[2], file: cells[4] });
  }
  return rows;
}

/** Rebuild the topic snapshot from AUDIT.md, preserving known timestamps and stamping new transitions. */
function reconcileTopics(prev: TopicState[], repoRoot: string): TopicState[] {
  const prevByTopic = new Map(prev.map((t) => [t.topic.toLowerCase(), t]));
  return parseAuditTopics(repoRoot).map((row) => {
    const before = prevByTopic.get(row.topic.toLowerCase());
    const draftedAt =
      before?.draftedAt ?? (row.status === "Draft" || row.status === "Approved" ? nowIso() : null);
    const approvedAt = before?.approvedAt ?? (row.status === "Approved" ? nowIso() : null);
    return {
      index: row.index,
      topic: row.topic,
      slug: slugify(row.topic),
      status: row.status,
      file: row.file,
      draftedAt,
      approvedAt,
    };
  });
}

function countTopics(topics: TopicState[]): InspectionState["counts"] {
  return {
    pendingBreakdown: topics.filter((t) => t.status === "Pending Breakdown").length,
    draft: topics.filter((t) => t.status === "Draft").length,
    approved: topics.filter((t) => t.status === "Approved").length,
    total: topics.length,
  };
}

function computeResume(state: InspectionState, stages: RegistryStage[]): InspectionState["resume"] {
  const c = state.counts;

  // 1. An open Draft awaiting review always takes priority.
  const firstDraft = state.topics.find((t) => t.status === "Draft");
  if (firstDraft) {
    return {
      nextAction: "review-draft",
      topic: firstDraft.topic,
      hint: `Review the ${firstDraft.topic} Draft, then /inspect-approve to finalize and continue.`,
    };
  }

  // 2. The current stage is the first (in registry order) not yet complete.
  const current = stages.find((st) => state.stages[st.id]?.status !== "complete");
  if (!current) {
    return { nextAction: "stage3-complete", topic: null, hint: "All inspection stages complete. /inspect-sync is available for optional maintenance." };
  }

  // 3. A topic-loop stage: break down the next pending topic, or nothing actionable.
  if (current.completion === "topics") {
    if (c.pendingBreakdown > 0) {
      const next = state.topics.find((t) => t.status === "Pending Breakdown");
      return {
        nextAction: "breakdown-next",
        topic: next?.topic ?? null,
        hint: `Break down the next Pending Breakdown topic${next ? ` (${next.topic})` : ""}.`,
      };
    }
    return { nextAction: "idle", topic: null, hint: "No topics pending." };
  }

  // 4. An artifact stage that has not yet produced its outputs.
  return { nextAction: "run-stage", topic: null, hint: `Run ${current.id} (stage ${current.stage}) next.` };
}

// --- schema migration (prepared for the future; v1 is current) ---

function migrateState(state: InspectionState): InspectionState {
  let s = state;
  while ((s.stateSchemaVersion ?? 0) < STATE_SCHEMA_VERSION) {
    const from = s.stateSchemaVersion ?? 0;
    // No historical migrations exist yet. Future example:
    //   if (from === 1) { s = { ...s, /* v1 -> v2 changes */ stateSchemaVersion: 2 }; }
    // Failsafe so an unknown/older file is not left in a broken loop:
    s = { ...s, stateSchemaVersion: from + 1 };
    s.migrations = s.migrations ?? { history: [] };
    s.migrations.history.push({ from, to: s.stateSchemaVersion, at: nowIso() });
  }
  return s;
}

// --- Project Knowledge freshness (derived on every detect, never persisted) ---

/**
 * Inspector-owned outputs. A change confined to these is the workflow's own
 * bookkeeping (committing artifacts, audit-sync, approvals), never evidence
 * that the repository's source moved away from the knowledge.
 */
export function isInspectorOwned(rel: string): boolean {
  return (
    rel === "CLAUDE.md" ||
    rel === "AUDIT.md" ||
    rel === "CLAUDE.md.bak" ||
    rel === "AUDIT.md.bak" ||
    rel.startsWith(".ono/") ||
    rel.startsWith("docs/project/") ||
    rel.startsWith("audits/")
  );
}

/**
 * Generic, ecosystem-neutral build / dependency / CI manifests. A change to one
 * can move what project-analysis recorded in CLAUDE.md (stack, commands), so it
 * signals that project-analysis should re-run too. Matched on basename.
 */
const ANALYSIS_MANIFEST_BASENAMES = new Set([
  "package.json", "pnpm-workspace.yaml", "lerna.json", "nx.json", "turbo.json",
  "Podfile", "Package.swift", "Cartfile", "project.pbxproj",
  "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts",
  "pom.xml", "Cargo.toml", "go.mod", "pyproject.toml", "setup.py", "setup.cfg",
  "requirements.txt", "Pipfile", "Gemfile", "pubspec.yaml", "composer.json",
  "Makefile", "Dockerfile", "docker-compose.yml", "docker-compose.yaml",
  ".gitlab-ci.yml", "Jenkinsfile",
  // Files that declare targets / surfaces / flavors / packaging (generic, per ecosystem):
  // Xcode project generators, Android app manifests, RN/Expo app config, Smart TV
  // app descriptors (Tizen config.xml, webOS appinfo.json).
  "project.yml", "Project.swift", "Workspace.swift", "AndroidManifest.xml",
  "app.json", "eas.json", "config.xml", "appinfo.json",
]);

function isAnalysisManifest(rel: string): boolean {
  const base = rel.split("/").pop() ?? rel;
  return (
    ANALYSIS_MANIFEST_BASENAMES.has(base) ||
    /\.csproj$/.test(base) ||
    // Xcode schemes and build-setting files; RN/Expo app config; web bundler targets.
    /\.(xcscheme|xcconfig)$/.test(base) ||
    /^(app\.config|vite\.config|webpack\.config|next\.config)\.(js|cjs|mjs|ts)$/.test(base) ||
    rel.startsWith(".github/workflows/") ||
    rel.startsWith(".circleci/")
  );
}

function git(repoRoot: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function currentGitHead(repoRoot: string): string | null {
  return git(repoRoot, ["rev-parse", "HEAD"]) || null;
}

type KnowledgeStatus = "COMPLETE" | "REFRESH_RECOMMENDED" | "BASELINE_UNKNOWN" | "NOT_APPLICABLE";

interface KnowledgeFreshness {
  status: KnowledgeStatus;
  knowledgeHead: string | null;
  currentHead: string | null;
  reason: string;
  changedSourceCount: number;
  /** Sorted; capped at MAX_LISTED_FILES — changedSourceCount is the full count. */
  changedSourceFiles: string[];
  refreshPlan: { stages: string[]; analysisSignals: string[]; modelSignals: string[] };
  /**
   * Change-surface attribution over the FULL changed-file list: capabilities,
   * relationships and surfaces whose recorded source roots / evidence contain
   * a changed file. Hints for the refresh report and for verify-on-use — never
   * a verdict, never persisted.
   */
  affectedCapabilities: string[];
  affectedRelationships: string[];
  affectedSurfaces: string[];
}

const MAX_LISTED_FILES = 50;

/**
 * Registry-ordered refresh stages for the given drift evidence. A stage already
 * regenerated at the current HEAD (an interrupted refresh) is not re-run.
 */
function refreshStages(
  stages: RegistryStage[],
  analysisSignalled: boolean,
  state: InspectionState,
  currentHead: string | null,
  opts: { drift: boolean; gapStages: Set<string> }
): string[] {
  const sourceBacked = stages.filter((st) => st.sourceBacked);
  // A stage whose output predates the knowledge model re-runs, and so does every
  // downstream source-backed stage (it consumes that output) — even at the same HEAD.
  const firstGap = sourceBacked.find((st) => opts.gapStages.has(st.id));
  return sourceBacked
    .filter(
      (st) =>
        (firstGap !== undefined && st.stage >= firstGap.stage) ||
        (opts.drift &&
          (!currentHead || state.stages[st.id]?.knowledgeHead !== currentHead) &&
          (st.knowledgeRefresh === "default" || (st.knowledgeRefresh === "when-signaled" && analysisSignalled)))
    )
    .map((st) => st.id);
}

function readIfPresent(repoRoot: string, rel: string): string | null {
  const p = join(repoRoot, rel);
  return existsSync(p) ? readFileSync(p, "utf-8") : null;
}

/** Which recorded surfaces / capabilities / relationships a set of changed files touches. */
function attribute(repoRoot: string, changed: string[]) {
  const surfaceModel = parseSurfaceModel(readIfPresent(repoRoot, "CLAUDE.md"));
  const map = parseCapabilityMap(readIfPresent(repoRoot, "docs/project/capabilities.md"));
  const touches = (refs: string[]) => refs.some((ref) => changed.some((rel) => isUnder(rel, parseEvidenceRef(ref).path)));

  const surfaceEvidence = [...surfaceModel.surfaces.flatMap((s) => s.evidence), ...surfaceModel.sharedCode.flatMap((c) => c.evidence)]
    .map((ref) => parseEvidenceRef(ref).path);
  const surfaceSignals = changed.filter((rel) => surfaceEvidence.some((p) => isUnder(rel, p))).map((rel) => `surface evidence changed: ${rel}`);

  const affectedSurfaces = new Set<string>();
  for (const s of surfaceModel.surfaces) if (touches([...s.sourceRoots, ...s.evidence])) affectedSurfaces.add(s.id);
  for (const c of surfaceModel.sharedCode) if (touches([c.root])) c.sharedBy.forEach((id) => affectedSurfaces.add(id));

  const affectedCapabilities = map.capabilities
    .filter((c) =>
      touches([
        ...c.sourceRoots.map((r) => r.path), ...c.entryPoints, ...c.services, ...c.routes, ...c.stateOwnership,
        ...c.tests, ...c.evidence, ...c.dataDependencies.filter((d) => d.includes("/")),
      ]))
    .map((c) => c.id);
  const affectedRelationships = map.relationships.filter((r) => touches(r.evidence)).map((r) => r.id);

  return {
    surfaceSignals,
    affectedSurfaces: Array.from(affectedSurfaces).sort(),
    affectedCapabilities: affectedCapabilities.sort(),
    affectedRelationships: affectedRelationships.sort(),
  };
}

/**
 * Compare the knowledge-authoring HEAD with the current HEAD. Only meaningful
 * once the inspection is complete; an in-progress inspection is still
 * producing its knowledge and keeps its normal resume behavior.
 */
function computeKnowledgeFreshness(state: InspectionState, repoRoot: string, stages: RegistryStage[]): KnowledgeFreshness {
  const knowledgeHead = state.repository?.knowledgeHead ?? null;
  const currentHead = currentGitHead(repoRoot);
  const noAttribution = { affectedCapabilities: [] as string[], affectedRelationships: [] as string[], affectedSurfaces: [] as string[] };
  const base = { knowledgeHead, currentHead, changedSourceCount: 0, changedSourceFiles: [] as string[], ...noAttribution };
  const none = { stages: [] as string[], analysisSignals: [] as string[], modelSignals: [] as string[] };

  if (!state.inspection?.stage3Complete) {
    return { ...base, status: "NOT_APPLICABLE", reason: "Inspection not complete; knowledge is still being produced.", refreshPlan: none };
  }

  // Knowledge-model gaps: output a source-backed stage produced under an older
  // model. They join the same Refresh Project Knowledge flow; they never create
  // a second freshness mechanism and never move knowledgeHead.
  const gapStages = new Set<string>();
  const modelSignals: string[] = [];
  for (const st of stages.filter((x) => x.sourceBacked)) {
    const gaps = modelGaps(st, repoRoot);
    if (gaps.length) gapStages.add(st.id);
    for (const g of gaps) modelSignals.push(`knowledge model: ${st.id} output lacks ${g}`);
  }
  const plan = (drift: boolean, analysisSignals: string[]) => ({
    stages: refreshStages(stages, analysisSignals.length > 0, state, currentHead, { drift, gapStages }),
    analysisSignals,
    modelSignals,
  });
  const modelReason = `Project Knowledge predates the current knowledge model (${modelSignals.length} missing section(s)/artifact(s)).`;

  const unknown = (reason: string): KnowledgeFreshness => ({ ...base, status: "BASELINE_UNKNOWN", reason, refreshPlan: plan(true, []) });
  if (!knowledgeHead) {
    return unknown("No knowledge-authoring HEAD recorded (inspected before knowledgeHead existed). Freshness cannot be established.");
  }
  if (!currentHead) return unknown("Current git HEAD cannot be determined.");
  if (git(repoRoot, ["cat-file", "-e", `${knowledgeHead}^{commit}`]) === null) {
    return unknown(`Recorded knowledgeHead ${knowledgeHead.slice(0, 12)} is not in this repository's history (rewritten or shallow).`);
  }
  const current = (reason: string): KnowledgeFreshness =>
    gapStages.size > 0
      ? { ...base, status: "REFRESH_RECOMMENDED", reason: modelReason, refreshPlan: plan(false, []) }
      : { ...base, status: "COMPLETE", reason, refreshPlan: none };
  if (knowledgeHead === currentHead) return current("Knowledge was generated at the current HEAD.");

  const diff = git(repoRoot, ["diff", "--name-only", "--no-renames", knowledgeHead, currentHead]);
  if (diff === null) return unknown("git diff between knowledgeHead and HEAD failed.");
  const changed = Array.from(new Set(diff.split("\n").filter((l) => l.length > 0)))
    .filter((rel) => !isInspectorOwned(rel))
    .sort();
  if (changed.length === 0) return current("Only Inspector-owned artifacts changed since knowledge was generated.");

  // Analysis signals: a build/dependency/CI/surface-declaring manifest changed, a
  // file recorded as surface evidence changed, or a top-level entry appeared or
  // disappeared (the repository structure CLAUDE.md records).
  const topAt = (rev: string): Set<string> =>
    new Set((git(repoRoot, ["ls-tree", "--name-only", rev]) ?? "").split("\n").filter(Boolean));
  const topBefore = topAt(knowledgeHead);
  const topNow = topAt(currentHead);
  const signals = new Set<string>();
  for (const rel of changed) {
    if (isAnalysisManifest(rel)) signals.add(`build/dependency manifest changed: ${rel}`);
    const top = rel.split("/")[0];
    if (!topBefore.has(top)) signals.add(`top-level entry added: ${top}`);
    else if (!topNow.has(top)) signals.add(`top-level entry removed: ${top}`);
  }
  const attribution = attribute(repoRoot, changed);
  for (const sig of attribution.surfaceSignals) signals.add(sig);
  const analysisSignals = Array.from(signals).sort();

  return {
    knowledgeHead,
    currentHead,
    status: "REFRESH_RECOMMENDED",
    reason: `${changed.length} source file(s) changed since knowledge was generated.` + (gapStages.size ? ` ${modelReason}` : ""),
    changedSourceCount: changed.length,
    changedSourceFiles: changed.slice(0, MAX_LISTED_FILES),
    refreshPlan: plan(true, analysisSignals),
    affectedCapabilities: attribution.affectedCapabilities,
    affectedRelationships: attribution.affectedRelationships,
    affectedSurfaces: attribution.affectedSurfaces,
  };
}

// --- commands ---

function cmdDetect(repoRoot: string): void {
  const state = readState(repoRoot);
  const current = currentPluginVersion();
  if (!state) {
    console.log(
      JSON.stringify(
        { inspected: false, resume: { nextAction: "run-stage", topic: null, hint: firstStageHint("No prior inspection. ") } },
        null,
        2
      )
    );
    process.exit(0);
  }
  const versionMismatch = state.plugin.version !== current.version;
  const needsMigration = (state.stateSchemaVersion ?? 0) < STATE_SCHEMA_VERSION;
  console.log(
    JSON.stringify(
      {
        inspected: true,
        started: state.inspection.started,
        storedPluginVersion: state.plugin.version,
        currentPluginVersion: current.version,
        versionMismatch,
        storedSchemaVersion: state.stateSchemaVersion,
        currentSchemaVersion: STATE_SCHEMA_VERSION,
        needsMigration,
        completedStages: state.inspection.completedStages,
        currentStage: state.inspection.currentStage,
        stage3Complete: state.inspection.stage3Complete,
        counts: state.counts,
        resume: state.resume,
        knowledge: computeKnowledgeFreshness(state, repoRoot, loadInspectionStages()),
      },
      null,
      2
    )
  );
  process.exit(0);
}

function cmdInit(repoRoot: string, gitRemote: string | null): void {
  let state = readState(repoRoot);
  if (state) {
    console.log(`state.json already present (schema v${state.stateSchemaVersion}, plugin ${state.plugin.version}).`);
    process.exit(0);
  }
  state = freshState(gitRemote);
  writeState(repoRoot, state);
  console.log(`Initialized ${join(".ono", "state.json")} (schema v${STATE_SCHEMA_VERSION}, plugin ${state.plugin.version}).`);
  process.exit(0);
}

function cmdSync(repoRoot: string, gitRemote: string | null, gitHead: string | null): void {
  let state = readState(repoRoot) ?? freshState(gitRemote);
  state = migrateState(state);
  state.plugin = currentPluginVersion();
  if (gitRemote) state.repository.gitRemote = gitRemote;
  if (gitHead) state.repository.gitHead = gitHead;

  // Reconcile the topic snapshot from AUDIT.md (the human source of truth).
  state.topics = reconcileTopics(state.topics, repoRoot);
  state.counts = countTopics(state.topics);

  // Reconcile every stage's completion entirely from the registry declaration.
  const stages = loadInspectionStages();
  for (const st of stages) {
    const prev = state.stages[st.id];
    const complete = isStageComplete(st, repoRoot, state.counts);
    const status = complete
      ? "complete"
      : isStageInProgress(st, repoRoot, state.counts)
      ? "in-progress"
      : prev?.status ?? "pending";
    // Spread `prev` so knowledgeHead / knowledgeRegeneratedAt survive: a routine
    // sync is bookkeeping and must never advance or erase knowledge freshness.
    state.stages[st.id] = { ...prev, status, completedAt: complete ? prev?.completedAt ?? nowIso() : null };
  }

  // Completed stages, current stage, and "topic loop done" all derive from registry order.
  state.inspection.completedStages = stages
    .filter((st) => state.stages[st.id]?.status === "complete")
    .map((st) => st.id);
  const firstIncomplete = stages.find((st) => state.stages[st.id]?.status !== "complete");
  state.inspection.currentStage = firstIncomplete ? firstIncomplete.id : null;
  const topicStages = stages.filter((st) => st.completion === "topics");
  state.inspection.stage3Complete =
    topicStages.length > 0 && topicStages.every((st) => state.stages[st.id]?.status === "complete");
  state.inspection.started = state.inspection.completedStages.length > 0 || state.counts.total > 0;

  state.resume = computeResume(state, stages);
  writeState(repoRoot, state);
  console.log(`Synced ${join(".ono", "state.json")}: ${JSON.stringify(state.counts)}, next=${state.resume.nextAction}.`);
  process.exit(0);
}

function cmdSetStage(repoRoot: string, stage: string, status: string): void {
  let state = readState(repoRoot) ?? freshState(null);
  state = migrateState(state);
  const valid = ["pending", "in-progress", "complete"];
  if (!valid.includes(status)) {
    console.error(`Invalid status "${status}" (expected one of ${valid.join(", ")}).`);
    process.exit(1);
  }
  const prev = state.stages[stage];
  state.stages[stage] = {
    ...prev,
    status: status as StageState["status"],
    completedAt: status === "complete" ? prev?.completedAt ?? nowIso() : prev?.completedAt ?? null,
  };
  state.inspection.completedStages = Object.entries(state.stages)
    .filter(([, v]) => v.status === "complete")
    .map(([k]) => k);
  writeState(repoRoot, state);
  console.log(`Stage "${stage}" set to "${status}".`);
  process.exit(0);
}

/**
 * The single writer of the knowledge-authoring HEAD. Called by a source-backed
 * stage's after-hook only once its regenerated artifacts are verified at the
 * real root. Refuses any stage that does not read source, and any stage whose
 * artifacts are missing, so bookkeeping can never claim knowledge is fresh.
 */
function cmdRecordKnowledge(repoRoot: string, stageId: string): void {
  const stages = loadInspectionStages();
  const stage = stages.find((st) => st.id === stageId);
  if (!stage || !stage.sourceBacked) {
    console.error(`"${stageId}" is not a source-backed inspection stage; it cannot record regenerated knowledge.`);
    process.exit(1);
  }
  const missing = stage.produces.filter((p) => !p.includes("<")).filter((rel) => !existsSync(join(repoRoot, rel)));
  if (missing.length) {
    console.error(`Refusing to record knowledge for "${stageId}": missing ${missing.join(", ")}.`);
    process.exit(1);
  }
  // Regenerated knowledge must be in the current knowledge model; otherwise the
  // next detect would still (correctly) plan this stage, and certifying it now
  // would make an incomplete refresh look done.
  const gaps = modelGaps(stage, repoRoot);
  if (gaps.length) {
    console.error(`Refusing to record knowledge for "${stageId}": output lacks ${gaps.join(", ")} (current knowledge model).`);
    process.exit(1);
  }
  const head = currentGitHead(repoRoot);
  if (!head) {
    console.error("Cannot determine git HEAD; knowledge-authoring HEAD not recorded.");
    process.exit(1);
  }
  let state = readState(repoRoot) ?? freshState(null);
  state = migrateState(state);
  const ts = nowIso();
  const prev = state.stages[stageId];
  state.stages[stageId] = {
    ...prev,
    status: "complete",
    completedAt: prev?.completedAt ?? ts,
    knowledgeHead: head,
    knowledgeRegeneratedAt: ts,
  };
  // Later source-backed stages consume earlier ones' output (project-docs reads
  // CLAUDE.md), so the knowledge set is current at `head` only once every
  // downstream source-backed stage has also regenerated at `head`. Until then an
  // interrupted multi-stage refresh keeps reporting REFRESH_RECOMMENDED.
  const downstreamCurrent = stages
    .filter((st) => st.sourceBacked && st.stage > stage.stage)
    .every((st) => state.stages[st.id]?.knowledgeHead === head);
  if (downstreamCurrent) state.repository = { ...state.repository, knowledgeHead: head };
  writeState(repoRoot, state);
  console.log(
    `Recorded knowledgeHead ${head.slice(0, 12)} for "${stageId}"` +
      (downstreamCurrent ? "; Project Knowledge is current at this HEAD." : "; downstream source-backed stages still need regeneration.")
  );
  process.exit(0);
}

function cmdMigrate(repoRoot: string): void {
  const existing = readState(repoRoot);
  if (!existing) {
    console.error("No state.json to migrate.");
    process.exit(1);
  }
  const before = existing.stateSchemaVersion ?? 0;
  const migrated = migrateState(existing);
  if (migrated.stateSchemaVersion === before) {
    console.log(`Already at schema v${before}; nothing to migrate.`);
    process.exit(0);
  }
  writeState(repoRoot, migrated);
  console.log(`Migrated schema v${before} -> v${migrated.stateSchemaVersion}.`);
  process.exit(0);
}

function main(): void {
  const [, , command, repoRoot, ...rest] = process.argv;
  if (!command || !repoRoot) {
    console.error("Usage: inspection-state.ts <detect|init|sync|set-stage|record-knowledge|migrate> <repo-root> [args...]");
    process.exit(1);
  }
  if (!existsSync(repoRoot)) {
    console.error(`Repository root not found: ${repoRoot}`);
    process.exit(1);
  }
  // Guard (worktree safety): never own/compute state inside a Claude agent
  // worktree — that path is an ephemeral execution copy, not the developer's
  // repository. Callers must pass the resolved main-tree root
  // (scripts/resolve-repo-root.ts). `detect` is read-only, but even reading
  // from a worktree would mislead the resume pointer, so guard all commands.
  const WORKTREE_MARKER = `${sep}.claude${sep}worktrees${sep}`;
  if (realpathSync(repoRoot).includes(WORKTREE_MARKER)) {
    console.error(
      `Refusing to operate on a Claude agent worktree: ${repoRoot}\n` +
        `Pass the resolved main repository root (scripts/resolve-repo-root.ts).`
    );
    process.exit(1);
  }
  switch (command) {
    case "detect":
      return cmdDetect(repoRoot);
    case "init":
      return cmdInit(repoRoot, rest[0] ?? null);
    case "sync":
      return cmdSync(repoRoot, rest[0] ?? null, rest[1] ?? null);
    case "set-stage":
      if (!rest[0] || !rest[1]) {
        console.error("Usage: inspection-state.ts set-stage <repo-root> <stage> <status>");
        process.exit(1);
      }
      return cmdSetStage(repoRoot, rest[0], rest[1]);
    case "record-knowledge":
      if (!rest[0]) {
        console.error("Usage: inspection-state.ts record-knowledge <repo-root> <stage>");
        process.exit(1);
      }
      return cmdRecordKnowledge(repoRoot, rest[0]);
    case "migrate":
      return cmdMigrate(repoRoot);
    default:
      console.error(`Unknown command "${command}".`);
      process.exit(1);
  }
}

if (require.main === module) {
  main();
}
