/** Shared types for the probe plugin. Kept loose (mirrors OpenClaw's own plugin SDK style)
 * because the host does not export narrow public types for audit/trajectory payloads. */

export type PluginLogger = {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type HookAgentContext = {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
};

export type ProbeConfig = {
  openclawBin: string;
  cliTimeoutMs: number;
  llmLog: {
    enabled: boolean;
    maxFileSizeMb: number;
    maxFiles: number;
    redactSecrets: boolean;
  };
  explain: {
    /** Model ref ("provider/model") for /probe explain's natural-language interpretation.
     * Unset uses api.runtime.llm.complete's default (the target agent's configured model) -
     * an explicit value here requires the operator to grant
     * plugins.entries.probe.llm.allowModelOverride: true (see README Requirements). */
    model?: string;
    modelFallback?: string;
    /** Natural language for the generated explanations, e.g. "en", "ru". Free text passed
     * into the LLM prompt, not validated against a fixed list. */
    language: string;
  };
};

export const DEFAULT_CONFIG: ProbeConfig = {
  openclawBin: "openclaw",
  cliTimeoutMs: 30_000,
  llmLog: {
    enabled: true,
    maxFileSizeMb: 20,
    maxFiles: 14,
    redactSecrets: true,
  },
  explain: {
    language: "en",
  },
};

/** One record from `openclaw audit --json` (agent_run or tool_action). Fields beyond
 * those the plugin reads are intentionally left untyped. */
export type AuditEvent = {
  kind: "agent_run" | "tool_action";
  action: string;
  status: string;
  errorCode?: string;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
  toolCallId?: string;
  toolName?: string;
  occurredAt: number;
  [key: string]: unknown;
};

export type RunWindow = {
  agentId: string;
  sessionId: string;
  /** Present when the pairing audit events carried one. Used to recognize the Active Memory
   * plugin's own blocking-recall sub-agent runs (`sessionKey` contains `:active-memory:`,
   * `sessionId` starts with `active-memory-`) - see `isActiveMemoryRunWindow` in report.ts. */
  sessionKey?: string;
  runId: string;
  startedMs: number;
  finishedMs: number;
};

export type SkillUsageEntry = { name: string; uses: number };

/** Which of the two memory-search paths a `memory_search`/`memory_get` call came from -
 * see `memorySearchUsage.ts` for how this is told apart (the Active Memory plugin's own
 * blocking-recall sub-agent runs with a distinct sessionKey/sessionId; everything else is a
 * normal tool call inside the agent's own session). */
export type MemorySearchSource = "active_memory" | "explicit";

export type MemorySearchStats = {
  calls: number;
  hits_total: number;
  chars_found: number;
};

/** One line of the report's chronological `events` timeline - ISO timestamp plus a short,
 * human-readable description. Built from the same underlying sources as the rest of the
 * report (audit ledger, trajectory files, probe's own skill-usage log); see
 * `events` in README's field reference for exactly which event kinds appear. */
export type ProbeEvent = {
  date: string;
  event: string;
};

export type ProbeMode = "start-stop" | "range";

export type ProbeReport = {
  probe: {
    name: string;
    mode: ProbeMode;
    generated_at: string;
  };
  window: {
    ts_start: string;
    ts_end: string;
    wall_clock_sec: number;
  };
  sessions: {
    session_ids: string[];
    agents_used: Record<string, number>;
  };
  time: {
    agent_active_sec: number;
    llm_latency_sec: number;
    tool_exec_sec: number;
  };
  iterations: {
    agent_runs: number;
    llm_calls: number;
    tool_calling_rounds: number;
    tool_calls_total: number;
  };
  models_used: Record<string, number>;
  tokens: Record<string, number>;
  context: {
    system_prompt_chars_samples: number[];
    system_prompt_chars_avg: number | null;
  };
  tools_used: Record<string, number>;
  plugins_used: string[];
  skills_used: Record<string, SkillUsageEntry>;
  errors: {
    tool_call_errors: {
      count: number;
      by_tool: Record<string, number>;
      by_status: Record<string, number>;
      by_code: Record<string, number>;
    };
    agent_run_errors: {
      count: number;
      by_status: Record<string, number>;
      by_code: Record<string, number>;
    };
  };
  llm_api_log: {
    entries_captured: number;
    file: string | null;
  };
  memory_search: {
    active_memory: MemorySearchStats;
    explicit: MemorySearchStats;
    file: string | null;
  };
  events: ProbeEvent[];
  warnings: string[];
};

/** Thrown for user-facing validation failures (bad args, no data, etc). The message is
 * shown to the chat user as-is, so it must be self-contained and not leak internals. */
export class ProbeUserError extends Error {}

/** One numeric metric compared between two reports. `diff` is always `name2 - name1` (the
 * second measurement minus the first) - never the other way round. Either side is `null`
 * when the source report had `null` there (e.g. `context.system_prompt_chars_avg` with no
 * samples), in which case `diff` is also `null` rather than a misleading number. */
export type DiffNumeric = {
  name1: number | null;
  name2: number | null;
  diff: number | null;
};

/** One "what was used/what happened" field compared between two reports as a set difference
 * (name2 minus name1), not a numeric diff - counts are discarded, only presence/absence
 * matters. `added` = present in name2 but not name1 (render with a `+` prefix), `removed` =
 * present in name1 but not name2 (render with a `-` prefix). Both are sorted for determinism. */
export type DiffSet = {
  added: string[];
  removed: string[];
};

/** Result of `/probe diff <name1>, <name2>`. Identifying/time metadata (names, generated_at,
 * window start/end) is informational only, in `compared`, and is never diffed - see the
 * field-level comments on `DiffNumeric`/`DiffSet` for how the two diff kinds behave. */
export type ProbeDiffReport = {
  diff: {
    generated_at: string;
    result_file: string;
  };
  compared: {
    name1: { name: string; slug: string; mode: ProbeMode; generated_at: string; ts_start: string; ts_end: string };
    name2: { name: string; slug: string; mode: ProbeMode; generated_at: string; ts_start: string; ts_end: string };
  };
  window: {
    wall_clock_sec: DiffNumeric;
  };
  sessions: {
    session_ids: DiffSet;
    agents_used: DiffSet;
  };
  time: {
    agent_active_sec: DiffNumeric;
    llm_latency_sec: DiffNumeric;
    tool_exec_sec: DiffNumeric;
  };
  iterations: {
    agent_runs: DiffNumeric;
    llm_calls: DiffNumeric;
    tool_calling_rounds: DiffNumeric;
    tool_calls_total: DiffNumeric;
  };
  models_used: DiffSet;
  tokens: {
    input: DiffNumeric;
    output: DiffNumeric;
    cacheRead: DiffNumeric;
    cacheWrite: DiffNumeric;
    reasoningTokens: DiffNumeric;
    total: DiffNumeric;
  };
  context: {
    system_prompt_chars_avg: DiffNumeric;
  };
  tools_used: DiffSet;
  plugins_used: DiffSet;
  skills_used: DiffSet;
  errors: {
    tool_call_errors: {
      count: DiffNumeric;
      by_tool: DiffSet;
      by_status: DiffSet;
      by_code: DiffSet;
    };
    agent_run_errors: {
      count: DiffNumeric;
      by_status: DiffSet;
      by_code: DiffSet;
    };
  };
  llm_api_log: {
    entries_captured: DiffNumeric;
  };
  memory_search: {
    active_memory: { calls: DiffNumeric; hits_total: DiffNumeric; chars_found: DiffNumeric };
    explicit: { calls: DiffNumeric; hits_total: DiffNumeric; chars_found: DiffNumeric };
  };
  events: DiffSet;
  warnings: DiffSet;
};

// ---- /probe explain ----

/** One tool call as OpenClaw's own trajectory writer already summarized it (see
 * `trajectory.ts`'s `findAllRunTraces`) - `meta` is a truncated, partially host-redacted
 * (e.g. `TOKEN=***`) one-line description, not the full raw arguments. */
export type SessionToolCallTrace = {
  toolName: string;
  meta: string;
};

/** One completed agent turn ("run") pulled from a session's trajectory file. */
export type SessionRunTrace = {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  runId: string;
  ts: string;
  provider?: string;
  model?: string;
  finalStatus?: string;
  aborted?: boolean;
  toolCalls: SessionToolCallTrace[];
};

/** One session in the explain graph (the root session, or a sub-agent session discovered by
 * walking `spawnedBy` chains) - see `sessionGraph.ts`. */
export type SessionNode = {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  spawnedBy?: string;
  costUsd?: number;
  tokens?: { input?: number; output?: number; total?: number };
  runs: SessionRunTrace[];
};

export type ExplainedToolCall = SessionToolCallTrace & {
  explanation: string;
};

export type ExplainedRun = Omit<SessionRunTrace, "toolCalls"> & {
  summary: string;
  toolCalls: ExplainedToolCall[];
};

export type AgentIdentity = {
  name?: string;
  emoji?: string;
};

export type ExplainUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
};

export type ExplainResult = {
  rootSessionKey: string;
  sessionsIncluded: number;
  runs: ExplainedRun[];
  agentIdentities: Record<string, AgentIdentity>;
  usage: ExplainUsage;
  warnings: string[];
};

/** Loose shape of a `sessions.json` entry (see `api.runtime.agent.session.listSessionEntries`)
 * - only the fields `sessionGraph.ts` actually reads are named; the host does not export a
 * narrow public type for this. */
export type SessionStoreEntryLike = {
  sessionId?: string;
  spawnedBy?: string;
  estimatedCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  [key: string]: unknown;
};

export type LlmCompleteMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type LlmCompleteResult = {
  text: string;
  provider: string;
  model: string;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    costUsd?: number;
  };
};

/** Narrow structural view of `api.runtime` for the two host capabilities /probe explain uses
 * (`docs/plugins/sdk-runtime.md`'s `api.runtime.agent.session` and `api.runtime.llm`) - kept
 * loose/local rather than importing OpenClaw's internal types, matching this file's existing
 * convention for host-shaped data. */
export type ExplainRuntimeApi = {
  runtime: {
    agent: {
      session: {
        listSessionEntries: (params: { agentId: string }) => Iterable<{ sessionKey: string; entry: SessionStoreEntryLike }>;
      };
    };
    llm: {
      complete: (params: {
        messages: LlmCompleteMessage[];
        model?: string;
        maxTokens?: number;
        temperature?: number;
        systemPrompt?: string;
        purpose?: string;
        signal?: AbortSignal;
      }) => Promise<LlmCompleteResult>;
    };
  };
};
