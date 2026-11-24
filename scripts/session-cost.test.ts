/**
 * session-cost.test.ts
 *
 * The offline session usage report (scripts/session-cost.ts, 0.13.0), on synthetic
 * transcripts shaped like Claude Code's (main file + <session>/subagents/*.jsonl).
 *
 *   S1  every API message counted once: repeated content-block entries, and subagent
 *       messages mirrored into the main transcript
 *   S2  main vs subagent attribution, per-model totals, 5m / 1h cache writes
 *   S3  reported (Claude Code cost-state) vs estimated (caller rates) vs unavailable
 *   S4  cache reads are priced at their own rate, never as uncached input
 *   S5  operation classification: a refresh is only a refresh
 *   S6  activity counters: tools, Inspector helpers, documents, changed-source count
 *   S7  privacy: no prompt, response, tool input/output, path, file or project name leaks
 *   S8  --repo size (local git), malformed lines, and no network / no writes
 *
 * No external test framework. Run with:
 *   node --no-warnings scripts/session-cost.test.ts
 */

import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { g } from "./fixtures/inspected.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ""}`); }
}

const HERE = import.meta.dirname;
const SCRIPT = join(HERE, "session-cost.ts");
const root = realpathSync(mkdtempSync(join(tmpdir(), "inspector-cost-")));
const SECRETS = ["AcmeCustomerCorp", "sk-live-SECRET-TOKEN-123", "/Users/someone/clients/acme-tv", "PaymentGateway.ts", "password=hunter2", "const apiKey"];

const usage = (input: number, output: number, read: number, w5: number, w1: number) => ({
  input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: w5 + w1,
  cache_creation: { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: w1 },
});
let ts = Date.parse("2026-11-20T10:00:00.000Z");
const at = (sec: number) => new Date(ts + sec * 1000).toISOString();
const assistant = (id: string, model: string, u: object, content: object[], sec: number, extra: object = {}) =>
  ({ type: "assistant", timestamp: at(sec), requestId: `req_${id}`, uuid: `u_${id}_${sec}`, message: { id, model, role: "assistant", usage: u, content }, ...extra });
const toolUse = (id: string, name: string, input: object) => ({ type: "tool_use", id, name, input });
const toolResult = (id: string, text: string, sec: number) => ({ type: "user", timestamp: at(sec), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] } });
const jsonl = (recs: object[]) => recs.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n";
function run(args: string[]) {
  const r = spawnSync(process.execPath, ["--no-warnings", SCRIPT, ...args], { encoding: "utf-8" });
  let json: any = null; try { json = JSON.parse(r.stdout); } catch { /* none */ }
  return { code: r.status ?? -1, json, out: r.stdout + r.stderr };
}

try {
  // A refresh session: main + one subagent.
  const project = join(root, "projects", "-Users-someone-clients-acme-tv");
  mkdirSync(join(project, "sess-1", "subagents"), { recursive: true });
  const main = join(project, "sess-1.jsonl");
  const P = "/Users/someone/clients/acme-tv";
  const mainRecs: any[] = [
    { type: "user", timestamp: at(0), message: { role: "user", content: `Refresh knowledge for AcmeCustomerCorp, password=hunter2` } },
    // msg A appears twice (one entry per content block) — counted once.
    assistant("msgA", "claude-opus-5-5", usage(10, 100, 1000, 0, 500), [{ type: "text", text: "Working on AcmeCustomerCorp with sk-live-SECRET-TOKEN-123" }], 1),
    assistant("msgA", "claude-opus-5-5", usage(10, 100, 1000, 0, 500), [toolUse("tu1", "Agent", { prompt: "inspect AcmeCustomerCorp" })], 2),
    // A subagent message mirrored into the main file (sidechain) — must not be counted twice.
    assistant("msgS1", "claude-sonnet-5-5", usage(5, 50, 2000, 300, 0), [toolUse("tuS1", "Bash", { command: `node --no-warnings "/plugin/scripts/inspection-state.ts" detect "${P}"` })], 3, { isSidechain: true }),
    "{ this line is not json",
    { type: "cost-state", timestamp: at(60), totalCostUSD: 0.5, totalDuration: 59000, totalAPIDuration: 41000, modelUsage: { "claude-opus-5-5": { costUSD: 0.3 }, "claude-sonnet-5-5": { costUSD: 0.2 } } },
    { type: "cost-state", timestamp: at(61), totalCostUSD: 0.75, totalDuration: 61000, totalAPIDuration: 45000, modelUsage: { "claude-opus-5-5": { costUSD: 0.45 }, "claude-sonnet-5-5": { costUSD: 0.3 } } },
  ];
  const subRecs: any[] = [
    assistant("msgS1", "claude-sonnet-5-5", usage(5, 50, 2000, 300, 0), [toolUse("tuS1", "Bash", { command: `node --no-warnings "/plugin/scripts/inspection-state.ts" detect "${P}"` })], 3, { isSidechain: true }),
    toolResult("tuS1", JSON.stringify({ knowledge: { status: "REFRESH_RECOMMENDED", changedSourceCount: 7 } }, null, 2).replace(/\n/g, "\n"), 4),
    assistant("msgS2", "claude-sonnet-5-5", usage(5, 70, 3000, 200, 0), [toolUse("tuS2", "Bash", { command: `node --no-warnings "/plugin/scripts/knowledge-refresh-guard.ts" snapshot "${P}"` })], 5, { isSidechain: true }),
    assistant("msgS3", "claude-sonnet-5-5", usage(5, 900, 4000, 100, 0), [
      toolUse("tuS3", "Write", { file_path: `${P}/CLAUDE.md`, content: "const apiKey = 1; PaymentGateway.ts" }),
      toolUse("tuS4", "Edit", { file_path: `${P}/docs/project/overview.md`, old_string: "a", new_string: "b" }),
      toolUse("tuS5", "Edit", { file_path: `${P}/docs/project/overview.md`, old_string: "b", new_string: "c" }),
      toolUse("tuS6", "Write", { file_path: `${P}/docs/project/capabilities.md`, content: "x" }),
      toolUse("tuS7", "Write", { file_path: `${P}/src/PaymentGateway.ts`, content: "should never happen" }),
    ], 30, { isSidechain: true }),
    assistant("msgS4", "claude-sonnet-5-5", usage(5, 40, 5000, 0, 0), [
      toolUse("tuS8", "Bash", { command: `node --no-warnings "/plugin/scripts/inspection-state.ts" record-knowledge "${P}" project-analysis && node --no-warnings "/plugin/scripts/inspection-state.ts" stamp-docs "${P}" CLAUDE.md` }),
      toolUse("tuS9", "Bash", { command: `cat ${P}/src/PaymentGateway.ts` }),
    ], 40, { isSidechain: true }),
    toolResult("tuS8", '{"changedSourceCount": 0}', 41),
  ];
  writeFileSync(main, jsonl(mainRecs));
  writeFileSync(join(project, "sess-1", "subagents", "agent-1.jsonl"), jsonl(subRecs));

  const r = run([main]);
  const rep = r.json;
  check("S8 exits 0 with one JSON report", r.code === 0 && rep?.report === "ono-project-inspector session-cost" && rep?.reportVersion === 1, r.out.slice(0, 300));

  // --- S1 / S2 ----------------------------------------------------------------------------------------
  check("S1 messages counted once (A once, S1 once despite the mirror)", rep?.tokens?.total?.messages === 5, JSON.stringify(rep?.tokens?.total));
  check("S1 output tokens = 100 + 50 + 70 + 900 + 40", rep?.tokens?.total?.output === 1160);
  check("S2 per model", rep?.tokens?.byModel?.["claude-opus-5-5"]?.output === 100 && rep?.tokens?.byModel?.["claude-sonnet-5-5"]?.output === 1060);
  check("S2 sidechain work is attributed to subagents", rep?.tokens?.bySource?.main?.messages === 1 && rep?.tokens?.bySource?.subagents?.messages === 4, JSON.stringify(rep?.tokens?.bySource));
  check("S2 uncached input, cache reads and 5m/1h writes kept separate", rep?.tokens?.total?.input === 30 && rep?.tokens?.total?.cacheRead === 15000 && rep?.tokens?.total?.cacheWrite5m === 600 && rep?.tokens?.total?.cacheWrite1h === 500 && rep?.tokens?.total?.cacheWrite === 1100, JSON.stringify(rep?.tokens?.total));
  check("S2 records read / skipped counted", rep?.transcripts?.subagents === 1 && rep?.transcripts?.recordsSkipped === 1);

  // --- S3 / S4 ----------------------------------------------------------------------------------------
  check("S3 reported cost = Claude Code's latest cost-state", rep?.reportedCost?.value === 0.75 && rep?.reportedCost?.label === "reported" && rep?.reportedCost?.byModel?.["claude-opus-5-5"] === 0.45);
  check("S3 reported duration / API time", rep?.time?.reportedDurationSeconds?.value === 61 && rep?.time?.reportedApiSeconds?.value === 45 && rep?.time?.reportedDurationSeconds?.label === "reported");
  check("S3 wall clock measured from timestamps", rep?.time?.wallClockSeconds?.value === 61 && rep?.time?.wallClockSeconds?.label === "measured");
  check("S3 no prices -> no estimate (unavailable), nothing built in", rep?.estimatedCost?.value === null && rep?.estimatedCost?.label === "unavailable");
  const prices = join(root, "prices.json");
  writeFileSync(prices, JSON.stringify({
    "claude-opus-5-5": { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 },
    "claude-sonnet-5-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
  }));
  const e = run([main, "--prices", prices]).json;
  // opus: 10*10 + 100*50 + 1000*1 + 0*12.5 + 500*20 = 16100 -> 0.0161 ; sonnet: 20*3 + 1060*15 + 14000*0.3 + 600*3.75 + 0 = 22410 -> 0.02241
  check("S4 estimate prices every token class at its own rate", e?.estimatedCost?.byModel?.["claude-opus-5-5"] === 0.0161 && e?.estimatedCost?.byModel?.["claude-sonnet-5-5"] === 0.02241 && e?.estimatedCost?.value === 0.03851, JSON.stringify(e?.estimatedCost));
  check("S4 cache reads are NOT priced as uncached input", e?.estimatedCost?.value !== (30 * 10 + 15000 * 10) / 1e6);
  check("S4 estimate labelled estimated", e?.estimatedCost?.label === "estimated");
  writeFileSync(prices, JSON.stringify({ "claude-opus-5-5": { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 } }));
  const partial = run([main, "--prices", prices]).json;
  check("S4 a model without rates -> total unavailable, never guessed", partial?.estimatedCost?.value === null && partial?.estimatedCost?.label === "unavailable" && partial?.estimatedCost?.byModel?.["claude-opus-5-5"] === 0.0161);

  // --- S5 / S6 -------------------------------------------------------------------------------------------
  check("S5 refresh classified from the refresh-guard snapshot", rep?.operation?.value === "refresh-project-knowledge" && rep?.operation?.label === "measured");
  const initial = join(project, "sess-2.jsonl");
  writeFileSync(initial, jsonl([assistant("i1", "claude-opus-5-5", usage(1, 1, 1, 0, 0), [toolUse("ti1", "Bash", { command: 'node "/p/scripts/inspection-state.ts" record-knowledge "/x" project-analysis' })], 1)]));
  check("S5 an initial inspection is never reported as a refresh", run([initial]).json?.operation?.value === "initial-inspection");
  const empty = join(project, "sess-3.jsonl");
  writeFileSync(empty, jsonl([{ type: "user", timestamp: at(0), message: { role: "user", content: "hi" } }]));
  const er = run([empty]).json;
  check("S5 no marker -> unknown / unavailable; tokens unavailable", er?.operation?.value === "unknown" && er?.tokens?.label === "unavailable");
  check("S6 tool calls by name (each tool_use once)", JSON.stringify(rep?.activity?.toolCalls) === JSON.stringify({ Agent: 1, Bash: 4, Write: 3, Edit: 2 }), JSON.stringify(rep?.activity?.toolCalls));
  check("S6 Inspector helper calls by script name", rep?.activity?.inspectorHelperCalls?.["inspection-state.ts"] === 3 && rep?.activity?.inspectorHelperCalls?.["knowledge-refresh-guard.ts"] === 1, JSON.stringify(rep?.activity?.inspectorHelperCalls));
  check("S6 inspection-state commands", rep?.activity?.inspectionStateCommands?.detect === 1 && rep?.activity?.inspectionStateCommands?.["record-knowledge"] === 1 && rep?.activity?.inspectionStateCommands?.["stamp-docs"] === 1, JSON.stringify(rep?.activity?.inspectionStateCommands));
  check("S6 documents written, as distinct counts per kind (source files excluded)", JSON.stringify(rep?.activity?.documentsWritten) === JSON.stringify({ claudeMd: 1, auditMd: 0, docsProject: 2, audits: 0, label: "measured" }), JSON.stringify(rep?.activity?.documentsWritten));
  check("S6 changed-source count as detect reported it (start and end)", rep?.activity?.changedSourceCount?.atStart === 7 && rep?.activity?.changedSourceCount?.atEnd === 0);

  // --- S7: privacy ----------------------------------------------------------------------------------------
  const out = run([main, "--prices", prices]).out;
  for (const s of SECRETS) check(`S7 the report never contains ${JSON.stringify(s)}`, !out.includes(s) && !out.includes(s.toLowerCase()));
  check("S7 no path separators beyond model names (no file or project paths)", !/[A-Za-z]:\\|\/Users\/|\/home\/|projects\//.test(out));
  check("S7 no session id or file name", !out.includes("sess-1") && !out.includes("agent-1"));

  // --- S9: transcript-derived labels are allowlisted (no connector, customer or account names) ------------------
  {
    const LEAKS = ["acme-bank", "acmebank", "jira", "123456789012", "AcmeCustomTool", "inference-profile", "eu-west"];
    const leaky = join(project, "sess-9.jsonl");
    writeFileSync(leaky, jsonl([
      assistant("l1", "arn:aws:bedrock:eu-west-1:123456789012:application-inference-profile/claude-acmebank-prod", usage(1, 10, 0, 0, 0), [
        toolUse("tl1", "mcp__acme-bank-jira__get_issue", { key: "ACME-1" }),
        toolUse("tl2", "mcp__acme-bank-jira__search", { q: "x" }),
        toolUse("tl3", "AcmeCustomTool", {}),
        toolUse("tl4", "Read", { file_path: "/x" }),
      ], 1),
      assistant("l2", "us.anthropic.claude-sonnet-5-5-v1:0", usage(1, 20, 0, 0, 0), [], 2),
      assistant("l3", "acme-bank-claude-proxy", usage(1, 30, 0, 0, 0), [], 3),
      { type: "cost-state", timestamp: at(4), totalCostUSD: 1, totalDuration: 1000, totalAPIDuration: 900, modelUsage: { "arn:aws:bedrock:eu-west-1:123456789012:application-inference-profile/claude-acmebank-prod": { costUSD: 0.4 }, "claude-sonnet-5-5": { costUSD: 0.6 } } },
    ]));
    const lr = run([leaky]);
    check("S9 MCP tools are counted only as `mcp`, unknown tools as `other`", JSON.stringify(lr.json?.activity?.toolCalls) === JSON.stringify({ mcp: 2, other: 1, Read: 1 }), JSON.stringify(lr.json?.activity?.toolCalls));
    check("S9 model labels: Anthropic ids only; ARNs / proxies / custom names -> other-model", JSON.stringify(Object.keys(lr.json?.tokens?.byModel ?? {}).sort()) === JSON.stringify(["claude-sonnet-5-5-v1", "other-model"]), JSON.stringify(Object.keys(lr.json?.tokens?.byModel ?? {})));
    check("S9 reported per-model cost uses the same labels", JSON.stringify(lr.json?.reportedCost?.byModel) === JSON.stringify({ "other-model": 0.4, "claude-sonnet-5-5": 0.6 }), JSON.stringify(lr.json?.reportedCost?.byModel));
    for (const s of LEAKS) check(`S9 the report never contains ${JSON.stringify(s)}`, !lr.out.toLowerCase().includes(s.toLowerCase()));
  }

  // --- S8: repository size, safety ---------------------------------------------------------------------------
  const repo = join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "work");
  writeFileSync(join(repo, "a.ts"), "12345");
  writeFileSync(join(repo, "פרויקט b.ts"), "123");
  g(repo, "add", "-A"); g(repo, "commit", "-q", "-m", "x");
  const rr = run([main, "--repo", repo]).json;
  check("S8 --repo: tracked files and bytes (local git)", rr?.repository?.trackedFiles === 2 && rr?.repository?.trackedBytes === 8 && rr?.repository?.label === "measured", JSON.stringify(rr?.repository));
  check("S8 without --repo the size is unavailable", rep?.repository?.label === "unavailable" && rep?.repository?.trackedFiles === null);
  const before = readdirSync(project, { recursive: true }).map(String).sort().join("|") + statSync(main).mtimeMs;
  run([main]);
  check("S8 nothing is written next to the transcripts", readdirSync(project, { recursive: true }).map(String).sort().join("|") + statSync(main).mtimeMs === before);
  const src = readFileSync(SCRIPT, "utf-8").replace(/\/\*\*[\s\S]*?\*\//g, "");
  const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  check("S8 imports only fs / path / child_process (git) and the plugin's entrypoint", imports.every((m) => ["child_process", "fs", "path", "./entrypoint.ts"].includes(m)), imports.join(","));
  check("S8 no network or write API", !/\b(fetch|https?|net|tls|dgram|XMLHttpRequest|WebSocket)\b\s*\(|from "(https?|net|tls|dgram)"|writeFileSync|appendFileSync|createWriteStream/.test(src));
  check("S8 the only process it starts is local `git ls-files`", (src.match(/execFileSync\(/g) ?? []).length === 1 && /execFileSync\("git", \["-c", "core\.quotePath=false", "ls-files", "-z"\]/.test(src));
  check("S8 missing transcript -> usage, exit 1", run([join(root, "nope.jsonl")]).code === 1);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
