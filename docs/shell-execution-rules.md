# Shell Execution Rules

**Owner:** `ono-project-inspector` (this plugin), internal policy.
**Cited by:** `skills/project-analysis`, `skills/project-docs`, `skills/audit-breakdown` — every
skill that inspects a repository.

This file is the single definition of the read-only shell policy those skills follow. It was
extracted from three byte-identical copies of the same block; each citing skill keeps only the
one line that names its own outputs, because that line differs per skill and this one cannot.

> This is **internal** policy, not an outbound contract. `docs/repo-knowledge-contract.md` is the
> cross-plugin interface other Ono plugins consume and is vendored into them; this file is cited
> by path from inside this plugin only, and is not duplicated anywhere.

Repository inspection must be strictly read-only.

Allowed commands include:

```text
ls
find
tree
cat
head
tail
grep
rg
wc
file
pwd
git status
git branch
git log
git show
```

Rules:

- Prefer one command per action.
- Avoid chaining unrelated commands with `&&`.
- Avoid multiple `cd` operations inside one command.
- Do not use output redirection except when writing the current skill's own declared output
  artifacts through the normal workflow. Those artifacts are the skill's `produces` entry in
  [`skills/registry.json`](../skills/registry.json), and each citing skill names them itself in
  its own Shell Execution Rules section — follow that wording, which is authoritative for that
  skill. Nothing else may be redirected to, ever.

Never use:

```text
rm
mv
cp
touch
tee
sed -i
perl -i
git add
git commit
git checkout
git switch
git restore
git clean
git reset
git revert
>
>>
```

## Why this is a separate file

The allowed list, the command-shape rules and the forbidden list are identical for every skill
that reads a repository, and a policy that governs what may never be run is exactly the kind of
rule that must not drift between three copies. Only the redirection exception is per-skill, so
only that line stays with each skill.

Adding a new inspection skill that runs shell commands means citing this file the same way the
three existing ones do, and stating that skill's own redirection exception beneath the citation.
