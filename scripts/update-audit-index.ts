/**
 * update-audit-index.ts
 *
 * Deterministic verification helper for the "Audit Topics" table in
 * AUDIT.md. Invoked by hooks/after-audit-breakdown.md after the
 * audit-breakdown skill reports it updated one topic row.
 *
 * IMPORTANT: This script is read-only / verification-only in its default
 * mode. It never writes to AUDIT.md or any source file on its own — the
 * plugin's hard constraint is that only the skills themselves (per their
 * own output contracts) write repository files. This script exists to catch
 * drift between what a skill claims to have written and what is actually in
 * AUDIT.md, so the orchestrating agent can surface a discrepancy to the
 * developer instead of trusting free-form LLM output blindly.
 *
 * Usage:
 *   npx ts-node update-audit-index.ts <path-to-AUDIT.md> <topic-name>
 *
 * Exit codes:
 *   0 - the row for <topic-name> is well-formed and matches the expected slug
 *   1 - AUDIT.md or the topic row could not be found
 *   2 - the row exists but is inconsistent (e.g. wrong file path, bad status)
 */

import { readFileSync } from "fs";
import { slugify } from "./slugify.ts";
import { isEntryPoint, useBlockingOutput } from "./entrypoint.ts";

interface TopicRow {
  index: string;
  status: string;
  topic: string;
  priority: string;
  file: string;
  notes: string;
  raw: string;
}

function parseAuditTopicsTable(markdown: string): TopicRow[] {
  const lines = markdown.split("\n");
  const rows: TopicRow[] = [];
  let inTable = false;

  for (const line of lines) {
    if (/^\|\s*#\s*\|\s*Status\s*\|\s*Topic\s*\|/i.test(line)) {
      inTable = true;
      continue;
    }
    if (inTable) {
      if (!line.trim().startsWith("|")) break; // table ended
      if (/^\|\s*-+\s*\|/.test(line)) continue; // header separator row
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
      if (cells.length < 6) continue;
      const [index, status, topic, priority, file, ...noteParts] = cells;
      rows.push({ index, status, topic, priority, file, notes: noteParts.join(" | "), raw: line });
    }
  }
  return rows;
}

function main(): void {
  const [, , auditPath, topicName] = process.argv;
  if (!auditPath || !topicName) {
    console.error("Usage: update-audit-index.ts <path-to-AUDIT.md> <topic-name>");
    process.exit(1);
  }

  let content: string;
  try {
    content = readFileSync(auditPath, "utf-8");
  } catch (err) {
    console.error(`Could not read AUDIT.md at ${auditPath}: ${(err as Error).message}`);
    process.exit(1);
  }

  const rows = parseAuditTopicsTable(content);
  const row = rows.find((r) => r.topic.toLowerCase() === topicName.toLowerCase());

  if (!row) {
    console.error(`No row found for topic "${topicName}" in ${auditPath}`);
    process.exit(1);
  }

  const expectedSlug = slugify(row.topic);
  const expectedFile = `audits/${expectedSlug}/${expectedSlug}-audit.md`;

  const problems: string[] = [];

  if (row.status !== "Draft" && row.status !== "Approved") {
    problems.push(`Unexpected status "${row.status}" (expected "Draft", or "Approved" if the developer already signed off).`);
  }
  if ((row.status === "Draft" || row.status === "Approved") && row.file !== expectedFile) {
    problems.push(`File column is "${row.file}", expected "${expectedFile}" based on the deterministic slug rule.`);
  }
  if (row.file === "Not created yet" && row.status !== "Pending Breakdown") {
    problems.push(`Status is "${row.status}" but File is still "Not created yet".`);
  }

  if (problems.length > 0) {
    console.error(`Inconsistency detected for topic "${row.topic}":`);
    for (const p of problems) console.error(` - ${p}`);
    process.exit(2);
  }

  console.log(`OK: "${row.topic}" row is consistent (status=${row.status}, file=${row.file}).`);
  process.exit(0);
}

if (isEntryPoint(import.meta.url)) {
  useBlockingOutput();
  main();
}
