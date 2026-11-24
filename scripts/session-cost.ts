/**
 * session-cost.ts — offline usage and timing report for one Claude Code session (0.13.0).
 *
 *   node --no-warnings scripts/session-cost.ts "<session>.jsonl" [--repo "<project root>"] [--prices "<prices.json>"]
 *
 * A developer tool, not part of the Inspector workflow. It reads a session transcript
 * that already exists on this machine (Claude Code keeps them under
 * ~/.claude/projects/<project>/<session-id>.jsonl, with the session's subagents in
 * <session-id>/subagents/*.jsonl, which are included automatically) and prints one JSON
 * report of AGGREGATE NUMBERS ONLY:
 *
 *   - tokens per model and per source (main session / subagents): uncached input,
 *     output, cache reads, cache writes (5-minute and 1-hour) — each API message counted
 *     once, even though transcripts repeat it per content block and may mirror subagent
 *     messages into the main file
 *   - wall-clock span, and Claude Code's own reported duration / API time / cost when
 *     the transcript carries its `cost-state` record
 *   - tool-call counts by tool name; Inspector helper calls by script name; documents the
 *     Inspector wrote, as counts per kind; the changed-source count `detect` reported
 *   - the operation the session performed (Refresh Project Knowledge, initial
 *     inspection, re-check, or unknown), so an initial inspection is never reported as
 *     a refresh
 *   - with --repo: tracked file count and total size of that project (local git only)
 *   - with --prices: an ESTIMATED cost from YOUR per-model rates (USD per million tokens:
 *     input, output, cacheRead, cacheWrite5m, cacheWrite1h). Cache reads are priced at
 *     their own rate, never as uncached input. No rates are built in.
 *
 * Every metric is labelled `measured` (counted from the transcript), `reported` (a value
 * Claude Code recorded), `estimated` (computed from your rates) or `unavailable`.
 *
 * Privacy: no network access, no model calls, nothing uploaded or written. The report
 * never contains prompts, responses, tool inputs or outputs, file paths, file names,
 * source code, project names or identifiers — only numbers, Anthropic model ids
 * (`claude-…`), Claude Code's built-in tool names (every MCP tool is `mcp`, anything
 * else `other`) and this plugin's own script and command names.
 */

import { execFileSync } from "child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { basename, dirname, join } from "path";
import { isEntryPoint, useBlockingOutput } from "./entrypoint.ts";

type Label = "measured" | "reported" | "estimated" | "unavailable";
interface Tokens { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite5m: number; cacheWrite1h: number; messages: number }
const zero = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, messages: 0 });
const add = (a: Tokens, b: Tokens) => { for (const k of Object.keys(a) as (keyof Tokens)[]) a[k] += b[k]; };

/** This plugin's helper scripts: the only names the report may contain. */
export const INSPECTOR_SCRIPTS = [
  "node-preflight.mjs", "resolve-repo-root.ts", "work-branch.ts", "inspection-state.ts", "repo-knowledge.ts",
  "verify-artifacts.ts", "knowledge-evidence.ts", "knowledge-refresh-guard.ts", "update-audit-index.ts",
  "audit-recheck.ts", "slugify.ts",
];
/**
 * Claude Code's built-in tools: the only tool names the report shows as they are. Every
 * MCP tool (`mcp__<server>__<tool>`, whose server name is user-chosen and may name a
 * customer or an organisation) is counted as `mcp`; any other name as `other`.
 */
export const BUILTIN_TOOLS = [
  "Agent", "Task", "Bash", "BashOutput", "KillShell", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit",
  "Glob", "Grep", "LS", "Skill", "SendMessage", "TodoWrite", "ToolSearch", "WebFetch", "WebSearch",
  "AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "Monitor", "TaskStop", "LSP", "Workflow",
  "ListMcpResourcesTool", "ReadMcpResourceTool", "SlashCommand",
];
export function toolLabel(name: unknown): string {
  if (typeof name !== "string") return "other";
  if (BUILTIN_TOOLS.includes(name)) return name;
  return name.startsWith("mcp__") ? "mcp" : "other";
}

/**
 * A model label safe to report: the Anthropic model id (`claude-…`) only. Provider-specific
 * forms (a region prefix, a deployment ARN, an inference-profile id — which can carry an
 * account id or a customer's name) are reduced to the `claude-…` id they contain, or
 * `other-model` when there is none.
 */
const MODEL_FAMILIES = ["opus", "sonnet", "haiku", "fable", "instant"];
export function modelLabel(model: unknown): string {
  if (typeof model !== "string") return "other-model";
  // claude-<tokens>: every token is a family name, a number/date, `latest` or `v<n>` — so a
  // custom name such as `claude-acmebank-prod` can never pass through.
  const m = /(?:^|[/:.])(claude(?:-(?:\d+|[a-z]+|v\d+))+)(?=$|[@:/])/.exec(model.toLowerCase());
  if (!m) return "other-model";
  const tokens = m[1].split("-").slice(1);
  const ok = tokens.every((x) => /^\d+$/.test(x) || /^v\d+$/.test(x) || x === "latest" || MODEL_FAMILIES.includes(x)) && tokens.some((x) => MODEL_FAMILIES.includes(x));
  return ok ? m[1] : "other-model";
}

const STATE_COMMANDS = ["detect", "freshness", "init", "sync", "set-stage", "record-knowledge", "migrate", "stamp-docs", "record-approval", "record-recheck"];

export interface Report {
  report: "ono-project-inspector session-cost";
  reportVersion: 1;
  operation: { value: "refresh-project-knowledge" | "initial-inspection" | "audit-recheck" | "unknown"; label: Label; basis: string };
  transcripts: { main: number; subagents: number; recordsRead: number; recordsSkipped: number };
  tokens: {
    label: Label;
    note: string;
    byModel: Record<string, Tokens>;
    bySource: { main: Tokens; subagents: Tokens };
    total: Tokens;
  };
  time: {
    wallClockSeconds: { value: number | null; label: Label };
    reportedDurationSeconds: { value: number | null; label: Label };
    reportedApiSeconds: { value: number | null; label: Label };
  };
  reportedCost: { value: number | null; byModel: Record<string, number>; label: Label; note: string };
  estimatedCost: { value: number | null; byModel: Record<string, number>; label: Label; note: string };
  activity: {
    toolCalls: Record<string, number>;
    inspectorHelperCalls: Record<string, number>;
    inspectionStateCommands: Record<string, number>;
    documentsWritten: { claudeMd: number; auditMd: number; docsProject: number; audits: number; label: Label };
    changedSourceCount: { atStart: number | null; atEnd: number | null; label: Label };
  };
  repository: { trackedFiles: number | null; trackedBytes: number | null; label: Label };
}

function readJsonl(path: string): { records: any[]; skipped: number } {
  const records: any[] = [];
  let skipped = 0;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { skipped++; }
  }
  return { records, skipped };
}

function subagentFiles(mainPath: string): string[] {
  const dir = join(dirname(mainPath), basename(mainPath).replace(/\.jsonl$/, ""), "subagents");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().map((f) => join(dir, f));
}

function tokensOf(usage: any): Tokens {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const cc = usage?.cache_creation ?? {};
  const w5 = n(cc.ephemeral_5m_input_tokens), w1 = n(cc.ephemeral_1h_input_tokens);
  const write = n(usage?.cache_creation_input_tokens);
  return {
    input: n(usage?.input_tokens), output: n(usage?.output_tokens), cacheRead: n(usage?.cache_read_input_tokens),
    cacheWrite: write, cacheWrite5m: w5, cacheWrite1h: w1, messages: 1,
  };
}

function docKind(path: string): keyof Report["activity"]["documentsWritten"] | null {
  const p = path.replace(/\\/g, "/");
  if (/(^|\/)CLAUDE\.md$/.test(p)) return "claudeMd";
  if (/(^|\/)AUDIT\.md$/.test(p)) return "auditMd";
  if (/(^|\/)docs\/project\/[^/]+\.md$/.test(p)) return "docsProject";
  if (/(^|\/)audits\/[^/]+\/[^/]+\.md$/.test(p)) return "audits";
  return null;
}

export function analyze(mainPath: string, opts: { repo?: string; prices?: Record<string, Record<string, number>> } = {}): Report {
  const files = [{ path: mainPath, source: "main" as const }, ...subagentFiles(mainPath).map((p) => ({ path: p, source: "subagents" as const }))];
  const byModel: Record<string, Tokens> = {};
  const bySource = { main: zero(), subagents: zero() };
  const total = zero();
  const seenMessages = new Set<string>();
  const seenTools = new Set<string>();
  const toolCalls: Record<string, number> = {};
  const helperCalls: Record<string, number> = {};
  const stateCommands: Record<string, number> = {};
  const docs = { claudeMd: new Set<string>(), auditMd: new Set<string>(), docsProject: new Set<string>(), audits: new Set<string>() };
  const changedCounts: number[] = [];
  let first: number | null = null, last: number | null = null, recordsRead = 0, skipped = 0;
  let costState: any = null;

  for (const { path, source } of files) {
    const { records, skipped: s } = readJsonl(path);
    skipped += s;
    recordsRead += records.length;
    for (const r of records) {
      const t = typeof r?.timestamp === "string" ? Date.parse(r.timestamp) : NaN;
      if (Number.isFinite(t)) { first = first === null ? t : Math.min(first, t); last = last === null ? t : Math.max(last, t); }
      if (r?.type === "cost-state" && source === "main" && typeof r.totalCostUSD === "number") {
        if (!costState || r.totalCostUSD >= costState.totalCostUSD) costState = r;
      }
      const m = r?.message;
      if (r?.type === "assistant" && m) {
        const key = m.id ? `msg:${m.id}` : r.requestId ? `req:${r.requestId}` : r.uuid ? `uuid:${r.uuid}` : null;
        if (key && !seenMessages.has(key) && m.usage) {
          seenMessages.add(key);
          const tk = tokensOf(m.usage);
          const model = modelLabel(m.model);
          add((byModel[model] ??= zero()), tk);
          add(bySource[source === "main" && r.isSidechain ? "subagents" : source], tk);
          add(total, tk);
        }
        for (const c of Array.isArray(m.content) ? m.content : []) {
          if (c?.type !== "tool_use" || !c.id || seenTools.has(c.id)) continue;
          seenTools.add(c.id);
          const name = toolLabel(c.name);
          toolCalls[name] = (toolCalls[name] ?? 0) + 1;
          if (name === "Bash" && typeof c.input?.command === "string") {
            for (const x of c.input.command.matchAll(/scripts\/([A-Za-z0-9.-]+\.(?:ts|mjs|sh))["'\s]*(\S*)/g)) {
              if (!INSPECTOR_SCRIPTS.includes(x[1])) continue;
              helperCalls[x[1]] = (helperCalls[x[1]] ?? 0) + 1;
              if (x[1] === "inspection-state.ts") {
                const sub = c.input.command.slice(x.index! + x[0].length - x[2].length).trim().split(/\s+/)[0];
                const cmd = STATE_COMMANDS.includes(x[2]) ? x[2] : STATE_COMMANDS.includes(sub) ? sub : null;
                if (cmd) stateCommands[cmd] = (stateCommands[cmd] ?? 0) + 1;
              }
              if (x[1] === "knowledge-refresh-guard.ts" && /knowledge-refresh-guard\.ts["']?\s+snapshot\b/.test(c.input.command)) stateCommands["refresh-guard snapshot"] = (stateCommands["refresh-guard snapshot"] ?? 0) + 1;
            }
          }
          if (["Write", "Edit", "MultiEdit"].includes(name) && typeof c.input?.file_path === "string") {
            const kind = docKind(c.input.file_path);
            if (kind) docs[kind].add(c.input.file_path);
          }
        }
      }
      if (r?.type === "user" && Array.isArray(m?.content)) {
        for (const c of m.content) {
          if (c?.type !== "tool_result") continue;
          const text = typeof c.content === "string" ? c.content : Array.isArray(c.content) ? c.content.map((x: any) => (typeof x?.text === "string" ? x.text : "")).join("\n") : "";
          for (const x of text.matchAll(/"changedSourceCount":\s*(\d+)/g)) changedCounts.push(Number(x[1]));
        }
      }
    }
  }

  const refresh = (stateCommands["refresh-guard snapshot"] ?? 0) > 0;
  const recheck = (helperCalls["audit-recheck.ts"] ?? 0) > 0;
  const recordKnowledge = (stateCommands["record-knowledge"] ?? 0) > 0;
  const operation: Report["operation"] = refresh
    ? { value: "refresh-project-knowledge", label: "measured", basis: "the knowledge-refresh-guard snapshot ran (it runs only in Refresh Project Knowledge)" }
    : recordKnowledge
    ? { value: "initial-inspection", label: "measured", basis: "knowledge was recorded without a refresh-guard snapshot" }
    : recheck
    ? { value: "audit-recheck", label: "measured", basis: "audit-recheck.ts ran" }
    : { value: "unknown", label: "unavailable", basis: "no Inspector stage marker found in the transcript" };

  // Estimated cost from the caller's rates only.
  const est: Record<string, number> = {};
  let estTotal: number | null = null;
  let estNote = "No --prices file given; no cost is estimated.";
  if (opts.prices) {
    let complete = true;
    estTotal = 0;
    for (const [model, t] of Object.entries(byModel)) {
      const p = opts.prices[model];
      const rate = (k: string) => (typeof p?.[k] === "number" ? p[k] : NaN);
      // A 5m/1h split, when recorded, is priced per tier; otherwise all cache writes at the 5m rate.
      const split = t.cacheWrite5m + t.cacheWrite1h;
      const w5 = split > 0 ? t.cacheWrite5m : t.cacheWrite, w1 = split > 0 ? t.cacheWrite1h : 0;
      const cost = (t.input * rate("input") + t.output * rate("output") + t.cacheRead * rate("cacheRead") + w5 * rate("cacheWrite5m") + w1 * (w1 > 0 ? rate("cacheWrite1h") : 0)) / 1e6;
      if (!Number.isFinite(cost)) { complete = false; continue; }
      est[model] = Math.round(cost * 1e6) / 1e6;
      estTotal += cost;
    }
    estTotal = complete ? Math.round(estTotal * 1e6) / 1e6 : null;
    estNote = complete
      ? "Estimated from the --prices rates you supplied (USD per million tokens). Cache reads use their own rate, never the uncached-input rate."
      : "At least one model has no complete rates in --prices; the total is unavailable. Per-model values are given where rates exist.";
  }

  let repo: Report["repository"] = { trackedFiles: null, trackedBytes: null, label: "unavailable" };
  if (opts.repo) {
    try {
      const names = execFileSync("git", ["-c", "core.quotePath=false", "ls-files", "-z"], { cwd: opts.repo, encoding: "utf-8", maxBuffer: 512 * 1024 * 1024 }).split("\0").filter(Boolean);
      let bytes = 0;
      for (const n of names) { try { bytes += statSync(join(opts.repo, n)).size; } catch { /* deleted in the work tree */ } }
      repo = { trackedFiles: names.length, trackedBytes: bytes, label: "measured" };
    } catch { /* not a repository */ }
  }

  const secs = (ms: unknown) => (typeof ms === "number" && Number.isFinite(ms) ? Math.round(ms / 100) / 10 : null);
  const reportedByModel: Record<string, number> = {};
  for (const [model, u] of Object.entries(costState?.modelUsage ?? {})) {
    if (typeof (u as any)?.costUSD !== "number") continue;
    const label = modelLabel(model);
    reportedByModel[label] = (reportedByModel[label] ?? 0) + (u as any).costUSD;
  }
  return {
    report: "ono-project-inspector session-cost",
    reportVersion: 1,
    operation,
    transcripts: { main: 1, subagents: files.length - 1, recordsRead, recordsSkipped: skipped },
    tokens: {
      label: total.messages > 0 ? "measured" : "unavailable",
      note: "Each API message counted once (deduplicated by message id across the main and subagent transcripts). `input` is uncached input only; cache reads and writes are separate.",
      byModel, bySource, total,
    },
    time: {
      wallClockSeconds: { value: first !== null && last !== null ? Math.round((last - first) / 100) / 10 : null, label: first !== null ? "measured" : "unavailable" },
      reportedDurationSeconds: { value: secs(costState?.totalDuration), label: costState ? "reported" : "unavailable" },
      reportedApiSeconds: { value: secs(costState?.totalAPIDuration), label: costState ? "reported" : "unavailable" },
    },
    reportedCost: {
      value: typeof costState?.totalCostUSD === "number" ? costState.totalCostUSD : null,
      byModel: reportedByModel,
      label: costState ? "reported" : "unavailable",
      note: costState ? "Claude Code's own session cost record (cost-state); its pricing, not recomputed here." : "The transcript has no cost-state record.",
    },
    estimatedCost: { value: estTotal, byModel: est, label: opts.prices ? (estTotal === null ? "unavailable" : "estimated") : "unavailable", note: estNote },
    activity: {
      toolCalls, inspectorHelperCalls: helperCalls, inspectionStateCommands: stateCommands,
      documentsWritten: { claudeMd: docs.claudeMd.size, auditMd: docs.auditMd.size, docsProject: docs.docsProject.size, audits: docs.audits.size, label: "measured" },
      changedSourceCount: {
        atStart: changedCounts.length ? changedCounts[0] : null,
        atEnd: changedCounts.length ? changedCounts[changedCounts.length - 1] : null,
        label: changedCounts.length ? "measured" : "unavailable",
      },
    },
    repository: repo,
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const file = args.find((a, i) => !a.startsWith("--") && !["--repo", "--prices"].includes(args[i - 1]));
  const opt = (name: string) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
  if (!file || !existsSync(file)) {
    console.error('Usage: session-cost.ts "<session>.jsonl" [--repo "<project root>"] [--prices "<prices.json>"]');
    process.exit(1);
  }
  let prices: Record<string, Record<string, number>> | undefined;
  const pricesPath = opt("--prices");
  if (pricesPath) {
    try { prices = JSON.parse(readFileSync(pricesPath, "utf-8")); } catch { console.error("--prices is not readable JSON"); process.exit(1); }
  }
  console.log(JSON.stringify(analyze(file, { repo: opt("--repo"), prices }), null, 2));
  process.exit(0);
}

if (isEntryPoint(import.meta.url)) {
  useBlockingOutput();
  main();
}
