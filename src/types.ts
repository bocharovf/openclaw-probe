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
  runId?: string;
  toolCallId?: string;
  toolName?: string;
  occurredAt: number;
  [key: string]: unknown;
};

export type RunWindow = {
  agentId: string;
  sessionId: string;
  runId: string;
  startedMs: number;
  finishedMs: number;
};

export type SkillUsageEntry = { name: string; uses: number };

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
  skills_used: Record<string, SkillUsageEntry> | null;
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
  warnings: string[];
};

/** Thrown for user-facing validation failures (bad args, no data, etc). The message is
 * shown to the chat user as-is, so it must be self-contained and not leak internals. */
export class ProbeUserError extends Error {}
