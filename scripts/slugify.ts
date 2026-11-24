/**
 * slugify.ts
 *
 * Single source of truth for the topic-name -> slug rule used by the
 * audit-breakdown skill (see skills/audit-breakdown/SKILL.md, Step 4) and by
 * scripts/update-audit-index.ts. Keeping this logic in one deterministic
 * function avoids the slug drifting between what the LLM-driven skill writes
 * and what a verification script expects.
 *
 * Rules (must match SKILL.md Step 4 exactly):
 * - Lowercase all letters.
 * - Replace spaces and "/" with "-".
 * - Remove special characters.
 * - Collapse repeated hyphens.
 * - Trim leading/trailing hyphens.
 */

import { isEntryPoint } from "./entrypoint.ts";

export function slugify(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/[\s/]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Quick self-check examples from SKILL.md, run with: node --no-warnings scripts/slugify.ts
if (isEntryPoint(import.meta.url)) {
  const cases: Array<[string, string]> = [
    ["Architecture", "architecture"],
    ["Managers and Singletons", "managers-and-singletons"],
    ["Player / Media", "player-media"],
    ["UI / Navigation", "ui-navigation"],
  ];

  let failures = 0;
  for (const [input, expected] of cases) {
    const actual = slugify(input);
    const ok = actual === expected;
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"}  "${input}" -> "${actual}" (expected "${expected}")`);
  }
  process.exit(failures > 0 ? 1 : 0);
}
