import { fetchAuditEvents, fetchToolToPluginMap } from "./cli.js";
import { collectRawLlmEntries, writeRawLlmEntriesFile } from "./llmCapture.js";
import type { ProbePaths } from "./paths.js";
import { rawRequestsPath } from "./store.js";
import { collectSkillUsageEvents } from "./skillUsage.js";
import { extractSystemPromptChars, findContextCompiledNear, findModelCompleted } from "./trajectory.js";
import type { AuditEvent, ProbeConfig, ProbeEvent, ProbeMode, ProbeReport, RunWindow, SkillUsageEntry } from "./types.js";

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function bump(map: Record<string, number>, key: string, by = 1): void {
  map[key] = (map[key] ?? 0) + by;
}

function fmtDuration(ms: number): string {
  return `${Math.round((ms / 1000) * 100) / 100}s`;
}

/** Formats the "(status, duration)" suffix for a timeline entry - empty string when the
 * outcome was a plain success and no duration is known, so the common case stays terse. */
function describeOutcome(status: string, errorCode: string | undefined, durationMs: number | undefined): string {
  const parts: string[] = [];
  if (status !== "succeeded") parts.push(errorCode ? `${status}: ${errorCode}` : status);
  if (durationMs !== undefined) parts.push(fmtDuration(durationMs));
  return parts.length ? ` (${parts.join(", ")})` : "";
}

/** Collapses started/finished audit events into one pair per correlation key (runId or
 * toolCallId). Incomplete pairs (still running when the window closed) are kept with
 * whichever half arrived so callers can decide how to treat them. */
function pairEvents(
  events: AuditEvent[],
  key: "runId" | "toolCallId",
  startAction: string,
  finishAction: string,
): Map<string, { started?: AuditEvent; finished?: AuditEvent }> {
  const paired = new Map<string, { started?: AuditEvent; finished?: AuditEvent }>();
  for (const ev of events) {
    const k = ev[key] as string | undefined;
    if (!k) continue;
    const entry = paired.get(k) ?? {};
    if (ev.action === startAction) entry.started = ev;
    else if (ev.action === finishAction) entry.finished = ev;
    paired.set(k, entry);
  }
  return paired;
}

export type BuildReportParams = {
  config: ProbeConfig;
  paths: ProbePaths;
  name: string;
  slug: string;
  mode: ProbeMode;
  tsStartMs: number;
  tsEndMs: number;
};

export type BuildReportResult = {
  report: ProbeReport;
  hasAnyAuditEvents: boolean;
};

export async function buildReport(params: BuildReportParams): Promise<BuildReportResult> {
  const { config, paths, name, slug, mode, tsStartMs, tsEndMs } = params;

  const events = await fetchAuditEvents(config, tsStartMs, tsEndMs);
  const agentRunEvents = events.filter((e) => e.kind === "agent_run");
  const toolActionEvents = events.filter((e) => e.kind === "tool_action");

  const runs = pairEvents(agentRunEvents, "runId", "agent.run.started", "agent.run.finished");
  const toolCalls = pairEvents(toolActionEvents, "toolCallId", "tool.action.started", "tool.action.finished");

  const sessionIds = [...new Set(events.map((e) => e.sessionId).filter((v): v is string => !!v))].sort();

  // ---- events timeline (one line per agent run / tool call / LLM call / skill use) ----
  const timeline: ProbeEvent[] = [];

  // ---- time ----
  let agentActiveMs = 0;
  const runWindows: RunWindow[] = [];
  const agentRunErrorsByStatus: Record<string, number> = {};
  const agentRunErrorsByCode: Record<string, number> = {};
  for (const pair of runs.values()) {
    const { started, finished } = pair;
    const agentId = (finished ?? started)?.agentId ?? "unknown";
    if (started && finished) {
      timeline.push({
        date: iso(finished.occurredAt),
        event: `agent run: ${agentId}${describeOutcome(finished.status, finished.errorCode, finished.occurredAt - started.occurredAt)}`,
      });
    } else if (finished) {
      timeline.push({ date: iso(finished.occurredAt), event: `agent run: ${agentId}${describeOutcome(finished.status, finished.errorCode, undefined)}` });
    } else if (started) {
      timeline.push({ date: iso(started.occurredAt), event: `agent run: ${agentId} (started, still running at window end)` });
    }
    if (!started || !finished) continue; // still in flight at window close
    const duration = finished.occurredAt - started.occurredAt;
    agentActiveMs += duration;
    runWindows.push({
      agentId: finished.agentId ?? "unknown",
      sessionId: finished.sessionId ?? "unknown",
      runId: finished.runId ?? "unknown",
      startedMs: started.occurredAt,
      finishedMs: finished.occurredAt,
    });
    if (finished.status !== "succeeded") {
      bump(agentRunErrorsByStatus, finished.status);
      if (finished.errorCode) bump(agentRunErrorsByCode, finished.errorCode);
    }
  }

  let toolExecMs = 0;
  const toolErrorsByTool: Record<string, number> = {};
  const toolErrorsByStatus: Record<string, number> = {};
  const toolErrorsByCode: Record<string, number> = {};
  const toolsUsed: Record<string, number> = {};
  for (const pair of toolCalls.values()) {
    const { started, finished } = pair;
    const toolName = (finished ?? started)?.toolName ?? "unknown";
    bump(toolsUsed, toolName);
    if (started && finished) {
      timeline.push({
        date: iso(finished.occurredAt),
        event: `tool call: ${toolName}${describeOutcome(finished.status, finished.errorCode, finished.occurredAt - started.occurredAt)}`,
      });
    } else if (finished) {
      timeline.push({ date: iso(finished.occurredAt), event: `tool call: ${toolName}${describeOutcome(finished.status, finished.errorCode, undefined)}` });
    } else if (started) {
      timeline.push({ date: iso(started.occurredAt), event: `tool call: ${toolName} (started, still running at window end)` });
    }
    if (started && finished) toolExecMs += finished.occurredAt - started.occurredAt;
    if (finished && finished.status !== "succeeded") {
      bump(toolErrorsByTool, toolName);
      bump(toolErrorsByStatus, finished.status);
      if (finished.errorCode) bump(toolErrorsByCode, finished.errorCode);
    }
  }

  const llmLatencyMs = Math.max(agentActiveMs - toolExecMs, 0);

  // ---- tokens / context / LLM call counts / models, from trajectory files ----
  const usageTotal: Record<string, number> = {};
  let llmCalls = 0;
  let toolRounds = 0;
  const contextCharsSamples: number[] = [];
  const warnings: string[] = [];
  const modelsUsed: Record<string, number> = {};

  for (const rw of runWindows) {
    const mc = await findModelCompleted(paths.agentsDir, rw.agentId, rw.sessionId, rw.runId);
    if (!mc) {
      warnings.push(
        `trajectory model.completed not found for run_id=${rw.runId} (rotated/deleted trajectory file, or run still in flight)`,
      );
      continue;
    }
    const usage = ((mc.data as { usage?: Record<string, number> } | undefined)?.usage ?? {}) as Record<
      string,
      number
    >;
    for (const k of ["input", "output", "cacheRead", "cacheWrite", "reasoningTokens", "total"]) {
      usageTotal[k] = (usageTotal[k] ?? 0) + (usage[k] ?? 0);
    }
    const runLevelModel = mc.provider && mc.modelId ? `${mc.provider}/${mc.modelId}` : undefined;

    const snapshot = ((mc.data as { messagesSnapshot?: unknown[] } | undefined)?.messagesSnapshot ?? []) as Array<
      Record<string, unknown>
    >;
    let matchedInWindow = 0;
    for (const m of snapshot) {
      if (m.role !== "assistant") continue;
      const ts = m.timestamp as number | undefined;
      if (ts === undefined || ts < rw.startedMs - 1000 || ts > rw.finishedMs + 1000) continue;
      llmCalls += 1;
      matchedInWindow += 1;
      const content = (m.content as Array<Record<string, unknown>> | undefined) ?? [];
      const hadToolCall = content.some((c) => c?.type === "toolCall");
      if (hadToolCall) toolRounds += 1;
      const provider = m.provider as string | undefined;
      const model = m.model as string | undefined;
      const key = provider && model ? `${provider}/${model}` : runLevelModel;
      bump(modelsUsed, key ?? "unknown");
      timeline.push({ date: iso(ts), event: `LLM call: ${key ?? "unknown"}${hadToolCall ? " (with tool call)" : ""}` });
    }

    // Fallback for a real but unmatchable completion: `mc` proves a model.completed event
    // exists for this run (its `usage` above is already counted), but none of its
    // messagesSnapshot's assistant-message timestamps fell inside the run's window. Observed
    // live on a long multi-turn session: messagesSnapshot was stale/reused verbatim (same
    // message content and timestamps) across several unrelated runIds finishing minutes apart,
    // with compactionCount 0 - not ordinary compaction truncation, apparently a host-side
    // trajectory-writer quirk on that build. Rather than silently reporting 0 llm_calls / an
    // empty models_used while tokens still show real numbers for the same event (the exact
    // contradiction this fallback exists to avoid), count one LLM call from the event's own
    // top-level provider/modelId/ts, which do not depend on the snapshot at all. This cannot
    // determine whether that call produced a tool call, so tool_calling_rounds is left
    // unincremented for it and a warning notes the gap.
    if (matchedInWindow === 0) {
      llmCalls += 1;
      bump(modelsUsed, runLevelModel ?? "unknown");
      const ts = typeof mc.ts === "string" ? mc.ts : iso(rw.finishedMs);
      timeline.push({
        date: ts,
        event: `LLM call: ${runLevelModel ?? "unknown"} (tool-call status unknown - trajectory snapshot timestamps were outside the run window)`,
      });
      warnings.push(
        `trajectory messagesSnapshot for run_id=${rw.runId} had no assistant-message timestamp inside the run window; counted 1 LLM call from the model.completed event's own provider/model instead of the snapshot, but could not determine whether it produced a tool call`,
      );
    }

    const cc = await findContextCompiledNear(paths.agentsDir, rw.agentId, rw.sessionId, rw.runId);
    const chars = extractSystemPromptChars(cc);
    if (chars) contextCharsSamples.push(chars);
  }

  // ---- skills (windowed from probe's own after_tool_call-based detection log) ----
  const skillUsageEvents = await collectSkillUsageEvents(paths.skillLogDir, tsStartMs, tsEndMs);
  const skillsUsed: Record<string, SkillUsageEntry> = {};
  for (const event of skillUsageEvents) {
    const entry = skillsUsed[event.skillId] ?? { name: event.skillName, uses: 0 };
    entry.uses += 1;
    skillsUsed[event.skillId] = entry;
    timeline.push({ date: event.observedAt, event: `skill used: ${event.skillName}` });
  }

  // ---- tool -> plugin ownership ----
  const toolToPlugin = await fetchToolToPluginMap(config).catch(() => new Map<string, string>());
  const pluginsUsed = [...new Set(Object.keys(toolsUsed).map((t) => toolToPlugin.get(t) ?? "core"))].sort();

  // ---- agents used ----
  const agentsUsed: Record<string, number> = {};
  for (const rw of runWindows) bump(agentsUsed, rw.agentId);

  // ---- raw LLM request/response archive ----
  const rawEntries = await collectRawLlmEntries(paths.llmLogDir, tsStartMs, tsEndMs);
  const rawFile = await writeRawLlmEntriesFile(rawRequestsPath(paths, slug), rawEntries);

  const report: ProbeReport = {
    probe: { name, mode, generated_at: iso(Date.now()) },
    window: {
      ts_start: iso(tsStartMs),
      ts_end: iso(tsEndMs),
      wall_clock_sec: Math.round(((tsEndMs - tsStartMs) / 1000) * 1000) / 1000,
    },
    sessions: { session_ids: sessionIds, agents_used: agentsUsed },
    time: {
      agent_active_sec: Math.round((agentActiveMs / 1000) * 1000) / 1000,
      llm_latency_sec: Math.round((llmLatencyMs / 1000) * 1000) / 1000,
      tool_exec_sec: Math.round((toolExecMs / 1000) * 1000) / 1000,
    },
    iterations: {
      agent_runs: runWindows.length,
      llm_calls: llmCalls,
      tool_calling_rounds: toolRounds,
      tool_calls_total: toolCalls.size,
    },
    models_used: sortRecord(modelsUsed),
    tokens: usageTotal,
    context: {
      system_prompt_chars_samples: contextCharsSamples,
      system_prompt_chars_avg: contextCharsSamples.length
        ? Math.round(contextCharsSamples.reduce((a, b) => a + b, 0) / contextCharsSamples.length)
        : null,
    },
    tools_used: sortRecord(toolsUsed),
    plugins_used: pluginsUsed,
    skills_used: skillsUsed,
    errors: {
      tool_call_errors: {
        count: Object.values(toolErrorsByTool).reduce((a, b) => a + b, 0),
        by_tool: toolErrorsByTool,
        by_status: toolErrorsByStatus,
        by_code: toolErrorsByCode,
      },
      agent_run_errors: {
        count: Object.values(agentRunErrorsByStatus).reduce((a, b) => a + b, 0),
        by_status: agentRunErrorsByStatus,
        by_code: agentRunErrorsByCode,
      },
    },
    llm_api_log: { entries_captured: rawEntries.length, file: rawFile },
    events: timeline.sort((a, b) => Date.parse(a.date) - Date.parse(b.date)),
    warnings,
  };

  return { report, hasAnyAuditEvents: events.length > 0 };
}

function sortRecord(rec: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(rec).sort(([a], [b]) => a.localeCompare(b)));
}
