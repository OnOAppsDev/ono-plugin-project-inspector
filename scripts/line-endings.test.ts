/**
 * line-endings.test.ts — CRLF Markdown (0.14.0).
 *
 * Regression for the Windows defect: with Git for Windows' default core.autocrlf=true the
 * Inspector's committed Markdown is checked out with CRLF, and every parser that split on
 * "\n" and matched `(.*)$` lost every heading — the evidence gate failed with
 * `surfaces-missing`, freshness reported false model gaps, and the manifest was silently
 * emptied. Every case runs on real CRLF bytes written at test time (never committed here,
 * so the plugin's .gitattributes cannot hide them) and on a real core.autocrlf=true clone
 * of an origin with LF blobs and no .gitattributes.
 *
 *   LE1  fixtures prove themselves: CRLF bytes on disk, LF blobs, clean status, local config only
 *   LE2  the knowledge model parses LF, CRLF and mixed text identically (6 surfaces, 3 Shared Code)
 *   LE3  evidence gate: positive (surfaces/docs/all) and negative cases on CRLF and on the clone
 *   LE4  model gaps, freshness, record-knowledge and drift attribution on the clone
 *   LE5  manifest: canonical sha256-lf, equivalence across checkouts, legacy + unknown markers
 *   LE6  commands fallback, AUDIT.md tables, update-audit-index, record-approval on CRLF
 *   LE7  audit findings: identical ids, unbackticked File lines, legacy ids, recheck scope
 *   LE8  refresh guard: line-ending-only rewrites pass, real changes still fail
 *   LE9  Hebrew evidence paths in a CRLF checkout
 *   LE10 the same CRLF repository under the released 0.13.0 helpers fails exactly as reported
 *
 * Run with: node --no-warnings scripts/line-endings.test.ts
 */

import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
import {
  APP_SHARED, APP_SOURCE, APP_SURFACES, claudeMd, surfacesSection, write, writeApp, type SharedRow, type SurfaceRow,
} from "./fixtures/knowledge-fixtures.ts";
import { commitOrigin, crlf, employeeClone, eolCounts, gitEol, lf, lfClone, rewriteEol } from "./fixtures/line-endings.ts";
import { extractRelease, helper } from "./fixtures/inspected.ts";
import {
  directBody, headingIndex, inventoryTables, parseCapabilityMap, parseInventory, parseSurfaceModel, surfaceAnchors,
} from "./knowledge-model.ts";
import { extractCommandsFromProse, buildManifest, validateManifest } from "./repo-knowledge.ts";
import { parseFindings } from "./audit-recheck.ts";
import { parseManagedBlocks, parseTopicRows } from "./knowledge-refresh-guard.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ""}`); }
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "inspector-eol-")));
const sha = (t: string | Buffer) => createHash("sha256").update(t).digest("hex");
const run = (dir: string, script: string, ...args: string[]) => helper(dir, script, ...args);
const WORK = "task/inspect-refresh";
const REL_0130 = "3ef4cd1771b57fd969ff2b78e95f33931a9fcea5";

// --- the employee-shaped fixture: six surfaces, three Shared Code rows, Hebrew evidence -----------
const EXTRA_SOURCE: Record<string, string> = {
  "platforms/webos/appinfo.json": '{ "id": "com.demo.tv", "type": "web" }\n',
  "platforms/androidtv/AndroidManifest.xml": '<manifest><uses-feature android:name="android.software.leanback"/></manifest>\n',
  "platforms/firetv/AndroidManifest.xml": '<manifest><uses-feature android:name="amazon.hardware.fire_tv"/></manifest>\n',
  "platforms/טלוויזיה/manifest.json": '{ "vidaa": "הדגמה" }\n',
  "src/shared/player.ts": "export const sharedPlayer = 1;\n",
  "src/shared/focus.ts": "export const sharedFocus = 1;\n",
};
const SURFACES: SurfaceRow[] = [
  ...APP_SURFACES,
  { id: "webos", platform: "LG webOS", formFactor: "tv", buildSelector: "Unknown", sourceRoots: ["platforms/webos/"], sharedWith: ["tizen"], packaging: "ipk", minimum: "Unknown", evidence: ['platforms/webos/appinfo.json::"type": "web"'] },
  { id: "androidtv", platform: "Android TV", formFactor: "tv", buildSelector: "Unknown", sourceRoots: ["platforms/androidtv/"], sharedWith: ["firetv"], packaging: "apk", minimum: "Unknown", evidence: ["platforms/androidtv/AndroidManifest.xml::android.software.leanback"] },
  { id: "firetv", platform: "Fire TV", formFactor: "tv", buildSelector: "Unknown", sourceRoots: ["platforms/firetv/"], sharedWith: ["androidtv"], packaging: "apk", minimum: "Unknown", evidence: ["platforms/firetv/AndroidManifest.xml::amazon.hardware.fire_tv"] },
  { id: "vidaa", platform: "VIDAA", formFactor: "tv", buildSelector: "Unknown", sourceRoots: ["platforms/טלוויזיה/"], sharedWith: [], packaging: "zip", minimum: "Unknown", evidence: ["platforms/טלוויזיה/manifest.json::הדגמה"] },
];
const SHARED: SharedRow[] = [
  ...APP_SHARED,
  { root: "src/shared/", sharedBy: ["webos", "androidtv", "firetv"], mechanism: "module import", evidence: ["src/shared/player.ts::sharedPlayer"] },
  { root: "src/tv/", sharedBy: ["tizen", "webos"], mechanism: "module import", evidence: ["src/tv/FocusRow.tsx::FocusRow"] },
];
const CAUTION = "\n<!-- audit-sync:caution-areas:start -->\n- [HIGH] Shared state (Architecture).\n<!-- audit-sync:caution-areas:end -->\n";
const AUDIT_MD = `# AUDIT.md

## Audit Topics

| # | Status | Topic | Priority | File | Notes |
|---|---|---|---|---|---|
| 1 | Approved | Architecture | High | audits/architecture/architecture-audit.md | Approved 2026-11-01 |
| 2 | Draft | Player / Media | High | audits/player-media/player-media-audit.md | |
`;
const ARCH_AUDIT = `# Architecture Audit

## Findings

### [HIGH] Shared state mutated from the player

- **File:** \`src/store/guideStore.ts\`, \`src/legacy/removed.ts\`
- The player writes guide state directly.

### [MEDIUM] Unbackticked file list

- **File:** src/tv/FocusRow.tsx, src/services/PlaybackService.ts
- Focus handling.

### [LOW] Cites a file that exists nowhere

- **File:** \`src/old/gone.ts\`

## Risks

None.
`;
const MARKDOWN = ["CLAUDE.md", "AUDIT.md", "docs/project/overview.md", "docs/project/components.md", "docs/project/patterns.md", "docs/project/integrations.md", "docs/project/capabilities.md", "audits/architecture/architecture-audit.md"];

/** The full LF tree: source + knowledge with six surfaces, three Shared Code rows, AUDIT.md, one audit. */
function writeTree(dir: string): void {
  writeApp(dir, { source: { ...APP_SOURCE, ...EXTRA_SOURCE } });
  write(dir, "CLAUDE.md", claudeMd(surfacesSection(SURFACES, SHARED), "React web, Tizen") + CAUTION);
  write(dir, "AUDIT.md", AUDIT_MD);
  write(dir, "audits/architecture/architecture-audit.md", ARCH_AUDIT);
  write(dir, "audits/player-media/player-media-audit.md", "# Player / Media Audit\n\n## Findings\n\nNone.\n");
}

const evidenceCodes = (r: { json: any }) => (r.json?.errors ?? []).map((e: any) => e.code).sort().join(",");

/** A fully inspected state for `dir` at its HEAD (both source-backed stages, inspection complete). */
function writeState(dir: string, head: string): void {
  const st = { status: "complete", completedAt: "2026-11-01T00:00:00.000Z", knowledgeHead: head, knowledgeRegeneratedAt: "2026-11-01T00:00:00.000Z" };
  const s = {
    stateSchemaVersion: 1, plugin: { name: "ono-project-inspector", version: "0.13.0" },
    repository: { gitRemote: null, gitHead: head, knowledgeHead: head }, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
    inspection: { started: true, completedStages: ["project-analysis", "project-docs", "audit-breakdown", "audit-approve"], currentStage: null, stage3Complete: true },
    stages: { "project-analysis": st, "project-docs": st, "audit-breakdown": { status: "complete", completedAt: null }, "audit-approve": { status: "complete", completedAt: null } },
    topics: [], counts: { pendingBreakdown: 0, draft: 0, approved: 1, total: 1 },
    resume: { nextAction: "stage3-complete", topic: null, hint: "" }, maintenance: { lastSyncAt: null }, migrations: { history: [] },
  };
  mkdirSync(join(dir, ".ono"), { recursive: true });
  writeFileSync(join(dir, ".ono", "state.json"), JSON.stringify(s, null, 2) + "\n");
}

try {
  // ----------------------------------------------------------------------------------------------
  const origin = join(root, "origin");
  writeTree(origin);
  commitOrigin(origin, "dev");
  const lfDir = join(root, "lf");
  lfClone(origin, lfDir);
  gitEol(lfDir, "false", "switch", "-q", "-c", WORK);
  const emp = employeeClone(origin, join(root, "employee"), "CLAUDE.md", WORK);
  const crlfDir = emp.dir;

  // --- LE1 --------------------------------------------------------------------------------------
  check("LE1 the clone's working tree really has CRLF bytes", emp.crlfInWorktree);
  check("LE1 ...while the committed blob is LF", emp.lfInBlob);
  check("LE1 ...the status is clean (Git itself produced the CRLF)", emp.clean);
  check("LE1 ...and autocrlf=true comes from the clone's own config, with no .gitattributes", emp.localAutocrlf === "true" && gitEol(crlfDir, "true", "ls-files", ".gitattributes") === "");
  const allCrlf = MARKDOWN.every((rel) => { const c = eolCounts(join(crlfDir, rel)); return c.crlf > 0 && c.bareLf === 0; });
  check("LE1 every Markdown artifact in the clone is uniformly CRLF", allCrlf);
  check("LE1 the LF checkout has no CR at all", MARKDOWN.every((rel) => eolCounts(join(lfDir, rel)).crlf === 0));

  // --- LE2 --------------------------------------------------------------------------------------
  {
    const claude = readFileSync(join(lfDir, "CLAUDE.md"), "utf-8");
    const caps = readFileSync(join(lfDir, "docs/project/capabilities.md"), "utf-8");
    const pats = readFileSync(join(lfDir, "docs/project/patterns.md"), "utf-8");
    const comps = readFileSync(join(lfDir, "docs/project/components.md"), "utf-8");
    // Mixed: alternate lines CRLF / LF.
    const mixed = (t: string) => t.split("\n").map((l, i) => (i % 2 ? l + "\r" : l)).join("\n").replace(/\r$/, "");
    const model = (c: string, k: string, p: string, m: string) => JSON.stringify({
      s: parseSurfaceModel(c), k: parseCapabilityMap(k), h: headingIndex(p), a: surfaceAnchors(p, ["web", "tizen"]), i: parseInventory(m), t: inventoryTables(m),
      d: directBody(p, headingIndex(p).find((h) => h.text === "Input and Interaction")!),
    });
    const ref = model(claude, caps, pats, comps);
    const sm = parseSurfaceModel(claude);
    check("LE2 LF baseline: 6 surfaces, 3 Shared Code rows, 9 evidence refs", sm.surfaces.length === 6 && sm.sharedCode.length === 3 && sm.surfaces.flatMap((s) => s.evidence).length + sm.sharedCode.flatMap((c) => c.evidence).length === 9, JSON.stringify(sm.issues));
    check("LE2 CRLF text parses to the identical model", model(crlf(claude), crlf(caps), crlf(pats), crlf(comps)) === ref);
    check("LE2 mixed-ending text parses to the identical model", model(mixed(claude), mixed(caps), mixed(pats), mixed(comps)) === ref);
    check("LE2 a UTF-8 BOM before the H1 changes nothing", model("﻿" + crlf(claude), caps, "﻿" + pats, comps) === ref);
    check("LE2 headings: 0.13.0 found none in CRLF text; now all of them", headingIndex(crlf(claude)).length === headingIndex(claude).length && headingIndex(claude).length >= 7);
  }

  // --- LE3 --------------------------------------------------------------------------------------
  for (const scope of ["surfaces", "docs", "all"]) {
    const a = run(lfDir, "knowledge-evidence.ts", "verify", lfDir, scope);
    const b = run(crlfDir, "knowledge-evidence.ts", "verify", crlfDir, scope);
    check(`LE3 evidence gate (${scope}) passes on LF`, a.code === 0, a.stdout);
    check(`LE3 evidence gate (${scope}) passes on the autocrlf checkout`, b.code === 0, b.stdout.slice(0, 400));
  }
  {
    // Negative: a genuinely unresolvable token is still caught on CRLF (the pass is not vacuous).
    const neg = join(root, "negative");
    writeTree(neg);
    write(neg, "CLAUDE.md", crlf(readFileSync(join(neg, "CLAUDE.md"), "utf-8").replace("android.software.leanback", "android.software.NOPE")));
    for (const rel of MARKDOWN.slice(1)) rewriteEol(neg, rel, "crlf");
    const r = run(neg, "knowledge-evidence.ts", "verify", neg, "surfaces");
    check("LE3 negative: a missing evidence token on CRLF fails with evidence-unresolved, not surfaces-missing", r.code === 3 && evidenceCodes(r) === "evidence-unresolved", evidenceCodes(r));
    write(neg, "CLAUDE.md", crlf(claudeMd("", "x")));
    const m = run(neg, "knowledge-evidence.ts", "verify", neg, "surfaces");
    check("LE3 negative: a CRLF CLAUDE.md that really lacks the section still fails surfaces-missing", m.code === 3 && evidenceCodes(m).includes("surfaces-missing"));
  }

  // --- LE4 --------------------------------------------------------------------------------------
  {
    const head = gitEol(crlfDir, "true", "rev-parse", "HEAD");
    for (const d of [lfDir, crlfDir]) writeState(d, head);
    const fl = run(lfDir, "inspection-state.ts", "freshness", lfDir).json;
    const fc = run(crlfDir, "inspection-state.ts", "freshness", crlfDir).json;
    check("LE4 knowledgeHead == HEAD: COMPLETE on LF", fl?.status === "COMPLETE", JSON.stringify(fl));
    check("LE4 knowledgeHead == HEAD: COMPLETE on the autocrlf checkout (no false REFRESH_RECOMMENDED)", fc?.status === "COMPLETE" && fc?.changedSourceCount === 0, fc?.reason);
    const dc = run(crlfDir, "inspection-state.ts", "detect", crlfDir).json?.knowledge;
    check("LE4 detect reports no model gaps on CRLF", dc?.refreshPlan?.modelSignals?.length === 0 && dc?.refreshPlan?.stages?.length === 0, JSON.stringify(dc?.refreshPlan));
    const rk = run(crlfDir, "inspection-state.ts", "record-knowledge", crlfDir, "project-analysis");
    check("LE4 record-knowledge certifies the CRLF project-analysis output", rk.code === 0, rk.stderr);
    writeState(crlfDir, head);

    // Drift on a surface-evidence file: identical analysis signals and attribution.
    for (const d of [lfDir, crlfDir]) {
      writeFileSync(join(d, "vite.config.ts"), "export default { base: './' };\n");
      gitEol(d, d === crlfDir ? "true" : "false", "commit", "-q", "-am", "source change");
    }
    const kl = run(lfDir, "inspection-state.ts", "detect", lfDir).json?.knowledge;
    const kc = run(crlfDir, "inspection-state.ts", "detect", crlfDir).json?.knowledge;
    const pick = (k: any) => JSON.stringify({ s: k?.status, a: k?.refreshPlan?.analysisSignals, m: k?.refreshPlan?.modelSignals, st: k?.refreshPlan?.stages, as: k?.affectedSurfaces, ac: k?.affectedCapabilities });
    check("LE4 drift: CRLF analysis signals and attribution equal LF's", pick(kl) === pick(kc), `${pick(kl)} vs ${pick(kc)}`);
    check("LE4 drift: the surface-evidence signal and its surface are reported", kc?.refreshPlan?.analysisSignals?.includes("surface evidence changed: vite.config.ts") && kc?.affectedSurfaces?.includes("web"), JSON.stringify(kc?.refreshPlan));
    const sl = run(lfDir, "inspection-state.ts", "freshness", lfDir).json?.signals;
    const sc = run(crlfDir, "inspection-state.ts", "freshness", crlfDir).json?.signals;
    check("LE4 drift: public signals identical on both checkouts", JSON.stringify(sl) === JSON.stringify(sc) && sc?.analysis?.find((x: any) => x.kind === "surface-evidence-changed")?.count === 1, JSON.stringify(sc));
    for (const d of [lfDir, crlfDir]) {
      gitEol(d, d === crlfDir ? "true" : "false", "reset", "-q", "--hard", "HEAD~1");
      rmSync(join(d, ".ono"), { recursive: true, force: true });
    }
  }

  // --- LE5 --------------------------------------------------------------------------------------
  {
    const ml = buildManifest(lfDir);
    const mc = buildManifest(crlfDir);
    const strip = (m: any) => { const c = JSON.parse(JSON.stringify(m)); delete c.generatedAt; delete c.fingerprint.gitHead; return JSON.stringify(c); };
    check("LE5 the CRLF manifest equals the LF manifest (artifacts included)", strip(ml) === strip(mc));
    // The shared fixture's CLAUDE.md has no commands block, so `commands` is unknown on LF as well.
    check("LE5 the CRLF manifest is fully populated (6 surfaces, 3 shared, capabilities; every category but commands)", mc.surfaces?.length === 6 && mc.sharedCode?.length === 3 && (mc.capabilities?.length ?? 0) > 0 && Object.entries(mc.coverage).every(([k, v]) => k === "commands" || v === "populated"), JSON.stringify(mc.coverage));
    check("LE5 the hash algorithm is declared: sha256-lf", mc.fingerprint.artifactHash === "sha256-lf");
    const blobOk = Object.entries(mc.fingerprint.artifacts).every(([rel, h]) => h === sha(execFileSync("git", ["cat-file", "blob", `HEAD:${rel}`], { cwd: crlfDir })));
    check("LE5 every canonical hash equals the SHA-256 of the committed (LF) blob", blobOk);
    const rawLf = Object.entries(ml.fingerprint.artifacts).every(([rel, h]) => h === sha(readFileSync(join(lfDir, rel))));
    check("LE5 on an LF checkout the canonical hash is the legacy raw hash (0.13.0 manifests unchanged)", rawLf);
    check("LE5 the legacy raw hash of a CRLF file differs (why the marker exists)", sha(readFileSync(join(crlfDir, "CLAUDE.md"))) !== mc.fingerprint.artifacts["CLAUDE.md"]);
    writeFileSync(join(crlfDir, "AUDIT.md"), readFileSync(join(crlfDir, "AUDIT.md"), "utf-8") + "Edited.\r\n");
    check("LE5 a genuine content change still changes the canonical hash", buildManifest(crlfDir).fingerprint.artifacts["AUDIT.md"] !== mc.fingerprint.artifacts["AUDIT.md"]);
    gitEol(crlfDir, "true", "checkout", "-q", "--", "AUDIT.md");
    check("LE5 validate accepts the new marker", validateManifest(mc).length === 0, validateManifest(mc).join("; "));
    const legacy = JSON.parse(JSON.stringify(mc)); delete legacy.fingerprint.artifactHash;
    check("LE5 validate accepts a legacy manifest without the marker", validateManifest(legacy).length === 0);
    const future = JSON.parse(JSON.stringify(mc)); future.fingerprint.artifactHash = "sha512-raw";
    check("LE5 validate rejects an unknown algorithm instead of reading it as sha256-lf", validateManifest(future).some((e) => /artifactHash "sha512-raw" is not a supported algorithm/.test(e)));
    // Missing vs empty, and only CRLF pairs are normalized (a lone CR is content).
    const edge = join(root, "edge");
    writeTree(edge);
    rmSync(join(edge, "docs/project/overview.md"));
    writeFileSync(join(edge, "docs/project/integrations.md"), "");
    const me = buildManifest(edge);
    check("LE5 a missing artifact is null; an empty one is the hash of empty text — distinct", me.fingerprint.artifacts["docs/project/overview.md"] === null && me.fingerprint.artifacts["docs/project/integrations.md"] === sha(""));
    writeFileSync(join(edge, "AUDIT.md"), "# A\rB\n");
    const loneCr = buildManifest(edge).fingerprint.artifacts["AUDIT.md"];
    writeFileSync(join(edge, "AUDIT.md"), "# A\nB\n");
    check("LE5 a lone CR is not normalized (only CRLF pairs are)", loneCr === sha("# A\rB\n") && loneCr !== buildManifest(edge).fingerprint.artifacts["AUDIT.md"]);
    writeFileSync(join(edge, "AUDIT.md"), "# A\r\nB\r\n");
    check("LE5 ...while a CRLF pair is", buildManifest(edge).fingerprint.artifacts["AUDIT.md"] === sha("# A\nB\n"));
    for (const bad of [null, 1, "", "SHA256-LF"]) {
      const m = JSON.parse(JSON.stringify(mc)); m.fingerprint.artifactHash = bad;
      check(`LE5 validate rejects artifactHash ${JSON.stringify(bad)}`, validateManifest(m).some((e) => /is not a supported algorithm/.test(e)));
    }
    const emit = run(crlfDir, "repo-knowledge.ts", "emit", crlfDir);
    const val = run(crlfDir, "repo-knowledge.ts", "validate", crlfDir);
    check("LE5 emit + validate on the autocrlf checkout: only the fixture's absent commands are unknown", emit.code === 0 && val.code === 0 && /coverage unknown: commands$/m.test(val.stdout.trim()), emit.stdout + val.stdout + val.stderr);
    rmSync(join(crlfDir, ".ono"), { recursive: true, force: true });
  }

  // --- LE6 --------------------------------------------------------------------------------------
  {
    const prose = "## Build, Run, and Test Commands\n\n```bash\n# Install dependencies\nnpm ci\n# Run / develop\nnpm start\n# Test\nnpm test\n# Build\nnpm run build\n```\n";
    check("LE6 commands fallback parses CRLF like LF", JSON.stringify(extractCommandsFromProse(crlf(prose))) === JSON.stringify(extractCommandsFromProse(prose)) && extractCommandsFromProse(crlf(prose)).install === "npm ci");
    check("LE6 AUDIT.md topic rows and notes identical on CRLF", JSON.stringify(parseTopicRows(crlf(AUDIT_MD))) === JSON.stringify(parseTopicRows(AUDIT_MD)));
    const ui = run(crlfDir, "update-audit-index.ts", join(crlfDir, "AUDIT.md"), "Architecture");
    check("LE6 update-audit-index accepts the CRLF AUDIT.md row", ui.code === 0, ui.stderr);
    // record-approval: the Inspector last saw the topic as Draft; a human approves it in the CRLF file.
    const appr = join(root, "approval");
    lfClone(origin, appr);
    gitEol(appr, "false", "switch", "-q", "-c", WORK);
    rewriteEol(appr, "AUDIT.md", "crlf");
    run(appr, "inspection-state.ts", "sync", appr);
    writeFileSync(join(appr, "AUDIT.md"), readFileSync(join(appr, "AUDIT.md"), "utf-8").replace("| 2 | Draft | Player / Media | High | audits/player-media/player-media-audit.md | |", "| 2 | Approved | Player / Media | High | audits/player-media/player-media-audit.md | Approved 2026-11-25 |"));
    const ra = run(appr, "inspection-state.ts", "record-approval", appr, "Player / Media");
    check("LE6 record-approval records the baseline for a human approval in a CRLF AUDIT.md", ra.code === 0 && ra.json?.approvalHead === gitEol(appr, "false", "rev-parse", "HEAD"), ra.stdout + ra.stderr);
    const again = run(appr, "inspection-state.ts", "record-approval", appr, "Architecture");
    check("LE6 ...and still refuses to invent one for a topic approved earlier", again.code === 1, again.stdout);
  }

  // --- LE7 --------------------------------------------------------------------------------------
  {
    const exists = (p: string) => !/legacy|gone/.test(p);
    const a = parseFindings(ARCH_AUDIT, exists);
    const b = parseFindings(crlf(ARCH_AUDIT), exists);
    check("LE7 finding ids are identical for LF and CRLF text", JSON.stringify(a.map((f) => [f.id, f.files])) === JSON.stringify(b.map((f) => [f.id, f.files])));
    check("LE7 an unbackticked **File:** list is read on CRLF", JSON.stringify(b[1].files) === JSON.stringify(["src/services/PlaybackService.ts", "src/tv/FocusRow.tsx"]));
    check("LE7 a cited path that exists nowhere is kept on CRLF", JSON.stringify(b[2].files) === JSON.stringify(["src/old/gone.ts"]));
    check("LE7 LF text carries no legacyId", a.every((f) => f.legacyId === undefined));
    check("LE7 CRLF text names the different 0.13.0 id where 0.13.0 lost a File line", b[1].legacyId !== undefined && b[1].legacyId !== b[1].id && b[2].legacyId !== undefined, JSON.stringify(b.map((f) => f.legacyId)));
    // The legacy id equals what the released 0.13.0 parser derived from the same CRLF text.
    const rel = join(root, "inspector-0.13.0");
    extractRelease(REL_0130, ["scripts", "skills", ".claude-plugin"], rel);
    // A file:// URL: the ESM loader rejects a raw C:\ path on Windows.
    const old = await import(pathToFileURL(join(rel, "scripts", "audit-recheck.ts")).href);
    const legacyIds = old.parseFindings(crlf(ARCH_AUDIT), exists).map((f: any) => f.id);
    check("LE7 legacyId is exactly the id released 0.13.0 derives from the CRLF text", JSON.stringify(b.map((f) => f.legacyId ?? f.id)) === JSON.stringify(legacyIds), JSON.stringify(legacyIds));
    check("LE7 ...and the id 0.13.0 derives from LF text is unchanged", JSON.stringify(old.parseFindings(ARCH_AUDIT, exists).map((f: any) => f.id)) === JSON.stringify(a.map((f) => f.id)));
  }

  // --- LE8 --------------------------------------------------------------------------------------
  {
    const guard = (dir: string, cmd: string) => run(dir, "knowledge-refresh-guard.ts", cmd, dir);
    const blocks = parseManagedBlocks(readFileSync(join(crlfDir, "CLAUDE.md"), "utf-8"));
    check("LE8 both managed blocks are found in the CRLF CLAUDE.md", Object.keys(blocks).sort().join(",") === "audit-sync:caution-areas,audit-sync:important-files");
    guard(crlfDir, "snapshot");
    rewriteEol(crlfDir, "CLAUDE.md", "lf");
    rewriteEol(crlfDir, "AUDIT.md", "lf");
    const v1 = guard(crlfDir, "verify");
    check("LE8 CRLF snapshot -> LF rewrite of identical content passes", v1.code === 0, v1.stdout);
    guard(crlfDir, "snapshot");
    rewriteEol(crlfDir, "CLAUDE.md", "crlf");
    const v2 = guard(crlfDir, "verify");
    check("LE8 LF snapshot -> CRLF rewrite passes", v2.code === 0, v2.stdout);
    guard(crlfDir, "snapshot");
    writeFileSync(join(crlfDir, "CLAUDE.md"), readFileSync(join(crlfDir, "CLAUDE.md"), "utf-8").replace("Shared state (Architecture)", "Shared STATE (Architecture)"));
    const v3 = guard(crlfDir, "verify");
    check("LE8 a real edit inside a managed block still fails (exit 3)", v3.code === 3 && /caution-areas --> content changed/.test(v3.stdout), v3.stdout);
    gitEol(crlfDir, "true", "checkout", "-q", "--", "CLAUDE.md", "AUDIT.md");
    guard(crlfDir, "snapshot");
    writeFileSync(join(crlfDir, "AUDIT.md"), readFileSync(join(crlfDir, "AUDIT.md"), "utf-8").replace("| 1 | Approved | Architecture", "| 1 | Draft | Architecture"));
    const v4 = guard(crlfDir, "verify");
    check("LE8 a changed approval status in a CRLF AUDIT.md still fails", v4.code === 3 && /status changed: Approved -> Draft/.test(v4.stdout), v4.stdout);
    gitEol(crlfDir, "true", "checkout", "-q", "--", "AUDIT.md");
    rmSync(join(crlfDir, ".ono"), { recursive: true, force: true });
  }

  // --- LE9 --------------------------------------------------------------------------------------
  {
    const vidaa = parseSurfaceModel(readFileSync(join(crlfDir, "CLAUDE.md"), "utf-8")).surfaces.find((s) => s.id === "vidaa");
    check("LE9 a Hebrew evidence ref survives CRLF parsing exactly", vidaa?.evidence[0] === "platforms/טלוויזיה/manifest.json::הדגמה" && vidaa?.sourceRoots[0] === "platforms/טלוויזיה/", JSON.stringify(vidaa));
    write(crlfDir, "CLAUDE.md", readFileSync(join(crlfDir, "CLAUDE.md"), "utf-8").replace("manifest.json::הדגמה", "manifest.json::אחר"));
    const r = run(crlfDir, "knowledge-evidence.ts", "verify", crlfDir, "surfaces");
    check("LE9 ...and a Hebrew token that is not in the file is reported", r.code === 3 && r.stdout.includes("אחר"), r.stdout.slice(0, 300));
    gitEol(crlfDir, "true", "checkout", "-q", "--", "CLAUDE.md");
  }

  // --- LE10 -------------------------------------------------------------------------------------
  {
    const rel = join(root, "inspector-0.13.0");
    const old = (script: string, ...args: string[]) => {
      try { execFileSync(process.execPath, ["--no-warnings", join(rel, "scripts", script), ...args], { stdio: ["ignore", "pipe", "pipe"] }); return 0; }
      catch (e: any) { return e.status ?? 1; }
    };
    check("LE10 released 0.13.0: the LF checkout passes the evidence gate", old("knowledge-evidence.ts", "verify", lfDir, "surfaces") === 0);
    check("LE10 released 0.13.0: the autocrlf checkout fails it (exit 3) — the reported defect", old("knowledge-evidence.ts", "verify", crlfDir, "surfaces") === 3);
    check("LE10 0.14.0 passes that same checkout", run(crlfDir, "knowledge-evidence.ts", "verify", crlfDir, "surfaces").code === 0);
  }
  check("LE  the fixtures left the line-ending sentinels intact (lf() round-trip)", lf(crlf("a\nb\n")) === "a\nb\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
