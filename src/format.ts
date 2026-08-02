import type { ProbeReport } from "./types.js";

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
      r.skills_used === null
        ? "unavailable - the skill-usage plugin's event log was not found on this host (plugin not installed/enabled), so skill invocation counts could not be computed for this window."
        : Object.keys(r.skills_used).length === 0
          ? "none invoked in this window."
          : Object.entries(r.skills_used)
              .map(([k, v]) => `  ${k}: ${v.uses} use(s)`)
              .join("\n"),
      "Source: the skill-usage plugin's own append-only event log, filtered to this window by timestamp (not a cumulative counter, so this works for past date ranges too).",
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

  if (r.warnings.length) {
    sections.push(["## Warnings", ...r.warnings.map((w) => `  - ${w}`)].join("\n"));
  }

  return sections.join("\n\n");
}
