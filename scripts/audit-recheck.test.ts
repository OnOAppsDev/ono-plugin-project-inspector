/**
 * audit-recheck.test.ts
 *
 * Scoped audit re-check (0.13.0): scripts/audit-recheck.ts (scope) and
 * `inspection-state.ts record-approval` / `record-recheck`.
 *
 *   R1  finding parsing; ids stable under reordering / insertion; duplicate headings
 *   R2  record-approval: only after a human approval, once, never overwritten
 *   R3  no change since approval -> nothing to re-verify
 *   R4  modified / deleted / renamed (only the old path cited) / body-cited / unrelated
 *   R5  findings without usable file references: cannot scope — manual review
 *   R6  record-recheck validation is all-or-nothing
 *   R7  partial runs never advance verifiedHead; pending work stays in scope
 *   R8  a complete run advances verifiedHead/verifiedAt; approval and documents untouched
 *   R9  fixing commits: candidate vs confirmed
 *   R10 legacy topic (approved before 0.13.0): one full "baseline unknown" re-check,
 *       then scoped from the verification — no approval commit fabricated
 *   R11 a baseline that left the history -> full re-check, labelled
 *   R12 history and earlier results are preserved; `changed` stays visible
 *   R13 only Approved topics
 *   R14 protected branch: scope reads, record refuses
 *   R15 nested Project Root with non-ASCII paths
 *   R16 workflow contract (approval records the baseline; re-check never stamps or approves)
 *
 * No external test framework. Run with:
 *   node --no-warnings scripts/audit-recheck.test.ts
 */

import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { parseFindings } from "./audit-recheck.ts";
import { g, helper, inspectedRepo, PLUGIN } from "./fixtures/inspected.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ""}`); }
}

const AUDIT_FILE = "audits/architecture/architecture-audit.md";
const AUDIT = `# Architecture Audit

Status: Draft

## Findings

### [HIGH] \`CatalogService\` — retries duplicate requests
- **File:** \`src/services/CatalogService.ts\`
- **Evidence:** retry loop without idempotency key.

### [MEDIUM] \`guideStore\` — global mutable state
- **File:** \`src/store/guideStore.ts:12\`
- **Evidence:** mutated from \`src/features/epg/EpgScreen.tsx\` directly.

### [LOW] \`FocusRow\` — focus trap
- **File:** \`src/tv/FocusRow.tsx\`

### [MEDIUM] Logging — scattered console output
- **File:** Unknown / multiple files

### [LOW] \`Tile\` — duplicated heading
- **File:** \`src/components/ChannelTile.tsx\`

### [LOW] \`Tile\` — duplicated heading
- **File:** \`src/services/PlaybackService.ts\`

## Evidence
Mentions \`src/tv/FocusRow.tsx\` outside the findings section.
`;

const root = realpathSync(mkdtempSync(join(tmpdir(), "inspector-recheck-")));
const read = (dir: string, rel: string) => readFileSync(join(dir, rel), "utf-8");
const put = (dir: string, rel: string, body: string) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), body); };
const commit = (dir: string, msg: string) => { g(dir, "add", "-A"); g(dir, "commit", "-q", "-m", msg); };
const state = (dir: string) => JSON.parse(read(dir, ".ono/state.json"));
const scope = (dir: string, topic = "Architecture") => helper(dir, "audit-recheck.ts", "scope", dir, topic);
const approve = (dir: string, topic = "Architecture") => helper(dir, "inspection-state.ts", "record-approval", dir, topic);
function record(dir: string, body: unknown, topic = "Architecture") {
  const r = spawnSync(process.execPath, ["--no-warnings", join(PLUGIN, "scripts", "inspection-state.ts"), "record-recheck", dir, topic, "-"], { cwd: dir, input: JSON.stringify(body), encoding: "utf-8" });
  let json: any = null; try { json = JSON.parse(r.stdout); } catch { /* none */ }
  return { code: r.status ?? -1, json, stdout: r.stdout, stderr: r.stderr };
}
const byHeading = (s: any, h: string) => s.findings.filter((f: any) => f.heading.includes(h));
const withAudit = (dir: string) => { put(dir, AUDIT_FILE, AUDIT); };
/** The topic as the workflow leaves it after audit-breakdown + sync: Draft in AUDIT.md and in state.json. */
const asDraft = (dir: string) => {
  withAudit(dir);
  put(dir, "AUDIT.md", read(dir, "AUDIT.md").replace("| 1 | Approved | Architecture |", "| 1 | Draft | Architecture |"));
  const s = JSON.parse(read(dir, ".ono/state.json"));
  for (const tp of s.topics) if (tp.topic === "Architecture") { tp.status = "Draft"; tp.approvedAt = null; }
  writeFileSync(join(dir, ".ono/state.json"), JSON.stringify(s, null, 2));
};
/** A human approval through the workflow: audit-approve flips the row, the after-hook records the baseline, then sync. */
function approveNow(dir: string, topic = "Architecture") {
  put(dir, "AUDIT.md", read(dir, "AUDIT.md").replace(`| Draft | ${topic} |`, `| Approved | ${topic} |`));
  const r = approve(dir, topic);
  helper(dir, "inspection-state.ts", "sync", dir);
  return r;
}

try {
  // --- R1: parsing -----------------------------------------------------------------------------------------
  const exists = (rel: string) => ["src/features/epg/EpgScreen.tsx", "src/tv/FocusRow.tsx"].includes(rel);
  const f1 = parseFindings(AUDIT, exists);
  check("R1 six findings, only from the Findings section", f1.length === 6, JSON.stringify(f1.map((f) => f.heading)));
  check("R1 severities", JSON.stringify(f1.map((f) => f.severity)) === JSON.stringify(["HIGH", "MEDIUM", "LOW", "MEDIUM", "LOW", "LOW"]));
  check("R1 :line suffix stripped; body-cited existing path added", JSON.stringify(f1[1].files) === JSON.stringify(["src/features/epg/EpgScreen.tsx", "src/store/guideStore.ts"]), JSON.stringify(f1[1].files));
  check("R1 `Unknown / multiple files` -> no files", f1[3].files.length === 0);
  check("R1 duplicate headings citing different files are distinct findings", f1[4].id !== f1[5].id);
  const [findingsPart, tail] = AUDIT.split("\n## Evidence");
  const blocks = findingsPart.split("\n### ");
  const reordered = [blocks[0], blocks[3], blocks[1], blocks[6], blocks[2], blocks[5], blocks[4]].join("\n### ") + "\n## Evidence" + tail;
  const f2 = parseFindings(reordered, exists);
  check("R1 ids are stable when findings are reordered", JSON.stringify(f2.map((f) => f.id).sort()) === JSON.stringify(f1.map((f) => f.id).sort()));
  const inserted = AUDIT.replace("## Findings\n", "## Findings\n\n### [HIGH] `New` — inserted first\n- **File:** `src/index.ts`\n");
  const f3 = parseFindings(inserted, exists);
  check("R1 inserting another finding leaves every existing id unchanged", f1.every((f) => f3.some((x) => x.id === f.id)) && f3.length === 7);
  const dup = parseFindings(AUDIT.replace("## Evidence", "### [LOW] `Tile` — duplicated heading\n- **File:** `src/services/PlaybackService.ts`\n\n## Evidence"), exists);
  check("R1 an exact duplicate (same heading, same files) gets its own id (-2), not conflated", new Set(dup.map((f) => f.id)).size === 7 && dup.some((f) => /-2$/.test(f.id)));

  // --- an inspected repository with an Approved topic ---------------------------------------------------------
  const repo = join(root, "repo");
  inspectedRepo(repo, "chore/project-inspection", asDraft);

  // --- R2: approval baseline -------------------------------------------------------------------------------------
  const approvalHead = g(repo, "rev-parse", "HEAD");
  const a1 = approveNow(repo);
  const auditMd = read(repo, "AUDIT.md");
  const auditDoc = read(repo, AUDIT_FILE);
  check("R2 record-approval records the HEAD at approval", a1.code === 0 && state(repo).audits?.[AUDIT_FILE]?.approval?.head === approvalHead && state(repo).audits[AUDIT_FILE].approval.baseline === "recorded", a1.stdout + a1.stderr);
  const approval = JSON.stringify(state(repo).audits[AUDIT_FILE].approval);
  commit(repo, "approval recorded");
  put(repo, "notes.txt", "x\n"); commit(repo, "later commit");
  check("R2 a second record-approval never overwrites the original", approve(repo).code === 0 && JSON.stringify(state(repo).audits[AUDIT_FILE].approval) === approval);
  check("R2 AUDIT.md and the audit file untouched", read(repo, "AUDIT.md") === auditMd && read(repo, AUDIT_FILE) === auditDoc);

  // --- R3: nothing changed in cited files -------------------------------------------------------------------------------
  const s0 = scope(repo).json;
  check("R3 scoped from the approval baseline", s0?.mode === "scoped" && s0?.baseline?.source === "approvalHead" && s0?.baseline?.head === approvalHead, JSON.stringify(s0?.baseline));
  check("R3 an unrelated change affects nothing", s0?.counts?.affected === 0 && s0?.counts?.unaffected === 5 && s0?.counts?.cannotScope === 1, JSON.stringify(s0?.counts));

  // --- R5: cannot scope ---------------------------------------------------------------------------------------------------
  const logging = byHeading(s0, "Logging")[0];
  check("R5 a finding without file references: cannot scope — manual review", logging?.scope === "cannot-scope" && /manual review/.test(logging?.reason));
  check("R5 ...and it is listed as needing human review", s0?.needsHumanReview?.includes(logging?.id));

  // --- R4: changes ----------------------------------------------------------------------------------------------------------
  put(repo, "src/services/CatalogService.ts", read(repo, "src/services/CatalogService.ts") + "// retry fix\n");
  g(repo, "mv", "src/store/guideStore.ts", "src/store/guide-store.ts");
  g(repo, "rm", "-q", "src/tv/FocusRow.tsx");
  put(repo, "src/features/search/Other.ts", "x\n");
  commit(repo, "source changes");
  const s1 = scope(repo).json;
  const cat = byHeading(s1, "CatalogService")[0], guide = byHeading(s1, "guideStore")[0], focus = byHeading(s1, "FocusRow")[0];
  check("R4 modified cited file -> affected (modified)", cat?.scope === "affected" && cat?.changes?.[0]?.change === "modified");
  check("R4 renamed file cited only by its old path -> affected, with the new path", guide?.scope === "affected" && guide?.changes?.some((c: any) => c.change === "renamed" && c.path === "src/store/guideStore.ts" && c.to === "src/store/guide-store.ts"), JSON.stringify(guide?.changes));
  check("R4 deleted cited file -> affected (deleted)", focus?.scope === "affected" && focus?.changes?.[0]?.change === "deleted");
  check("R4 findings whose files did not change stay unaffected", byHeading(s1, "Tile").every((f: any) => f.scope === "unaffected") && s1?.counts?.affected === 3, JSON.stringify(s1?.counts));

  // --- R6: validation (nothing written on any error) ------------------------------------------------------------------------------
  const stBefore = read(repo, ".ono/state.json");
  const ok = (id: string, result = "still-open") => ({ id, result, evidence: "checked the cited code" });
  const bad: Array<[string, unknown]> = [
    ["stale scopeHead", { scopeHead: approvalHead, results: [ok(cat.id)] }],
    ["unknown id", { scopeHead: s1.head, results: [ok("F-000000000000")] }],
    ["unaffected id", { scopeHead: s1.head, results: [ok(byHeading(s1, "Tile")[0].id)] }],
    ["cannot-scope id", { scopeHead: s1.head, results: [ok(logging.id)] }],
    ["missing evidence", { scopeHead: s1.head, results: [{ id: cat.id, result: "fixed" }] }],
    ["invalid result", { scopeHead: s1.head, results: [{ id: cat.id, result: "approved", evidence: "x" }] }],
    ["duplicate result", { scopeHead: s1.head, results: [ok(cat.id), ok(cat.id)] }],
    ["fixCommit that does not touch the files", { scopeHead: s1.head, results: [{ id: cat.id, result: "fixed", evidence: "x", fixCommit: approvalHead, fixCommitEvidence: "y" }] }],
    ["fixCommit on a non-fixed result", { scopeHead: s1.head, results: [{ id: cat.id, result: "still-open", evidence: "x", fixCommit: s1.head, fixCommitEvidence: "y" }] }],
  ];
  for (const [label, body] of bad) {
    const r = record(repo, body);
    check(`R6 ${label} -> rejected, exit 1`, r.code === 1 && r.json?.recorded === false, r.stdout + r.stderr);
  }
  check("R6 a rejected batch records nothing", read(repo, ".ono/state.json") === stBefore);

  // --- R7: partial run ----------------------------------------------------------------------------------------------------------------
  const p1 = record(repo, { scopeHead: s1.head, results: [{ id: cat.id, result: "fixed", evidence: "retries now carry an idempotency key in CatalogService" }] });
  check("R7 partial results -> exit 3, recorded, incomplete", p1.code === 3 && p1.json?.recorded === true && p1.json?.complete === false, p1.stdout + p1.stderr);
  check("R7 verifiedHead does not advance past unverified findings", state(repo).audits[AUDIT_FILE].verification.verifiedHead === null);
  check("R7 the unverified findings are reported pending", JSON.stringify(p1.json?.pending?.sort()) === JSON.stringify([guide.id, focus.id].sort()));
  const s2 = scope(repo).json;
  check("R7 the next scope still covers the pending findings (baseline unchanged)", s2?.baseline?.source === "approvalHead" && [guide.id, focus.id].every((id) => s2.findings.find((f: any) => f.id === id)?.scope === "affected"));

  // --- R8 / R9: complete run --------------------------------------------------------------------------------------------------------------
  const fixCommit = g(repo, "rev-parse", "HEAD");
  const c1 = record(repo, {
    scopeHead: s2.head,
    results: [
      { id: cat.id, result: "fixed", evidence: "retries carry an idempotency key", fixCommit, fixCommitEvidence: "this commit's diff adds the key" },
      { id: guide.id, result: "changed", evidence: "store moved and now exposes setters; review" },
      { id: focus.id, result: "still-open", evidence: "focus trap logic moved into TvPlayerControls" },
    ],
  });
  const ver = state(repo).audits[AUDIT_FILE].verification;
  check("R8 complete -> exit 0, verifiedHead = HEAD, verifiedAt set", c1.code === 0 && ver.verifiedHead === g(repo, "rev-parse", "HEAD") && typeof ver.verifiedAt === "string", c1.stdout + c1.stderr);
  check("R8 the approval record is unchanged", JSON.stringify(state(repo).audits[AUDIT_FILE].approval) === approval);
  check("R8 AUDIT.md (still Approved) and the audit file are unchanged", read(repo, "AUDIT.md") === auditMd && read(repo, AUDIT_FILE) === auditDoc && /\| Approved \|/.test(read(repo, "AUDIT.md")));
  check("R8 results are labelled AI re-verification", ver.findings[cat.id].source === "ai-reverification" && /human approval is unchanged/.test(c1.json?.note ?? ""));
  check("R9 fixed: the last commit touching the files is stored only as a candidate", ver.findings[cat.id].candidateFixCommit === fixCommit);
  check("R9 a verified fixCommit with evidence is stored as confirmed", ver.findings[cat.id].confirmedFixCommit === fixCommit && /diff adds/.test(ver.findings[cat.id].confirmedFixEvidence));
  check("R12 `changed` needs human review", ver.findings[guide.id].needsHumanReview === true && c1.json?.needsHumanReview?.includes(guide.id));

  // --- R12: history and visibility -----------------------------------------------------------------------------------------------------------
  put(repo, "src/components/ChannelTile.tsx", read(repo, "src/components/ChannelTile.tsx") + "// x\n");
  commit(repo, "tile change");
  const s3 = scope(repo).json;
  check("R12 scoped from the last complete verification", s3?.baseline?.source === "verifiedHead" && s3?.counts?.affected === 1);
  check("R12 an earlier `changed` result stays visible as needing review", s3?.needsHumanReview?.includes(guide.id));
  const tile = s3.findings.find((f: any) => f.scope === "affected");
  check("R12 run 3 records", record(repo, { scopeHead: s3.head, results: [{ id: tile.id, result: "still-open", evidence: "unchanged duplication" }] }).code === 0);
  const v3 = state(repo).audits[AUDIT_FILE].verification;
  check("R12 history keeps every run (partial included)", v3.history.length === 3 && v3.history[0].complete === false && v3.history[1].complete === true);
  check("R12 earlier results of unaffected findings are preserved", v3.findings[cat.id].result === "fixed" && v3.findings[guide.id].result === "changed");

  // --- R10: legacy topic -------------------------------------------------------------------------------------------------------------------------
  const legacy = join(root, "legacy");
  inspectedRepo(legacy, "chore/project-inspection", withAudit);
  const ls = scope(legacy).json;
  check("R10 no approval record -> full re-check labelled baseline unknown", ls?.mode === "full" && /baseline unknown/.test(ls?.baseline?.label) && ls?.counts?.affected === 5 && ls?.counts?.cannotScope === 1, JSON.stringify(ls?.baseline));
  const lr = record(legacy, { scopeHead: ls.head, results: ls.findings.filter((f: any) => f.scope === "affected").map((f: any) => ok(f.id)) });
  const lst = state(legacy).audits[AUDIT_FILE];
  check("R10 a complete full re-check sets a verification baseline", lr.code === 0 && lst.verification.verifiedHead === ls.head && lst.verification.history[0].mode === "full");
  check("R10 ...without fabricating an approval commit", lst.approval === undefined);
  put(legacy, "src/tv/FocusRow.tsx", "changed\n");
  commit(legacy, "change");
  const ls2 = scope(legacy).json;
  check("R10 later re-checks are scoped from that verification", ls2?.mode === "scoped" && ls2?.baseline?.source === "verifiedHead" && ls2?.counts?.affected === 1);

  // --- R11: baseline left the history ------------------------------------------------------------------------------------------------------------
  const gone = join(root, "gone");
  inspectedRepo(gone, "chore/project-inspection", withAudit);
  const sg = state(gone);
  sg.audits = { [AUDIT_FILE]: { topic: "Architecture", approval: { head: "0123456789abcdef0123456789abcdef01234567", recordedAt: "2026-01-01T00:00:00.000Z", baseline: "recorded" } } };
  writeFileSync(join(gone, ".ono/state.json"), JSON.stringify(sg, null, 2));
  const sgs = scope(gone).json;
  check("R11 an approval HEAD not in the history -> full, labelled, never treated as unchanged", sgs?.mode === "full" && /not in this repository's history/.test(sgs?.baseline?.label) && sgs?.counts?.affected === 5);

  // --- R13: only Approved topics ----------------------------------------------------------------------------------------------------------------
  const draft = join(root, "draft");
  inspectedRepo(draft, "chore/project-inspection", (d) => { withAudit(d); writeFileSync(join(d, "AUDIT.md"), readFileSync(join(d, "AUDIT.md"), "utf-8").replace("| Approved |", "| Draft |")); });
  check("R13 scope refuses a Draft topic", scope(draft).code === 1);
  check("R13 record-approval refuses a Draft topic", approve(draft).code === 1);
  check("R13 an unknown topic is refused", scope(repo, "No Such Topic").code === 1);

  // --- R14: protected branch -----------------------------------------------------------------------------------------------------------------------
  const prot = join(root, "protected");
  inspectedRepo(prot, "chore/project-inspection", withAudit);
  g(prot, "branch", "-m", "main");
  const sp = scope(prot);
  check("R14 scope works on main (read-only)", sp.code === 0 && sp.json?.mode === "full");
  const pst = read(prot, ".ono/state.json");
  check("R14 record-recheck refuses on main (exit 5)", record(prot, { scopeHead: sp.json.head, results: [] }).code === 5);
  check("R14 record-approval refuses on main (exit 5)", approve(prot).code === 5);
  check("R14 nothing written", read(prot, ".ono/state.json") === pst);

  // --- R15: nested project, non-ASCII paths -----------------------------------------------------------------------------------------------------------
  const umbrella = join(root, "umbrella repo");
  const project = join(umbrella, "פרויקט TV");
  const tree = join(root, "tree");
  inspectedRepo(tree, "chore/project-inspection", (d) => {
    renameSync(join(d, "src/features/epg/EpgScreen.tsx"), join(d, "src/features/epg/מסך EPG.tsx"));
    for (const rel of ["docs/project/capabilities.md", "docs/project/components.md", "CLAUDE.md"]) {
      writeFileSync(join(d, rel), readFileSync(join(d, rel), "utf-8").split("src/features/epg/EpgScreen.tsx").join("src/features/epg/מסך EPG.tsx"));
    }
    asDraft(d);
    put(d, AUDIT_FILE, "# A\n\n## Findings\n\n### [HIGH] `EPG` — x\n- **File:** `src/features/epg/מסך EPG.tsx`\n");
  });
  rmSync(join(tree, ".git"), { recursive: true, force: true });
  mkdirSync(umbrella);
  g(umbrella, "init", "-q", "-b", "chore/project-inspection");
  renameSync(tree, project);
  commit(umbrella, "nested");
  check("R15 nested: approval recorded at the Project Root", approveNow(project).code === 0);
  commit(umbrella, "approval");
  g(umbrella, "mv", "פרויקט TV/src/features/epg/מסך EPG.tsx", "פרויקט TV/src/features/epg/מסך EPG חדש.tsx");
  g(umbrella, "commit", "-q", "-m", "rename");
  const ns = scope(project).json;
  check("R15 a renamed non-ASCII file below a nested Project Root is detected (paths relative to the project)", ns?.counts?.affected === 1 && ns?.findings?.[0]?.changes?.[0]?.to === "src/features/epg/מסך EPG חדש.tsx", JSON.stringify(ns?.findings?.[0]?.changes));

  // --- R17: a human-review requirement is sticky ----------------------------------------------------------------------------
  {
    const st = join(root, "sticky");
    inspectedRepo(st, "chore/project-inspection", asDraft);
    approveNow(st);
    commit(st, "approved");
    const bump = (n: string) => { put(st, "src/services/CatalogService.ts", read(st, "src/services/CatalogService.ts") + `// ${n}\n`); commit(st, n); };
    bump("c1");
    let sc = scope(st).json;
    const catId = byHeading(sc, "CatalogService")[0].id;
    const all = (s: any, first: string) => s.findings.filter((f: any) => f.scope === "affected").map((f: any) => ({ id: f.id, result: f.id === catId ? first : "still-open", evidence: "checked" }));
    record(st, { scopeHead: sc.head, results: all(sc, "changed") });
    commit(st, "r1");
    for (const next of ["still-open", "fixed", "changed"]) {
      bump(next);
      sc = scope(st).json;
      check(`R17 before a later "${next}" result the finding is listed for human review`, sc.needsHumanReview.includes(catId));
      const r = record(st, { scopeHead: sc.head, results: all(sc, next) });
      const f = state(st).audits[AUDIT_FILE].verification.findings[catId];
      check(`R17 a later AI "${next}" result never clears the human-review requirement`, r.code === 0 && f.result === next && f.needsHumanReview === true && typeof f.humanReviewRequiredSince === "string" && r.json?.needsHumanReview?.includes(catId), JSON.stringify(f));
      check(`R17 ...and the next scope still lists it`, scope(st).json?.needsHumanReview?.includes(catId));
      commit(st, `after ${next}`);
    }
    const since = state(st).audits[AUDIT_FILE].verification.findings[catId].humanReviewRequiredSince;
    check("R17 inspection-state sync keeps the flag and its date", helper(st, "inspection-state.ts", "sync", st).code === 0 && state(st).audits[AUDIT_FILE].verification.findings[catId].needsHumanReview === true && state(st).audits[AUDIT_FILE].verification.findings[catId].humanReviewRequiredSince === since);
    const s012 = join(root, "inspector-0.12.0");
    mkdirSync(s012);
    const archive = spawnSync("git", ["archive", "edbc2772fb0eb11d3fa5e51a89e81fbb9b4b3f0d", "scripts", "skills", ".claude-plugin"], { cwd: PLUGIN, maxBuffer: 64 * 1024 * 1024 }).stdout;
    spawnSync("tar", ["-x", "-C", s012], { input: archive });
    const old = spawnSync(process.execPath, ["--no-warnings", join(s012, "scripts", "inspection-state.ts"), "sync", st], { encoding: "utf-8" });
    check("R17 a sync by the previous release (0.12.0) keeps it too", old.status === 0 && state(st).audits[AUDIT_FILE].verification.findings[catId].needsHumanReview === true, old.stderr);
  }

  // --- R18: approval baseline integrity -------------------------------------------------------------------------------------------
  {
    // (a) the original reproduction: a topic approved and committed long ago
    const legacy2 = join(root, "legacy-approved");
    inspectedRepo(legacy2, "chore/project-inspection", withAudit);
    put(legacy2, "src/services/CatalogService.ts", "// much later\n");
    commit(legacy2, "much later");
    const lr2 = approve(legacy2);
    check("R18 a historically approved topic gets no new approval HEAD (refused)", lr2.code === 1 && /baseline unknown/.test(lr2.stderr) && state(legacy2).audits?.[AUDIT_FILE]?.approval === undefined, lr2.stderr);
    check("R18 ...and keeps the baseline-unknown full re-check", scope(legacy2).json?.mode === "full");
    // (b) recorded Draft, but the committed AUDIT.md already shows Approved
    const committed = join(root, "committed-approved");
    inspectedRepo(committed, "chore/project-inspection", (d) => { asDraft(d); put(d, "AUDIT.md", readFileSync(join(d, "AUDIT.md"), "utf-8").replace("| Draft | Architecture |", "| Approved | Architecture |")); });
    check("R18 an approval already in the committed AUDIT.md is refused", approve(committed).code === 1 && state(committed).audits?.[AUDIT_FILE]?.approval === undefined);
    // (c) AUDIT.md says Approved (uncommitted) but the Inspector never recorded the topic as a Draft
    const unrecorded = join(root, "unrecorded");
    inspectedRepo(unrecorded, "chore/project-inspection", (d) => {
      asDraft(d);
      const s = JSON.parse(readFileSync(join(d, ".ono/state.json"), "utf-8"));
      s.topics = [];
      writeFileSync(join(d, ".ono/state.json"), JSON.stringify(s, null, 2));
    });
    put(unrecorded, "AUDIT.md", read(unrecorded, "AUDIT.md").replace("| Draft | Architecture |", "| Approved | Architecture |"));
    const ur = approve(unrecorded);
    check("R18 an uncommitted Approved row alone is not evidence (no recorded Draft) -> refused", ur.code === 1 && /never recorded/.test(ur.stderr), ur.stderr);
    // (d) a brand-new, never committed AUDIT.md written as Approved, with no recorded Draft
    const fresh = join(root, "fresh-audit");
    inspectedRepo(fresh, "chore/project-inspection", (d) => {
      withAudit(d);
      const s = JSON.parse(readFileSync(join(d, ".ono/state.json"), "utf-8"));
      s.topics = [];
      writeFileSync(join(d, ".ono/state.json"), JSON.stringify(s, null, 2));
    });
    g(fresh, "rm", "-q", "--cached", "AUDIT.md");
    g(fresh, "commit", "-q", "-m", "AUDIT.md untracked");
    check("R18 a newly created, uncommitted AUDIT.md alone is not evidence -> refused", approve(fresh).code === 1);
    // (e) the legitimate path, and preservation of an existing record
    const good = join(root, "legit");
    inspectedRepo(good, "chore/project-inspection", asDraft);
    const goodHead = g(good, "rev-parse", "HEAD");
    const ok1 = approveNow(good);
    check("R18 a Draft -> Approved transition through the workflow is recorded", ok1.code === 0 && state(good).audits[AUDIT_FILE].approval.head === goodHead, ok1.stdout + ok1.stderr);
    const rec1 = JSON.stringify(state(good).audits[AUDIT_FILE].approval);
    commit(good, "approved");
    put(good, "x.txt", "x\n"); commit(good, "later");
    check("R18 an existing approval record is preserved (no new HEAD)", approve(good).code === 0 && JSON.stringify(state(good).audits[AUDIT_FILE].approval) === rec1);
  }

  // --- R16: workflow contract ---------------------------------------------------------------------------------------------------------------------------
  const approveHook = readFileSync(join(PLUGIN, "hooks", "after-audit-approve.md"), "utf-8");
  check("R16 after-audit-approve records the approval baseline", approveHook.includes('inspection-state.ts" record-approval "<TARGET_ROOT>" "<topic>"'));
  const recheckHook = readFileSync(join(PLUGIN, "hooks", "after-audit-recheck.md"), "utf-8");
  check("R16 after-audit-recheck never stamps or emits", /Do \*\*not\*\* run `stamp-docs` and do not emit the manifest/.test(recheckHook) && !/node [^`]*stamp-docs/.test(recheckHook));
  const skill = readFileSync(join(PLUGIN, "skills", "audit-recheck", "SKILL.md"), "utf-8");
  check("R16 the skill never presents results as approval", /never a human approval/.test(skill) && /Never describe a re-check result as approval/.test(skill));
  check("R16 the skill re-verifies only affected findings and labels candidates", /Re-verify only `affected` findings/.test(skill) && /\*\*candidate\*\* fixing commit/.test(skill));
  const reg = JSON.parse(readFileSync(join(PLUGIN, "skills", "registry.json"), "utf-8")).skills.find((s: any) => s.id === "audit-recheck");
  check("R16 registry: a maintenance tool, not a stage", reg?.workflowRole === "maintenance" && reg?.hooks?.after === "after-audit-recheck");
  const manifest = JSON.parse(readFileSync(join(PLUGIN, ".claude-plugin", "plugin.json"), "utf-8"));
  check("R16 plugin.json registers the command and the skill", manifest.commands.includes("./commands/inspect-recheck.md") && manifest.skills.includes("./skills/audit-recheck"));
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
