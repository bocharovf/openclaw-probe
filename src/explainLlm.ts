import type {
  AgentIdentity,
  ExplainRuntimeApi,
  ExplainUsage,
  ExplainedRun,
  ExplainedToolCall,
  PluginLogger,
  SessionRunTrace,
} from "./types.js";

/**
 * Turns the raw, ordered run/tool-call data `sessionGraph.ts` collected into natural-language
 * explanations via `api.runtime.llm.complete` (see docs/plugins/sdk-runtime.md). Batches many
 * runs into few LLM calls (one call per chunk, not one per action) so a real multi-agent
 * incident with a few dozen actions costs a couple of calls, not dozens - and so the model
 * sees each run's tool calls together, which is what lets it write one coherent per-run
 * summary instead of disconnected one-liners.
 */

const DEFAULT_CHUNK_SIZE = 10;
const MAX_META_CHARS = 300;
// A flat maxTokens budget silently truncates the response mid-JSON on a busy chunk - observed
// live on a real 9-run/~50-tool-call incident: a fixed 2000-token cap cut the response off
// partway through run 2 of 9, and the truncated JSON failed to parse (the content itself, up
// to the cut, was accurate - this was purely a budget problem, not a quality one). Scale the
// budget with what's actually being asked for instead of guessing one constant for every
// chunk size.
const TOKENS_PER_TOOL_CALL = 100;
const TOKENS_PER_RUN_SUMMARY = 80;
const MIN_TOKENS_PER_CHUNK = 1500;
const MAX_TOKENS_PER_CHUNK = 8000;

// Redacts secret-shaped SUBSTRINGS inside a free-text command summary (llmCapture.ts's
// redact() tests whether a whole VALUE is secret-shaped, which is right for structured
// request fields but wrong here - `meta` is a full one-line command like
// `curl -H "Authorization: Bearer sk-abc123..." https://...`, so a secret is usually embedded
// inside a longer string, not the whole string. OpenClaw's own trajectory writer already
// masks some of this (observed live: `TOKEN=***`) - these patterns are defense in depth for
// what it might miss, not the primary safeguard.
/** Already-masked by OpenClaw itself (observed live: `TOKEN=***`) - leave as-is rather than
 * redacting a placeholder that carries no information to begin with. */
function isAlreadyMasked(value: string): boolean {
  return /^\*+$/.test(value);
}

function redactVarAssignments(text: string): string {
  return text.replace(
    /\b(\w*(?:TOKEN|SECRET|PASSWORD|PASS|API_?KEY)\w*\s*=\s*)(['"]?)([^\s'"]+)\2/gi,
    (full: string, prefix: string, quote: string, value: string) =>
      isAlreadyMasked(value) ? full : `${prefix}${quote}[REDACTED]${quote}`,
  );
}

function redactBearerTokens(text: string): string {
  return text.replace(
    /(Authorization:\s*Bearer\s+)([^\s'"]+)/gi,
    (full: string, prefix: string, value: string) => (isAlreadyMasked(value) ? full : `${prefix}[REDACTED]`),
  );
}

function redactBareTokens(text: string): string {
  return text.replace(
    /\b(sk-[a-zA-Z0-9_-]{20,}|ghp_[a-zA-Z0-9]{20,}|eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)\b/g,
    "[REDACTED]",
  );
}

export function redactCommandText(text: string): string {
  return redactBareTokens(redactBearerTokens(redactVarAssignments(text)));
}

function truncateMeta(meta: string): string {
  const redacted = redactCommandText(meta);
  return redacted.length > MAX_META_CHARS ? `${redacted.slice(0, MAX_META_CHARS)}…` : redacted;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Maps common language codes/names to a full language name, so a short config value like
 * `"ru"` still produces an unambiguous instruction for the model (the old `in ${language}`
 * wording made "in ru" a weak signal the model ignored). Free-text values pass through
 * unchanged, e.g. "simple Russian, no jargon". */
const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  english: "English",
  ru: "Russian",
  russian: "Russian",
  русский: "Russian",
  uk: "Ukrainian",
  ukrainian: "Ukrainian",
  ja: "Japanese",
  japanese: "Japanese",
  de: "German",
  german: "German",
  fr: "French",
  french: "French",
  es: "Spanish",
  spanish: "Spanish",
  pt: "Portuguese",
  portuguese: "Portuguese",
  it: "Italian",
  italian: "Italian",
  zh: "Chinese",
  chinese: "Chinese",
};

function languageName(language: string): string {
  const key = language.trim().toLowerCase();
  return LANGUAGE_NAMES[key] ?? language.trim();
}

function buildSystemPrompt(language: string): string {
  const lang = languageName(language);
  return [
    "You explain OpenClaw agent session logs to a human operator reviewing what happened.",
    "",
    `Language: write every run summary and every tool-call explanation in ${lang}, and respond in ${lang}. Do not translate tool names or command text - only the summary and explanation prose must be in ${lang}.`,
    "",
    "Input is a JSON array of \"runs\" (agent turns), each with an agent id/name, a timestamp, and an ordered list of tool calls (name + a truncated command/argument summary).",
    "For each run, write one short, concrete sentence summarizing what that turn accomplished - state what happened, not vague filler.",
    "For each tool call inside a run, write one short sentence explaining what it does in plain language.",
    "Base explanations only on the tool name and command/argument text given - never invent outcomes, numbers, or results that are not shown.",
    "Respond with JSON only, no prose outside the JSON, matching exactly this shape:",
    '{"runs":[{"runId":"<echo the given runId>","summary":"<one sentence>","toolCalls":[{"index":<0-based index into that run\'s toolCalls array>,"explanation":"<one sentence>"}]}]}',
  ].join("\n");
}

type PromptRun = {
  runId: string;
  agent: string;
  ts: string;
  finalStatus?: string;
  toolCalls: Array<{ index: number; toolName: string; meta: string }>;
};

function toPromptRun(run: SessionRunTrace, identity: AgentIdentity): PromptRun {
  const agentLabel = [identity.emoji, identity.name].filter(Boolean).join(" ").trim();
  return {
    runId: run.runId,
    agent: agentLabel ? `${agentLabel} (${run.agentId})` : run.agentId,
    ts: run.ts,
    finalStatus: run.finalStatus,
    toolCalls: run.toolCalls.map((t, index) => ({ index, toolName: t.toolName, meta: truncateMeta(t.meta) })),
  };
}

type ParsedChunkResponse = {
  runs: Array<{
    runId: string;
    summary: string;
    toolCalls: Array<{ index: number; explanation: string }>;
  }>;
};

function parseChunkResponse(text: string): ParsedChunkResponse | undefined {
  // Models sometimes wrap JSON in a fenced code block despite "JSON only" instructions -
  // strip a leading/trailing ``` fence before parsing rather than failing the whole chunk.
  const stripped = text.trim().replace(/^```(?:json)?\n?/i, "").replace(/```$/i, "").trim();
  try {
    const parsed = JSON.parse(stripped);
    if (parsed && Array.isArray(parsed.runs)) return parsed as ParsedChunkResponse;
    return undefined;
  } catch {
    return undefined;
  }
}

export type GenerateExplanationsOptions = {
  language: string;
  model?: string;
  modelFallback?: string;
  chunkSize?: number;
};

export type GenerateExplanationsResult = {
  explainedRuns: ExplainedRun[];
  usage: ExplainUsage;
  warnings: string[];
};

/** Generates natural-language explanations for every run/tool-call in `runs` (already sorted
 * chronologically by the caller). A chunk whose response fails to parse gets a fallback
 * "explanation unavailable" for every run in it plus a warning - one bad chunk does not fail
 * the whole report. */
export async function generateExplanations(
  api: ExplainRuntimeApi,
  runs: SessionRunTrace[],
  agentIdentities: Record<string, AgentIdentity>,
  opts: GenerateExplanationsOptions,
  logger: PluginLogger,
): Promise<GenerateExplanationsResult> {
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunks = chunk(runs, chunkSize);

  const explainedByRunId = new Map<string, ExplainedRun>();
  const usage: ExplainUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
  const warnings: string[] = [];

  for (const [chunkIndex, group] of chunks.entries()) {
    const promptRuns = group.map((r) => toPromptRun(r, agentIdentities[r.agentId] ?? {}));
    const model = opts.model ?? opts.modelFallback;
    const totalToolCalls = group.reduce((sum, r) => sum + r.toolCalls.length, 0);
    const maxTokens = Math.min(
      MAX_TOKENS_PER_CHUNK,
      Math.max(MIN_TOKENS_PER_CHUNK, totalToolCalls * TOKENS_PER_TOOL_CALL + group.length * TOKENS_PER_RUN_SUMMARY),
    );

    let result: Awaited<ReturnType<ExplainRuntimeApi["runtime"]["llm"]["complete"]>>;
    try {
      result = await api.runtime.llm.complete({
        messages: [{ role: "user", content: JSON.stringify({ runs: promptRuns }) }],
        systemPrompt: buildSystemPrompt(opts.language),
        model,
        maxTokens,
        temperature: 0.3,
        purpose: "probe.explain",
      });
    } catch (err) {
      warnings.push(
        `explanation generation failed for chunk ${chunkIndex + 1}/${chunks.length} (${group.length} run(s)): ${(err as Error)?.message ?? String(err)}`,
      );
      logger.warn(`[probe] explain llm.complete failed: ${String((err as Error)?.stack ?? err)}`);
      for (const run of group) explainedByRunId.set(run.runId, fallbackExplainedRun(run));
      continue;
    }

    usage.inputTokens += result.usage.inputTokens ?? 0;
    usage.outputTokens += result.usage.outputTokens ?? 0;
    usage.totalTokens += result.usage.totalTokens ?? 0;
    usage.costUsd += result.usage.costUsd ?? 0;

    const parsed = parseChunkResponse(result.text);
    if (!parsed) {
      warnings.push(`could not parse explanation response for chunk ${chunkIndex + 1}/${chunks.length} - showing raw actions without explanations`);
      logger.warn(`[probe] explain: unparsable response for chunk ${chunkIndex + 1}/${chunks.length}: ${result.text.slice(0, 4000)}`);
      for (const run of group) explainedByRunId.set(run.runId, fallbackExplainedRun(run));
      continue;
    }

    const byRunId = new Map(parsed.runs.map((r) => [r.runId, r]));
    for (const run of group) {
      const match = byRunId.get(run.runId);
      if (!match) {
        warnings.push(`no explanation returned for run ${run.runId} - showing raw actions without explanations`);
        explainedByRunId.set(run.runId, fallbackExplainedRun(run));
        continue;
      }
      const explanationByIndex = new Map(match.toolCalls.map((t) => [t.index, t.explanation]));
      const toolCalls: ExplainedToolCall[] = run.toolCalls.map((t, index) => ({
        ...t,
        // Redact the command text again here (not just for the LLM prompt in
        // `toPromptRun`) so the rendered HTML report never writes un-redacted
        // command metadata to disk. Idempotent over the host's own masking.
        meta: redactCommandText(t.meta),
        explanation: explanationByIndex.get(index) ?? "(no explanation)",
      }));
      explainedByRunId.set(run.runId, { ...run, summary: match.summary ?? "(no summary)", toolCalls });
    }
  }

  const explainedRuns = runs.map((r) => explainedByRunId.get(r.runId) ?? fallbackExplainedRun(r));
  return { explainedRuns, usage, warnings };
}

function fallbackExplainedRun(run: SessionRunTrace): ExplainedRun {
  return {
    ...run,
    summary: "(explanation unavailable)",
    toolCalls: run.toolCalls.map((t) => ({ ...t, meta: redactCommandText(t.meta), explanation: "(no explanation)" })),
  };
}
