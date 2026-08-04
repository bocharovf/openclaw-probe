import type { DiffNumeric, DiffSet, ProbeDiffReport, ProbeReport } from "./types.js";

function numDiff(a: number | null | undefined, b: number | null | undefined): DiffNumeric {
  const n1 = a ?? null;
  const n2 = b ?? null;
  return { name1: n1, name2: n2, diff: n1 === null || n2 === null ? null : n2 - n1 };
}

/** Set difference name2 - name1 over de-duplicated string values, sorted for determinism.
 * Counts (how many times a value occurred) are intentionally discarded - only presence is
 * compared, per the plugin's `diff` command contract. */
function setDiff(a: string[], b: string[]): DiffSet {
  const setA = new Set(a);
  const setB = new Set(b);
  const added = [...setB].filter((v) => !setA.has(v)).sort();
  const removed = [...setA].filter((v) => !setB.has(v)).sort();
  return { added, removed };
}

/** Reduces one timeline entry's `event` text to its "<type>: <name>" grouping key - e.g.
 * `"tool call: exec (0.16s)"` and `"tool call: exec (failed: tool_failed, 0.41s)"` both become
 * `"tool call: exec"`. Every event string built in `report.ts` puts its optional
 * duration/status/still-running detail in a trailing `" (...)"` block, so cutting at the first
 * `" ("` reliably strips it (event kinds with no such block, like `"skill used: x"`, are
 * returned unchanged). This is what makes the diff answer "did a new tool/model/skill start or
 * stop being used" instead of flagging every call as a change just because its duration
 * differs from the last time - which it almost always will. */
function normalizeEventKey(event: string): string {
  const parenIdx = event.indexOf(" (");
  return parenIdx === -1 ? event : event.slice(0, parenIdx);
}

/** Diffs each timeline entry's normalized "<type>: <name>" key (see `normalizeEventKey`),
 * ignoring `date` (always different between two separate measurement windows, which would
 * otherwise make every event look "new") and duration/status/still-running detail (which
 * would otherwise make even a repeat call to the same tool look like a change). Two calls to
 * the same tool/skill/model within one report collapse to a single set entry either way. */
function eventTexts(events: ProbeReport["events"]): string[] {
  return events.map((e) => normalizeEventKey(e.event));
}

/** Builds a `ProbeDiffReport` comparing `report1` (baseline, "name1") against `report2`
 * ("name2"). Every numeric field's `diff` is `name2 - name1`; every list/usage field ("what
 * was used or happened") is a set difference name2-name1 with counts discarded - see
 * `DiffNumeric`/`DiffSet` doc comments in types.ts. Identifying fields (probe name, mode,
 * generated_at, window start/end) are never diffed - they're informational only, under
 * `compared`. */
export function buildDiff(
  name1: string,
  slug1: string,
  report1: ProbeReport,
  name2: string,
  slug2: string,
  report2: ProbeReport,
  resultFile: string,
): ProbeDiffReport {
  return {
    diff: {
      generated_at: new Date().toISOString(),
      result_file: resultFile,
    },
    compared: {
      name1: {
        name: report1.probe.name,
        slug: slug1,
        mode: report1.probe.mode,
        generated_at: report1.probe.generated_at,
        ts_start: report1.window.ts_start,
        ts_end: report1.window.ts_end,
      },
      name2: {
        name: report2.probe.name,
        slug: slug2,
        mode: report2.probe.mode,
        generated_at: report2.probe.generated_at,
        ts_start: report2.window.ts_start,
        ts_end: report2.window.ts_end,
      },
    },
    window: {
      wall_clock_sec: numDiff(report1.window.wall_clock_sec, report2.window.wall_clock_sec),
    },
    sessions: {
      session_ids: setDiff(report1.sessions.session_ids, report2.sessions.session_ids),
      agents_used: setDiff(Object.keys(report1.sessions.agents_used), Object.keys(report2.sessions.agents_used)),
    },
    time: {
      agent_active_sec: numDiff(report1.time.agent_active_sec, report2.time.agent_active_sec),
      llm_latency_sec: numDiff(report1.time.llm_latency_sec, report2.time.llm_latency_sec),
      tool_exec_sec: numDiff(report1.time.tool_exec_sec, report2.time.tool_exec_sec),
    },
    iterations: {
      agent_runs: numDiff(report1.iterations.agent_runs, report2.iterations.agent_runs),
      llm_calls: numDiff(report1.iterations.llm_calls, report2.iterations.llm_calls),
      tool_calling_rounds: numDiff(report1.iterations.tool_calling_rounds, report2.iterations.tool_calling_rounds),
      tool_calls_total: numDiff(report1.iterations.tool_calls_total, report2.iterations.tool_calls_total),
    },
    models_used: setDiff(Object.keys(report1.models_used), Object.keys(report2.models_used)),
    tokens: {
      input: numDiff(report1.tokens.input, report2.tokens.input),
      output: numDiff(report1.tokens.output, report2.tokens.output),
      cacheRead: numDiff(report1.tokens.cacheRead, report2.tokens.cacheRead),
      cacheWrite: numDiff(report1.tokens.cacheWrite, report2.tokens.cacheWrite),
      reasoningTokens: numDiff(report1.tokens.reasoningTokens, report2.tokens.reasoningTokens),
      total: numDiff(report1.tokens.total, report2.tokens.total),
    },
    context: {
      system_prompt_chars_avg: numDiff(report1.context.system_prompt_chars_avg, report2.context.system_prompt_chars_avg),
    },
    tools_used: setDiff(Object.keys(report1.tools_used), Object.keys(report2.tools_used)),
    plugins_used: setDiff(report1.plugins_used, report2.plugins_used),
    skills_used: setDiff(Object.keys(report1.skills_used), Object.keys(report2.skills_used)),
    errors: {
      tool_call_errors: {
        count: numDiff(report1.errors.tool_call_errors.count, report2.errors.tool_call_errors.count),
        by_tool: setDiff(Object.keys(report1.errors.tool_call_errors.by_tool), Object.keys(report2.errors.tool_call_errors.by_tool)),
        by_status: setDiff(Object.keys(report1.errors.tool_call_errors.by_status), Object.keys(report2.errors.tool_call_errors.by_status)),
        by_code: setDiff(Object.keys(report1.errors.tool_call_errors.by_code), Object.keys(report2.errors.tool_call_errors.by_code)),
      },
      agent_run_errors: {
        count: numDiff(report1.errors.agent_run_errors.count, report2.errors.agent_run_errors.count),
        by_status: setDiff(Object.keys(report1.errors.agent_run_errors.by_status), Object.keys(report2.errors.agent_run_errors.by_status)),
        by_code: setDiff(Object.keys(report1.errors.agent_run_errors.by_code), Object.keys(report2.errors.agent_run_errors.by_code)),
      },
    },
    llm_api_log: {
      entries_captured: numDiff(report1.llm_api_log.entries_captured, report2.llm_api_log.entries_captured),
    },
    events: setDiff(eventTexts(report1.events), eventTexts(report2.events)),
    warnings: setDiff(report1.warnings, report2.warnings),
  };
}
