/**
 * audit-recheck.ts — scoped re-check of an Approved audit topic (0.13.0).
 *
 *   node --no-warnings scripts/audit-recheck.ts scope "<repo-root>" "<topic | audits/…-audit.md>"
 *
 * READ-ONLY. Prints one JSON object: which findings of the topic must be re-verified
 * because a file they cite changed since the topic's verification baseline, which are
 * unaffected, and which cannot be scoped (no usable file reference — manual review).
 * Results are recorded separately by `inspection-state.ts record-recheck`, which
 * recomputes this same scope and accepts nothing outside it.
 *
 * Baseline: the topic's last COMPLETE verification (`verifiedHead`), else the HEAD
 * recorded when a human approved it (`approval.head`). A topic approved before 0.13.0
 * has neither: every scopable finding is re-verified once, labelled "baseline unknown"
 * — no historical approval commit is ever inferred.
 *
 * Findings: the `### …` entries of the audit file's `## Findings` section. A finding's
 * id is derived from its heading (plus its cited files, and an occurrence number for
 * exact duplicates), so it survives reordering and the insertion of other findings.
 * Cited files: backticked paths on its `**File:**` line, plus backticked path-like
 * tokens in its body that exist in the repository. Rename detection runs on the whole
 * diff, so a finding that cites only the old path of a renamed file is affected.
 *
 * Nothing here approves anything, changes AUDIT.md, or edits an audit file.
 *
 * Exit codes: 0 scope printed · 1 usage / unknown topic / not Approved / no audit file
 */

import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { isEntryPoint, useBlockingOutput } from "./entrypoint.ts";

export interface Finding {
  id: string;
  heading: string;
  severity: string | null;
  /** Cited, repository-relative paths (exact text, normalized only for ./ and :line suffixes). */
  files: string[];
}

export interface Change { path: string; change: "modified" | "deleted" | "renamed" | "added" | "type-changed"; to?: string }

export interface ScopedFinding extends Finding {
  scope: "affected" | "unaffected" | "cannot-scope";
  /** Why it is in scope: the cited files' changes, or "baseline-unknown" for a full re-check. */
  changes: Change[];
  reason: string;
}

export interface RecheckScope {
  auditFile: string;
  topic: string;
  head: string;
  mode: "scoped" | "full";
  baseline: { head: string | null; source: "verifiedHead" | "approvalHead" | "none"; label: string };
  findings: ScopedFinding[];
  /** Findings a human still has to look at: `changed` results not yet reviewed, and cannot-scope findings. */
  needsHumanReview: string[];
  counts: { total: number; affected: number; unaffected: number; cannotScope: number };
}

// --- git (local, read-only) --------------------------------------------------------------------

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-c", "core.quotePath=false", ...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 });
  } catch {
    return null;
  }
}
export const headOf = (cwd: string): string | null => git(cwd, ["rev-parse", "HEAD"])?.trim() || null;
const existsAt = (cwd: string, rev: string, rel: string): boolean => git(cwd, ["cat-file", "-e", `${rev}:./${rel}`]) !== null;
export const isCommit = (cwd: string, rev: string): boolean => git(cwd, ["cat-file", "-e", `${rev}^{commit}`]) !== null;

/** `git diff -z --name-status -M --relative base HEAD`: exact paths, renames as old -> new. */
export function changesSince(cwd: string, base: string, head: string): Change[] | null {
  const out = git(cwd, ["diff", "-z", "--name-status", "-M", "--relative", base, head]);
  if (out === null) return null;
  const t = out.split("\0");
  const changes: Change[] = [];
  for (let i = 0; i < t.length && t[i] !== ""; ) {
    const status = t[i];
    if (/^[RC]/.test(status)) {
      if (status.startsWith("R")) changes.push({ path: t[i + 1], change: "renamed", to: t[i + 2] });
      else changes.push({ path: t[i + 2], change: "added" }); // a copy adds the new path; the source is unchanged
      i += 3;
    } else {
      const kind = status[0] === "D" ? "deleted" : status[0] === "A" ? "added" : status[0] === "T" ? "type-changed" : "modified";
      changes.push({ path: t[i + 1], change: kind });
      i += 2;
    }
  }
  return changes;
}

// --- findings -----------------------------------------------------------------------------------

const nfc = (p: string) => p.normalize("NFC");
const sha = (s: string) => createHash("sha256").update(s, "utf-8").digest("hex");

/** A cited reference reduced to a repository path: no ./, no :line / #L / ::token suffix. */
export function citedPath(raw: string): string | null {
  let p = raw.trim().replace(/^\.\//, "").replace(/\\/g, "/");
  p = p.replace(/::.*$/, "").replace(/#L\d+(-L?\d+)?$/, "").replace(/:\d+(-\d+)?(:\d+)?$/, "");
  if (!p || /^(https?:|\/)/.test(p) || /[*?<>|]/.test(p)) return null;
  return p;
}
const looksLikePath = (s: string) => /\//.test(s) || /\.[A-Za-z0-9]{1,10}$/.test(s);

/** Parse the findings of an audit file. `exists` decides which body tokens are real paths. */
export function parseFindings(md: string, exists: (rel: string) => boolean): Finding[] {
  const lines = md.split("\n");
  let start = lines.findIndex((l) => /^##\s+Findings\s*$/i.test(l));
  let end = lines.length;
  if (start === -1) start = 0;
  else {
    const next = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
    if (next !== -1) end = next;
  }
  const blocks: Array<{ heading: string; body: string[] }> = [];
  for (let i = start; i < end; i++) {
    const m = /^###\s+(.*\S)\s*$/.exec(lines[i]);
    if (m) blocks.push({ heading: m[1], body: [] });
    else if (blocks.length) blocks[blocks.length - 1].body.push(lines[i]);
  }
  const seen = new Map<string, number>();
  return blocks.map(({ heading, body }) => {
    const severity = /^\[(HIGH|MEDIUM|LOW)\]/i.exec(heading)?.[1]?.toUpperCase() ?? null;
    const files = new Set<string>();
    for (const line of body) {
      const fileLine = /^\s*[-*]\s*\*\*Files?:\*\*\s*(.*)$/i.exec(line);
      if (fileLine) {
        const ticks = [...fileLine[1].matchAll(/`([^`]+)`/g)].map((x) => x[1]);
        const raw = ticks.length ? ticks : /unknown|multiple/i.test(fileLine[1]) ? [] : fileLine[1].split(",");
        for (const r of raw) { const p = citedPath(r); if (p && looksLikePath(p)) files.add(p); }
        continue;
      }
      for (const x of line.matchAll(/`([^`]+)`/g)) {
        const p = citedPath(x[1]);
        if (p && looksLikePath(p) && exists(p)) files.add(p);
      }
    }
    const sorted = [...files].sort();
    const key = `${heading.replace(/\s+/g, " ").trim()}\u0000${sorted.join("\u0000")}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    const id = `F-${sha(key).slice(0, 12)}${n > 1 ? `-${n}` : ""}`;
    return { id, heading, severity, files: sorted };
  });
}

// --- topic resolution ------------------------------------------------------------------------------

export interface AuditRow { index: string; status: string; topic: string; file: string }

export function auditRows(repoRoot: string): AuditRow[] {
  const p = join(repoRoot, "AUDIT.md");
  if (!existsSync(p)) return [];
  const rows: AuditRow[] = [];
  let inTable = false;
  for (const line of readFileSync(p, "utf-8").split("\n")) {
    if (/^\|\s*#\s*\|\s*Status\s*\|\s*Topic\s*\|/i.test(line)) { inTable = true; continue; }
    if (!inTable) continue;
    if (!line.trim().startsWith("|")) break;
    if (/^\|\s*-+\s*\|/.test(line)) continue;
    const c = line.split("|").slice(1, -1).map((x) => x.trim());
    if (c.length >= 6) rows.push({ index: c[0], status: c[1], topic: c[2], file: c[4] });
  }
  return rows;
}

export function findRow(repoRoot: string, topicOrFile: string): AuditRow | null {
  const want = topicOrFile.trim().replace(/^\.\//, "").replace(/\\/g, "/");
  const rows = auditRows(repoRoot);
  return rows.find((r) => r.file === want) ?? rows.find((r) => r.topic.toLowerCase() === want.toLowerCase()) ?? null;
}

// --- scope -----------------------------------------------------------------------------------------------

export interface TopicRecord {
  topic: string;
  approval?: { head: string | null; recordedAt: string | null; baseline: "recorded" | "unknown" };
  verification?: {
    verifiedHead: string | null;
    verifiedAt: string | null;
    findings: Record<string, any>;
    history: any[];
  };
}

export function readTopicRecord(repoRoot: string, auditFile: string): TopicRecord | null {
  try {
    const s = JSON.parse(readFileSync(join(repoRoot, ".ono", "state.json"), "utf-8"));
    return s?.audits?.[auditFile] ?? null;
  } catch {
    return null;
  }
}

export class RecheckError extends Error {}

export function computeScope(repoRoot: string, topicOrFile: string): RecheckScope {
  const row = findRow(repoRoot, topicOrFile);
  if (!row) throw new RecheckError(`No AUDIT.md topic or audit file matches "${topicOrFile}".`);
  if (row.status !== "Approved") throw new RecheckError(`Topic "${row.topic}" is ${row.status}; only Approved topics are re-checked.`);
  const auditAbs = join(repoRoot, row.file);
  if (!row.file || !existsSync(auditAbs)) throw new RecheckError(`Audit file for "${row.topic}" not found: ${row.file}`);
  const head = headOf(repoRoot);
  if (!head) throw new RecheckError("Cannot determine git HEAD; nothing can be scoped.");

  const record = readTopicRecord(repoRoot, row.file);
  const verified = record?.verification?.verifiedHead ?? null;
  const approved = record?.approval?.head ?? null;
  let base: string | null = verified ?? approved;
  const source: RecheckScope["baseline"]["source"] = verified ? "verifiedHead" : approved ? "approvalHead" : "none";
  let label = verified ? `last complete verification ${verified.slice(0, 7)}` : approved ? `approval ${approved.slice(0, 7)}` : "baseline unknown — approved before 0.13.0; full re-verification";
  if (base && !isCommit(repoRoot, base)) {
    label = `baseline unknown — recorded ${source} ${base.slice(0, 7)} is not in this repository's history; full re-verification`;
    base = null;
  }

  const exists = (rel: string) => (base !== null && existsAt(repoRoot, base, rel)) || existsAt(repoRoot, head, rel) || existsSync(join(repoRoot, rel));
  const findings = parseFindings(readFileSync(auditAbs, "utf-8"), exists);
  const changes = base ? changesSince(repoRoot, base, head) : [];
  if (changes === null) throw new RecheckError(`git diff ${base!.slice(0, 7)}..HEAD failed; the scope cannot be established.`);

  const under = (path: string, cited: string) => { const a = nfc(path), b = nfc(cited).replace(/\/$/, ""); return a === b || a.startsWith(`${b}/`); };
  const scoped: ScopedFinding[] = findings.map((f) => {
    const usable = f.files.filter((p) => exists(p) || changes.some((c) => under(c.path, p)));
    if (usable.length === 0) return { ...f, scope: "cannot-scope", changes: [], reason: "no usable file reference — manual review" };
    if (!base) return { ...f, scope: "affected", changes: [], reason: "baseline unknown — full re-verification" };
    const hit = changes.filter((c) => usable.some((p) => under(c.path, p)));
    return hit.length
      ? { ...f, scope: "affected", changes: hit, reason: "a cited file changed since the baseline" }
      : { ...f, scope: "unaffected", changes: [], reason: "no cited file changed since the baseline" };
  });

  const prev = record?.verification?.findings ?? {};
  const needsHumanReview = [
    ...Object.entries(prev).filter(([, v]) => v?.needsHumanReview && !v?.humanReviewedAt).map(([id]) => id),
    ...scoped.filter((f) => f.scope === "cannot-scope").map((f) => f.id),
  ];
  return {
    auditFile: row.file,
    topic: row.topic,
    head,
    mode: base ? "scoped" : "full",
    baseline: { head: base, source: base ? source : "none", label },
    findings: scoped,
    needsHumanReview: [...new Set(needsHumanReview)].sort(),
    counts: {
      total: scoped.length,
      affected: scoped.filter((f) => f.scope === "affected").length,
      unaffected: scoped.filter((f) => f.scope === "unaffected").length,
      cannotScope: scoped.filter((f) => f.scope === "cannot-scope").length,
    },
  };
}

/** Last commit in (base, HEAD] touching any of the paths — a CANDIDATE fixing commit only. */
export function candidateCommit(repoRoot: string, base: string | null, paths: string[]): string | null {
  if (paths.length === 0) return null;
  const range = base ? [`${base}..HEAD`] : ["HEAD"];
  const out = git(repoRoot, ["log", "-1", "--format=%H", ...range, "--", ...paths.map((p) => `:(literal)${p}`)]);
  return out?.trim() || null;
}

/** True when `commit` is in (base, HEAD] and touches one of the paths. */
export function commitTouches(repoRoot: string, base: string | null, commit: string, paths: string[]): boolean {
  const full = git(repoRoot, ["rev-parse", "--verify", "-q", `${commit}^{commit}`])?.trim();
  if (!full || paths.length === 0) return false;
  const range = base ? [`${base}..HEAD`] : ["HEAD"];
  const out = git(repoRoot, ["log", "--format=%H", ...range, "--", ...paths.map((p) => `:(literal)${p}`)]);
  return (out ?? "").split("\n").includes(full);
}

function main(): void {
  const [, , command, repoRoot, topic] = process.argv;
  if (command !== "scope" || !repoRoot || !topic) {
    console.error('Usage: audit-recheck.ts scope "<repo-root>" "<topic | audits/…-audit.md>"');
    process.exit(1);
  }
  try {
    console.log(JSON.stringify(computeScope(repoRoot, topic), null, 2));
    process.exit(0);
  } catch (err) {
    console.error(err instanceof RecheckError ? err.message : `Scope failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

if (isEntryPoint(import.meta.url)) {
  useBlockingOutput();
  main();
}
