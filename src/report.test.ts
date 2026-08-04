import { describe, expect, it, vi } from "vitest";
import { resolvePaths } from "./paths.js";
import { DEFAULT_CONFIG, type AuditEvent, type ProbeEvent } from "./types.js";

vi.mock("./cli.js", () => ({
  fetchAuditEvents: vi.fn(),
  fetchToolToPluginMap: vi.fn(),
}));
vi.mock("./trajectory.js", () => ({
  findModelCompleted: vi.fn().mockResolvedValue(undefined),
  findContextCompiledNear: vi.fn().mockResolvedValue(undefined),
  extractSystemPromptChars: vi.fn().mockReturnValue(undefined),
}));
vi.mock("./skillUsage.js", () => ({
  collectSkillUsageEvents: vi.fn().mockResolvedValue([]),
  registerSkillCapture: vi.fn(),
}));
vi.mock("./llmCapture.js", () => ({
  collectRawLlmEntries: vi.fn().mockResolvedValue([]),
  writeRawLlmEntriesFile: vi.fn().mockResolvedValue(null),
}));

import { fetchAuditEvents, fetchToolToPluginMap } from "./cli.js";
import { buildReport } from "./report.js";
import { findModelCompleted } from "./trajectory.js";
import { collectSkillUsageEvents } from "./skillUsage.js";

const mockedFetchAuditEvents = vi.mocked(fetchAuditEvents);
const mockedFetchToolToPluginMap = vi.mocked(fetchToolToPluginMap);
const mockedFindModelCompleted = vi.mocked(findModelCompleted);
const mockedCollectSkillUsageEvents = vi.mocked(collectSkillUsageEvents);

function ev(partial: Partial<AuditEvent>): AuditEvent {
  return { kind: "agent_run", action: "", status: "succeeded", occurredAt: 0, ...partial } as AuditEvent;
}

describe("buildReport", () => {
  const paths = resolvePaths("/tmp/probe-report-test-base");

  it("reports hasAnyAuditEvents=false for an empty window", async () => {
    mockedFetchAuditEvents.mockResolvedValue([]);
    mockedFetchToolToPluginMap.mockResolvedValue(new Map());

    const { report, hasAnyAuditEvents } = await buildReport({
      config: DEFAULT_CONFIG,
      paths,
      name: "empty",
      slug: "empty",
      mode: "range",
      tsStartMs: 0,
      tsEndMs: 1000,
    });

    expect(hasAnyAuditEvents).toBe(false);
    expect(report.iterations.agent_runs).toBe(0);
    expect(report.sessions.session_ids).toEqual([]);
  });

  it("aggregates time, tool usage, errors, and plugin ownership from paired audit events", async () => {
    mockedFetchAuditEvents.mockResolvedValue([
      ev({ kind: "agent_run", action: "agent.run.started", runId: "run-1", sessionId: "s1", agentId: "main", occurredAt: 1000 }),
      ev({ kind: "agent_run", action: "agent.run.finished", runId: "run-1", sessionId: "s1", agentId: "main", occurredAt: 4000, status: "succeeded" }),
      ev({ kind: "tool_action", action: "tool.action.started", toolCallId: "tc-1", sessionId: "s1", toolName: "k8s_get_pods", occurredAt: 1200 }),
      ev({ kind: "tool_action", action: "tool.action.finished", toolCallId: "tc-1", sessionId: "s1", toolName: "k8s_get_pods", occurredAt: 1700, status: "succeeded" }),
      ev({ kind: "tool_action", action: "tool.action.started", toolCallId: "tc-2", sessionId: "s1", toolName: "read", occurredAt: 2000 }),
      ev({ kind: "tool_action", action: "tool.action.finished", toolCallId: "tc-2", sessionId: "s1", toolName: "read", occurredAt: 2100, status: "failed", errorCode: "not_found" }),
    ]);
    mockedFetchToolToPluginMap.mockResolvedValue(new Map([["k8s_get_pods", "k8s-ops"]]));

    const { report, hasAnyAuditEvents } = await buildReport({
      config: DEFAULT_CONFIG,
      paths,
      name: "run",
      slug: "run",
      mode: "start-stop",
      tsStartMs: 0,
      tsEndMs: 5000,
    });

    expect(hasAnyAuditEvents).toBe(true);
    expect(report.sessions.session_ids).toEqual(["s1"]);
    expect(report.sessions.agents_used).toEqual({ main: 1 });
    expect(report.iterations.agent_runs).toBe(1);
    expect(report.iterations.tool_calls_total).toBe(2);
    expect(report.time.agent_active_sec).toBeCloseTo(3, 5); // 4000-1000ms
    expect(report.time.tool_exec_sec).toBeCloseTo(0.6, 5); // 500ms + 100ms
    expect(report.time.llm_latency_sec).toBeCloseTo(2.4, 5); // 3 - 0.6
    expect(report.tools_used).toEqual({ k8s_get_pods: 1, read: 1 });
    expect(report.plugins_used).toEqual(["core", "k8s-ops"]); // "read" has no owner -> core
    expect(report.errors.tool_call_errors.count).toBe(1);
    expect(report.errors.tool_call_errors.by_tool).toEqual({ read: 1 });
    expect(report.errors.tool_call_errors.by_code).toEqual({ not_found: 1 });
    expect(report.errors.agent_run_errors.count).toBe(0);
    expect(report.skills_used).toEqual({});
  });

  it("excludes runs and tool calls that never finished inside the window", async () => {
    mockedFetchAuditEvents.mockResolvedValue([
      ev({ kind: "agent_run", action: "agent.run.started", runId: "run-unfinished", sessionId: "s1", agentId: "main", occurredAt: 1000 }),
      ev({ kind: "tool_action", action: "tool.action.started", toolCallId: "tc-unfinished", sessionId: "s1", toolName: "exec", occurredAt: 1000 }),
    ]);
    mockedFetchToolToPluginMap.mockResolvedValue(new Map());

    const { report } = await buildReport({
      config: DEFAULT_CONFIG,
      paths,
      name: "partial",
      slug: "partial",
      mode: "start-stop",
      tsStartMs: 0,
      tsEndMs: 5000,
    });

    expect(report.iterations.agent_runs).toBe(0); // unfinished run excluded from run_windows
    expect(report.tools_used).toEqual({ exec: 1 }); // still counted as "used" even if in-flight
    expect(report.time.agent_active_sec).toBe(0);
  });

  it("counts an agent_run failure by status and error code", async () => {
    mockedFetchAuditEvents.mockResolvedValue([
      ev({ kind: "agent_run", action: "agent.run.started", runId: "run-x", sessionId: "s1", agentId: "main", occurredAt: 0 }),
      ev({ kind: "agent_run", action: "agent.run.finished", runId: "run-x", sessionId: "s1", agentId: "main", occurredAt: 100, status: "failed", errorCode: "provider_error" }),
    ]);
    mockedFetchToolToPluginMap.mockResolvedValue(new Map());

    const { report } = await buildReport({
      config: DEFAULT_CONFIG,
      paths,
      name: "fail",
      slug: "fail",
      mode: "start-stop",
      tsStartMs: 0,
      tsEndMs: 1000,
    });

    expect(report.errors.agent_run_errors.count).toBe(1);
    expect(report.errors.agent_run_errors.by_status).toEqual({ failed: 1 });
    expect(report.errors.agent_run_errors.by_code).toEqual({ provider_error: 1 });
  });

  it("falls back to an empty tool->plugin map instead of throwing if the CLI call fails", async () => {
    mockedFetchAuditEvents.mockResolvedValue([
      ev({ kind: "tool_action", action: "tool.action.started", toolCallId: "tc-1", sessionId: "s1", toolName: "read", occurredAt: 0 }),
      ev({ kind: "tool_action", action: "tool.action.finished", toolCallId: "tc-1", sessionId: "s1", toolName: "read", occurredAt: 10, status: "succeeded" }),
    ]);
    mockedFetchToolToPluginMap.mockRejectedValue(new Error("openclaw not on PATH"));

    const { report } = await buildReport({
      config: DEFAULT_CONFIG,
      paths,
      name: "cli-fail",
      slug: "cli-fail",
      mode: "start-stop",
      tsStartMs: 0,
      tsEndMs: 1000,
    });

    expect(report.plugins_used).toEqual(["core"]);
  });

  describe("events timeline", () => {
    function findEvent(events: ProbeEvent[], substring: string): ProbeEvent | undefined {
      return events.find((e) => e.event.includes(substring));
    }

    it("records one entry per completed agent run and tool call, with status/duration for failures", async () => {
      mockedFetchAuditEvents.mockResolvedValue([
        ev({ kind: "agent_run", action: "agent.run.started", runId: "run-1", sessionId: "s1", agentId: "main", occurredAt: 1000 }),
        ev({ kind: "agent_run", action: "agent.run.finished", runId: "run-1", sessionId: "s1", agentId: "main", occurredAt: 4000, status: "succeeded" }),
        ev({ kind: "tool_action", action: "tool.action.started", toolCallId: "tc-1", sessionId: "s1", toolName: "read", occurredAt: 1200 }),
        ev({ kind: "tool_action", action: "tool.action.finished", toolCallId: "tc-1", sessionId: "s1", toolName: "read", occurredAt: 1700, status: "succeeded" }),
        ev({ kind: "tool_action", action: "tool.action.started", toolCallId: "tc-2", sessionId: "s1", toolName: "postgres_query", occurredAt: 2000 }),
        ev({ kind: "tool_action", action: "tool.action.finished", toolCallId: "tc-2", sessionId: "s1", toolName: "postgres_query", occurredAt: 2500, status: "failed", errorCode: "connection_refused" }),
      ]);
      mockedFetchToolToPluginMap.mockResolvedValue(new Map());

      const { report } = await buildReport({
        config: DEFAULT_CONFIG,
        paths,
        name: "events-basic",
        slug: "events-basic",
        mode: "start-stop",
        tsStartMs: 0,
        tsEndMs: 5000,
      });

      const runEvent = findEvent(report.events, "agent run: main");
      expect(runEvent).toEqual({ date: new Date(4000).toISOString(), event: "agent run: main (3s)" });

      const readEvent = findEvent(report.events, "tool call: read");
      expect(readEvent).toEqual({ date: new Date(1700).toISOString(), event: "tool call: read (0.5s)" });

      const failedEvent = findEvent(report.events, "tool call: postgres_query");
      expect(failedEvent?.event).toBe("tool call: postgres_query (failed: connection_refused, 0.5s)");
    });

    it("records a still-running entry for a run/tool call with no matching finish in the window", async () => {
      mockedFetchAuditEvents.mockResolvedValue([
        ev({ kind: "agent_run", action: "agent.run.started", runId: "run-unfinished", sessionId: "s1", agentId: "diag-state", occurredAt: 1000 }),
        ev({ kind: "tool_action", action: "tool.action.started", toolCallId: "tc-unfinished", sessionId: "s1", toolName: "exec", occurredAt: 1500 }),
      ]);
      mockedFetchToolToPluginMap.mockResolvedValue(new Map());

      const { report } = await buildReport({
        config: DEFAULT_CONFIG,
        paths,
        name: "events-inflight",
        slug: "events-inflight",
        mode: "start-stop",
        tsStartMs: 0,
        tsEndMs: 5000,
      });

      expect(findEvent(report.events, "agent run: diag-state")?.event).toBe("agent run: diag-state (started, still running at window end)");
      expect(findEvent(report.events, "tool call: exec")?.event).toBe("tool call: exec (started, still running at window end)");
    });

    it("records one entry per LLM call from the trajectory, noting tool-calling turns", async () => {
      mockedFetchAuditEvents.mockResolvedValue([
        ev({ kind: "agent_run", action: "agent.run.started", runId: "run-1", sessionId: "s1", agentId: "main", occurredAt: 1000 }),
        ev({ kind: "agent_run", action: "agent.run.finished", runId: "run-1", sessionId: "s1", agentId: "main", occurredAt: 4000, status: "succeeded" }),
      ]);
      mockedFetchToolToPluginMap.mockResolvedValue(new Map());
      mockedFindModelCompleted.mockResolvedValueOnce({
        provider: "deepseek",
        modelId: "deepseek-v4-pro",
        data: {
          usage: { total: 100 },
          messagesSnapshot: [
            { role: "assistant", timestamp: 1500, provider: "deepseek", model: "deepseek-v4-pro", content: [{ type: "toolCall" }] },
            { role: "assistant", timestamp: 3500, provider: "deepseek", model: "deepseek-v4-pro", content: [{ type: "text" }] },
          ],
        },
      } as any);

      const { report } = await buildReport({
        config: DEFAULT_CONFIG,
        paths,
        name: "events-llm",
        slug: "events-llm",
        mode: "start-stop",
        tsStartMs: 0,
        tsEndMs: 5000,
      });

      const llmEvents = report.events.filter((e) => e.event.startsWith("LLM call:"));
      expect(llmEvents).toEqual([
        { date: new Date(1500).toISOString(), event: "LLM call: deepseek/deepseek-v4-pro (with tool call)" },
        { date: new Date(3500).toISOString(), event: "LLM call: deepseek/deepseek-v4-pro" },
      ]);
    });

    it("falls back to the model.completed event's own provider/model when messagesSnapshot has no timestamp inside the run window (regression: llm_calls=0/models_used={} despite real tokens)", async () => {
      // Reproduces a real trajectory observed live: the matched model.completed event's usage
      // is real (correctly summed into tokens), but its messagesSnapshot was stale - every
      // assistant-message timestamp fell well before the run's actual window (a host-side
      // trajectory-writer quirk, not compaction - compactionCount was 0). Before this fix,
      // that meant tokens showed real numbers while llm_calls stayed 0 and models_used was
      // empty for the same run, which is exactly the contradiction a user flagged.
      mockedFetchAuditEvents.mockResolvedValue([
        ev({ kind: "agent_run", action: "agent.run.started", runId: "run-stale", sessionId: "s1", agentId: "main", occurredAt: 100000 }),
        ev({ kind: "agent_run", action: "agent.run.finished", runId: "run-stale", sessionId: "s1", agentId: "main", occurredAt: 200000, status: "succeeded" }),
      ]);
      mockedFetchToolToPluginMap.mockResolvedValue(new Map());
      mockedFindModelCompleted.mockResolvedValueOnce({
        provider: "deepseek",
        modelId: "deepseek-v4-pro",
        ts: new Date(200000).toISOString(),
        data: {
          usage: { input: 100, output: 20, total: 120 },
          // stale: every assistant timestamp is way before the run's [100000, 200000] window
          messagesSnapshot: [
            { role: "assistant", timestamp: 500, provider: "deepseek", model: "deepseek-v4-pro", content: [{ type: "text" }] },
          ],
        },
      } as any);

      const { report } = await buildReport({
        config: DEFAULT_CONFIG,
        paths,
        name: "events-stale-snapshot",
        slug: "events-stale-snapshot",
        mode: "start-stop",
        tsStartMs: 0,
        tsEndMs: 300000,
      });

      expect(report.tokens.total).toBe(120); // unaffected either way - not the bug
      expect(report.iterations.llm_calls).toBe(1); // was 0 before the fix
      expect(report.models_used).toEqual({ "deepseek/deepseek-v4-pro": 1 }); // was {} before the fix
      expect(report.iterations.tool_calling_rounds).toBe(0); // can't be known for the fallback call
      const llmEvent = report.events.find((e) => e.event.startsWith("LLM call:"));
      expect(llmEvent?.date).toBe(new Date(200000).toISOString());
      expect(llmEvent?.event).toContain("deepseek/deepseek-v4-pro");
      expect(report.warnings.some((w) => w.includes("run_id=run-stale") && w.includes("no assistant-message timestamp"))).toBe(true);
    });

    it("records one entry per skill use", async () => {
      mockedFetchAuditEvents.mockResolvedValue([
        ev({ kind: "tool_action", action: "tool.action.started", toolCallId: "tc-1", sessionId: "s1", toolName: "read", occurredAt: 1000 }),
        ev({ kind: "tool_action", action: "tool.action.finished", toolCallId: "tc-1", sessionId: "s1", toolName: "read", occurredAt: 1100, status: "succeeded" }),
      ]);
      mockedFetchToolToPluginMap.mockResolvedValue(new Map());
      mockedCollectSkillUsageEvents.mockResolvedValueOnce([
        { observedAt: new Date(1050).toISOString(), skillId: "weather", skillName: "weather" },
      ]);

      const { report } = await buildReport({
        config: DEFAULT_CONFIG,
        paths,
        name: "events-skill",
        slug: "events-skill",
        mode: "start-stop",
        tsStartMs: 0,
        tsEndMs: 5000,
      });

      expect(findEvent(report.events, "skill used:")?.event).toBe("skill used: weather");
      expect(report.skills_used).toEqual({ weather: { name: "weather", uses: 1 } });
    });

    it("sorts events chronologically regardless of source order", async () => {
      mockedFetchAuditEvents.mockResolvedValue([
        ev({ kind: "tool_action", action: "tool.action.started", toolCallId: "tc-late", sessionId: "s1", toolName: "read", occurredAt: 4000 }),
        ev({ kind: "tool_action", action: "tool.action.finished", toolCallId: "tc-late", sessionId: "s1", toolName: "read", occurredAt: 4100, status: "succeeded" }),
        ev({ kind: "tool_action", action: "tool.action.started", toolCallId: "tc-early", sessionId: "s1", toolName: "exec", occurredAt: 1000 }),
        ev({ kind: "tool_action", action: "tool.action.finished", toolCallId: "tc-early", sessionId: "s1", toolName: "exec", occurredAt: 1100, status: "succeeded" }),
      ]);
      mockedFetchToolToPluginMap.mockResolvedValue(new Map());

      const { report } = await buildReport({
        config: DEFAULT_CONFIG,
        paths,
        name: "events-order",
        slug: "events-order",
        mode: "start-stop",
        tsStartMs: 0,
        tsEndMs: 5000,
      });

      const dates = report.events.map((e) => Date.parse(e.date));
      expect(dates).toEqual([...dates].sort((a, b) => a - b));
      expect(report.events[0].event).toContain("exec");
      expect(report.events[1].event).toContain("read");
    });
  });
});
