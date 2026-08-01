# Repository Knowledge Contract

**Schema version: 1**
Producer: `ono-project-inspector` (this plugin), via `skills/repo-knowledge` and `scripts/repo-knowledge.ts`.
Consumers: `ono-mobile-dev-plugin` (and future Ono plugins), via their own deterministic reader.

> This file is duplicated verbatim (below the title line) in every plugin that participates in the contract. Claude Code has no cross-plugin dependency mechanism, so the specification is vendored the same way `resolve-target-repo-root.ts` is. **When this file changes, change every copy in the same release.**

## The file

`<repository-root>/.ono/repo-knowledge.json` — committed to Git, portable, machine-generated.

## Guarantees the producer makes

1. **Derived, never authored.** Built only from `CLAUDE.md`, `AUDIT.md`, and `docs/project/*.md` — artifacts this plugin's workflow already produced and a human already approved. No repository source is read. No audit file body is read.
2. **Deterministic.** Identical inputs produce a byte-identical file except `generatedAt`. `stack.*` list fields are sorted and de-duplicated (via `toList`); `auditTopics[]` and `documents.<key>.anchors` instead preserve source-document order — itself deterministic, and the property a consumer needs to cite sections in document order.
3. **Portable.** Only repo-relative paths, content hashes, and the git HEAD SHA. Never an absolute filesystem path.
4. **Pointers, not copies.** Prose stays in the artifact. The manifest carries a path and heading anchors.
5. **Honest coverage.** A category that could not be parsed is reported `unknown`, never guessed.
6. **Additive versioning.** New optional fields keep `repoKnowledgeSchemaVersion: 1`. A breaking shape change bumps it.

## Obligations the consumer accepts

1. **Read-only.** Never write `.ono/repo-knowledge.json`, `CLAUDE.md`, `AUDIT.md`, `docs/project/**`, `audits/**`, or `.ono/state.json`.
2. **One reader.** Exactly one component per consumer plugin parses the manifest. Commands and agents receive its normalized output.
3. **Cite, do not copy.** Downstream documents record `{ path, anchor, fingerprint }`, never a verbatim paste of repository knowledge.
4. **Degrade, never fail.** An absent, malformed, stale, or too-new manifest is never fatal. Fall back to live derivation.
5. **Do not re-derive a covered, fresh category.**
6. **Derive any `unknown` category yourself.**
7. **Report drift, never repair it.** Recommend `/inspect` or `/inspect-sync`; never regenerate a producer-owned artifact.
8. **`platformHints` is advisory only.** It must never be used as the authoritative platform for routing or for a feature decision. The consumer runs its own platform detection and its own human confirmation gate regardless.

## Schema v1

See the `RepoKnowledge` interface in `scripts/repo-knowledge.ts` for the authoritative type. Field reference:

| Field | Type | Meaning |
|---|---|---|
| `repoKnowledgeSchemaVersion` | `1` | Contract version. A consumer supporting max version N treats `> N` as absent. |
| `producedBy` | `{plugin, version}` | Which plugin and version wrote it. |
| `generatedAt` | ISO-8601 | Emit time. The only field that varies between two emits over identical inputs. |
| `fingerprint.gitHead` | sha \| null | HEAD at emit time. Differs from current HEAD → `stale-head`. |
| `fingerprint.artifacts` | `{relpath: sha256 \| null}` | Per-source-document hash. `null` = the document did not exist. A mismatch → `stale-artifacts` for the categories that document backs. |
| `coverage.<category>` | `populated \| partial \| unknown` | Per-category trust for `stack`, `commands`, `structure`, `inventory`, `conventions`, `integrations`, `auditTopics`. |
| `stack` | `{languages, frameworks, platformHints, runtimeTooling, packageManagers}` | Sorted string lists. `platformHints` is **advisory only**. |
| `commands` | `{install, run, test, build}` | Strings or `null`. `null` means not known. |
| `structure` | `{repositoryTree, keyModules, entryPoints}` | `CLAUDE.md#anchor` pointers, or `null` when `CLAUDE.md` is absent. |
| `documents.<key>` | `{path, exists, anchors}` | Keys: `claudeMd`, `auditMd`, `overview`, `inventory`, `conventions`, `integrations`. `anchors` holds GitHub-style heading anchors, re-derived on every emit, and is populated **only** for the four `docs/project/*` documents — `claudeMd` and `auditMd` always carry `[]` and are cited through `structure`'s fixed pointers instead. |
| `auditTopics[]` | `{topic, slug, status, file}` | Index over `AUDIT.md`'s topic table. **Index only — no findings.** |

**Not in v1:** audit findings / cautions, platform capability beyond `platformHints`, device targets, task lifecycle state. These are deliberate exclusions, not omissions; each is a separate project.

## Category → backing document

| Category | Backed by | Consumer uses it for |
|---|---|---|
| `stack` | `CLAUDE.md` facts block, else Tech Stack bullets | languages/frameworks/tooling context |
| `commands` | `CLAUDE.md` facts block, else the Commands fenced block | install/run/test/build |
| `structure` | `CLAUDE.md` | repository tree, key modules, entry points |
| `inventory` | `docs/project/components.md` | existing screens, components, hooks — reuse before creating |
| `conventions` | `docs/project/patterns.md` | state management, API, navigation, styling, errors, i18n, naming, testing |
| `integrations` | `docs/project/integrations.md` | services, SDKs, env-var names |
| `auditTopics` | `AUDIT.md` | which topics exist and their approval status |

## Freshness verdicts

| Verdict | Condition | Consumer behavior |
|---|---|---|
| `fresh` | `gitHead` and current HEAD are both known and equal, and every recorded hash matches | Trust all non-`unknown` categories. |
| `stale-head` | HEAD moved, all recorded hashes still match | Trust the manifest; report how far behind. |
| `stale-artifacts` | A recorded hash no longer matches | Trust unaffected categories; derive the affected ones live; report it. |
| `unknown` | `gitHead` is null, or current HEAD cannot be determined (git unavailable) | Trust the manifest; report that freshness could not be established. |

Verdicts are evaluated in this precedence order, and the first matching condition wins: `stale-artifacts`, then `unknown`, then `stale-head`, then `fresh`.
