import type { DiffNumeric, DiffSet, ProbeDiffReport, ProbeReport } from "./types.js";

function fmtRecord(rec: Record<string, number>, emptyText: string): string {
  const entries = Object.entries(rec);
  if (!entries.length) return `  ${emptyText}`;
  return entries.map(([k, v]) => `  ${k}: ${v}`).join("\n");
}

function fmtErrorBlock(block: { count: number; by_status?: Record<string, number>; by_tool?: Record<string, number>; by_code?: Record<string, number> }): string {
  if (block.count === 0) return "  none";
  const lines = [`  count: ${block.count}`];
  if (block.by_tool && Object.keys(block.by_tool).length) lines.push(`  by tool: ${JSON.stringify(block.by_tool)}`);
  if (block.by_status && Object.keys(block.by_status).length) lines.push(`  by status: ${JSON.stringify(block.by_status)}`);
  if (block.by_code && Object.keys(block.by_code).length) lines.push(`  by error code: ${JSON.stringify(block.by_code)}`);
  return lines.join("\n");
}

/** Renders a saved probe report as a human-readable, self-explanatory text report - every
 * section carries a one-line explanation of what the numbers mean and where they came from,
 * so the report is readable without also having the plugin's README open. */
export function formatVerboseReport(r: ProbeReport): string {
  const sections: string[] = [];

  sections.push(
    [
      `PROBE REPORT: "${r.probe.name}"`,
      `mode: ${r.probe.mode} (${r.probe.mode === "start-stop" ? "bounded by /probe start .. /probe stop" : "bounded by an explicit --after/--before range you gave to /probe"})`,
      `generated: ${r.probe.generated_at}`,
    ].join("\n"),
  );

  sections.push(
    [
      "## Window",
      `Measurement covers ${r.window.ts_start} .. ${r.window.ts_end} (${r.window.wall_clock_sec}s of real time).`,
      "Source: the timestamps you gave (start/stop or an explicit range), not derived from any log.",
    ].join("\n"),
  );

  sections.push(
    [
      "## Sessions & agents",
      `session_ids (${r.sessions.session_ids.length}): every OpenClaw session that had at least one audit event in the window - a probe can span more than one session, e.g. a webhook-triggered run.`,
      r.sessions.session_ids.length ? r.sessions.session_ids.map((s) => `  - ${s}`).join("\n") : "  none",
      "agents_used: completed agent runs per agentId - shows whether sub-agents (spawned diagnostics workers, etc) participated, not just the main agent.",
      fmtRecord(r.sessions.agents_used, "none"),
      "Source: `openclaw audit --json` (agent_run events), scoped to [ts_start, ts_end].",
    ].join("\n"),
  );

  sections.push(
    [
      "## Time breakdown",
      `agent_active_sec: ${r.time.agent_active_sec}s - sum of (agent.run.finished - agent.run.started) across every completed run. This is wall-clock time the agent was actually working, not the whole probe window (idle time between runs is excluded).`,
      `tool_exec_sec: ${r.time.tool_exec_sec}s - sum of (tool.action.finished - tool.action.started) across every tool call. Time spent waiting on kubectl/psql/exec/etc, not on the model.`,
      `llm_latency_sec: ${r.time.llm_latency_sec}s - agent_active_sec minus tool_exec_sec (floored at 0). An approximation of time spent waiting on the model API, since the audit ledger does not record LLM call boundaries directly.`,
      "Source: `openclaw audit --json` (agent_run + tool_action started/finished pairs).",
    ].join("\n"),
  );

  sections.push(
    [
      "## Iterations",
      `agent_runs: ${r.iterations.agent_runs} - completed top-level agent turns (one per user message or triggered run, plus one per sub-agent run).`,
      `llm_calls: ${r.iterations.llm_calls} - individual model completions across all runs, including intermediate tool-calling steps within one agent turn.`,
      `tool_calling_rounds: ${r.iterations.tool_calling_rounds} - of those LLM calls, how many produced at least one tool call (vs a final text-only answer).`,
      `tool_calls_total: ${r.iterations.tool_calls_total} - individual tool invocations (one row per tool_action pair in the audit ledger; a "round" can contain several tool calls in parallel).`,
      "Source: agent_runs/tool_calls_total from the audit ledger; llm_calls/tool_calling_rounds from each run's trajectory file (`model.completed` events' message snapshot).",
    ].join("\n"),
  );

  sections.push(
    [
      "## Models used",
      "Count of LLM calls per \"provider/model\" - useful for spotting mid-run fallback to a different model.",
      fmtRecord(r.models_used, "none (no completed run had a trajectory file, or the window had no LLM calls)"),
      "Source: trajectory `model.completed` events, per assistant message (not the run-level default, so a fallback mid-run is captured).",
    ].join("\n"),
  );

  sections.push(
    [
      "## Tokens",
      "Summed usage across every LLM call in the window:",
      `  input: ${r.tokens.input ?? 0}`,
      `  output: ${r.tokens.output ?? 0}`,
      `  cacheRead: ${r.tokens.cacheRead ?? 0} (served from prompt cache - cheap/fast)`,
      `  cacheWrite: ${r.tokens.cacheWrite ?? 0} (written to prompt cache this call - one-time cost)`,
      `  reasoningTokens: ${r.tokens.reasoningTokens ?? 0}`,
      `  total: ${r.tokens.total ?? 0}`,
      "This is the primary signal for cost experiments - compare `total`/`input`/`cacheRead` across two probes to see whether a change increased spend.",
      "Source: trajectory `model.completed` events' `usage` field, as reported by the provider.",
    ].join("\n"),
  );

  sections.push(
    [
      "## Context size",
      `system_prompt_chars_avg: ${r.context.system_prompt_chars_avg ?? "n/a"} - average compiled system prompt size (characters) across sampled runs. A proxy for context bloat; larger prompts cost more per call and can degrade quality.`,
      `samples (${r.context.system_prompt_chars_samples.length}): ${JSON.stringify(r.context.system_prompt_chars_samples)}`,
      "Source: trajectory `context.compiled` events, one sample per completed run that has one.",
    ].join("\n"),
  );

  sections.push(
    [
      "## Tools used",
      "Count of completed tool calls per tool name (includes both started+finished and started-only calls still in flight at window close).",
      fmtRecord(r.tools_used, "none"),
      "Source: `openclaw audit --json` tool_action events.",
    ].join("\n"),
  );

  sections.push(
    [
      "## Plugins used",
      `Owning plugin ids for every tool in \"Tools used\" above (\"core\" = a built-in tool, not from an installed plugin): ${r.plugins_used.length ? r.plugins_used.join(", ") : "none"}`,
      "Source: `openclaw plugins list --json`, `contracts.tools` (manifest-declared tool ownership) inverted into a tool -> plugin map.",
    ].join("\n"),
  );

  sections.push(
    [
      "## Skills used",
      Object.keys(r.skills_used).length === 0
        ? "none invoked in this window."
        : Object.entries(r.skills_used)
            .map(([k, v]) => `  ${k}: ${v.uses} use(s)`)
            .join("\n"),
      "Source: probe's own detection - watches after_tool_call for a read of a SKILL.md file and recovers the skill's declared name from its frontmatter. Windowed by timestamp, not a cumulative counter, so this works for past date ranges too.",
    ].join("\n"),
  );

  sections.push(
    [
      "## Errors",
      "tool_call_errors: tool invocations that did not finish with status \"succeeded\".",
      fmtErrorBlock(r.errors.tool_call_errors),
      "agent_run_errors: agent turns that did not finish with status \"succeeded\" (failed/cancelled/timed_out/blocked).",
      fmtErrorBlock(r.errors.agent_run_errors),
      "Source: `openclaw audit --json`, `status`/`errorCode` on finished events.",
    ].join("\n"),
  );

  sections.push(
    [
      "## Raw LLM request/response log",
      `entries_captured: ${r.llm_api_log.entries_captured}`,
      `file: ${r.llm_api_log.file ?? "none (no entries, or raw capture is disabled/not authorized - see README `hooks.allowConversationAccess`)"}`,
      "Full system prompt/prompt/response text for one representative LLM call per completed agent run in the window, one JSON object per line. Capped at agents_used's run count, not iterations.llm_calls - the underlying llm_input/llm_output hooks fire once per agent run, not once per LLM completion inside a run's tool-calling loop, so a multi-step run's later calls in that loop are not individually archived here. Not needed for any of the numeric metrics above - those come from the audit ledger and trajectory files regardless of whether this capture is enabled.",
      "Source: probe's own llm_input/llm_output hook capture (see README) - not the llm-api-logger plugin.",
    ].join("\n"),
  );

  sections.push(
    [
      "## Events",
      `Chronological log of everything else in this report, one line per agent run / tool call / LLM call / skill use (${r.events.length} entries).`,
      r.events.length ? r.events.map((e) => `  ${e.date}  ${e.event}`).join("\n") : "  none",
      "Source: the same audit-ledger, trajectory, and skill-usage data as the sections above, merged into one timeline and sorted by timestamp.",
    ].join("\n"),
  );

  if (r.warnings.length) {
    sections.push(["## Warnings", ...r.warnings.map((w) => `  - ${w}`)].join("\n"));
  }

  return sections.join("\n\n");
}

function fmtNumericLine(label: string, d: DiffNumeric): string {
  if (d.name1 === null || d.name2 === null) {
    return `  ${label}: n/a (name1=${d.name1 ?? "null"}, name2=${d.name2 ?? "null"})`;
  }
  const sign = d.diff !== null && d.diff > 0 ? "+" : "";
  return `  ${label}: ${d.name1} -> ${d.name2}  (diff: ${sign}${d.diff})`;
}

function fmtSetLines(label: string, s: DiffSet): string {
  if (!s.added.length && !s.removed.length) return `  ${label}: no changes`;
  const lines = [`  ${label}:`];
  for (const v of s.added) lines.push(`    +${v}`);
  for (const v of s.removed) lines.push(`    -${v}`);
  return lines.join("\n");
}

/** Renders a saved `/probe diff` result as a human-readable text report. Mirrors
 * `formatVerboseReport`'s section layout so the two are easy to read side by side. Every
 * numeric line's diff is `name2 - name1`; every list line is a set difference name2-name1
 * with `+`/`-` prefixes (counts discarded) - see `DiffNumeric`/`DiffSet` in types.ts. */
export function formatVerboseDiff(d: ProbeDiffReport): string {
  const sections: string[] = [];

  sections.push(
    [
      `PROBE DIFF: "${d.compared.name1.name}" (name1) -> "${d.compared.name2.name}" (name2)`,
      `generated: ${d.diff.generated_at}`,
      `saved to: ${d.diff.result_file}`,
      "Numeric fields below show name1 -> name2 and diff = name2 - name1. List fields show a set",
      "difference name2-name1: \"+x\" means x is in name2 but not name1, \"-x\" the reverse.",
    ].join("\n"),
  );

  sections.push(
    [
      "## Compared measurements",
      `name1: "${d.compared.name1.name}" (${d.compared.name1.slug}) - mode: ${d.compared.name1.mode}, generated: ${d.compared.name1.generated_at}, window: ${d.compared.name1.ts_start} .. ${d.compared.name1.ts_end}`,
      `name2: "${d.compared.name2.name}" (${d.compared.name2.slug}) - mode: ${d.compared.name2.mode}, generated: ${d.compared.name2.generated_at}, window: ${d.compared.name2.ts_start} .. ${d.compared.name2.ts_end}`,
      "Names, modes, generated-at, and window start/end are informational only and are not diffed.",
    ].join("\n"),
  );

  sections.push(["## Window", fmtNumericLine("wall_clock_sec", d.window.wall_clock_sec)].join("\n"));

  sections.push(
    [
      "## Sessions & agents",
      fmtSetLines("session_ids", d.sessions.session_ids),
      fmtSetLines("agents_used", d.sessions.agents_used),
    ].join("\n"),
  );

  sections.push(
    [
      "## Time breakdown",
      fmtNumericLine("agent_active_sec", d.time.agent_active_sec),
      fmtNumericLine("llm_latency_sec", d.time.llm_latency_sec),
      fmtNumericLine("tool_exec_sec", d.time.tool_exec_sec),
    ].join("\n"),
  );

  sections.push(
    [
      "## Iterations",
      fmtNumericLine("agent_runs", d.iterations.agent_runs),
      fmtNumericLine("llm_calls", d.iterations.llm_calls),
      fmtNumericLine("tool_calling_rounds", d.iterations.tool_calling_rounds),
      fmtNumericLine("tool_calls_total", d.iterations.tool_calls_total),
    ].join("\n"),
  );

  sections.push(["## Models used", fmtSetLines("models_used", d.models_used)].join("\n"));

  sections.push(
    [
      "## Tokens",
      fmtNumericLine("input", d.tokens.input),
      fmtNumericLine("output", d.tokens.output),
      fmtNumericLine("cacheRead", d.tokens.cacheRead),
      fmtNumericLine("cacheWrite", d.tokens.cacheWrite),
      fmtNumericLine("reasoningTokens", d.tokens.reasoningTokens),
      fmtNumericLine("total", d.tokens.total),
    ].join("\n"),
  );

  sections.push(["## Context size", fmtNumericLine("system_prompt_chars_avg", d.context.system_prompt_chars_avg)].join("\n"));

  sections.push(["## Tools used", fmtSetLines("tools_used", d.tools_used)].join("\n"));
  sections.push(["## Plugins used", fmtSetLines("plugins_used", d.plugins_used)].join("\n"));
  sections.push(["## Skills used", fmtSetLines("skills_used", d.skills_used)].join("\n"));

  sections.push(
    [
      "## Errors",
      "tool_call_errors:",
      fmtNumericLine("  count", d.errors.tool_call_errors.count),
      fmtSetLines("  by_tool", d.errors.tool_call_errors.by_tool),
      fmtSetLines("  by_status", d.errors.tool_call_errors.by_status),
      fmtSetLines("  by_code", d.errors.tool_call_errors.by_code),
      "agent_run_errors:",
      fmtNumericLine("  count", d.errors.agent_run_errors.count),
      fmtSetLines("  by_status", d.errors.agent_run_errors.by_status),
      fmtSetLines("  by_code", d.errors.agent_run_errors.by_code),
    ].join("\n"),
  );

  sections.push(["## Raw LLM request/response log", fmtNumericLine("entries_captured", d.llm_api_log.entries_captured)].join("\n"));

  sections.push(
    [
      "## Events",
      "Set difference of each event's <type>: <name> (e.g. \"tool call: exec\", \"skill used:",
      "aiops-incident\") - timestamps and any duration/status/still-running detail are ignored,",
      "so a repeat call to the same tool/model/skill (even with a different duration or outcome)",
      "is not a change. Only whether something started or stopped being used at all shows up here.",
      fmtSetLines("events", d.events),
    ].join("\n"),
  );

  sections.push(["## Warnings", fmtSetLines("warnings", d.warnings)].join("\n"));

  return sections.join("\n\n");
}
