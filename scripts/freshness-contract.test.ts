/**
 * freshness-contract.test.ts
 *
 * The machine-readable knowledge freshness contract for Guardian (0.13.0):
 * `inspection-state.ts freshness <root>` (read-only) and the `knowledge` snapshot that
 * the Inspector stores in `.ono/state.json` whenever it writes that file anyway.
 *
 *   F1  shape: exactly the documented fields, contractVersion 1
 *   F2  every status, and changedSourceCount null whenever it is not established
 *   F3  never COMPLETE without Git evidence: git missing, rewritten history, corrupt state
 *   F4  read-only: works on main / detached HEAD, modifies no file, never refuses
 *   F5  the snapshot is written only together with existing writes (sync, record-knowledge)
 *   F6  a stored COMPLETE is detectably out of date once HEAD moves
 *   F7  older Inspector (0.12.0, real code from edbc277) keeps working with — and keeps —
 *       the additive state fields
 *
 * No external test framework. Run with:
 *   node --no-warnings scripts/freshness-contract.test.ts
 */

import { execFileSync, spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { extractRelease, g, helper, inspectedRepo, PLUGIN } from "./fixtures/inspected.ts";
import { childEnv, pathList } from "./fixtures/platform.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ""}`); }
}

const FIELDS = ["changedSourceCount", "checkedAt", "checkedHead", "contractVersion", "knowledgeHead", "reason", "status"];
const root = realpathSync(mkdtempSync(join(tmpdir(), "inspector-fresh-")));
const fresh = (dir: string) => helper(dir, "inspection-state.ts", "freshness", dir);
const put = (dir: string, rel: string, body: string) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), body); };
const commit = (dir: string, msg: string) => { g(dir, "add", "-A"); g(dir, "commit", "-q", "-m", msg); };
const readState = (dir: string) => JSON.parse(readFileSync(join(dir, ".ono", "state.json"), "utf-8"));
/** Every file under dir (except .git) with its size and mtime: proves nothing was written. */
function treeFingerprint(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { const s = statSync(p); out.push(`${p}:${s.size}:${s.mtimeMs}:${readFileSync(p, "utf-8")}`); }
    }
  };
  walk(dir);
  return out.sort().join("\n");
}

try {
  // --- F1 / F2: shape and statuses ----------------------------------------------------------------
  const repo = join(root, "repo");
  const knowledgeHead = inspectedRepo(repo);
  const c = fresh(repo);
  check("F1 exits 0 with one JSON object", c.code === 0 && c.json !== null && c.stderr === "", c.stdout + c.stderr);
  check("F1 exactly the documented fields", JSON.stringify(Object.keys(c.json ?? {}).sort()) === JSON.stringify(FIELDS), Object.keys(c.json ?? {}).join(","));
  check("F1 contractVersion is 1", c.json?.contractVersion === 1);
  check("F1 checkedAt is ISO-8601", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(c.json?.checkedAt ?? ""));
  check("F2 fresh knowledge -> COMPLETE, count 0, heads reported", c.json?.status === "COMPLETE" && c.json?.changedSourceCount === 0 && c.json?.knowledgeHead === knowledgeHead && c.json?.checkedHead === g(repo, "rev-parse", "HEAD"), JSON.stringify(c.json));
  check("F2 agrees with detect", c.json?.status === helper(repo, "inspection-state.ts", "detect", repo).json?.knowledge?.status);

  put(repo, "src/features/epg/New.tsx", "x\n");
  put(repo, "src/features/epg/Other.tsx", "y\n");
  commit(repo, "source change");
  const s = fresh(repo).json;
  check("F2 stale knowledge -> REFRESH_RECOMMENDED with the changed count", s?.status === "REFRESH_RECOMMENDED" && s?.changedSourceCount === 2, JSON.stringify(s));

  const none = join(root, "uninspected");
  mkdirSync(none);
  g(none, "init", "-q", "-b", "main");
  put(none, "a.txt", "a\n");
  commit(none, "init");
  const n = fresh(none).json;
  check("F2 no inspection -> NOT_APPLICABLE, count null", n?.status === "NOT_APPLICABLE" && n?.changedSourceCount === null && n?.knowledgeHead === null, JSON.stringify(n));

  const prog = join(root, "in-progress");
  inspectedRepo(prog);
  const st = readState(prog);
  st.inspection.stage3Complete = false;
  writeFileSync(join(prog, ".ono", "state.json"), JSON.stringify(st, null, 2));
  check("F2 inspection in progress -> NOT_APPLICABLE, count null", fresh(prog).json?.status === "NOT_APPLICABLE" && fresh(prog).json?.changedSourceCount === null);

  const nokh = join(root, "no-knowledge-head");
  inspectedRepo(nokh);
  const st2 = readState(nokh);
  delete st2.repository.knowledgeHead;
  writeFileSync(join(nokh, ".ono", "state.json"), JSON.stringify(st2, null, 2));
  const u = fresh(nokh).json;
  check("F2 no knowledgeHead recorded -> BASELINE_UNKNOWN, count null", u?.status === "BASELINE_UNKNOWN" && u?.changedSourceCount === null, JSON.stringify(u));

  // --- F3: never COMPLETE without Git evidence ------------------------------------------------------
  const nodeOnly = childEnv(pathList(dirname(process.execPath)));
  const noGit = spawnSync(process.execPath, ["--no-warnings", join(PLUGIN, "scripts", "inspection-state.ts"), "freshness", repo], { encoding: "utf-8", env: nodeOnly });
  const ng = JSON.parse(noGit.stdout || "null");
  check("F3 git not available -> BASELINE_UNKNOWN (never COMPLETE), count null, exit 0", noGit.status === 0 && ng?.status === "BASELINE_UNKNOWN" && ng?.changedSourceCount === null, noGit.stdout + noGit.stderr);
  const fresh2 = join(root, "fresh-but-no-git");
  inspectedRepo(fresh2);
  const ng2 = JSON.parse(spawnSync(process.execPath, ["--no-warnings", join(PLUGIN, "scripts", "inspection-state.ts"), "freshness", fresh2], { encoding: "utf-8", env: nodeOnly }).stdout || "null");
  check("F3 even an up-to-date repository is not COMPLETE when git is unavailable", ng2?.status === "BASELINE_UNKNOWN", JSON.stringify(ng2));

  const rewritten = join(root, "rewritten");
  inspectedRepo(rewritten);
  const st3 = readState(rewritten);
  st3.repository.knowledgeHead = "0123456789abcdef0123456789abcdef01234567";
  writeFileSync(join(rewritten, ".ono", "state.json"), JSON.stringify(st3, null, 2));
  check("F3 knowledgeHead not in history (rewritten / shallow) -> BASELINE_UNKNOWN", fresh(rewritten).json?.status === "BASELINE_UNKNOWN");

  const corrupt = join(root, "corrupt");
  inspectedRepo(corrupt);
  writeFileSync(join(corrupt, ".ono", "state.json"), "{ not json");
  const cj = fresh(corrupt);
  check("F3 unreadable state.json -> BASELINE_UNKNOWN, exit 0", cj.code === 0 && cj.json?.status === "BASELINE_UNKNOWN" && cj.json?.changedSourceCount === null, cj.stdout + cj.stderr);

  // --- F4: read-only on every branch ------------------------------------------------------------------
  const onMain = join(root, "on-main");
  inspectedRepo(onMain);
  g(onMain, "branch", "-m", "main");
  const before = treeFingerprint(onMain);
  const statusBefore = g(onMain, "status", "--porcelain");
  const m = fresh(onMain);
  check("F4 on main: answers (no protected-branch refusal), exit 0", m.code === 0 && m.json?.status === "COMPLETE", m.stdout + m.stderr);
  g(onMain, "switch", "-q", "--detach");
  check("F4 on a detached HEAD: answers", fresh(onMain).json?.status === "COMPLETE");
  check("F4 no file in the project was created, changed or touched", treeFingerprint(onMain) === before);
  check("F4 git status unchanged", g(onMain, "status", "--porcelain") === statusBefore);
  const writesOnMain = helper(onMain, "inspection-state.ts", "sync", onMain);
  check("F4 writing commands still refuse there (exit 5)", writesOnMain.code === 5);

  // --- F5: snapshot only alongside existing writes -------------------------------------------------------
  const snap = join(root, "snapshot");
  inspectedRepo(snap);
  const stored = readState(snap).knowledge;
  check("F5 record-knowledge stored a snapshot with the documented fields", JSON.stringify(Object.keys(stored ?? {}).sort()) === JSON.stringify(FIELDS) && stored?.status === "COMPLETE", JSON.stringify(stored));
  const stateBytes = readFileSync(join(snap, ".ono", "state.json"), "utf-8");
  for (let i = 0; i < 3; i++) { fresh(snap); helper(snap, "inspection-state.ts", "detect", snap); }
  check("F5 freshness and detect never write state.json (no checkedAt-only writes)", readFileSync(join(snap, ".ono", "state.json"), "utf-8") === stateBytes);
  check("F5 sync refreshes the snapshot as part of its normal write", helper(snap, "inspection-state.ts", "sync", snap).code === 0 && readState(snap).knowledge?.checkedHead === g(snap, "rev-parse", "HEAD"));
  const src = readFileSync(join(PLUGIN, "scripts", "inspection-state.ts"), "utf-8");
  check("F5 the snapshot is set only inside writeState (no separate writer)", (src.match(/state\.knowledge = freshnessContract/g) ?? []).length === 1 && /function writeState[\s\S]{0,600}state\.knowledge = freshnessContract/.test(src));

  // --- F6: a stored COMPLETE goes out of date when HEAD moves ----------------------------------------------
  const moved = join(root, "moved");
  inspectedRepo(moved);
  const storedC = readState(moved).knowledge;
  put(moved, "src/features/epg/Moved.tsx", "x\n");
  commit(moved, "source change after the snapshot");
  const live = fresh(moved).json;
  check("F6 the stored snapshot still says COMPLETE (it is a record, not a live answer)", storedC?.status === "COMPLETE");
  check("F6 its checkedHead no longer equals HEAD, so it is not authoritative", storedC?.checkedHead !== g(moved, "rev-parse", "HEAD"));
  check("F6 the read-only command reports the truth", live?.status === "REFRESH_RECOMMENDED" && live?.changedSourceCount === 1);

  // --- F7: the previous release (0.12.0) with 0.13.0 state ------------------------------------------------------
  const old = join(root, "inspector-0.12.0");
  mkdirSync(old);
  const REL_0120 = "edbc2772fb0eb11d3fa5e51a89e81fbb9b4b3f0d";
  const ex = extractRelease(REL_0120, ["scripts", "skills", ".claude-plugin"], old);
  check("F7 the 0.12.0 helpers were extracted from the exact commit (Git objects, no tar)", ex.files > 20, String(ex.files));
  const shown = execFileSync("git", ["show", `${REL_0120}:scripts/inspection-state.ts`], { cwd: PLUGIN });
  check("F7 extraction is byte-for-byte", Buffer.compare(shown, readFileSync(join(old, "scripts", "inspection-state.ts"))) === 0);
  if (process.platform !== "win32") check("F7 the executable bit is kept (write-guard.sh is 100755)", (statSync(join(old, "scripts", "write-guard.sh")).mode & 0o111) !== 0);
  else check("F7 the 100755 file is extracted on Windows too (no POSIX mode bits there)", existsSync(join(old, "scripts", "write-guard.sh")));
  let threw = "";
  try { extractRelease("0123456789abcdef0123456789abcdef01234567", ["scripts"], join(root, "nope")); } catch (e) { threw = (e as Error).message; }
  check("F7 an unknown commit fails explicitly", /extractRelease: git cat-file -e/.test(threw), threw);
  threw = "";
  try { extractRelease(REL_0120, ["no-such-dir"], join(root, "nope2")); } catch (e) { threw = (e as Error).message; }
  check("F7 an empty selection fails explicitly", /has no files under/.test(threw), threw);
  // A hostile commit: Git stores a tree entry named "..", which would write outside the destination.
  const evil = join(root, "evil-repo");
  mkdirSync(evil);
  g(evil, "init", "-q", "-b", "work");
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: evil, input: "evil\n", encoding: "utf-8" }).trim();
  const sub = execFileSync("git", ["mktree", "-z"], { cwd: evil, input: `100644 blob ${blob}\t..\u0000`, encoding: "utf-8" }).trim();
  const top = execFileSync("git", ["mktree", "-z"], { cwd: evil, input: `040000 tree ${sub}\tscripts\u0000`, encoding: "utf-8" }).trim();
  const evilCommit = g(evil, "commit-tree", top, "-m", "evil");
  const evilDest = join(root, "evil-dest", "inner");
  threw = "";
  try { extractRelease(evilCommit, ["scripts"], evilDest, evil); } catch (e) { threw = (e as Error).message; }
  check("F7 a path that would leave the destination is refused, nothing written outside", /path escapes the destination/.test(threw) && readdirSync(evilDest).length === 0 && readdirSync(join(root, "evil-dest")).join(",") === "inner", threw);
  const oldVersion = JSON.parse(readFileSync(join(old, ".claude-plugin", "plugin.json"), "utf-8")).version;
  check("F7 the previous release really is 0.12.0", oldVersion === "0.12.0");
  const shared = join(root, "shared");
  inspectedRepo(shared);
  const s013 = readState(shared);
  s013.audits = { "fixture-only": { approval: null } }; // stands in for any additive 0.13.0 key
  s013.documents = { "CLAUDE.md": { bodySha256: "x" } };
  writeFileSync(join(shared, ".ono", "state.json"), JSON.stringify(s013, null, 2));
  const runOld = (cmd: string) => spawnSync(process.execPath, ["--no-warnings", join(old, "scripts", "inspection-state.ts"), cmd, shared], { encoding: "utf-8" });
  const od = runOld("detect");
  check("F7 0.12.0 detect reads 0.13.0 state", od.status === 0 && JSON.parse(od.stdout).knowledge?.status === "COMPLETE", od.stdout.slice(0, 200) + od.stderr);
  const os = runOld("sync");
  const after = readState(shared);
  check("F7 0.12.0 sync succeeds on 0.13.0 state", os.status === 0, os.stderr);
  check("F7 ...and keeps every additive 0.13.0 key", after.knowledge !== undefined && after.audits?.["fixture-only"] !== undefined && after.documents?.["CLAUDE.md"] !== undefined, Object.keys(after).join(","));
  check("F7 the schema version is still 1 (additive)", after.stateSchemaVersion === 1);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
