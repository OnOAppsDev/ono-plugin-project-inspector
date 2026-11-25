/**
 * freshness-ref.test.ts — `freshness <root> --ref <rev>` and the additive `signals` (0.14.0).
 *
 *   FR1  central branch measured from a divergent, dirty feature checkout: identical to a real
 *        checkout of the central branch; ref.resolved === checkedHead; no working-tree fallback
 *   FR2  read-only proof: refs, HEAD, index, working tree, objects unchanged; nothing created
 *   FR3  revision forms: full / short id, full ref, tag, --ref=, remote-tracking, HEAD
 *   FR4  unresolvable revisions -> BASELINE_UNKNOWN (missing, ambiguous, range, path, tree, blob)
 *   FR5  argument errors -> exit 1 usage (missing, empty, duplicated, option-like, control, unknown)
 *   FR6  detached HEAD and a protected branch
 *   FR7  nested project root: project-relative reads and drift
 *   FR8  state at the commit: absent -> NOT_APPLICABLE; invalid / incomplete / unavailable object
 *        -> BASELINE_UNKNOWN; an unavailable knowledge document -> BASELINE_UNKNOWN, never COMPLETE
 *   FR9  missing history (shallow clone) and Git unavailable -> BASELINE_UNKNOWN
 *   FR10 partial clone: missing objects are never fetched (no network), result BASELINE_UNKNOWN;
 *        a negative control proves the fixture fetches when unprotected; a Git without
 *        --no-lazy-fetch fails closed; ordinary clones get no new requirement
 *   FR11 signals: exact counts, stable kinds and order, zero vs null, model gaps, no paths
 *   FR12 without --ref: every status identical to the released 0.13.0 helper (signals aside)
 *
 * Run with: node --no-warnings scripts/freshness-ref.test.ts
 */

import { execFileSync, spawnSync } from "child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { pathToFileURL } from "url";
import { createHash } from "crypto";
import { extractRelease, FIXTURE_0113, g, GIT_ENV, helper, inspectedRepo } from "./fixtures/inspected.ts";
import { childEnv } from "./fixtures/platform.ts";
import { SIGNAL_KINDS } from "./inspection-state.ts";
import { objectReadPolicy } from "./knowledge-source.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ""}`); }
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "inspector-ref-")));
const REL_0130 = "3ef4cd1771b57fd969ff2b78e95f33931a9fcea5";
const fresh = (dir: string, ...args: string[]) => helper(dir, "inspection-state.ts", "freshness", dir, ...args);
const put = (dir: string, rel: string, body: string) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), body); };
const commit = (dir: string, msg: string) => { g(dir, "add", "-A"); g(dir, "commit", "-q", "-m", msg); };
const comparable = (j: any) => { const c = { ...j }; delete c.checkedAt; delete c.ref; return JSON.stringify(c); };
const FAKE = "0123456789abcdef0123456789abcdef01234567";

/** Every file under dir (except .git) with size, mtime and content. */
function treeFingerprint(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { const s = statSync(p); out.push(`${p}:${s.size}:${s.mtimeMs}:${createHash("sha256").update(readFileSync(p)).digest("hex")}`); }
    }
  };
  walk(dir);
  return out.sort().join("\n");
}
/** Refs, HEAD, index bytes, objects and working tree: proves a command changed nothing. */
function repoFingerprint(dir: string): string {
  const gitDir = g(dir, "rev-parse", "--absolute-git-dir");
  const index = join(gitDir, "index");
  return JSON.stringify({
    refs: g(dir, "for-each-ref", "--format=%(refname) %(objectname)"),
    head: g(dir, "rev-parse", "HEAD"),
    symbolic: spawnSync("git", ["symbolic-ref", "-q", "HEAD"], { cwd: dir, encoding: "utf-8" }).stdout,
    index: existsSync(index) ? `${statSync(index).mtimeMs}:${createHash("sha256").update(readFileSync(index)).digest("hex")}` : null,
    objects: g(dir, "count-objects", "-v"),
    fetchHead: existsSync(join(gitDir, "FETCH_HEAD")),
    tree: treeFingerprint(dir),
  });
}
/** A commit like `base` but with the blob at `rel` (top-level, or one level under a directory) replaced by a missing object. */
function commitWithMissingBlob(dir: string, base: string, rel: string): string {
  const mk = (entries: string) => execFileSync("git", ["mktree", "--missing", "-z"], { cwd: dir, input: entries, encoding: "utf-8", env: GIT_ENV }).trim();
  const list = (tree: string) => g(dir, "ls-tree", "-z", tree).split("\u0000").filter(Boolean);
  const replace = (entries: string[], name: string, line: string) => entries.map((e) => (e.slice(e.indexOf("\t") + 1) === name ? line : e)).join("\u0000") + "\u0000";
  const parts = rel.split("/");
  let tree: string;
  if (parts.length === 1) tree = mk(replace(list(`${base}^{tree}`), parts[0], `100644 blob ${FAKE}\t${parts[0]}`));
  else {
    const sub = mk(replace(list(`${base}:${parts[0]}`), parts[1], `100644 blob ${FAKE}\t${parts[1]}`));
    tree = mk(replace(list(`${base}^{tree}`), parts[0], `040000 tree ${sub}\t${parts[0]}`));
  }
  return execFileSync("git", ["commit-tree", tree, "-p", base, "-m", "missing object"], { cwd: dir, encoding: "utf-8", env: GIT_ENV }).trim();
}

try {
  // --- the central branch and a divergent feature checkout ----------------------------------------
  const repo = join(root, "repo");
  const knowledgeHead = inspectedRepo(repo, "dev", (d) => put(d, "legacy/old.ts", "export const old = 1;\n"));
  const stateCommit = g(repo, "rev-parse", "HEAD");
  // Central drift: 3 manifests (2 of them surface evidence), +1 / -1 top-level entry, a Hebrew path.
  put(repo, "package.json", readFileSync(join(repo, "package.json"), "utf-8").replace("{", '{\n  "private": true,'));
  put(repo, "vite.config.ts", readFileSync(join(repo, "vite.config.ts"), "utf-8") + "// central\n");
  put(repo, "tizen/config.xml", readFileSync(join(repo, "tizen/config.xml"), "utf-8") + "<!-- central -->\n");
  put(repo, "newtop/a.ts", "export const a = 1;\n");
  put(repo, "src/features/epg/חדש.tsx", "export const x = 1;\n");
  rmSync(join(repo, "legacy"), { recursive: true });
  commit(repo, "central drift");
  const dev = g(repo, "rev-parse", "HEAD");
  // Feature branch from the state commit: its own drift, then a dirty, broken working tree.
  g(repo, "switch", "-q", "-c", "feature/x", stateCommit);
  put(repo, "featuretop/f.ts", "export const f = 1;\n");
  put(repo, "package.json", readFileSync(join(repo, "package.json"), "utf-8").replace("{", '{\n  "feature": true,'));
  commit(repo, "feature work");
  writeFileSync(join(repo, ".ono", "state.json"), "{ corrupt");
  writeFileSync(join(repo, "CLAUDE.md"), "# CLAUDE.md\n\nRewritten on the feature branch, no surfaces.\n");
  put(repo, "untracked.txt", "u\n");

  // Reference: a real checkout of the central branch, measured without --ref.
  const central = join(root, "central");
  execFileSync("git", ["clone", "-q", "--no-hardlinks", "-b", "dev", repo, central], { env: GIT_ENV });
  const expected = fresh(central).json;

  // --- FR1 ---------------------------------------------------------------------------------------
  const before = repoFingerprint(repo);
  const r = fresh(repo, "--ref", "dev");
  check("FR1 exits 0 with one JSON object, nothing on stderr", r.code === 0 && r.json !== null && r.stderr === "", r.stdout + r.stderr);
  check("FR1 the central drift is reported (REFRESH_RECOMMENDED, 6 files)", r.json?.status === "REFRESH_RECOMMENDED" && r.json?.changedSourceCount === 6, JSON.stringify(r.json));
  check("FR1 identical to a real checkout of the central branch (status, counts, heads, signals)", comparable(r.json) === comparable(expected), `${comparable(r.json)}\n  vs ${comparable(expected)}`);
  check("FR1 ref = { requested, resolved } and resolved === checkedHead === the central commit", r.json?.ref?.requested === "dev" && r.json?.ref?.resolved === dev && r.json?.checkedHead === dev);
  check("FR1 the knowledge baseline is the one recorded at the central commit", r.json?.knowledgeHead === knowledgeHead);
  check("FR1 the checked-out branch's own drift and dirty files are ignored", r.json?.signals?.analysis?.find((s: any) => s.kind === "top-level-entry-added")?.count === 1);
  const wt = fresh(repo).json;
  check("FR1 without --ref the same checkout reads its broken working-tree state (no silent fallback either way)", wt?.status === "BASELINE_UNKNOWN" && wt?.ref === undefined, JSON.stringify(wt));
  // --- FR2 ---------------------------------------------------------------------------------------
  check("FR2 read-only: refs, HEAD, index, objects and working tree are unchanged", repoFingerprint(repo) === before);

  // --- FR3 ---------------------------------------------------------------------------------------
  g(repo, "tag", "central-tag", dev);
  for (const [label, args] of [
    ["full commit id", ["--ref", dev]], ["abbreviated id", ["--ref", dev.slice(0, 12)]], ["full ref name", ["--ref", "refs/heads/dev"]],
    ["tag", ["--ref", "central-tag"]], ["--ref=<rev>", ["--ref=dev"]], ["relative revision", ["--ref", "feature/x~0"]],
  ] as Array<[string, string[]]>) {
    const x = fresh(repo, ...args).json;
    const want = label === "relative revision" ? g(repo, "rev-parse", "HEAD") : dev;
    check(`FR3 ${label} resolves to the exact commit`, x?.checkedHead === want && x?.ref?.resolved === want && x?.ref?.requested === args[args.length - 1].replace(/^--ref=/, ""), JSON.stringify(x?.ref));
  }
  const hx = fresh(repo, "--ref", "HEAD").json;
  check("FR3 --ref HEAD reads the committed HEAD, not the corrupt working-tree state", hx?.checkedHead === g(repo, "rev-parse", "HEAD") && hx?.status === "REFRESH_RECOMMENDED", JSON.stringify(hx));
  const guardian = join(root, "guardian");
  execFileSync("git", ["clone", "-q", "--no-hardlinks", "-b", "feature/x", repo, guardian], { env: GIT_ENV });
  const rt = fresh(guardian, "--ref", "origin/dev").json;
  check("FR3 a remote-tracking revision (origin/dev) from a clone on another branch", comparable(rt) === comparable(expected) && rt?.ref?.resolved === dev, JSON.stringify(rt?.ref));

  // --- FR4 ---------------------------------------------------------------------------------------
  const unresolved = (x: any) => x?.status === "BASELINE_UNKNOWN" && x?.checkedHead === null && x?.ref?.resolved === null && x?.signals === null && x?.changedSourceCount === null && x?.knowledgeHead === null;
  for (const [label, rev] of [
    ["missing name", "no-such-branch"], ["range", "dev..HEAD"], ["path inside a revision", "dev:CLAUDE.md"],
    ["tree object", g(repo, "rev-parse", "dev^{tree}")], ["blob object", g(repo, "rev-parse", "dev:CLAUDE.md")], ["unknown full id", FAKE],
  ]) {
    const x = fresh(repo, "--ref", rev);
    check(`FR4 ${label} -> BASELINE_UNKNOWN, exit 0, nothing resolved`, x.code === 0 && unresolved(x.json), x.stdout);
  }
  g(repo, "tag", "dev", stateCommit);
  const amb = fresh(repo, "--ref", "dev").json;
  check("FR4 an ambiguous name (branch and tag 'dev') is not silently resolved", unresolved(amb) && /ambiguous/.test(amb?.reason ?? ""), amb?.reason);
  check("FR4 ...the full ref name still resolves", fresh(repo, "--ref", "refs/heads/dev").json?.checkedHead === dev);
  g(repo, "tag", "-d", "dev");
  const hexRef = dev.slice(0, 7);
  g(repo, "branch", hexRef, stateCommit);
  const ambHex = fresh(repo, "--ref", hexRef).json;
  check("FR4 a name that is both a ref and an abbreviated object id is ambiguous", unresolved(ambHex) && /ambiguous/.test(ambHex?.reason ?? ""), ambHex?.reason);
  g(repo, "branch", "-D", hexRef);

  // --- FR5 ---------------------------------------------------------------------------------------
  for (const [label, args] of [
    ["--ref without a value", ["--ref"]], ["empty --ref=", ["--ref="]], ["--ref given twice", ["--ref", "dev", "--ref", "dev"]],
    ["option-like value", ["--ref", "-x"]], ["option-like --ref=", ["--ref=--output=x"]], ["control character", ["--ref", "dev\nmain"]],
    ["unknown option", ["--bogus"]], ["extra positional argument", ["dev"]],
  ] as Array<[string, string[]]>) {
    const x = fresh(repo, ...args);
    check(`FR5 ${label} -> usage error (exit 1, no JSON)`, x.code === 1 && x.json === null && /Usage: inspection-state\.ts freshness/.test(x.stderr), x.stdout + x.stderr);
  }

  // --- FR6 ---------------------------------------------------------------------------------------
  const det = join(root, "detached");
  execFileSync("git", ["clone", "-q", "--no-hardlinks", repo, det], { env: GIT_ENV });
  g(det, "checkout", "-q", "--detach", "origin/feature/x");
  check("FR6 on a detached HEAD", comparable(fresh(det, "--ref", "origin/dev").json) === comparable(expected));
  g(det, "switch", "-q", "-c", "main");
  const fp = repoFingerprint(det);
  check("FR6 on a protected branch (main): works and writes nothing", comparable(fresh(det, "--ref", "origin/dev").json) === comparable(expected) && repoFingerprint(det) === fp);

  // --- FR7 ---------------------------------------------------------------------------------------
  {
    const umbrella = join(root, "umbrella");
    const project = join(umbrella, "apps", "tv");
    mkdirSync(project, { recursive: true });
    cpSync(FIXTURE_0113, project, { recursive: true });
    put(umbrella, "README.md", "umbrella\n");
    g(umbrella, "init", "-q", "-b", "dev");
    commit(umbrella, "umbrella");
    for (const stage of ["project-analysis", "project-docs"]) helper(project, "inspection-state.ts", "record-knowledge", project, stage);
    commit(umbrella, "nested knowledge recorded");
    put(umbrella, "README.md", "umbrella changed outside the project\n");
    put(project, "src/features/epg/More.tsx", "export const m = 1;\n");
    commit(umbrella, "central change");
    const nestedDev = g(umbrella, "rev-parse", "HEAD");
    g(umbrella, "switch", "-q", "-c", "feature/n", "HEAD~1");
    rmSync(join(project, ".ono"), { recursive: true });
    const n = fresh(project, "--ref", "dev").json;
    check("FR7 nested project: state read at apps/tv/.ono in the commit; only project files count", n?.status === "REFRESH_RECOMMENDED" && n?.changedSourceCount === 1 && n?.checkedHead === nestedDev, JSON.stringify(n));
    const nc = join(root, "umbrella-central");
    execFileSync("git", ["clone", "-q", "--no-hardlinks", "-b", "dev", umbrella, nc], { env: GIT_ENV });
    check("FR7 ...identical to a checkout of the central branch at the same project root", comparable(n) === comparable(fresh(join(nc, "apps", "tv")).json));
    check("FR7 the umbrella root itself has no inspection at that commit -> NOT_APPLICABLE", fresh(umbrella, "--ref", "dev").json?.status === "NOT_APPLICABLE");
  }

  // --- FR8 ---------------------------------------------------------------------------------------
  {
    const s = join(root, "states");
    execFileSync("git", ["clone", "-q", "--no-hardlinks", "-b", "dev", repo, s], { env: GIT_ENV });
    g(s, "switch", "-q", "-c", "nostate");
    rmSync(join(s, ".ono"), { recursive: true });
    commit(s, "no inspection state");
    const noState = g(s, "rev-parse", "HEAD");
    g(s, "switch", "-q", "-c", "work", "dev");
    const absent = fresh(s, "--ref", "nostate").json;
    check("FR8 no state file at the commit -> NOT_APPLICABLE, resolved commit reported, signals null", absent?.status === "NOT_APPLICABLE" && absent?.checkedHead === noState && absent?.ref?.resolved === noState && absent?.signals === null && absent?.changedSourceCount === null, JSON.stringify(absent));
    check("FR8 ...even though the checked-out working tree has a state file", existsSync(join(s, ".ono", "state.json")));
    writeFileSync(join(s, ".ono", "state.json"), "{ not json");
    commit(s, "corrupt state");
    const bad = fresh(s, "--ref", "work").json;
    check("FR8 invalid JSON state at the commit -> BASELINE_UNKNOWN", bad?.status === "BASELINE_UNKNOWN" && bad?.checkedHead === g(s, "rev-parse", "HEAD") && /unreadable/.test(bad?.reason ?? ""), JSON.stringify(bad));
    writeFileSync(join(s, ".ono", "state.json"), JSON.stringify({ stateSchemaVersion: 1 }));
    commit(s, "incomplete state");
    check("FR8 a state object without inspection data -> BASELINE_UNKNOWN", fresh(s, "--ref", "work").json?.status === "BASELINE_UNKNOWN");
    const missingState = commitWithMissingBlob(s, dev, ".ono/state.json");
    const ms = fresh(s, "--ref", missingState).json;
    check("FR8 a state entry whose object is unavailable -> BASELINE_UNKNOWN (never NOT_APPLICABLE)", ms?.status === "BASELINE_UNKNOWN" && ms?.checkedHead === missingState && /not available locally/.test(ms?.reason ?? ""), JSON.stringify(ms));
    const missingDoc = commitWithMissingBlob(s, stateCommit, "CLAUDE.md");
    const md = fresh(s, "--ref", missingDoc).json;
    check("FR8 an unavailable knowledge document -> BASELINE_UNKNOWN, never COMPLETE", md?.status === "BASELINE_UNKNOWN" && md?.signals === null && /CLAUDE\.md/.test(md?.reason ?? ""), JSON.stringify(md));
  }

  // --- FR9 ---------------------------------------------------------------------------------------
  {
    const shallow = join(root, "shallow");
    execFileSync("git", ["clone", "-q", "--depth", "1", "-b", "dev", pathToFileURL(repo).href, shallow], { env: GIT_ENV });
    const sh = fresh(shallow, "--ref", "HEAD").json;
    check("FR9 shallow history (knowledgeHead absent) -> BASELINE_UNKNOWN", sh?.status === "BASELINE_UNKNOWN" && sh?.checkedHead === dev && /not in this repository's history/.test(sh?.reason ?? ""), JSON.stringify(sh));
    const noGit = join(root, "no-git-bin");
    mkdirSync(noGit);
    const ng = spawnSync(process.execPath, ["--no-warnings", join(import.meta.dirname, "inspection-state.ts"), "freshness", repo, "--ref", "dev"], { encoding: "utf-8", env: childEnv(noGit) });
    const ngj = (() => { try { return JSON.parse(ng.stdout); } catch { return null; } })();
    check("FR9 Git unavailable -> BASELINE_UNKNOWN, exit 0", ng.status === 0 && ngj?.status === "BASELINE_UNKNOWN" && ngj?.checkedHead === null, ng.stdout + ng.stderr);
  }

  // --- FR10 --------------------------------------------------------------------------------------
  {
    const server = join(root, "server");
    execFileSync("git", ["clone", "-q", "--bare", "--no-hardlinks", repo, server], { env: GIT_ENV });
    g(server, "config", "uploadpack.allowFilter", "true");
    g(server, "config", "uploadpack.allowAnySHA1InWant", "true");
    const pc = join(root, "partial");
    execFileSync("git", ["clone", "-q", "--filter=blob:none", "--no-checkout", pathToFileURL(server).href, pc], { env: GIT_ENV });
    const stateBlob = g(pc, "rev-parse", "origin/dev:.ono/state.json");
    const missing = () => spawnSync("git", ["cat-file", "-e", stateBlob], { cwd: pc, env: { ...process.env, GIT_NO_LAZY_FETCH: "1" } }).status !== 0;
    check("FR10 fixture: a real partial clone without the state blob", missing() && g(pc, "config", "--get", "remote.origin.promisor") === "true");
    const objs = g(pc, "count-objects", "-v");
    const p = fresh(pc, "--ref", "origin/dev").json;
    check("FR10 the result is BASELINE_UNKNOWN (object not available locally, or lazy fetch cannot be disabled)", p?.status === "BASELINE_UNKNOWN" && p?.signals === null, JSON.stringify(p));
    check("FR10 nothing was fetched: the blob is still missing and the object store is unchanged", missing() && g(pc, "count-objects", "-v") === objs && !existsSync(join(pc, ".git", "FETCH_HEAD")));
    const pol = objectReadPolicy(pc);
    const supported = pol.ok;
    check(`FR10 this Git ${supported ? "supports" : "lacks"} --no-lazy-fetch: ${supported ? "every read passes it" : "the partial clone is refused"}`,
      supported ? pol.ok && pol.policy.partialClone && JSON.stringify(pol.policy.args) === '["--no-lazy-fetch"]' && pol.policy.env.GIT_NO_LAZY_FETCH === "1" && /not available locally/.test(p?.reason ?? "")
        : /--no-lazy-fetch/.test(p?.reason ?? ""), p?.reason);
    const old = objectReadPolicy(pc, () => false);
    check("FR10 a Git without --no-lazy-fetch fails closed on a partial clone", !old.ok && /could access the network/.test(old.ok ? "" : old.reason));
    const ord = objectReadPolicy(repo, () => false);
    check("FR10 an ordinary clone needs nothing new, whatever the Git (env only, no extra option)", ord.ok && !ord.policy.partialClone && ord.policy.args.length === 0);
    // Negative control: the same partial clone WITHOUT protection does fetch the missing object,
    // so the no-fetch results above are the protection at work, not a fixture that cannot fetch.
    const ctl = join(root, "partial-control");
    execFileSync("git", ["clone", "-q", "--filter=blob:none", "--no-checkout", pathToFileURL(server).href, ctl], { env: GIT_ENV });
    const ctlEnv = { ...process.env };
    delete ctlEnv.GIT_NO_LAZY_FETCH;
    const lazy = spawnSync("git", ["cat-file", "blob", stateBlob], { cwd: ctl, env: ctlEnv });
    check("FR10 negative control: unprotected, Git lazily fetches the missing blob over the remote", lazy.status === 0 && spawnSync("git", ["cat-file", "-e", stateBlob], { cwd: ctl, env: { ...process.env, GIT_NO_LAZY_FETCH: "1" } }).status === 0);
    const guarded = spawnSync("git", ["--no-lazy-fetch", "cat-file", "blob", stateBlob], { cwd: pc, env: ctlEnv });
    check("FR10 ...while --no-lazy-fetch alone (no environment variable) prevents it", guarded.status !== 0 && missing());
  }

  // --- FR11 --------------------------------------------------------------------------------------
  {
    const sig = r.json?.signals;
    check("FR11 analysis kinds are the stable list, in order", JSON.stringify(sig?.analysis?.map((a: any) => a.kind)) === JSON.stringify(SIGNAL_KINDS));
    const count = (k: string) => sig?.analysis?.find((a: any) => a.kind === k);
    check("FR11 build-manifest-changed counts distinct changed manifests (package.json, vite.config.ts, tizen/config.xml)", count("build-manifest-changed")?.count === 3);
    check("FR11 top-level-entry-added / -removed count distinct entries (newtop / legacy)", count("top-level-entry-added")?.count === 1 && count("top-level-entry-removed")?.count === 1);
    check("FR11 surface-evidence-changed counts changed evidence files and names their surfaces", count("surface-evidence-changed")?.count === 2 && JSON.stringify(count("surface-evidence-changed")?.surfaces) === '["tizen","web"]', JSON.stringify(count("surface-evidence-changed")));
    check("FR11 refreshStages: registry order, both stages (analysis signalled)", JSON.stringify(sig?.refreshStages) === '["project-analysis","project-docs"]');
    check("FR11 affected ids are sorted ids from the recorded knowledge", JSON.stringify(sig?.affected?.surfaces) === JSON.stringify([...(sig?.affected?.surfaces ?? [])].sort()) && sig?.affected?.surfaces?.includes("tizen"));
    check("FR11 model gaps: none for complete knowledge", Array.isArray(sig?.model) && sig.model.length === 0);
    const text = JSON.stringify(sig);
    check("FR11 no file path, directory name or source content appears in signals", !["package.json", "vite.config", "config.xml", "newtop", "legacy", "חדש", "src/", ".tsx"].some((s) => text.includes(s)), text);
    check("FR11 deterministic: a second run gives identical signals", JSON.stringify(fresh(repo, "--ref", "dev").json?.signals) === text);
    const complete = fresh(repo, "--ref", stateCommit).json;
    check("FR11 COMPLETE: every kind is established as 0 (not null), nothing affected", complete?.status === "COMPLETE" &&
      complete?.signals?.analysis?.every((a: any) => a.count === 0) && JSON.stringify(complete?.signals?.analysis?.[3]?.surfaces) === "[]" &&
      complete?.signals?.refreshStages?.length === 0 && Object.values(complete?.signals?.affected ?? {}).every((x: any) => x.length === 0), JSON.stringify(complete?.signals));
    check("FR11 BASELINE_UNKNOWN: signals is null (not established); NOT_APPLICABLE: see FR8", fresh(repo, "--ref", knowledgeHead).json?.signals === null && fresh(repo, "--ref", "no-such").json?.signals === null);
    // A model gap alone (no source drift): REFRESH_RECOMMENDED with zero analysis signals.
    const gap = join(root, "gap");
    inspectedRepo(gap);
    put(gap, "docs/project/patterns.md", readFileSync(join(gap, "docs/project/patterns.md"), "utf-8").replace(/\n## Accessibility\n/, "\n## Accessibility notes\n"));
    commit(gap, "patterns section renamed");
    const gj = fresh(gap).json;
    check("FR11 model gap only: REFRESH_RECOMMENDED, analysis all 0, the gap named by stage and requirement",
      gj?.status === "REFRESH_RECOMMENDED" && gj?.signals?.analysis?.every((a: any) => a.count === 0) &&
      JSON.stringify(gj?.signals?.model) === '[{"stage":"project-docs","requirement":"docs/project/patterns.md#accessibility"}]' &&
      JSON.stringify(gj?.signals?.refreshStages) === '["project-docs"]', JSON.stringify(gj?.signals));
  }

  // --- FR12 --------------------------------------------------------------------------------------
  {
    const rel = join(root, "inspector-0.13.0");
    extractRelease(REL_0130, ["scripts", "skills", ".claude-plugin"], rel);
    const old = (dir: string) => JSON.parse(execFileSync(process.execPath, ["--no-warnings", join(rel, "scripts", "inspection-state.ts"), "freshness", dir], { encoding: "utf-8" }));
    const same = (dir: string) => { const a = fresh(dir).json; const b = old(dir); delete a.signals; delete a.checkedAt; delete b.checkedAt; return JSON.stringify(a) === JSON.stringify(b) ? a.status : `DIFF ${JSON.stringify(a)} vs ${JSON.stringify(b)}`; };
    const uninspected = join(root, "uninspected");
    mkdirSync(uninspected);
    g(uninspected, "init", "-q", "-b", "main");
    put(uninspected, "a.txt", "a\n");
    commit(uninspected, "init");
    const results = [same(central), same(join(root, "gap")), same(uninspected), same(repo)];
    check("FR12 without --ref: COMPLETE / REFRESH_RECOMMENDED / NOT_APPLICABLE / BASELINE_UNKNOWN identical to 0.13.0",
      JSON.stringify(results) === JSON.stringify(["REFRESH_RECOMMENDED", "REFRESH_RECOMMENDED", "NOT_APPLICABLE", "BASELINE_UNKNOWN"]), JSON.stringify(results));
    const fc = join(root, "fresh-complete");
    inspectedRepo(fc);
    check("FR12 ...and COMPLETE", same(fc) === "COMPLETE");
    const plain = fresh(fc).json;
    check("FR12 without --ref there is no ref field", plain && !("ref" in plain));
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
