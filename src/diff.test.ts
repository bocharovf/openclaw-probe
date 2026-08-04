import { describe, expect, it } from "vitest";
import { buildDiff } from "./diff.js";
import type { ProbeReport } from "./types.js";

function baseReport(overrides: Partial<ProbeReport> = {}): ProbeReport {
  return {
    probe: { name: "r1", mode: "start-stop", generated_at: "2026-08-01T00:00:00.000Z" },
    window: { ts_start: "2026-08-01T00:00:00.000Z", ts_end: "2026-08-01T00:01:00.000Z", wall_clock_sec: 60 },
    sessions: { session_ids: ["agent:main:main"], agents_used: { main: 1 } },
    time: { agent_active_sec: 10, llm_latency_sec: 8, tool_exec_sec: 2 },
    iterations: { agent_runs: 1, llm_calls: 2, tool_calling_rounds: 1, tool_calls_total: 1 },
    models_used: { "anthropic/claude-x": 2 },
    tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0, total: 150 },
    context: { system_prompt_chars_samples: [1000], system_prompt_chars_avg: 1000 },
    tools_used: { read: 1 },
    plugins_used: ["core"],
    skills_used: { skillA: { name: "skillA", uses: 1 } },
    errors: {
      tool_call_errors: { count: 0, by_tool: {}, by_status: {}, by_code: {} },
      agent_run_errors: { count: 0, by_status: {}, by_code: {} },
    },
    llm_api_log: { entries_captured: 1, file: "/x/r1.rawrequests.jsonl" },
    events: [{ date: "2026-08-01T00:00:05.000Z", event: "tool call: read (0.1s)" }],
    warnings: [],
    ...overrides,
  };
}

describe("buildDiff", () => {
  it("header/compared block carries identifying info without diffing it", () => {
    const r1 = baseReport({ probe: { name: "baseline", mode: "start-stop", generated_at: "g1" } });
    const r2 = baseReport({ probe: { name: "after", mode: "range", generated_at: "g2" } });
    const d = buildDiff("baseline", "baseline", r1, "after", "after", r2, "/results/baseline.after.diff.json");

    expect(d.diff.result_file).toBe("/results/baseline.after.diff.json");
    expect(d.diff.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(d.compared.name1).toEqual({
      name: "baseline",
      slug: "baseline",
      mode: "start-stop",
      generated_at: "g1",
      ts_start: r1.window.ts_start,
      ts_end: r1.window.ts_end,
    });
    expect(d.compared.name2).toMatchObject({ name: "after", slug: "after", mode: "range", generated_at: "g2" });
  });

  it("numeric fields diff as name2 - name1", () => {
    const r1 = baseReport({ window: { ts_start: "a", ts_end: "b", wall_clock_sec: 60 } });
    const r2 = baseReport({ window: { ts_start: "a", ts_end: "b", wall_clock_sec: 90 } });
    const d = buildDiff("r1", "r1", r1, "r2", "r2", r2, "/x");
    expect(d.window.wall_clock_sec).toEqual({ name1: 60, name2: 90, diff: 30 });
  });

  it("numeric diff can be negative", () => {
    const r1 = baseReport({ iterations: { agent_runs: 5, llm_calls: 5, tool_calling_rounds: 5, tool_calls_total: 5 } });
    const r2 = baseReport({ iterations: { agent_runs: 2, llm_calls: 2, tool_calling_rounds: 2, tool_calls_total: 2 } });
    const d = buildDiff("r1", "r1", r1, "r2", "r2", r2, "/x");
    expect(d.iterations.agent_runs).toEqual({ name1: 5, name2: 2, diff: -3 });
  });

  it("nullable numeric field: null on either side yields a null diff", () => {
    const r1 = baseReport({ context: { system_prompt_chars_samples: [], system_prompt_chars_avg: null } });
    const r2 = baseReport({ context: { system_prompt_chars_samples: [500], system_prompt_chars_avg: 500 } });
    const d = buildDiff("r1", "r1", r1, "r2", "r2", r2, "/x");
    expect(d.context.system_prompt_chars_avg).toEqual({ name1: null, name2: 500, diff: null });
  });

  it("tools_used is a set diff of keys, not a numeric diff of counts", () => {
    const r1 = baseReport({ tools_used: { read: 5, write: 1 } });
    const r2 = baseReport({ tools_used: { read: 1, k8s_get_pods: 3 } });
    const d = buildDiff("r1", "r1", r1, "r2", "r2", r2, "/x");
    expect(d.tools_used).toEqual({ added: ["k8s_get_pods"], removed: ["write"] });
  });

  it("plugins_used is a set diff of array values", () => {
    const r1 = baseReport({ plugins_used: ["core", "k8s-ops"] });
    const r2 = baseReport({ plugins_used: ["core", "postgres-ops"] });
    const d = buildDiff("r1", "r1", r1, "r2", "r2", r2, "/x");
    expect(d.plugins_used).toEqual({ added: ["postgres-ops"], removed: ["k8s-ops"] });
  });

  it("skills_used is a set diff of keys", () => {
    const r1 = baseReport({ skills_used: { skillA: { name: "skillA", uses: 3 } } });
    const r2 = baseReport({
      skills_used: { skillA: { name: "skillA", uses: 1 }, skillB: { name: "skillB", uses: 1 } },
    });
    const d = buildDiff("r1", "r1", r1, "r2", "r2", r2, "/x");
    expect(d.skills_used).toEqual({ added: ["skillB"], removed: [] });
  });

  it("models_used and sessions.agents_used are set diffs of keys", () => {
    const r1 = baseReport({ models_used: { "a/x": 5 }, sessions: { session_ids: [], agents_used: { main: 2 } } });
    const r2 = baseReport({
      models_used: { "a/y": 5 },
      sessions: { session_ids: [], agents_used: { main: 2, "diag-logs": 1 } },
    });
    const d = buildDiff("r1", "r1", r1, "r2", "r2", r2, "/x");
    expect(d.models_used).toEqual({ added: ["a/y"], removed: ["a/x"] });
    expect(d.sessions.agents_used).toEqual({ added: ["diag-logs"], removed: [] });
  });

  it("session_ids is a set diff", () => {
    const r1 = baseReport({ sessions: { session_ids: ["s1", "s2"], agents_used: {} } });
    const r2 = baseReport({ sessions: { session_ids: ["s2", "s3"], agents_used: {} } });
    const d = buildDiff("r1", "r1", r1, "r2", "r2", r2, "/x");
    expect(d.sessions.session_ids).toEqual({ added: ["s3"], removed: ["s1"] });
  });

  it("error breakdown maps are set diffs of keys", () => {
    const r1 = baseReport({
      errors: {
        tool_call_errors: { count: 1, by_tool: { postgres_query: 1 }, by_status: { failed: 1 }, by_code: { connection_refused: 1 } },
        agent_run_errors: { count: 0, by_status: {}, by_code: {} },
      },
    });
    const r2 = baseReport({
      errors: {
        tool_call_errors: { count: 0, by_tool: {}, by_status: {}, by_code: {} },
        agent_run_errors: { count: 1, by_status: { timed_out: 1 }, by_code: { deadline_exceeded: 1 } },
      },
    });
    const d = buildDiff("r1", "r1", r1, "r2", "r2", r2, "/x");
    expect(d.errors.tool_call_errors.count).toEqual({ name1: 1, name2: 0, diff: -1 });
    expect(d.errors.tool_call_errors.by_tool).toEqual({ added: [], removed: ["postgres_query"] });
    expect(d.errors.tool_call_errors.by_status).toEqual({ added: [], removed: ["failed"] });
    expect(d.errors.tool_call_errors.by_code).toEqual({ added: [], removed: ["connection_refused"] });
    expect(d.errors.agent_run_errors.count).toEqual({ name1: 0, name2: 1, diff: 1 });
    expect(d.errors.agent_run_errors.by_status).toEqual({ added: ["timed_out"], removed: [] });
    expect(d.errors.agent_run_errors.by_code).toEqual({ added: ["deadline_exceeded"], removed: [] });
  });

  it("events is a set diff of event text, ignoring timestamps", () => {
    const r1 = baseReport({
      events: [
        { date: "2026-08-01T00:00:01.000Z", event: "skill used: aiops-incident" },
        { date: "2026-08-01T00:00:02.000Z", event: "tool call: postgres_query (failed: connection_refused, 0.3s)" },
      ],
    });
    const r2 = baseReport({
      events: [
        { date: "2026-08-02T00:00:01.000Z", event: "skill used: aiops-incident" },
        { date: "2026-08-02T00:00:02.000Z", event: "tool call: read (0.2s)" },
      ],
    });
    const d = buildDiff("r1", "r1", r1, "r2", "r2", r2, "/x");
    expect(d.events).toEqual({
      added: ["tool call: read"],
      removed: ["tool call: postgres_query"],
    });
  });

  it("duplicate identical event text in one report collapses to a single set entry", () => {
    const r1 = baseReport({ events: [] });
    const r2 = baseReport({
      events: [
        { date: "2026-08-01T00:00:01.000Z", event: "tool call: read (0.1s)" },
        { date: "2026-08-01T00:00:02.000Z", event: "tool call: read (0.1s)" },
      ],
    });
    const d = buildDiff("r1", "r1", r1, "r2", "r2", r2, "/x");
    expect(d.events).toEqual({ added: ["tool call: read"], removed: [] });
  });

  it("events are grouped by <type>: <name>, ignoring duration/status/still-running detail", () => {
    // Same tool ("exec") called multiple times with different durations in each report should
    // not show up as a change at all - only whether a tool/model/skill started or stopped
    // being used matters, not each individual call's timing.
    const r1 = baseReport({
      events: [
        { date: "2026-08-01T00:00:01.000Z", event: "tool call: exec (0.16s)" },
        { date: "2026-08-01T00:00:02.000Z", event: "tool call: exec (0.41s)" },
      ],
    });
    const r2 = baseReport({
      events: [
        { date: "2026-08-02T00:00:01.000Z", event: "tool call: exec (2.76s)" },
        { date: "2026-08-02T00:00:02.000Z", event: "tool call: exec (failed: tool_failed, 0.05s)" },
      ],
    });
    const d = buildDiff("r1", "r1", r1, "r2", "r2", r2, "/x");
    expect(d.events).toEqual({ added: [], removed: [] });
  });

  it("a genuinely new tool call still shows up after normalization", () => {
    const r1 = baseReport({
      events: [{ date: "2026-08-01T00:00:01.000Z", event: "tool call: exec (0.16s)" }],
    });
    const r2 = baseReport({
      events: [
        { date: "2026-08-02T00:00:01.000Z", event: "tool call: exec (0.20s)" },
        { date: "2026-08-02T00:00:02.000Z", event: "tool call: k8s_get_pods (1.5s)" },
      ],
    });
    const d = buildDiff("r1", "r1", r1, "r2", "r2", r2, "/x");
    expect(d.events).toEqual({ added: ["tool call: k8s_get_pods"], removed: [] });
  });

  it("normalizes agent-run/LLM-call/still-running event kinds the same way", () => {
    const r1 = baseReport({
      events: [
        { date: "t1", event: "agent run: main (212.29s)" },
        { date: "t2", event: "LLM call: deepseek/deepseek-v4-pro (with tool call)" },
      ],
    });
    const r2 = baseReport({
      events: [
        { date: "t3", event: "agent run: main (started, still running at window end)" },
        { date: "t4", event: "LLM call: deepseek/deepseek-v4-pro" },
        { date: "t5", event: "agent run: diag-state (57.47s)" },
      ],
    });
    const d = buildDiff("r1", "r1", r1, "r2", "r2", r2, "/x");
    // "agent run: main" and "LLM call: deepseek/deepseek-v4-pro" are unchanged despite the
    // different suffixes; only the genuinely new agent shows up.
    expect(d.events).toEqual({ added: ["agent run: diag-state"], removed: [] });
  });

  it("warnings is a set diff", () => {
    const r1 = baseReport({ warnings: ["missing trajectory for run xyz"] });
    const r2 = baseReport({ warnings: [] });
    const d = buildDiff("r1", "r1", r1, "r2", "r2", r2, "/x");
    expect(d.warnings).toEqual({ added: [], removed: ["missing trajectory for run xyz"] });
  });

  it("identical reports produce empty sets and zero numeric diffs", () => {
    const r1 = baseReport();
    const r2 = baseReport();
    const d = buildDiff("r1", "r1", r1, "r2", "r2", r2, "/x");
    expect(d.tools_used).toEqual({ added: [], removed: [] });
    expect(d.events).toEqual({ added: [], removed: [] });
    expect(d.time.agent_active_sec.diff).toBe(0);
    expect(d.tokens.total.diff).toBe(0);
  });
});
