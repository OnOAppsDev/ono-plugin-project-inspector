/**
 * knowledge-refresh-guard.ts
 *
 * Deterministic preservation guard for a Project Knowledge refresh. The
 * project-inspector agent runs `snapshot` before re-running any source-backed
 * stage in Update mode, and `verify` after that stage's after-hook passes. The
 * guard proves the refresh did not destroy previously approved inspection
 * work:
 *
 * - every AUDIT.md topic row still exists (matched by topic name) with the same
 *   Status and File reference — new rows may be added, none may disappear;
 * - every `Approved <YYYY-MM-DD>` approval note audit-approve recorded is kept;
 * - every CLAUDE.md `audit-sync:*` managed block is still present and
 *   byte-identical (audit-sync owns them; a refresh must not touch them).
 *
 * It is a check, not a repair: on a violation it reports and keeps the
 * snapshot, and the agent stops so the developer can restore from Git.
 *
 * Usage:
 *   bun scripts/knowledge-refresh-guard.ts <snapshot|verify> <repo-root>
 *
 * Exit codes:
 *   0 - snapshot written / verify passed (snapshot removed)
 *   1 - usage error, missing repo root, or a .claude/worktrees path
 *   2 - verify called with no snapshot (or an unreadable one)
 *   3 - verify found approved work that the refresh destroyed
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync, rmSync } from "fs";
import { join, sep } from "path";

const WORKTREE_MARKER = `${sep}.claude${sep}worktrees${sep}`;
const SNAPSHOT_REL = join(".ono", "knowledge-refresh-snapshot.json");

interface TopicRow {
  status: string;
  topic: string;
  file: string;
  notes: string;
}

interface Snapshot {
  takenAt: string;
  topics: TopicRow[];
  managedBlocks: Record<string, string>;
}

function readIfExists(repoRoot: string, rel: string): string | null {
  const p = join(repoRoot, rel);
  return existsSync(p) ? readFileSync(p, "utf-8") : null;
}

/** Same row-shape logic as scripts/inspection-state.ts and scripts/repo-knowledge.ts. */
export function parseTopicRows(md: string | null): TopicRow[] {
  if (!md) return [];
  const rows: TopicRow[] = [];
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
    rows.push({ status: cells[1], topic: cells[2], file: cells[4], notes: cells[5] });
  }
  return rows;
}

/** Every `<!-- audit-sync:<name>:start --> ... <!-- audit-sync:<name>:end -->` block, keyed by name. */
export function parseManagedBlocks(md: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!md) return out;
  const re = /<!--\s*audit-sync:([a-z0-9-]+):start\s*-->([\s\S]*?)<!--\s*audit-sync:\1:end\s*-->/g;
  for (const m of md.matchAll(re)) out[`audit-sync:${m[1]}`] = m[2];
  return out;
}

function approvalNotes(notes: string): string[] {
  return notes.match(/Approved \d{4}-\d{2}-\d{2}/g) ?? [];
}

export function takeSnapshot(repoRoot: string): Snapshot {
  return {
    takenAt: new Date().toISOString(),
    topics: parseTopicRows(readIfExists(repoRoot, "AUDIT.md")),
    managedBlocks: parseManagedBlocks(readIfExists(repoRoot, "CLAUDE.md")),
  };
}

export function findViolations(before: Snapshot, repoRoot: string): string[] {
  const violations: string[] = [];
  const now = parseTopicRows(readIfExists(repoRoot, "AUDIT.md"));
  const byTopic = new Map(now.map((r) => [r.topic.toLowerCase(), r]));
  for (const row of before.topics) {
    const cur = byTopic.get(row.topic.toLowerCase());
    if (!cur) {
      violations.push(`AUDIT.md topic "${row.topic}" (${row.status}) was removed.`);
      continue;
    }
    if (cur.status !== row.status) {
      violations.push(`AUDIT.md topic "${row.topic}" status changed: ${row.status} -> ${cur.status}.`);
    }
    if (cur.file !== row.file) {
      violations.push(`AUDIT.md topic "${row.topic}" file reference changed: ${row.file} -> ${cur.file}.`);
    }
    for (const note of approvalNotes(row.notes)) {
      if (!cur.notes.includes(note)) violations.push(`AUDIT.md topic "${row.topic}" lost its approval note "${note}".`);
    }
  }
  const blocks = parseManagedBlocks(readIfExists(repoRoot, "CLAUDE.md"));
  for (const [name, body] of Object.entries(before.managedBlocks)) {
    if (!(name in blocks)) violations.push(`CLAUDE.md managed block <!-- ${name} --> was removed.`);
    else if (blocks[name] !== body) violations.push(`CLAUDE.md managed block <!-- ${name} --> content changed.`);
  }
  return violations;
}

function cmdSnapshot(repoRoot: string): void {
  const snap = takeSnapshot(repoRoot);
  const dir = join(repoRoot, ".ono");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(repoRoot, SNAPSHOT_REL), JSON.stringify(snap, null, 2) + "\n", "utf-8");
  console.log(
    `Snapshot written to ${SNAPSHOT_REL}: ${snap.topics.length} topic row(s), ` +
      `${Object.keys(snap.managedBlocks).length} managed block(s).`
  );
  process.exit(0);
}

function cmdVerify(repoRoot: string): void {
  const p = join(repoRoot, SNAPSHOT_REL);
  if (!existsSync(p)) {
    console.error(`No snapshot at ${SNAPSHOT_REL}. Run "snapshot" before the refresh.`);
    process.exit(2);
  }
  let before: Snapshot;
  try {
    before = JSON.parse(readFileSync(p, "utf-8"));
  } catch (err) {
    console.error(`Snapshot is not valid JSON: ${(err as Error).message}`);
    process.exit(2);
  }
  const violations = findViolations(before, repoRoot);
  if (violations.length) {
    console.log(
      `Refresh destroyed approved inspection work (${violations.length} issue(s)):\n- ${violations.join("\n- ")}\n` +
        `Snapshot kept at ${SNAPSHOT_REL}. Restore the affected files from Git before continuing.`
    );
    process.exit(3);
  }
  rmSync(p);
  console.log(
    `Refresh preserved approved work: ${before.topics.length} topic row(s), ` +
      `${Object.keys(before.managedBlocks).length} managed block(s) intact.`
  );
  process.exit(0);
}

function main(): void {
  const [, , command, repoRoot] = process.argv;
  if (!command || !repoRoot) {
    console.error("Usage: knowledge-refresh-guard.ts <snapshot|verify> <repo-root>");
    process.exit(1);
  }
  if (!existsSync(repoRoot)) {
    console.error(`Repository root not found: ${repoRoot}`);
    process.exit(1);
  }
  if (realpathSync(repoRoot).includes(WORKTREE_MARKER)) {
    console.error(
      `Refusing to operate on a Claude agent worktree: ${repoRoot}\n` +
        `Pass the resolved main repository root (scripts/resolve-repo-root.ts).`
    );
    process.exit(1);
  }
  switch (command) {
    case "snapshot":
      return cmdSnapshot(repoRoot);
    case "verify":
      return cmdVerify(repoRoot);
    default:
      console.error(`Unknown command "${command}".`);
      process.exit(1);
  }
}

if (require.main === module) {
  main();
}
