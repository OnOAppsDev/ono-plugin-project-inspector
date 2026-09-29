---
name: project-docs
description: >-
  Generates a docs/project/ knowledge base for an already-analyzed repository:
  overview.md (plain-language project overview), components.md (reusable
  component and screen inventory, scoped by surface), patterns.md (state
  management, API, navigation, styling, and the generic architecture / input /
  lifecycle / media / platform-adapter / accessibility / performance
  conventions — shared, with per-surface overrides), integrations.md (SDKs,
  APIs, external services — names only, no secrets), and capabilities.md (the
  evidence-backed Feature & Capability Map with first-degree capability
  relationships). Requires CLAUDE.md to exist (run project-analysis first).
  Never modifies source code. Part of the project-inspector workflow.
---

# Project Docs Skill

## Purpose

Generate a `docs/project/` knowledge base that serves two audiences:

- **People writing feature specs** — a plain-language overview and an inventory of existing screens/components, so specs reuse what exists instead of re-inventing it.
- **Claude in future sessions** — component, pattern, integration and capability facts available without a fresh full scan.
- **Downstream Ono plugins** — which capabilities exist, where they live, on which surfaces, and which other capabilities a change to one is likely to touch (first-degree, evidence-backed relationships), indexed by `.ono/repo-knowledge.json`.

This skill is step 2 of the project-inspector workflow:

1. `project-analysis` creates `CLAUDE.md` and `AUDIT.md`.
2. `project-docs` (this skill) creates the `docs/project/` knowledge base.
3. `audit-breakdown` expands one audit topic at a time into a Draft audit.
4. `audit-sync` syncs approved audit findings into `CLAUDE.md`.

This skill is a reading and mapping skill. It is not a full audit, implementation review, refactor plan, task generator, or feature documentation generator.

## Precondition: CLAUDE.md Must Exist

Before doing anything else, check the repository root for `CLAUDE.md`.

If it is missing, output:

> ❌ **CLAUDE.md not found.** This skill builds on the project context created by `project-analysis`.
> Please run `/inspect` (the project-analysis stage) first, then return here.

And stop. Do not continue.

## Output Contract

This skill generates only:

```text
<repository-root>/docs/project/overview.md
<repository-root>/docs/project/components.md
<repository-root>/docs/project/patterns.md
<repository-root>/docs/project/integrations.md
<repository-root>/docs/project/capabilities.md
```

These five files are its only outputs. It must not create any other file under `docs/`, must not modify `CLAUDE.md` or `AUDIT.md`, and must never modify source code.

## Step 1: Ask the Developer

```text
I'll need a few details before generating the project docs:

1. Repository folder: What is the full path to the local repository?

2. Surfaces: I will scope everything by the surfaces recorded in CLAUDE.md's
   "Targets and Surfaces" section (<surface ids>). Is that list still right?
   (It shapes what I inventory — screens, components, hooks, navigators — and
   where a surface needs its own convention. If it is wrong, re-run
   project-analysis first; this skill never edits CLAUDE.md.)

3. Existing docs/project/ files: If any already exist, should I:
   - Overwrite — replace them entirely
   - Update — preserve useful existing structure and refresh content
   - Preserve — skip existing files
   - Version — save old copies as .bak before writing new ones

4. Source code safety: Should all source code remain completely unchanged?
   Default: Yes — I will only read files and only write the five docs/project/ files.
```

Wait for the developer's answers before proceeding.

## Step 2: Confirmation Summary

```text
Here's what I'm about to do:

- Repository: <path>
- Surfaces: <surface ids from CLAUDE.md#targets-and-surfaces>
- Existing docs handling: <overwrite / update / preserve / version>
- Source code: Read-only — no source files will be modified

I will generate or update:
  ✓ docs/project/overview.md      — plain-language project overview
  ✓ docs/project/components.md    — screen & reusable component inventory
  ✓ docs/project/patterns.md      — coding patterns and conventions
  ✓ docs/project/integrations.md  — SDKs, APIs, services (names only)
  ✓ docs/project/capabilities.md  — Feature & Capability Map + relationships

I will not modify:
  ✗ CLAUDE.md
  ✗ AUDIT.md
  ✗ audits/
  ✗ any source code

Shall I proceed?
```

Only begin after explicit approval.

## Step 3: Read Existing Context First

Before scanning source, read what already exists — do not rediscover known facts:

1. `CLAUDE.md` — stack, structure, key modules, conventions, and **`## Targets and Surfaces`**: the surface ids, their source roots, and the shared-code roots. Every surface id you write in these files must be one declared there. If the section is missing, stop and report that `project-analysis` must run first (a refresh plans it automatically).
2. `AUDIT.md` (if present) — architecture summary, module table, cross-cutting observations.
3. `audits/**/*.md` (if present) — verified findings about specific areas.

Use source inspection to fill the gaps these files leave, not to repeat them.

## Step 4: Targeted Inspection

Inspect the repository directly using read-only commands, one focused pass per output file:

- For `components.md`: inventory all screens, reusable UI components, and shared hooks — name, path, one-line purpose, and **Surface** (`all`, or the surface ids it is built into, decided from its location under the surfaces' source roots / shared-code roots). Note duplicates and deprecated-looking components.
- For `patterns.md`: identify the state management, data fetching, navigation, styling, error handling, and i18n patterns actually used, with representative file paths — and the seven generic sections: architecture and composition (layers, modules, DI/composition root), input and interaction (touch, pointer, keyboard, focus/remote, gamepad — whichever the code handles), app lifecycle and state (launch, foreground/background, restoration, process death, visibility), media and playback (player abstraction, ownership, state model), platform adapters (native modules, platform-specific files, conditional compilation, vendor shims, polyfills), accessibility (labels, roles, focus order, dynamic type, a11y tests), and performance constraints (**only** budgets/limits the repository explicitly defines — a size-limit config, a CI gate, a documented number; otherwise `None defined in repository`).
- For `integrations.md`: list third-party SDKs, backend APIs, auth, analytics, push, and payment integrations from dependency manifests and imports, each with its **Surface**. Names and purposes only — no keys or secret values.
- For `capabilities.md`: infer the repository's product/development capabilities (e.g. a player, a guide, search, authentication, profiles, settings, downloads — names are this project's own) from code structure and explicit repository evidence: feature folders/modules, route/screen registrations, service boundaries, stores, tests, and repository docs. Then record the **direct** relationships between them that a concrete source edge proves. See "Feature & Capability Map rules".
- For `overview.md`: describe the app in plain language — what it does, main features/screens, user roles, high-level architecture.

Rules:

- Do not fabricate. Mark unverifiable items as `Unknown`.
- Variable names only from env/sample files — never values.
- Prefer file paths and symbol names over vague descriptions.

## Step 5: Shell Execution Rules

Repository inspection must be strictly read-only. Follow
[`docs/shell-execution-rules.md`](../../docs/shell-execution-rules.md) in full: the allowed
command list, the command-shape rules, and the forbidden list live there and are not
restated here.

- Do not use output redirection except when writing the five generated artifacts through the normal workflow.

## Step 6: Existing File Handling

| Developer choice | Action |
|------------------|--------|
| Overwrite | Replace the target files directly |
| Update | Preserve useful existing structure and refresh content |
| Preserve | Skip files that already exist |

Update is the mode the orchestrator uses for **Refresh Project Knowledge** on a completed inspection: re-derive each of the five files from the current source, keeping the section structure (headings, and therefore their anchors, where the subject still exists) so downstream citations keep resolving. Keep capability ids stable for a capability that still exists; drop a capability or relationship whose evidence no longer holds in the current source (never keep an edge because it used to exist). Files written before the current knowledge model lack the generic `patterns.md` sections, the `Surface` columns, or `capabilities.md` altogether: add them. Update never touches `CLAUDE.md`, `AUDIT.md`, or `audits/` — same as every other mode.
| Version | Save `<file>.bak`, then write new files |

Never modify source code.

## Step 7: Generate the Four Files

Use the embedded templates below as the exact structure for each file. No external template files are required.

Writing rules:

- `overview.md` is written for non-developers: plain language, no code jargon, explain acronyms.
- `components.md` and `patterns.md` are written for developers and Claude: concrete paths and symbols.
- Adapt terminology to the stack (screens/navigators for RN, ViewControllers/Activities for native, routes/pages for web). Never add a platform-specific section heading; the generic sections plus surface overrides express every platform.
- Keep each file focused and scannable; tables over prose where the template uses tables.
- If a template section does not apply, write `Not applicable — <reason>` rather than deleting it.
- Never reproduce secret values, tokens, private keys, or credentials — variable names only.

### Surface scoping rules

- Write each convention **once**, as the shared body of its `##` section, when it holds for every surface.
- Where one surface differs, add `### <Section> (<surface-id>)` directly under that `##` section — the section's exact name, the surface id exactly as declared in `CLAUDE.md`. State only how that surface differs; never repeat the shared text. A surface without an override inherits the shared convention.
- Never merge conflicting facts: if two surfaces do it differently, the shared body says what is common (or `Differs per surface — see below.`) and each differing surface gets its override.
- A single-surface repository has no overrides.
- Inventory and integration rows carry a `Surface` cell: `all`, or a comma-separated list of surface ids. Shared code appears once with `all` (or the ids that share it), never once per surface.

### Evidence and volatile knowledge

Every persisted fact must answer "where in THIS repository did this come from?" — cite representative paths, and in `capabilities.md` use evidence refs of the form `path` or `path::token` (the token must literally occur in that file). Evidence is repository source, build files, or repository documentation — never `CLAUDE.md`, `AUDIT.md`, `docs/project/**`, `audits/**`, or `.ono/**`. Do **not** persist volatile platform knowledge — SDK or OS release notes, OS capabilities, vendor bugs, store policy, recommended practices. If the repository contains a workaround for such an issue, record the workaround, its location, and its local trigger/condition if visible — not the vendor claim.

### Feature & Capability Map rules

`capabilities.md` is an evidence-backed map, not a product-requirements database and not a hand-curated catalog.

- **Capability** — one `### Capability: <id>` section per capability under `## Capabilities`. `<id>` is a stable lowercase slug. Include a capability only if repository evidence justifies it (a feature folder/module, a registered route/screen, a service boundary, a store, tests, or explicit repository docs). Never invent one from a product name, a README wish list, or domain expectations.
- **Represent shared code once.** A capability that exists on several surfaces is one section: `Surfaces` = `all` or the ids; a surface-specific root is written `` `path/` (surface-id) `` in `Source roots`. Never create a per-surface copy of the same capability, and never let two capabilities claim the same source root.
- **Reference, never copy.** `Screens and components` lists names exactly as they appear in `components.md`; `Data dependencies` lists names exactly as they appear in `integrations.md` (or a repository path). Descriptions stay in those files.
- **Every other field is evidence refs** (`path` / `path::token`): entry points, services and modules, navigation routes (the registration or navigation call), state ownership (the store/slice/view model), tests, and `Evidence` (at least one ref proving the capability exists). Write `None found` when a field has nothing; never guess.
- **Relationships** — one row per **direct, first-degree** edge under `## Relationships`. `Relationship` is one of `depends_on`, `used_by`, `contains`, `navigates_to`, `shares_component_with`, `shares_state_with`, `reads_from`, `writes_to`, `covered_by`, `related_to`. `Evidence kind` is one of `import`, `navigation-route`, `shared-component`, `shared-state`, `shared-service`, `shared-data-source`, `test`, `repository-doc`:
  - `import` / `navigation-route` — a ref inside one endpoint's source roots showing the edge (the import, the navigate call, the route registration).
  - `shared-component` / `shared-state` / `shared-service` / `shared-data-source` — refs inside **both** endpoints' source roots showing the **same** token (the shared component, store, service, or data source).
  - `test` — one test file (in either capability's roots or tests) exercising both, with a token for each.
  - `repository-doc` — a repository document quoting the relationship (`path::<the statement>`).
- **Naming or semantic similarity is never evidence.** Two capabilities with similar names, or that "sound related", get no relationship unless a source edge above proves one. Do not compute impact scores or transitive chains; record direct edges only.

The after-hook runs `scripts/knowledge-evidence.ts verify <TARGET_ROOT> docs`, which resolves every ref against the current source and checks each rule above; a violation stops the stage.

### overview.md Template

```markdown
# Project Overview — {{PROJECT_NAME}}

> Auto-generated by the project-inspector plugin (project-docs skill).
> Audience: product and anyone who needs to understand the project without reading code.
> Generated: {{GENERATED_DATE}}

## What This Project Is

{{WHAT_IT_IS}}

## Who Uses It

{{USERS_AND_ROLES}}

## Main Features / Screens

| Feature / Screen | What it does | Entry point |
|------------------|--------------|-------------|
{{FEATURES_TABLE}}

## High-Level Architecture

{{ARCHITECTURE_PLAIN_LANGUAGE}}

## Platforms and Stack (Plain Language)

{{STACK_PLAIN_LANGUAGE}}

## Key Terms and Domain Glossary

| Term | Meaning in this project |
|------|------------------------|
{{GLOSSARY_TABLE}}

## Where Things Live

| Area | Location |
|------|----------|
| Feature specs | {{SPECS_LOCATION}} |
| Design documents | {{DESIGN_DOCS_LOCATION}} |
| Audit reports | audits/ |
| AI project context | CLAUDE.md |

## Known Limitations and Caution Areas (Non-Technical Summary)

{{LIMITATIONS_SUMMARY}}

## Unknowns

{{UNKNOWNS}}
```

### components.md Template

```markdown
# Component Inventory — {{PROJECT_NAME}}

> Auto-generated by the project-inspector plugin (project-docs skill).
> Audience: spec writers and developers checking what already exists before speccing or building a feature.
> Generated: {{GENERATED_DATE}}

## How to Use This File

Before writing a spec or design doc for a new feature, check here whether a screen, component, or flow already exists that the feature should reuse. Each entry lists the file path so it can be inspected directly.

## Screens

| Screen | Path | Purpose | Surface | Notes |
|--------|------|---------|---------|-------|
{{SCREENS_TABLE}}

## Reusable UI Components

| Component | Path | Purpose | Surface | Reuse notes |
|-----------|------|---------|---------|-------------|
{{COMPONENTS_TABLE}}

## Shared Hooks / Utilities

| Name | Path | Purpose | Surface |
|------|------|---------|---------|
{{HOOKS_UTILITIES_TABLE}}

## Navigation Map

{{NAVIGATION_MAP}}

## Design System / Theming

{{DESIGN_SYSTEM_NOTES}}

## Known Duplicates or Deprecated Components

{{DUPLICATES_AND_DEPRECATED}}

## Unknowns

{{UNKNOWNS}}
```

### patterns.md Template

```markdown
# Patterns and Conventions — {{PROJECT_NAME}}

> Auto-generated by the project-inspector plugin (project-docs skill).
> Audience: developers and Claude Code — how things are done in this codebase.
> Generated: {{GENERATED_DATE}}

## State Management

{{STATE_MANAGEMENT}}

## Data Fetching / API Conventions

{{API_CONVENTIONS}}

## Navigation Patterns

{{NAVIGATION_PATTERNS}}

## Styling Conventions

{{STYLING_CONVENTIONS}}

## Error Handling Patterns

{{ERROR_HANDLING}}

## Localization / RTL

{{LOCALIZATION}}

## Naming and Folder Conventions

{{NAMING_CONVENTIONS}}

## Testing Patterns

{{TESTING_PATTERNS}}

## Architecture and Composition

{{ARCHITECTURE_AND_COMPOSITION}}

## Input and Interaction

{{INPUT_AND_INTERACTION}}

## App Lifecycle and State

{{APP_LIFECYCLE_AND_STATE}}

## Media and Playback

{{MEDIA_AND_PLAYBACK}}

## Platform Adapters

{{PLATFORM_ADAPTERS}}

## Accessibility

{{ACCESSIBILITY}}

## Performance Constraints

{{PERFORMANCE_CONSTRAINTS_DEFINED_IN_REPOSITORY_OR_None_defined_in_repository}}

## Patterns to Avoid (Observed Anti-Patterns)

{{ANTI_PATTERNS}}

## Unknowns

{{UNKNOWNS}}
```

### integrations.md Template

```markdown
# External Integrations — {{PROJECT_NAME}}

> Auto-generated by the project-inspector plugin (project-docs skill).
> Names and purposes only — never keys, tokens, or secret values.
> Generated: {{GENERATED_DATE}}

## Backend Services / APIs

| Service / API | Used for | Where in code | Surface |
|---------------|----------|---------------|---------|
{{BACKEND_SERVICES_TABLE}}

## Third-Party SDKs

| SDK | Purpose | Where in code | Surface |
|-----|---------|---------------|---------|
{{SDKS_TABLE}}

## Authentication

{{AUTH_SUMMARY}}

## Analytics / Crash Reporting

{{ANALYTICS_SUMMARY}}

## Push Notifications

{{PUSH_SUMMARY}}

## Payments / Billing

{{PAYMENTS_SUMMARY}}

## Environment Configuration

Environment variable names detected from sample/template files only (values never reproduced):

{{ENV_VAR_NAMES}}

## Unknowns

{{UNKNOWNS}}
```

### capabilities.md Template

```markdown
# Capability Map — {{PROJECT_NAME}}

> Auto-generated by the project-inspector plugin (project-docs skill).
> Audience: developers, Claude, and downstream Ono plugins — which capabilities exist, where, on which surfaces, and what a change to one directly touches.
> Every entry is backed by repository evidence (`path` or `path::token`). Current source code remains authoritative.
> Generated: {{GENERATED_DATE}}

## How to Use This File

Find the capability a change concerns, read its source roots and references, then follow its direct relationships to the other capabilities the change is likely to touch. Verify any relationship you rely on against the current source — the evidence column says exactly where to look. Descriptions of screens, components and integrations live in `components.md` and `integrations.md`; this file only references them.

## Capabilities

### Capability: {{CAPABILITY_ID}}

| Field | Value |
|-------|-------|
| Name | {{CAPABILITY_NAME}} |
| Surfaces | {{all_OR_SURFACE_IDS}} |
| Source roots | {{BACKTICKED_PATHS_OPTIONALLY_SUFFIXED_(surface-id)}} |
| Entry points | {{EVIDENCE_REFS_OR_None_found}} |
| Screens and components | {{NAMES_FROM_components.md_OR_None_found}} |
| Services and modules | {{EVIDENCE_REFS_OR_None_found}} |
| Navigation routes | {{EVIDENCE_REFS_OR_None_found}} |
| Data dependencies | {{NAMES_FROM_integrations.md_OR_PATHS_OR_None_found}} |
| State ownership | {{EVIDENCE_REFS_OR_None_found}} |
| Tests | {{EVIDENCE_REFS_OR_None_found}} |
| Evidence | {{AT_LEAST_ONE_EVIDENCE_REF}} |

{{REPEAT_THE_CAPABILITY_SECTION_PER_CAPABILITY}}

## Relationships

| From | Relationship | To | Evidence kind | Evidence |
|------|--------------|----|---------------|----------|
{{RELATIONSHIP_ROWS_OR_REPLACE_THE_TABLE_WITH_None_found}}

## Unknowns

{{UNKNOWNS}}
```

## Step 8: Completion Report

After writing the files, report:

```text
Project docs complete.

Files written:
  ✓ <target-path>/docs/project/overview.md
  ✓ <target-path>/docs/project/components.md
  ✓ <target-path>/docs/project/patterns.md
  ✓ <target-path>/docs/project/integrations.md
  ✓ <target-path>/docs/project/capabilities.md

Summary:
- Surfaces scoped: <surface ids> (<n> per-surface overrides)
- Capabilities: <count>; direct relationships: <count>

Files intentionally not modified:
  ✗ CLAUDE.md
  ✗ AUDIT.md
  ✗ audits/

Next steps:
1. Review the five files, especially components.md accuracy and every capabilities.md relationship.
2. Continue to audit-breakdown (via /inspect-approve, or /inspect-topic <topic>) to expand
   the first audit topic from AUDIT.md.
3. Re-run this stage after major refactors to keep the inventory fresh.
```

## Hard Constraints

- Never run without `CLAUDE.md` present — stop and point to `project-analysis`.
- Never modify source code.
- Only write the five files in the Output Contract.
- Never persist a capability, relationship, or convention without repository evidence; never infer a relationship from naming or semantic similarity.
- Never persist volatile platform/vendor knowledge (see "Evidence and volatile knowledge").
- Never flatten surfaces: shared conventions once, per-surface overrides only where a surface differs, and only surface ids declared in `CLAUDE.md`.
- Never modify `CLAUDE.md`, `AUDIT.md`, or `audits/`.
- Never clone remote repositories.
- Never read or reproduce actual secret values; variable names only.
- Never reproduce credentials, tokens, private keys, or secrets from any file.
- Never proceed without explicit developer confirmation after the Step 2 summary.
- Never assume the current working directory is the target repository. Write every artifact under the absolute `<TARGET_ROOT>` passed by the orchestrator; never resolve the root from CWD or `git rev-parse --show-toplevel`, and never write to any path containing `.claude/worktrees/`. If the provided root contains that segment, stop and report instead of writing.
- Do not depend on external template files; the required templates are embedded in this `SKILL.md`.
