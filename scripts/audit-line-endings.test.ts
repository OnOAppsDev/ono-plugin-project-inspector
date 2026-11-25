/**
 * audit-line-endings.test.ts — audit re-check records across line endings (0.14.0).
 *
 * Inspector 0.13.0 parsed a CRLF audit file as-is: a `**File:**` line it could not read gave
 * the finding no cited files (cannot-scope) and a different id. Such records can exist in a
 * released 0.13.0 state.json (a /inspect-recheck run on a core.autocrlf=true checkout). The
 * records are produced here by the RELEASED 0.13.0 helpers, then re-checked by 0.14.0:
 *
 *   AL1  LF: 0.13.0 and 0.14.0 derive the same ids; existing records are used as before
 *   AL2  CRLF: 0.14.0 parses the cited files, names the 0.13.0 id as legacyId, and lists the
 *        pending human review exactly once
 *   AL3  recording carries the legacy record forward under the current id — sticky human
 *        review and its date included — and never modifies or removes the legacy record
 *   AL4  approval records are untouched by re-checks on either line ending
 *   AL5  repeating record-recheck keeps the link: no duplicate record or human-review entry
 *   AL6  a partial re-check of a carried finding does not advance the verification baseline
 *   AL7  a later "fixed" result never clears the carried human review, approves or resolves anything
 *   AL8  AMBIGUOUS legacy identities (duplicate headings that 0.13.0 could only tell apart by
 *        position) are never carried: no evidence moves between findings; the legacy records stay
 *        untouched and listed for human review
 *   AL9  a legacy record whose stored heading / files / siblings do not match is not carried
 *
 * Run with: node --no-warnings scripts/audit-line-endings.test.ts
 */

import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { extractRelease, g, inspectedRepo, PLUGIN } from "./fixtures/inspected.ts";
import { crlf } from "./fixtures/line-endings.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ""}`); }
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "inspector-audit-eol-")));
const REL_0130 = "3ef4cd1771b57fd969ff2b78e95f33931a9fcea5";
const AUDIT_FILE = "audits/architecture/architecture-audit.md";
const AUDIT = `# Architecture Audit

## Findings

### [HIGH] Catalog retries duplicate requests
- **File:** src/services/CatalogService.ts, src/services/PlaybackService.ts
- **Evidence:** retry loop without idempotency key.

### [MEDIUM] \`guideStore\` — global mutable state
- **File:** \`src/store/guideStore.ts\`

## Evidence
None.
`;
const put = (dir: string, rel: string, body: string) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), body); };
const state = (dir: string) => JSON.parse(readFileSync(join(dir, ".ono", "state.json"), "utf-8"));
const released = join(root, "inspector-0.13.0");
extractRelease(REL_0130, ["scripts", "skills", ".claude-plugin"], released);

function run(plugin: string, dir: string, script: string, args: string[], input?: string) {
  const r = spawnSync(process.execPath, ["--no-warnings", join(plugin, "scripts", script), ...args], { cwd: dir, input, encoding: "utf-8" });
  let json: any = null; try { json = JSON.parse(r.stdout); } catch { /* none */ }
  return { code: r.status ?? -1, json, stdout: r.stdout, stderr: r.stderr };
}
const scope = (plugin: string, dir: string) => run(plugin, dir, "audit-recheck.ts", ["scope", dir, "Architecture"]);
const record = (plugin: string, dir: string, results: unknown[]) =>
  run(plugin, dir, "inspection-state.ts", ["record-recheck", dir, "Architecture", "-"], JSON.stringify({ scopeHead: g(dir, "rev-parse", "HEAD"), results }));
const still = (id: string) => ({ id, result: "still-open", evidence: "the retry loop is unchanged" });
const findingBy = (s: any, h: string) => s.findings.find((f: any) => f.heading.includes(h));
/** A source change to cited files, so the next scoped re-check has them in scope. */
function change(dir: string, ...rels: string[]): void {
  for (const rel of rels) writeFileSync(join(dir, rel), readFileSync(join(dir, rel), "utf-8") + "// changed\n");
  g(dir, "add", "--", ...rels);
  g(dir, "commit", "-q", "-m", "source change");
}

function project(name: string, eol: "lf" | "crlf"): string {
  const dir = join(root, name);
  inspectedRepo(dir, "chore/project-inspection", (d) => put(d, AUDIT_FILE, AUDIT));
  // The working-tree file as a core.autocrlf=true checkout has it.
  if (eol === "crlf") writeFileSync(join(dir, AUDIT_FILE), crlf(AUDIT));
  return dir;
}

try {
  // --- AL1 --------------------------------------------------------------------------------------
  {
    const d = project("lf", "lf");
    const o = scope(released, d).json;
    const n = scope(PLUGIN, d).json;
    check("AL1 LF: 0.13.0 and 0.14.0 derive identical finding ids and files", JSON.stringify(o.findings.map((f: any) => [f.id, f.files])) === JSON.stringify(n.findings.map((f: any) => [f.id, f.files])));
    check("AL1 LF: no legacyId", n.findings.every((f: any) => f.legacyId === undefined));
    const cat = findingBy(o, "Catalog");
    const rec = record(released, d, [still(cat.id), still(findingBy(o, "guideStore").id)]);
    check("AL1 LF: the released 0.13.0 records results", rec.code === 0, rec.stdout + rec.stderr);
    const prev = JSON.stringify(state(d).audits[AUDIT_FILE].verification.findings[cat.id]);
    change(d, "src/services/CatalogService.ts", "src/store/guideStore.ts");
    const n2 = record(PLUGIN, d, [still(cat.id), { id: findingBy(n, "guideStore").id, result: "changed", evidence: "the store moved" }]);
    check("AL1 LF: 0.14.0 records under the same ids; nothing orphaned", n2.code === 0 && Object.keys(state(d).audits[AUDIT_FILE].verification.findings).length === 2 && prev.length > 0, n2.stdout + n2.stderr);
  }

  // --- AL2 / AL3 / AL4 ---------------------------------------------------------------------------
  {
    const d = project("crlf", "crlf");
    const o = scope(released, d).json;
    const oc = findingBy(o, "Catalog");
    check("AL2 fixture: released 0.13.0 cannot read the unbackticked File line on CRLF (cannot-scope)", oc.scope === "cannot-scope" && oc.files.length === 0, JSON.stringify(oc));
    const orec = record(released, d, [still(findingBy(o, "guideStore").id)]);
    check("AL2 fixture: 0.13.0 stores a sticky human-review record under that legacy id", orec.code === 0 && state(d).audits[AUDIT_FILE].verification.findings[oc.id]?.needsHumanReview === true, orec.stdout + orec.stderr);
    const legacyBefore = JSON.stringify(state(d).audits[AUDIT_FILE].verification.findings[oc.id]);
    const approvalBefore = JSON.stringify(state(d).audits[AUDIT_FILE].approval ?? null);

    change(d, "src/services/CatalogService.ts");
    const n = scope(PLUGIN, d).json;
    const nc = findingBy(n, "Catalog");
    check("AL2 0.14.0 reads both cited files on CRLF and scopes the finding", JSON.stringify(nc.files) === '["src/services/CatalogService.ts","src/services/PlaybackService.ts"]' && nc.scope === "affected", JSON.stringify(nc));
    check("AL2 ...the finding names its 0.13.0 id as legacyId", nc.legacyId === oc.id && nc.id !== oc.id);
    check("AL2 ...and the guideStore finding (readable by 0.13.0) keeps its id; its file did not change", findingBy(n, "guideStore").id === findingBy(o, "guideStore").id && findingBy(n, "guideStore").legacyId === undefined && findingBy(n, "guideStore").scope === "unaffected");
    check("AL2 before any 0.14.0 record, the pending human review is still listed (legacy id)", n.needsHumanReview.includes(oc.id), JSON.stringify(n.needsHumanReview));

    const nrec = record(PLUGIN, d, [still(nc.id)]);
    const v = state(d).audits[AUDIT_FILE].verification.findings;
    check("AL3 0.14.0 records the result under the current id", nrec.code === 0 && v[nc.id]?.result === "still-open", nrec.stdout + nrec.stderr);
    check("AL3 ...carrying the sticky human-review requirement and its original date", v[nc.id]?.needsHumanReview === true && v[nc.id]?.humanReviewRequiredSince === JSON.parse(legacyBefore).humanReviewRequiredSince && v[nc.id]?.legacyId === oc.id);
    check("AL3 the legacy record is kept, byte for byte (never discarded or replaced)", JSON.stringify(v[oc.id]) === legacyBefore);
    check("AL3 the human review is listed once, under the current id", JSON.stringify(nrec.json?.needsHumanReview) === JSON.stringify([nc.id]) && JSON.stringify(scope(PLUGIN, d).json.needsHumanReview) === JSON.stringify([nc.id]), JSON.stringify(nrec.json?.needsHumanReview));
    check("AL3 verification history is appended, never rewritten", state(d).audits[AUDIT_FILE].verification.history.length === 2);
    check("AL4 the approval record is unchanged by both re-checks", JSON.stringify(state(d).audits[AUDIT_FILE].approval ?? null) === approvalBefore);
    check("AL4 AUDIT.md keeps the topic Approved", /\| Approved \| Architecture \|/.test(readFileSync(join(d, "AUDIT.md"), "utf-8")));

    // --- AL5: a second re-check after another change -------------------------------------------------
    change(d, "src/services/CatalogService.ts");
    const again = record(PLUGIN, d, [still(nc.id)]);
    const v2 = state(d).audits[AUDIT_FILE].verification;
    check("AL5 a repeated record-recheck succeeds", again.code === 0, again.stdout + again.stderr);
    check("AL5 ...keeps the legacy link on the current record", v2.findings[nc.id]?.legacyId === oc.id);
    check("AL5 ...creates no duplicate record (one current + the untouched legacy record)", Object.keys(v2.findings).filter((id) => v2.findings[id].heading === nc.heading).sort().join(",") === [nc.id, oc.id].sort().join(",") && JSON.stringify(v2.findings[oc.id]) === legacyBefore);
    check("AL5 ...and lists the human review exactly once", JSON.stringify(again.json?.needsHumanReview) === JSON.stringify([nc.id]) && JSON.stringify(scope(PLUGIN, d).json.needsHumanReview) === JSON.stringify([nc.id]), JSON.stringify(again.json?.needsHumanReview));
    check("AL5 ...the human review stays sticky with its original date", v2.findings[nc.id].needsHumanReview === true && v2.findings[nc.id].humanReviewRequiredSince === JSON.parse(legacyBefore).humanReviewRequiredSince);
    check("AL5 ...and history keeps every earlier entry", v2.history.length === 3);

    // --- AL6: partial re-check ---------------------------------------------------------------------
    const headBefore = v2.verifiedHead;
    change(d, "src/services/CatalogService.ts", "src/store/guideStore.ts");
    const sc6 = scope(PLUGIN, d).json;
    check("AL6 fixture: both findings are in scope", sc6.counts.affected === 2, JSON.stringify(sc6.counts));
    const partial = record(PLUGIN, d, [still(nc.id)]);
    const v3 = state(d).audits[AUDIT_FILE].verification;
    check("AL6 a partial run is recorded but reported incomplete (exit 3)", partial.code === 3 && partial.json?.complete === false, partial.stdout);
    check("AL6 ...the verification baseline does not advance", v3.verifiedHead === headBefore);
    check("AL6 ...the unverified finding stays pending; the carried review is still required", v3.findings[findingBy(sc6, "guideStore").id]?.pendingSince !== undefined && v3.findings[nc.id].needsHumanReview === true);

    // --- AL7: "fixed" never resolves the carried human review or approves anything -----------------------
    const fixed = record(PLUGIN, d, [{ id: nc.id, result: "fixed", evidence: "the retry now uses an idempotency key" }, still(findingBy(sc6, "guideStore").id)]);
    const v4 = state(d).audits[AUDIT_FILE].verification;
    check("AL7 a later AI result 'fixed' is recorded as AI re-verification only", fixed.code === 0 && v4.findings[nc.id].result === "fixed" && v4.findings[nc.id].source === "ai-reverification", fixed.stdout + fixed.stderr);
    check("AL7 ...the carried human review is still required (sticky), with its original date", v4.findings[nc.id].needsHumanReview === true && v4.findings[nc.id].humanReviewRequiredSince === JSON.parse(legacyBefore).humanReviewRequiredSince && fixed.json?.needsHumanReview?.includes(nc.id));
    check("AL7 ...the approval record, AUDIT.md and the audit file are unchanged", JSON.stringify(state(d).audits[AUDIT_FILE].approval ?? null) === approvalBefore && /\| Approved \| Architecture \|/.test(readFileSync(join(d, "AUDIT.md"), "utf-8")) && readFileSync(join(d, AUDIT_FILE), "utf-8") === crlf(AUDIT));
    check("AL7 ...and the legacy record is still byte-identical", JSON.stringify(v4.findings[oc.id]) === legacyBefore);
  }

  // --- AL8: ambiguous legacy identities ------------------------------------------------------------
  {
    const DUP = `# Architecture Audit

## Findings

### [HIGH] Retries duplicate requests
- **File:** src/services/CatalogService.ts

### [HIGH] Retries duplicate requests
- **File:** src/store/guideStore.ts

## Evidence
None.
`;
    const d = join(root, "dup");
    inspectedRepo(d, "chore/project-inspection", (x) => put(x, AUDIT_FILE, DUP));
    writeFileSync(join(d, AUDIT_FILE), crlf(DUP));
    const o = scope(released, d).json;
    check("AL8 fixture: 0.13.0 tells the two findings apart only by position (F-x, F-x-2), both cannot-scope", o.findings.length === 2 && o.findings[1].id === `${o.findings[0].id}-2` && o.findings.every((f: any) => f.scope === "cannot-scope"), JSON.stringify(o.findings.map((f: any) => f.id)));
    const orec = record(released, d, []);
    const legacy = JSON.stringify(state(d).audits[AUDIT_FILE].verification.findings);
    check("AL8 fixture: 0.13.0 stored two sticky human-review records", orec.code === 0 && o.findings.every((f: any) => state(d).audits[AUDIT_FILE].verification.findings[f.id]?.needsHumanReview === true), orec.stdout + orec.stderr);
    // The two findings swap places afterwards: positional matching would now cross them over.
    const swapped = DUP.replace(/(### \[HIGH\] Retries duplicate requests\n- \*\*File:\*\* src\/services\/CatalogService\.ts\n)\n(### \[HIGH\] Retries duplicate requests\n- \*\*File:\*\* src\/store\/guideStore\.ts\n)/, "$2\n$1");
    writeFileSync(join(d, AUDIT_FILE), crlf(swapped));
    change(d, "src/services/CatalogService.ts", "src/store/guideStore.ts");
    const n = scope(PLUGIN, d).json;
    check("AL8 0.14.0 reads both findings, distinct ids, and offers NO legacy id for either", n.findings.length === 2 && n.findings[0].id !== n.findings[1].id && n.findings.every((f: any) => f.legacyId === undefined && f.files.length === 1), JSON.stringify(n.findings));
    check("AL8 ...both legacy reviews stay listed (visible, not dropped)", o.findings.every((f: any) => n.needsHumanReview.includes(f.id)), JSON.stringify(n.needsHumanReview));
    const nrec = record(PLUGIN, d, n.findings.map((f: any) => still(f.id)));
    const v = state(d).audits[AUDIT_FILE].verification.findings;
    check("AL8 recording creates fresh records: no legacy result, evidence or review date transferred", nrec.code === 0 && n.findings.every((f: any) => v[f.id]?.legacyId === undefined && v[f.id]?.needsHumanReview === false && v[f.id]?.humanReviewRequiredSince === null), nrec.stdout + nrec.stderr);
    check("AL8 ...the legacy records are byte-identical and still listed for human review", JSON.stringify(Object.fromEntries(o.findings.map((f: any) => [f.id, v[f.id]]))) === JSON.stringify(Object.fromEntries(o.findings.map((f: any) => [f.id, JSON.parse(legacy)[f.id]]))) && o.findings.every((f: any) => nrec.json?.needsHumanReview?.includes(f.id)));
  }

  // --- AL9: a legacy record that does not match is not carried -----------------------------------------
  {
    const d = project("mismatch", "crlf");
    const o = scope(released, d).json;
    const oc = findingBy(o, "Catalog");
    record(released, d, [still(findingBy(o, "guideStore").id)]);
    const s = state(d);
    s.audits[AUDIT_FILE].verification.findings[oc.id].heading = "[HIGH] A different finding";
    writeFileSync(join(d, ".ono", "state.json"), JSON.stringify(s, null, 2));
    change(d, "src/services/CatalogService.ts");
    const n = scope(PLUGIN, d).json;
    const nc = findingBy(n, "Catalog");
    check("AL9 fixture: the finding names a legacy id", nc.legacyId === oc.id);
    const r = record(PLUGIN, d, [still(nc.id)]);
    const v = state(d).audits[AUDIT_FILE].verification.findings;
    check("AL9 a stored heading that differs: nothing carried, the legacy record kept and still listed", r.code === 0 && v[nc.id]?.legacyId === undefined && v[nc.id]?.needsHumanReview === false && v[oc.id]?.needsHumanReview === true && r.json?.needsHumanReview?.includes(oc.id), r.stdout + r.stderr);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
