import { describe, expect, it, vi } from "vitest";
import { resolvePaths } from "./paths.js";
import { DEFAULT_CONFIG, type AuditEvent } from "./types.js";

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
  collectSkillUsage: vi.fn().mockResolvedValue(null),
}));
vi.mock("./llmCapture.js", () => ({
  collectRawLlmEntries: vi.fn().mockResolvedValue([]),
  writeRawLlmEntriesFile: vi.fn().mockResolvedValue(null),
}));

import { fetchAuditEvents, fetchToolToPluginMap } from "./cli.js";
import { buildReport } from "./report.js";

const mockedFetchAuditEvents = vi.mocked(fetchAuditEvents);
const mockedFetchToolToPluginMap = vi.mocked(fetchToolToPluginMap);

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
    expect(report.skills_used).toBeNull();
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
});
