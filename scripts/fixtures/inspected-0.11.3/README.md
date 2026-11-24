# Fixture: a repository inspected by Inspector 0.11.3

`tree/` is the complete working tree of a small Smart TV project after a full
inspection (project-analysis, project-docs, one audit topic broken down and
approved) by **Inspector 0.11.3 running under Bun** — the last Bun-based release.
It was produced with the unmodified 0.11.3 helpers from `origin/main` (b6c89e0),
not hand-written, so it is real 0.11.x output: `.ono/state.json`,
`.ono/repo-knowledge.json`, `CLAUDE.md`, `AUDIT.md`, `docs/project/*.md` and
`audits/`.

The project was committed in two deterministic commits (fixed author, committer
and dates; see `compat-0.11.test.ts`):

1. `source` — everything except the Inspector's artifacts. Its commit ID,
   `d7335feb9de91547775e044197e9b80644189fd5`, is the `knowledgeHead` recorded in
   the stored state and manifest, so the test can recreate the same history and
   the stored freshness data stays valid.
2. the Inspector's artifacts.

`scripts/compat-0.11.test.ts` loads this tree under Node.js and checks that 0.12.0
continues it without a re-inspection, and that the outputs of the Node.js helpers
match the stored 0.11.3 (Bun) outputs apart from timestamps and the plugin
version. Do not regenerate or edit these files: they are the compatibility
baseline.
