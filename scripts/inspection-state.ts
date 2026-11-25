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
 *   freshness <repo-root> [--ref <rev>]     READ-ONLY. Print the knowledge freshness contract
 *                                           (Guardian), exit 0. Works on every branch. With
 *                                           --ref (0.14.0): one exact commit, read from Git
 *                                           objects only (docs/freshness-contract.md).
 *   record-approval <repo-root> <topic>     After a HUMAN approval (/inspect-approve): record
 *                                           the HEAD it was approved at, once; then write
 *   record-recheck <repo-root> <topic> <results.json|->
 *                                           Record AI re-verification results for the scope
 *                                           audit-recheck.ts computes; then write
 *   stamp-docs <repo-root> <rel>...         Write/normalize the generation header of the
 *                                           given Inspector documents (doc-header.ts), then
 *                                           write. Run before the manifest is emitted.
 *
 * Exit codes:
 *   0 - success (for `detect`, always 0; read its JSON stdout)
 *   1 - usage error (including a malformed freshness argument) or unreadable/repo problem
 *   2 - state file present but invalid/corrupt JSON
 *   5 - refused: a writing command on main, master or a detached HEAD (scripts/work-branch.ts)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync } from "fs";
import { execFileSync } from "child_process";
import { join, sep } from "path";
import { slugify } from "./slugify.ts";
import { CAPABILITIES_DOC, headingAnchors, isUnder, parseCapabilityMap, parseEvidenceRef, parseSurfaceModel } from "./knowledge-model.ts";
import {
  commitSource, gitPathList, gitText, malformedRevision, objectReadPolicy, resolveRevision, worktreeSource,
  type KnowledgeSource,
} from "./knowledge-source.ts";
import { assertWritable, guardWrite } from "./work-branch.ts";
import { isEntryPoint, useBlockingOutput } from "./entrypoint.ts";
import { bodyHash, bodyHashMatches, findHeader, insertHeader, isStampable, shortCommit, stripHeader, todayUtc, type Header } from "./doc-header.ts";
import { toLf } from "./markdown-text.ts";
import { candidateCommit, commitTouches, computeScope, findRow, RecheckError, type TopicRecord } from "./audit-recheck.ts";

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
  /**
   * Additive (0.13.0): the knowledge freshness snapshot taken whenever the Inspector
   * writes this file anyway — never written on its own. Authoritative only while
   * `checkedHead` equals the current HEAD; consumers prefer `inspection-state.ts
   * freshness` (read-only, always current). See KnowledgeFreshnessContract.
   */
  knowledge?: KnowledgeFreshnessContract;
  /**
   * Additive (0.13.0): per Inspector document, the header it carries and the hash of its
   * body (the document without the header line) when that header was written. Lets
   * stamp-docs keep the date of an unchanged document. Keyed by repo-relative path.
   */
  documents?: Record<string, DocumentRecord>;
  /**
   * Additive (0.13.0): per Approved audit topic, keyed by its audit file path. `approval`
   * is written once, by record-approval after a human approval, and never changed again.
   * `verification` holds AI re-verification results (record-recheck) — never an approval.
   */
  audits?: Record<string, TopicRecord>;
}

interface DocumentRecord extends Header {
  bodySha256: string;
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
    const reg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "skills", "registry.json"), "utf-8"));
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
export function modelGaps(stage: RegistryStage, from: string | KnowledgeSource): string[] {
  const source = typeof from === "string" ? worktreeSource(from) : from;
  const gaps: string[] = [];
  for (const req of stage.knowledgeModel) {
    const [rel, anchor] = req.split("#");
    const text = source.read(rel);
    if (text === null) {
      gaps.push(req);
      continue;
    }
    if (anchor && !headingAnchors(text).includes(`#${anchor}`)) gaps.push(req);
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
      readFileSync(join(import.meta.dirname, "..", ".claude-plugin", "plugin.json"), "utf-8")
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
  // Protected-branch backstop (0.11.3): never write on main, master or a detached HEAD.
  assertWritable(repoRoot, "inspection-state");
  const dir = stateDir(repoRoot);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  state.updatedAt = nowIso();
  // 0.13.0: refresh the freshness snapshot as part of this (already happening) write.
  state.knowledge = freshnessContract(state, repoRoot, loadInspectionStages());
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

const git = (repoRoot: string, args: string[]): string | null => gitText(repoRoot, args);

/** NUL-delimited, unquoted Git path listing (0.13.0) — see knowledge-source.ts gitPathList. */
export const gitPaths = (repoRoot: string, args: string[]): string[] | null => gitPathList(repoRoot, args);

/**
 * Unicode-normalized form used ONLY to compare a Git path with a path recorded in
 * a document (a model may write NFC where Git stores NFD, e.g. names created on
 * macOS). Never used as an identity: distinct Git paths stay distinct.
 */
export const comparablePath = (p: string): string => p.normalize("NFC");

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
  /**
   * Structured form of the signals above (0.14.0), for the public contract's `signals`.
   * Null whenever the result is not established. Counts are over the FULL changed list.
   */
  structured: { analysis: AnalysisCounts; model: ModelGap[] } | null;
}

/** One knowledge-model requirement a source-backed stage's output lacks. */
interface ModelGap { stage: string; requirement: string }

/** Distinct changed source files per signal (top-level entries: distinct entry names). */
interface AnalysisCounts {
  buildManifests: number;
  topLevelAdded: number;
  topLevelRemoved: number;
  surfaceEvidence: number;
  /** Declared surfaces whose recorded evidence (or Shared Code evidence) contains a changed file. */
  surfaceEvidenceSurfaces: string[];
}

const emptyAnalysis = (): AnalysisCounts => ({ buildManifests: 0, topLevelAdded: 0, topLevelRemoved: 0, surfaceEvidence: 0, surfaceEvidenceSurfaces: [] });

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

/** Which recorded surfaces / capabilities / relationships a set of changed files touches. */
function attribute(source: KnowledgeSource, changed: string[]) {
  const surfaceModel = parseSurfaceModel(source.read("CLAUDE.md"));
  const map = parseCapabilityMap(source.read(CAPABILITIES_DOC));
  // Comparison only: each changed path keeps its exact Git identity in the output.
  const under = (rel: string, root: string) => isUnder(comparablePath(rel), comparablePath(root));
  const touches = (refs: string[]) => refs.some((ref) => changed.some((rel) => under(rel, parseEvidenceRef(ref).path)));

  // Recorded surface evidence, each path with the surfaces it is evidence for (a Shared Code
  // row's evidence counts for every surface sharing that code).
  const declared = new Set(surfaceModel.surfaces.map((s) => s.id));
  const evidence = [
    ...surfaceModel.surfaces.flatMap((s) => s.evidence.map((ref) => ({ path: parseEvidenceRef(ref).path, surfaces: [s.id] }))),
    ...surfaceModel.sharedCode.flatMap((c) => c.evidence.map((ref) => ({ path: parseEvidenceRef(ref).path, surfaces: c.sharedBy.filter((id) => declared.has(id)) }))),
  ];
  const evidenceChanged = changed.filter((rel) => evidence.some((e) => under(rel, e.path)));
  const evidenceSurfaces = new Set<string>();
  for (const rel of evidenceChanged) for (const e of evidence) if (under(rel, e.path)) e.surfaces.forEach((id) => evidenceSurfaces.add(id));

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
    evidenceChanged,
    evidenceSurfaces: Array.from(evidenceSurfaces).sort(),
    affectedSurfaces: Array.from(affectedSurfaces).sort(),
    affectedCapabilities: affectedCapabilities.sort(),
    affectedRelationships: affectedRelationships.sort(),
  };
}

/**
 * Compare the knowledge-authoring HEAD with the source's HEAD (the checked-out HEAD, or the
 * commit `--ref` resolved). Only meaningful once the inspection is complete; an in-progress
 * inspection is still producing its knowledge and keeps its normal resume behavior. Every
 * document and Git read goes through `source`, so the same algorithm serves both inputs.
 */
function computeKnowledgeFreshness(
  state: InspectionState,
  repoRoot: string,
  stages: RegistryStage[],
  source: KnowledgeSource = worktreeSource(repoRoot)
): KnowledgeFreshness {
  const knowledgeHead = state.repository?.knowledgeHead ?? null;
  const currentHead = source.head;
  const noAttribution = { affectedCapabilities: [] as string[], affectedRelationships: [] as string[], affectedSurfaces: [] as string[] };
  const base = { knowledgeHead, currentHead, changedSourceCount: 0, changedSourceFiles: [] as string[], ...noAttribution };
  const none = { stages: [] as string[], analysisSignals: [] as string[], modelSignals: [] as string[] };

  if (!state.inspection?.stage3Complete) {
    return { ...base, status: "NOT_APPLICABLE", reason: "Inspection not complete; knowledge is still being produced.", refreshPlan: none, structured: null };
  }

  // Knowledge-model gaps: output a source-backed stage produced under an older
  // model. They join the same Refresh Project Knowledge flow; they never create
  // a second freshness mechanism and never move knowledgeHead.
  const gapStages = new Set<string>();
  const modelSignals: string[] = [];
  const modelGapList: ModelGap[] = [];
  for (const st of stages.filter((x) => x.sourceBacked)) {
    const gaps = modelGaps(st, source);
    if (gaps.length) gapStages.add(st.id);
    for (const g of gaps) {
      modelSignals.push(`knowledge model: ${st.id} output lacks ${g}`);
      modelGapList.push({ stage: st.id, requirement: g });
    }
  }
  const plan = (drift: boolean, analysisSignals: string[]) => ({
    stages: refreshStages(stages, analysisSignals.length > 0, state, currentHead, { drift, gapStages }),
    analysisSignals,
    modelSignals,
  });
  const modelReason = `Project Knowledge predates the current knowledge model (${modelSignals.length} missing section(s)/artifact(s)).`;

  const unknown = (reason: string): KnowledgeFreshness => ({ ...base, status: "BASELINE_UNKNOWN", reason, refreshPlan: plan(true, []), structured: null });
  if (!knowledgeHead) {
    return unknown("No knowledge-authoring HEAD recorded (inspected before knowledgeHead existed). Freshness cannot be established.");
  }
  if (!currentHead) return unknown("Current git HEAD cannot be determined.");
  if (source.git(["cat-file", "-e", `${knowledgeHead}^{commit}`]) === null) {
    return unknown(`Recorded knowledgeHead ${knowledgeHead.slice(0, 12)} is not in this repository's history (rewritten or shallow).`);
  }
  // Established, and no source drift: zero of every analysis signal (not unknown).
  const noDrift = { structured: { analysis: emptyAnalysis(), model: modelGapList } };
  const current = (reason: string): KnowledgeFreshness =>
    gapStages.size > 0
      ? { ...base, status: "REFRESH_RECOMMENDED", reason: modelReason, refreshPlan: plan(false, []), ...noDrift }
      : { ...base, status: "COMPLETE", reason, refreshPlan: none, ...noDrift };
  if (knowledgeHead === currentHead) return current("Knowledge was generated at the current HEAD.");

  // --relative: for a Project Root below the Git Root, report only files inside
  // the project, with paths relative to it (matching every recorded path and
  // `ls-tree`, which is already cwd-relative). A no-op at the Git Root.
  // NUL-delimited, unquoted (gitPaths): Hebrew, spaces, quotes and tabs arrive as the exact stored path.
  const diff = source.gitPaths(["diff", "-z", "--relative", "--name-only", "--no-renames", knowledgeHead, currentHead]);
  if (diff === null) return unknown("git diff between knowledgeHead and HEAD failed.");
  const changed = Array.from(new Set(diff))
    .filter((rel) => !isInspectorOwned(rel))
    .sort();
  if (changed.length === 0) return current("Only Inspector-owned artifacts changed since knowledge was generated.");

  // Analysis signals: a build/dependency/CI/surface-declaring manifest changed, a
  // file recorded as surface evidence changed, or a top-level entry appeared or
  // disappeared (the repository structure CLAUDE.md records).
  const topAt = (rev: string): Set<string> | null => {
    const names = source.gitPaths(["ls-tree", "-z", "--name-only", rev]);
    return names === null ? null : new Set(names);
  };
  const topBefore = topAt(knowledgeHead);
  const topNow = topAt(currentHead);
  // Evidence that cannot be read is never treated as "nothing changed".
  if (topBefore === null || topNow === null) return unknown("git ls-tree of knowledgeHead or HEAD failed.");
  const analysis = emptyAnalysis();
  const manifests = new Set<string>(), added = new Set<string>(), removed = new Set<string>();
  const signals = new Set<string>();
  for (const rel of changed) {
    if (isAnalysisManifest(rel)) {
      signals.add(`build/dependency manifest changed: ${rel}`);
      manifests.add(rel);
    }
    const top = rel.split("/")[0];
    if (!topBefore.has(top)) {
      signals.add(`top-level entry added: ${top}`);
      added.add(top);
    } else if (!topNow.has(top)) {
      signals.add(`top-level entry removed: ${top}`);
      removed.add(top);
    }
  }
  const attribution = attribute(source, changed);
  for (const rel of attribution.evidenceChanged) signals.add(`surface evidence changed: ${rel}`);
  const analysisSignals = Array.from(signals).sort();
  analysis.buildManifests = manifests.size;
  analysis.topLevelAdded = added.size;
  analysis.topLevelRemoved = removed.size;
  analysis.surfaceEvidence = attribution.evidenceChanged.length;
  analysis.surfaceEvidenceSurfaces = attribution.evidenceSurfaces;

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
    structured: { analysis, model: modelGapList },
  };
}

// --- freshness contract (Guardian, 0.13.0; ref + signals 0.14.0) ---

export const FRESHNESS_CONTRACT_VERSION = 1;

/** Stable analysis-signal kinds, in output order. Consumers ignore kinds they do not know. */
export const SIGNAL_KINDS = ["build-manifest-changed", "top-level-entry-added", "top-level-entry-removed", "surface-evidence-changed"] as const;

export interface FreshnessSignals {
  analysis: Array<{ kind: (typeof SIGNAL_KINDS)[number]; count: number; surfaces?: string[] }>;
  model: ModelGap[];
  refreshStages: string[];
  affected: { surfaces: string[]; capabilities: string[]; relationships: string[] };
}

/**
 * The stable, machine-readable freshness result (contractVersion 1).
 *
 *   status              COMPLETE            knowledge matches source at checkedHead
 *                       REFRESH_RECOMMENDED source changed since knowledgeHead (or the
 *                                           knowledge predates the current model)
 *                       BASELINE_UNKNOWN    cannot be established: no knowledgeHead,
 *                                           HEAD unreadable, history rewritten/shallow,
 *                                           a git command failed, unreadable state, or
 *                                           (with --ref) an unresolvable revision or an
 *                                           object that is not available locally
 *                       NOT_APPLICABLE      no completed inspection (none, or in progress)
 *   changedSourceCount  number of changed source files for COMPLETE (0) and
 *                       REFRESH_RECOMMENDED; null whenever it is not established
 *   checkedAt           ISO-8601 time this result was computed
 *   checkedHead         the commit the result describes (null if unreadable): the
 *                       checked-out HEAD, or with --ref the resolved commit
 *   knowledgeHead       the knowledge-authoring HEAD (null if not recorded)
 *   reason              human-readable explanation (not for parsing)
 *   signals             (additive, 0.14.0) the classification behind the status — see
 *                       FreshnessSignals; null whenever the status is not established
 *   ref                 (additive, 0.14.0; only with --ref) { requested, resolved }, resolved
 *                       = checkedHead, or null when the revision did not resolve
 *
 * Commit-based: uncommitted source edits are not considered. A stored COMPLETE is
 * only valid while checkedHead equals the current HEAD.
 */
export interface KnowledgeFreshnessContract {
  contractVersion: number;
  status: KnowledgeStatus;
  changedSourceCount: number | null;
  checkedAt: string;
  checkedHead: string | null;
  knowledgeHead: string | null;
  reason: string;
  signals: FreshnessSignals | null;
  ref?: { requested: string; resolved: string | null };
}

function publicSignals(k: KnowledgeFreshness): FreshnessSignals | null {
  if (!k.structured || (k.status !== "COMPLETE" && k.status !== "REFRESH_RECOMMENDED")) return null;
  const a = k.structured.analysis;
  return {
    analysis: [
      { kind: "build-manifest-changed", count: a.buildManifests },
      { kind: "top-level-entry-added", count: a.topLevelAdded },
      { kind: "top-level-entry-removed", count: a.topLevelRemoved },
      { kind: "surface-evidence-changed", count: a.surfaceEvidence, surfaces: a.surfaceEvidenceSurfaces },
    ],
    model: k.structured.model,
    refreshStages: k.refreshPlan.stages,
    affected: { surfaces: k.affectedSurfaces, capabilities: k.affectedCapabilities, relationships: k.affectedRelationships },
  };
}

function freshnessContract(
  state: InspectionState,
  repoRoot: string,
  stages: RegistryStage[],
  source: KnowledgeSource = worktreeSource(repoRoot)
): KnowledgeFreshnessContract {
  let k: KnowledgeFreshness;
  try {
    k = computeKnowledgeFreshness(state, repoRoot, stages, source);
  } catch (err) {
    // An unreadable document or object (KnowledgeUnavailable) or any other failure: never COMPLETE.
    return {
      contractVersion: FRESHNESS_CONTRACT_VERSION, status: "BASELINE_UNKNOWN", changedSourceCount: null, checkedAt: nowIso(),
      checkedHead: source.head, knowledgeHead: state.repository?.knowledgeHead ?? null,
      reason: `Freshness could not be computed: ${(err as Error).message}`, signals: null,
    };
  }
  const established = k.status === "COMPLETE" || k.status === "REFRESH_RECOMMENDED";
  return {
    contractVersion: FRESHNESS_CONTRACT_VERSION,
    status: k.status,
    changedSourceCount: established ? k.changedSourceCount : null,
    checkedAt: nowIso(),
    checkedHead: k.currentHead,
    knowledgeHead: k.knowledgeHead,
    reason: k.reason,
    signals: publicSignals(k),
  };
}

const STATE_REL = ".ono/state.json";

/** The contract for one exact commit (`freshness <root> --ref <rev>`). Never reads the working tree. */
function refFreshness(repoRoot: string, requested: string): KnowledgeFreshnessContract {
  const ref = { requested, resolved: null as string | null };
  const unknown = (reason: string, checkedHead: string | null = null): KnowledgeFreshnessContract => ({
    contractVersion: FRESHNESS_CONTRACT_VERSION, status: "BASELINE_UNKNOWN", changedSourceCount: null, checkedAt: nowIso(),
    checkedHead, knowledgeHead: null, reason, signals: null, ref: { ...ref, resolved: checkedHead },
  });
  const read = objectReadPolicy(repoRoot);
  if (!read.ok) return unknown(`Freshness at "${requested}" cannot be established without risking network access: ${read.reason}.`);
  // Resolved exactly once; every later read uses the commit id, never the requested name.
  const r = resolveRevision(repoRoot, requested, read.policy);
  if (!r.ok) return unknown(`Revision not resolved: ${r.reason}.`);
  let source: KnowledgeSource;
  let text: string | null;
  try {
    source = commitSource(repoRoot, r.commit, read.policy);
    text = source.read(STATE_REL);
  } catch (err) {
    return unknown(`Inspection state at ${r.commit.slice(0, 12)} could not be read: ${(err as Error).message}.`, r.commit);
  }
  if (text === null) {
    return {
      contractVersion: FRESHNESS_CONTRACT_VERSION, status: "NOT_APPLICABLE", changedSourceCount: null, checkedAt: nowIso(),
      checkedHead: r.commit, knowledgeHead: null, reason: `No inspection state (${STATE_REL}) in this project at ${r.commit.slice(0, 12)}.`,
      signals: null, ref: { requested, resolved: r.commit },
    };
  }
  let state: InspectionState | null = null;
  try {
    state = JSON.parse(text) as InspectionState;
  } catch {
    state = null;
  }
  if (!state || typeof state !== "object" || !state.inspection) {
    return unknown(`${STATE_REL} at ${r.commit.slice(0, 12)} is unreadable; freshness cannot be established.`, r.commit);
  }
  return { ...freshnessContract(state, repoRoot, loadInspectionStages(), source), ref: { requested, resolved: r.commit } };
}

/** Read-only: never writes, never refuses on a protected branch, always exits 0 with one JSON object. */
function cmdFreshness(repoRoot: string, ref: string | null): void {
  if (ref !== null) {
    console.log(JSON.stringify(refFreshness(repoRoot, ref), null, 2));
    process.exit(0);
  }
  const p = statePath(repoRoot);
  const head = currentGitHead(repoRoot);
  const base = { contractVersion: FRESHNESS_CONTRACT_VERSION, changedSourceCount: null, checkedAt: nowIso(), checkedHead: head, knowledgeHead: null, signals: null };
  let out: KnowledgeFreshnessContract;
  if (!existsSync(p)) {
    out = { ...base, status: "NOT_APPLICABLE", reason: "No inspection state (.ono/state.json) in this project." };
  } else {
    let state: InspectionState | null = null;
    try {
      state = JSON.parse(readFileSync(p, "utf-8")) as InspectionState;
    } catch {
      state = null;
    }
    out = state && typeof state === "object" && state.inspection
      ? freshnessContract(state, repoRoot, loadInspectionStages())
      : { ...base, status: "BASELINE_UNKNOWN", reason: ".ono/state.json is unreadable; freshness cannot be established." };
  }
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

/** `freshness <root> [--ref <rev> | --ref=<rev>]` arguments; anything else is a usage error. */
export function parseFreshnessArgs(rest: string[]): { ref: string | null } | { error: string } {
  let ref: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    let value: string | undefined;
    if (a === "--ref") {
      value = rest[i + 1];
      if (value === undefined) return { error: "--ref needs a revision" };
      i++;
    } else if (a.startsWith("--ref=")) value = a.slice("--ref=".length);
    else return { error: `unsupported argument ${JSON.stringify(a)}` };
    if (ref !== null) return { error: "--ref given more than once" };
    const bad = malformedRevision(value);
    if (bad) return { error: `invalid --ref: ${bad}` };
    ref = value;
  }
  return { ref };
}

// --- document headers (0.13.0) ---

interface StampResult { path: string; action: "stamped" | "unchanged" | "restored" | "skipped-no-baseline" | "error"; header?: string; reason?: string }

/** The body of `rel` as committed at HEAD (header stripped), or null if it has no committed version. */
function committedBody(repoRoot: string, rel: string): string | null {
  // `HEAD:./<rel>` resolves relative to the current directory, so a nested Project Root works.
  const out = (() => {
    try {
      return execFileSync("git", ["-c", "core.quotePath=false", "show", `HEAD:./${rel}`], { cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
    } catch {
      return null;
    }
  })();
  return out === null ? null : stripHeader(out);
}

/** The knowledge baseline a document's content reflects (see doc-header.ts). */
function knowledgeCommitFor(rel: string, state: InspectionState, stages: RegistryStage[], repoRoot: string): string {
  if (rel.startsWith("audits/")) return shortCommit(currentGitHead(repoRoot));
  const producer = stages.find((st) => st.sourceBacked && st.produces.includes(rel));
  return shortCommit(producer ? state.stages[producer.id]?.knowledgeHead : null);
}

function cmdStampDocs(repoRoot: string, rels: string[]): void {
  if (rels.length === 0) {
    console.error("Usage: inspection-state.ts stamp-docs <repo-root> <relpath>...");
    process.exit(1);
  }
  const stages = loadInspectionStages();
  const produced = stages.flatMap((st) => st.produces);
  let state = readState(repoRoot) ?? freshState(null);
  state = migrateState(state);
  const version = currentPluginVersion().version;
  const records: Record<string, DocumentRecord> = { ...(state.documents ?? {}) };
  const writes: Array<{ path: string; text: string }> = [];
  const results: StampResult[] = [];

  for (const raw of rels) {
    const rel = raw.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!isStampable(rel, produced)) { results.push({ path: rel, action: "error", reason: "not an Inspector-generated document; never stamped" }); continue; }
    const abs = join(repoRoot, rel);
    if (!existsSync(abs)) { results.push({ path: rel, action: "error", reason: "file not found" }); continue; }
    const text = readFileSync(abs, "utf-8");
    const body = stripHeader(text);
    const record = records[rel];
    const inFile = findHeader(text);
    // Changed in this workflow? Against the recorded body when there is one, otherwise
    // against the committed version (a new or uncommitted document counts as changed).
    // Both comparisons ignore line endings (0.14.0): a CRLF checkout of an unchanged
    // document is unchanged, and keeps its header date.
    const committed = record ? null : committedBody(repoRoot, rel);
    const changed = record ? !bodyHashMatches(record.bodySha256, body) : committed === null || toLf(committed) !== toLf(body);
    let header: Header;
    if (changed) {
      header = { version, knowledgeCommit: knowledgeCommitFor(rel, state, stages, repoRoot), updated: todayUtc() };
    } else if (record) {
      header = { version: record.version, knowledgeCommit: record.knowledgeCommit, updated: record.updated };
    } else if (inFile) {
      header = inFile; // unchanged, header already present: keep it as written
    } else {
      // Unchanged and never stamped (written by an older version): no backfill, no invented date.
      results.push({ path: rel, action: "skipped-no-baseline", reason: "unchanged since its last commit and never stamped; headers are added when the document is next regenerated" });
      continue;
    }
    const next = insertHeader(body, header);
    // An unchanged document that needs no rewrite keeps its record exactly as stored: no
    // state churn just to re-encode a legacy hash. Every record written is canonical.
    if (changed || !record || next !== text) records[rel] = { ...header, bodySha256: bodyHash(stripHeader(next)) };
    const line = `Generated by ono-project-inspector ${header.version} · knowledge at ${header.knowledgeCommit} · updated ${header.updated}`;
    if (next === text) { results.push({ path: rel, action: "unchanged", header: line }); continue; }
    writes.push({ path: abs, text: next });
    results.push({ path: rel, action: changed ? "stamped" : "restored", header: line });
  }

  const errors = results.filter((r) => r.action === "error");
  // Nothing to change (every document already carries its correct header): write nothing at
  // all — neither the documents nor state.json — so a repeated stamp causes no churn.
  const recordsChanged = JSON.stringify(records) !== JSON.stringify(state.documents ?? {});
  if (errors.length === 0 && (writes.length > 0 || recordsChanged)) {
    // All or nothing: refuse on a protected branch before the first document write.
    assertWritable(repoRoot, "inspection-state stamp-docs");
    for (const w of writes) writeFileSync(w.path, w.text, "utf-8");
    state.documents = records;
    writeState(repoRoot, state);
  }
  console.log(JSON.stringify({ ok: errors.length === 0, results }, null, 2));
  process.exit(errors.length === 0 ? 0 : 1);
}

// --- audit approval baseline and re-check (0.13.0) ---

const RESULTS = ["still-open", "fixed", "changed"] as const;
const MAX_EVIDENCE = 600;
const MAX_HISTORY = 50;

/** Record the HEAD a human approved a topic at. Idempotent; never overwrites an existing approval. */
function cmdRecordApproval(repoRoot: string, topic: string): void {
  const row = findRow(repoRoot, topic);
  if (!row) { console.error(`No AUDIT.md topic or audit file matches "${topic}".`); process.exit(1); }
  if (row.status !== "Approved") { console.error(`Topic "${row.topic}" is ${row.status}; record-approval runs only after a human approval.`); process.exit(1); }
  const head = currentGitHead(repoRoot);
  if (!head) { console.error("Cannot determine git HEAD; the approval baseline is not recorded (never guessed)."); process.exit(1); }
  let state = readState(repoRoot) ?? freshState(null);
  state = migrateState(state);
  state.audits = state.audits ?? {};
  const existing = state.audits[row.file];
  if (existing?.approval?.head) {
    console.log(JSON.stringify({ ok: true, auditFile: row.file, approvalHead: existing.approval.head, note: "approval baseline already recorded; unchanged" }, null, 2));
    process.exit(0);
  }
  // Only a NEW Draft -> Approved transition made through the workflow gets a baseline.
  // Evidence 1: the Inspector's own last recorded status for this topic is Draft (the sync
  //   after audit-breakdown records it; the sync after approval has not run yet).
  // Evidence 2: the committed AUDIT.md does not already show the topic Approved.
  // A topic approved earlier (recorded or committed as Approved) keeps "baseline unknown":
  // its approval commit is never inferred. AUDIT.md content alone is never evidence.
  const recorded = (state.topics ?? []).find((t) => t.file === row.file) ?? (state.topics ?? []).find((t) => t.topic.toLowerCase() === row.topic.toLowerCase());
  const committedAudit = (() => {
    try {
      return execFileSync("git", ["-c", "core.quotePath=false", "show", "HEAD:./AUDIT.md"], { cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return null;
    }
  })();
  const committedApproved = committedAudit !== null && committedAudit.split("\n").some((l) => {
    const c = l.split("|").slice(1, -1).map((x) => x.trim());
    return c.length >= 6 && c[1] === "Approved" && (c[4] === row.file || c[2].toLowerCase() === row.topic.toLowerCase());
  });
  const refuse = (why: string) => {
    console.error(`Not recorded: ${why} The topic keeps "baseline unknown" — its first re-check is a full one. No approval commit is inferred.`);
    process.exit(1);
  };
  if (!recorded) refuse(`the Inspector never recorded "${row.topic}" as a Draft, so this is not an approval transition it can attest.`);
  if (recorded!.status !== "Draft") refuse(`the Inspector last recorded "${row.topic}" as ${recorded!.status}, not Draft — it was approved earlier.`);
  if (committedApproved) refuse(`"${row.topic}" is already Approved in the committed AUDIT.md — it was approved earlier.`);
  state.audits[row.file] = { ...(existing ?? {}), topic: row.topic, approval: { head, recordedAt: nowIso(), baseline: "recorded" } };
  writeState(repoRoot, state);
  console.log(JSON.stringify({ ok: true, auditFile: row.file, approvalHead: head }, null, 2));
  process.exit(0);
}

/**
 * The 0.13.0 record of a finding's legacy id, when it provably describes this finding: the
 * stored heading and cited files are the ones 0.13.0 derived for it, no other finding was ever
 * recorded under the same identity with an occurrence suffix, and no current record has already
 * claimed it. Anything less is ambiguous and nothing is carried (the record stays where it is).
 */
function legacyRecord(findings: Record<string, any>, f: { heading: string; legacyId?: string; legacyFiles?: string[] }): any {
  if (!f.legacyId || !f.legacyFiles) return undefined;
  const rec = findings[f.legacyId];
  if (!rec || typeof rec !== "object") return undefined;
  const norm = (h: unknown) => String(h ?? "").replace(/\s+/g, " ").trim();
  if (norm(rec.heading) !== norm(f.heading)) return undefined;
  if (Array.isArray(rec.files) && JSON.stringify([...rec.files].sort()) !== JSON.stringify([...f.legacyFiles].sort())) return undefined;
  const base = f.legacyId.replace(/-\d+$/, "");
  if (Object.keys(findings).some((id) => id !== f.legacyId && (id === base || id.startsWith(`${base}-`)))) return undefined;
  if (Object.values(findings).some((v: any) => v?.legacyId === f.legacyId)) return undefined;
  return rec;
}

/**
 * Record re-verification results. The scope is recomputed here and must still describe
 * HEAD; only its affected findings accept results. verifiedHead advances only when EVERY
 * affected finding has a result — a partial run records what it has and leaves the
 * baseline where it was, so the next re-check covers the rest again.
 */
function cmdRecordRecheck(repoRoot: string, topic: string, source: string): void {
  let input: any;
  try {
    input = JSON.parse(source === "-" ? readFileSync(0, "utf-8") : readFileSync(source, "utf-8"));
  } catch (err) {
    console.error(`Results are not valid JSON: ${(err as Error).message}`);
    process.exit(1);
  }
  let scope;
  try {
    scope = computeScope(repoRoot, topic);
  } catch (err) {
    console.error(err instanceof RecheckError ? err.message : `Scope failed: ${(err as Error).message}`);
    process.exit(1);
  }
  const errors: string[] = [];
  if (input?.scopeHead !== scope.head) errors.push(`scopeHead ${String(input?.scopeHead).slice(0, 12)} is not the current HEAD ${scope.head.slice(0, 12)}; run the scope again`);
  const byId = new Map(scope.findings.map((f) => [f.id, f]));
  const results: any[] = Array.isArray(input?.results) ? input.results : [];
  if (!Array.isArray(input?.results)) errors.push("results must be an array");
  const accepted = new Map<string, any>();
  for (const r of results) {
    const f = byId.get(r?.id);
    if (!f) { errors.push(`unknown finding id ${JSON.stringify(r?.id)}`); continue; }
    if (f.scope === "cannot-scope") { errors.push(`${f.id} cannot be scoped — manual review only, no AI result is recorded`); continue; }
    if (f.scope !== "affected") { errors.push(`${f.id} is not in scope (no cited file changed)`); continue; }
    if (!RESULTS.includes(r.result)) { errors.push(`${f.id}: result must be one of ${RESULTS.join(", ")}`); continue; }
    if (typeof r.evidence !== "string" || r.evidence.trim().length === 0) { errors.push(`${f.id}: evidence is required (what the current code shows)`); continue; }
    if (accepted.has(f.id)) { errors.push(`${f.id}: more than one result`); continue; }
    const paths = [...f.files, ...f.changes.filter((c) => c.to).map((c) => c.to as string)];
    if (r.fixCommit !== undefined) {
      if (r.result !== "fixed") { errors.push(`${f.id}: fixCommit is only valid for a fixed finding`); continue; }
      if (typeof r.fixCommitEvidence !== "string" || !r.fixCommitEvidence.trim()) { errors.push(`${f.id}: fixCommit needs fixCommitEvidence`); continue; }
      if (!commitTouches(repoRoot, scope.baseline.head, String(r.fixCommit), paths)) { errors.push(`${f.id}: fixCommit ${String(r.fixCommit).slice(0, 12)} is not a commit since the baseline that touches the cited files`); continue; }
    }
    accepted.set(f.id, { ...r, paths });
  }
  if (errors.length) {
    console.log(JSON.stringify({ ok: false, recorded: false, errors }, null, 2));
    process.exit(1);
  }

  let state = readState(repoRoot) ?? freshState(null);
  state = migrateState(state);
  state.audits = state.audits ?? {};
  const rec: TopicRecord = state.audits[scope.auditFile] ?? { topic: scope.topic };
  const approvalBefore = JSON.stringify(rec.approval ?? null);
  const ver = rec.verification ?? { verifiedHead: null, verifiedAt: null, findings: {}, history: [] };
  const at = nowIso();
  const affected = scope.findings.filter((f) => f.scope === "affected");
  const missing = affected.filter((f) => !accepted.has(f.id)).map((f) => f.id);
  for (const f of scope.findings) {
    const r = accepted.get(f.id);
    // 0.14.0: a record 0.13.0 stored under this finding's legacy (CRLF-parsed) id is carried
    // forward under the current id — its sticky human-review requirement included. The legacy
    // record itself is never modified or removed, and stays the record of last resort.
    const carried = ver.findings[f.id] === undefined ? legacyRecord(ver.findings, f) : undefined;
    const prev = ver.findings[f.id] ?? carried;
    // Once carried, the link is kept on every later write, so the legacy record stays superseded.
    const legacyId = carried ? f.legacyId : prev?.legacyId;
    const base = { heading: f.heading, severity: f.severity, files: f.files, ...(legacyId ? { legacyId } : {}) };
    if (r) {
      const candidate = r.result === "fixed" ? candidateCommit(repoRoot, scope.baseline.head, r.paths) : null;
      ver.findings[f.id] = {
        ...base,
        result: r.result,
        evidence: String(r.evidence).trim().slice(0, MAX_EVIDENCE),
        changes: f.changes,
        // The last commit that touched the cited files — a candidate, never presented as confirmed.
        candidateFixCommit: candidate,
        confirmedFixCommit: r.fixCommit !== undefined ? String(r.fixCommit) : null,
        confirmedFixEvidence: r.fixCommit !== undefined ? String(r.fixCommitEvidence).trim().slice(0, MAX_EVIDENCE) : null,
        // Sticky: once a finding needs human review, no later AI result clears it. Clearing it
        // needs an explicit human-review step, which 0.13.0 does not have.
        needsHumanReview: r.result === "changed" || prev?.needsHumanReview === true,
        humanReviewRequiredSince: prev?.humanReviewRequiredSince ?? (r.result === "changed" ? at : null),
        verifiedAt: at,
        verifiedHead: scope.head,
        source: "ai-reverification",
      };
    } else if (f.scope === "cannot-scope") {
      ver.findings[f.id] = { ...(prev ?? {}), ...base, result: "cannot-scope", needsHumanReview: true, humanReviewRequiredSince: prev?.humanReviewRequiredSince ?? at, note: "no usable file reference — manual review" };
    } else if (f.scope === "affected") {
      // In scope but not verified in this run: stays pending; the baseline does not advance.
      ver.findings[f.id] = { ...(prev ?? { result: "open" }), ...base, pendingSince: prev?.pendingSince ?? at };
    } else if (!prev) {
      ver.findings[f.id] = { ...base, result: "open", note: "as approved; no cited file changed since the baseline" };
    } else if (carried) {
      ver.findings[f.id] = { ...carried, ...base };
    }
  }
  const complete = missing.length === 0;
  if (complete) {
    ver.verifiedHead = scope.head;
    ver.verifiedAt = at;
    for (const f of affected) delete ver.findings[f.id].pendingSince;
  }
  const count = (res: string) => affected.filter((f) => accepted.get(f.id)?.result === res).length;
  ver.history = [
    ...(ver.history ?? []),
    {
      at, head: scope.head, baseline: scope.baseline.head, baselineLabel: scope.baseline.label, mode: scope.mode, complete,
      counts: { stillOpen: count("still-open"), fixed: count("fixed"), changed: count("changed"), pending: missing.length, unaffected: scope.counts.unaffected, cannotScope: scope.counts.cannotScope },
    },
  ].slice(-MAX_HISTORY);
  rec.verification = ver;
  rec.topic = scope.topic;
  if (JSON.stringify(rec.approval ?? null) !== approvalBefore) { console.error("internal: approval record changed"); process.exit(1); }
  state.audits[scope.auditFile] = rec;
  writeState(repoRoot, state);
  const superseded = new Set(Object.values(ver.findings).map((v: any) => v?.legacyId).filter((x): x is string => typeof x === "string"));
  console.log(JSON.stringify({
    ok: true, recorded: true, complete, auditFile: scope.auditFile, mode: scope.mode, baseline: scope.baseline.label,
    verifiedHead: ver.verifiedHead, verifiedAt: ver.verifiedAt, pending: missing,
    needsHumanReview: Object.entries(ver.findings).filter(([id, v]: any) => v.needsHumanReview && !superseded.has(id)).map(([id]) => id).sort(),
    note: "AI re-verification only — the topic's human approval is unchanged.",
  }, null, 2));
  process.exit(complete ? 0 : 3);
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
        knowledge: (({ structured, ...k }) => k)(computeKnowledgeFreshness(state, repoRoot, loadInspectionStages())),
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
    console.error("Usage: inspection-state.ts <detect|freshness|init|sync|set-stage|record-knowledge|migrate|stamp-docs|record-approval|record-recheck> <repo-root> [args...]");
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
  // Protected-branch backstop (0.11.3): every command except the read-only
  // `detect` writes state.json, so refuse before the first mutation while the
  // repository is on main, master or a detached HEAD. No flag bypasses this.
  if (command !== "detect" && command !== "freshness") guardWrite(repoRoot, `inspection-state ${command}`);
  switch (command) {
    case "detect":
      return cmdDetect(repoRoot);
    case "freshness": {
      const parsed = parseFreshnessArgs(rest);
      if ("error" in parsed) {
        console.error(`Usage: inspection-state.ts freshness <repo-root> [--ref <rev>] — ${parsed.error}.`);
        process.exit(1);
      }
      return cmdFreshness(repoRoot, parsed.ref);
    }
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
    case "stamp-docs":
      return cmdStampDocs(repoRoot, rest);
    case "record-approval":
      if (!rest[0]) { console.error("Usage: inspection-state.ts record-approval <repo-root> <topic>"); process.exit(1); }
      return cmdRecordApproval(repoRoot, rest[0]);
    case "record-recheck":
      if (!rest[0] || !rest[1]) { console.error("Usage: inspection-state.ts record-recheck <repo-root> <topic> <results.json|->"); process.exit(1); }
      return cmdRecordRecheck(repoRoot, rest[0], rest[1]);
    default:
      console.error(`Unknown command "${command}".`);
      process.exit(1);
  }
}

if (isEntryPoint(import.meta.url)) {
  useBlockingOutput();
  main();
}
