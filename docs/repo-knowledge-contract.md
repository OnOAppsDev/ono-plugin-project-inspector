# Repository Knowledge Contract

**Schema version: 1**
Producer: `ono-project-inspector` (this plugin), via `skills/repo-knowledge` and `scripts/repo-knowledge.ts`.
Consumers: `ono-mobile-dev-plugin` (and future Ono plugins), via their own deterministic reader.

> This file is duplicated verbatim (below the title line) in every plugin that participates in the contract. Claude Code has no cross-plugin dependency mechanism, so the specification is vendored the same way `resolve-target-repo-root.ts` is. **When this file changes, change every copy in the same release.**

## The file

`<repository-root>/.ono/repo-knowledge.json` — committed to Git, portable, machine-generated.

## Guarantees the producer makes

1. **Derived, never authored.** Built only from `CLAUDE.md`, `AUDIT.md`, and `docs/project/*.md` — artifacts this plugin's workflow already produced and a human already approved. No repository source is read. No audit file body is read.
2. **Deterministic.** Identical inputs produce a byte-identical file except `generatedAt`. `stack.*` list fields are sorted and de-duplicated (via `toList`); `auditTopics[]`, `documents.<key>.anchors` and `surfaces[]` instead preserve source-document order — itself deterministic, and the property a consumer needs to cite sections in document order. `capabilities[]` and `capabilityRelationships[]` are sorted by `id`, and every list inside a surface, shared-code root, capability or relationship is sorted, so a regenerated document listing the same facts in a different order indexes identically.
3. **Portable.** Only repo-relative paths, content hashes, and the git HEAD SHA. Never an absolute filesystem path.
4. **Pointers, not copies.** Prose stays in the artifact. The manifest carries a path and heading anchors.
5. **Honest coverage.** A category that could not be parsed is reported `unknown`, never guessed.
6. **Additive versioning.** New optional fields keep `repoKnowledgeSchemaVersion: 1`. A breaking shape change bumps it.
7. **Knowledge-authoring HEAD is never advanced by a re-emit.** `fingerprint.knowledgeHead` is the git HEAD at which the source-backed knowledge (`CLAUDE.md` stack/commands/structure, `docs/project/*.md`) was last actually generated from repository source. It advances only when a source-backed inspection stage regenerates that knowledge — never when the manifest is merely re-emitted (after an audit approval, `audit-sync`, or `/inspect-sync`). A multi-stage regeneration advances it only once every stage in it has regenerated at the same HEAD. It is never set to the current HEAD as a default.
8. **Every persisted surface, capability and relationship is evidence-backed.** Before `record-knowledge` certifies a source-backed stage, `scripts/knowledge-evidence.ts verify` resolves every evidence ref against the repository's current source (see "Evidence refs"); a fact that cannot be proven stops the stage. Relationships are direct (first-degree) edges proven by a concrete source edge — never by naming or semantic similarity — and are never scored or expanded transitively. Volatile platform knowledge (SDK/OS release notes, OS capabilities, vendor bugs, recommended practices) is never persisted; a repository workaround for one is recorded as a repository fact with its location.
9. **Advisory, never authoritative over code.** Project Knowledge describes the repository at `knowledgeHead`. The current repository source is authoritative whenever the two disagree. Project Knowledge never decides Dev Plugin routing: `platformHints`, `surfaces[].platform` and `surfaces[].formFactor` are descriptive, and `formFactor` (`handheld | desktop | tv | wearable | other`) is deliberately not a `device_type`.

## Obligations the consumer accepts

1. **Read-only.** Never write `.ono/repo-knowledge.json`, `CLAUDE.md`, `AUDIT.md`, `docs/project/**`, `audits/**`, or `.ono/state.json`.
2. **One reader.** Exactly one component per consumer plugin parses the manifest. Commands and agents receive its normalized output.
3. **Cite, do not copy.** Downstream documents record `{ path, anchor, fingerprint }`, never a verbatim paste of repository knowledge.
4. **Degrade, never fail.** An absent, malformed, stale, or too-new manifest is never fatal. Fall back to live derivation.
5. **Do not re-derive a covered, fresh category.**
6. **Derive any `unknown` category yourself.**
7. **Report drift, never repair it.** Recommend `/inspect` (which offers **Refresh Project Knowledge** when source changed since the knowledge was generated) or `/inspect-sync` (which re-indexes artifacts and the manifest, but never refreshes source-backed knowledge); never regenerate a producer-owned artifact.
8. **`platformHints` is advisory only.** It must never be used as the authoritative platform for routing or for a feature decision. The consumer runs its own platform detection and its own human confirmation gate regardless.
9. **Surfaces and capabilities are advisory too.** `surfaces[]` may prefill or scope a consumer's own confirmation (which surface a change targets, which `surfaceAnchors` apply once a surface is confirmed), but never replaces it and never resolves `device_type`. A capability relationship is a first-degree starting point: before relying on it, re-check its `evidence` refs against the current source; expanding the graph beyond first degree is the consumer's own analysis.

## Schema v1

See the `RepoKnowledge` interface in `scripts/repo-knowledge.ts` for the authoritative type. The generic surface and capability model is additive within v1: `surfaces`, `sharedCode`, `capabilities`, `capabilityRelationships`, `structure.surfaces` and `documents.<key>.surfaceAnchors` may be absent in a manifest from an older producer, and a consumer treats absence exactly as `coverage: unknown` (derive live), never as an error. Field reference:

| Field | Type | Meaning |
|---|---|---|
| `repoKnowledgeSchemaVersion` | `1` | Contract version. A consumer supporting max version N treats `> N` as absent. |
| `producedBy` | `{plugin, version}` | Which plugin and version wrote it. |
| `generatedAt` | ISO-8601 | Emit time. The only field that varies between two emits over identical inputs. |
| `fingerprint.gitHead` | sha \| null | HEAD at emit time. Differs from current HEAD → `stale-head`. Advances on every emit, including a metadata-only re-emit, so it does **not** establish that source-backed knowledge is current. |
| `fingerprint.knowledgeHead` | sha \| null \| absent | *Optional (additive, v1).* HEAD at which source-backed knowledge was last generated (Guarantee 7). `null` = not recorded (an inspection completed before the producer recorded it). Absent = manifest written by a producer older than 0.10.0; treat exactly as `null`. Always an ancestor-or-equal of `gitHead` in normal history. |
| `fingerprint.artifacts` | `{relpath: sha256 \| null}` | Per-source-document hash. `null` = the document did not exist. A mismatch → `stale-artifacts` for the categories that document backs. |
| `coverage.<category>` | `populated \| partial \| unknown` | Per-category trust for `stack`, `commands`, `structure`, `inventory`, `conventions`, `integrations`, `auditTopics`, and (additive) `surfaces`, `capabilities`. `partial` for the additive categories means some rows were rejected as malformed and are not indexed. |
| `stack` | `{languages, frameworks, platformHints, runtimeTooling, packageManagers}` | Sorted string lists. `platformHints` is **advisory only**. |
| `commands` | `{install, run, test, build}` | Strings or `null`. `null` means not known. |
| `structure` | `{repositoryTree, keyModules, entryPoints, surfaces?}` | `CLAUDE.md#anchor` pointers, or `null` when `CLAUDE.md` is absent. *Additive:* `surfaces` = `CLAUDE.md#targets-and-surfaces`, present only when that section exists (so an older `CLAUDE.md` yields a byte-identical `structure`). `coverage.structure` is still computed over the first three only. |
| `documents.<key>` | `{path, exists, anchors, surfaceAnchors}` | Keys: `claudeMd`, `auditMd`, `overview`, `inventory`, `conventions`, `integrations`, and (additive) `capabilities`. `anchors` holds GitHub-style heading anchors, re-derived on every emit, and is populated **only** for the `docs/project/*` documents — `claudeMd` and `auditMd` always carry `[]` and are cited through `structure`'s fixed pointers instead. A repeated heading gets a deterministic `-1`, `-2`, … suffix (never dropped); unique headings keep their anchor. *Additive:* `surfaceAnchors` = `{ <surfaceId>: [{ section, anchor }] }` — the per-surface override headings (`### <Section> (<surface-id>)`) under their shared `section`; a surface with no key inherits every shared convention; always `{}` for `claudeMd` / `auditMd`. |
| `auditTopics[]` | `{topic, slug, status, file}` | Index over `AUDIT.md`'s topic table. **Index only — no findings.** |
| `surfaces[]` | `{id, platform, formFactor, buildSelector, sourceRoots, sharedWith, packaging, minimumRuntime, evidence}` | *Optional (additive, v1).* One per independently built/shipped target, from `CLAUDE.md#targets-and-surfaces`, in declaration order (the first is the one `commands` describe). `formFactor` ∈ `handheld \| desktop \| tv \| wearable \| other`, or `null` when the document's value was not one of them. `minimumRuntime` only as declared in the repository's build files, else `null`. Absent = produced before 0.11.0: treat as `coverage.surfaces: unknown`. |
| `sharedCode[]` | `{root, sharedBy, mechanism, evidence}` | *Optional (additive, v1).* Source roots shared by two or more surfaces — each represented once. |
| `capabilities[]` | `{id, name, anchor, surfaceScope, surfaces, sourceRoots, entryPoints, components, services, routes, dataDependencies, stateOwnership, tests, evidence, relationships}` | *Optional (additive, v1).* The Feature & Capability Map from `docs/project/capabilities.md`. `anchor` = `docs/project/capabilities.md#capability-<id>`. `surfaceScope` `all` (then `surfaces` lists every declared surface) or `subset`. `sourceRoots` = `[{path, surface}]` (`surface` non-null for a surface-specific root of a shared capability — shared code appears once). `components` / `dataDependencies` = `[{name, anchor}]` pointers into `components.md` / `integrations.md` (`anchor: null` = unresolved); descriptions are never copied. `entryPoints`, `services`, `routes`, `stateOwnership`, `tests`, `evidence` = evidence refs. `relationships` = ids of every first-degree relationship this capability is an endpoint of. |
| `capabilityRelationships[]` | `{id, from, type, to, evidenceKind, evidence, anchor}` | *Optional (additive, v1).* Direct, evidence-backed edges. `type` ∈ `depends_on \| used_by \| contains \| navigates_to \| shares_component_with \| shares_state_with \| reads_from \| writes_to \| covered_by \| related_to`; `evidenceKind` ∈ `import \| navigation-route \| shared-component \| shared-state \| shared-service \| shared-data-source \| test \| repository-doc`; `evidence` non-empty refs. `id` = `<from>:<type>:<to>`; for the symmetric types (`shares_component_with`, `shares_state_with`, `related_to`) `from` < `to`, so each edge exists once. `anchor` = `docs/project/capabilities.md#relationships`. |

**Not in v1:** audit findings / cautions, platform capability beyond `platformHints`, `device_type` or any routing decision, impact scores or transitive capability graphs, task lifecycle state. These are deliberate exclusions, not omissions; each is a separate project.

### Evidence refs

Wherever the manifest carries evidence (`surfaces[].evidence`, `sharedCode[].evidence`, a capability's ref fields, `capabilityRelationships[].evidence`), each entry is a repo-relative ref: `path` (the file or directory must exist) or `path::token` (the literal `token` must occur in that file). Evidence always points at repository source, build files, or repository documentation — never at `CLAUDE.md`, `AUDIT.md`, `docs/project/**`, `audits/**`, or `.ono/**`. A consumer verifies a fact by re-checking these refs against the current source; a ref that no longer resolves means the fact moved, and the current code wins.

### Surface-scoped knowledge

Conventions are written once as the shared body of a `docs/project/patterns.md` section; a surface that differs gets `### <Section> (<surface-id>)` under that section, indexed in `documents.conventions.surfaceAnchors`. To read the conventions for a confirmed surface, read the shared section, then that surface's override for the section if `surfaceAnchors` lists one. Inventory and integration rows carry a `Surface` cell (`all` or surface ids) in the documents themselves.

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
| `surfaces` *(additive)* | `CLAUDE.md#targets-and-surfaces` | targets/surfaces, their roots, shared code — scoping only, never routing |
| `capabilities` *(additive)* | `docs/project/capabilities.md` | capabilities, their references, and first-degree relationships — the starting change surface for a feature |

## Freshness verdicts

| Verdict | Condition | Consumer behavior |
|---|---|---|
| `fresh` | `gitHead` and current HEAD are both known and equal, and every recorded hash matches | Trust all non-`unknown` categories. |
| `stale-head` | HEAD moved, all recorded hashes still match | Trust the manifest; report how far behind. |
| `stale-artifacts` | A recorded hash no longer matches | Trust unaffected categories; derive the affected ones live; report it. |
| `unknown` | `gitHead` is null, or current HEAD cannot be determined (git unavailable) | Trust the manifest; report that freshness could not be established. |

Verdicts are evaluated in this precedence order, and the first matching condition wins: `stale-artifacts`, then `unknown`, then `stale-head`, then `fresh`.

The verdicts above are defined over `gitHead` and are unchanged by the addition of `fingerprint.knowledgeHead`.

## Producer-side source drift

The producer derives, on every `/inspect` of a completed inspection, whether source-backed knowledge is stale: it compares `knowledgeHead` with the current HEAD and ignores changes confined to producer-owned paths — `.ono/**`, `CLAUDE.md`, `AUDIT.md`, `CLAUDE.md.bak`, `AUDIT.md.bak`, `docs/project/**`, `audits/**`. Any other changed path is source drift, and the producer offers **Refresh Project Knowledge**, which regenerates the source-backed documents in place, preserves every audit topic status and `CLAUDE.md` managed block, and re-emits this manifest with an advanced `knowledgeHead`. This status is not persisted in the manifest.

The same flow covers two more signals — no second freshness mechanism:

- **Surface-defining changes** re-run `project-analysis` (it owns `surfaces`): build/dependency/CI manifests, surface-declaring files (Xcode schemes and `.xcconfig`, project generators, `AndroidManifest.xml`, RN/Expo app config, web bundler configs, Smart TV app descriptors), any file recorded as surface or shared-code evidence, and top-level entries appearing or disappearing.
- **Knowledge-model gaps.** Each source-backed stage declares a `knowledgeModel` in the producer's registry — the sections (`path#anchor`) and artifacts its output must contain (`CLAUDE.md#targets-and-surfaces`; `docs/project/capabilities.md` and the seven generic `patterns.md` sections). Output produced before a requirement existed makes the next `/inspect` recommend a refresh of that stage and every downstream source-backed stage, even with no source drift. `record-knowledge` refuses to certify output with a gap, so `knowledgeHead` advances exactly as before: only when regenerated, model-complete knowledge is recorded.

Alongside drift the producer reports (never persists) which recorded capabilities, relationships and surfaces a changed file falls under — attribution for the refresh report and a hint for a consumer's verify-on-use, not a verdict. Capabilities and relationships are `docs/project`-backed, so any source drift already re-runs the stage that regenerates them, and a relationship whose source edge disappeared fails the evidence gate until the refreshed map drops it.
