import { appendFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HookAgentContext, PluginLogger, ProbeConfig } from "./types.js";

// ---- redaction (defense in depth; hook payloads are structured fields, not raw HTTP, but
// system prompts/tool results can still echo back secrets a user pasted into chat) ----

const SENSITIVE_KEY_PATTERNS = [/api[_-]?key/i, /authorization/i, /bearer/i, /token/i, /secret/i, /password/i, /credential/i];
const SECRET_SHAPED_VALUE_PATTERNS = [
  /^sk-[a-zA-Z0-9_-]{20,}$/,
  /^ghp_[a-zA-Z0-9]{20,}$/,
  /^[a-zA-Z0-9]{32,}$/,
  /^eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/,
];

function redact(value: unknown, enabled: boolean, depth = 0): unknown {
  if (!enabled) return value;
  if (depth > 12) return "[MAX_DEPTH]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return SECRET_SHAPED_VALUE_PATTERNS.some((p) => p.test(value)) ? "[REDACTED]" : value;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, enabled, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_PATTERNS.some((p) => p.test(k)) ? "[REDACTED]" : redact(v, enabled, depth + 1);
    }
    return out;
  }
  return value;
}

// ---- capture ----

type InFlight = {
  timestamp: string;
  startedAtMs: number;
  provider: string;
  model: string;
  agentId?: string;
  sessionId?: string;
  request: unknown;
};

export type RawLlmLogEntry = {
  timestamp: string;
  provider: string;
  model: string;
  runId: string;
  sessionId?: string;
  agentId?: string;
  durationMs: number;
  status: "success";
  contextTokenBudget?: number;
  usage?: unknown;
  request: unknown;
  response: unknown;
};

function dayFilePath(llmLogDir: string, date: Date): string {
  return join(llmLogDir, `${date.toISOString().slice(0, 10)}.jsonl`);
}

async function rotateIfNeeded(filePath: string, llmLogDir: string, config: ProbeConfig, logger: PluginLogger): Promise<void> {
  try {
    const stats = await stat(filePath);
    if (stats.size / (1024 * 1024) < config.llmLog.maxFileSizeMb) return;
    const suffix = new Date().toISOString().replace(/[:.]/g, "-");
    const rotatedName = filePath.replace(/\.jsonl$/, `-${suffix}.jsonl`);
    await rename(filePath, rotatedName);
    const files = (await readdir(llmLogDir)).filter((f) => f.endsWith(".jsonl")).sort().reverse();
    for (const old of files.slice(config.llmLog.maxFiles)) {
      await unlink(join(llmLogDir, old)).catch(() => undefined);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      logger.warn(`[probe] llm log rotation check failed: ${String(err)}`);
    }
  }
}

/** Registers llm_input/llm_output hooks that archive full request/response payloads to our
 * own JSONL log (one clean, self-contained JSON object per line - no dependency on the
 * llm-api-logger plugin or its multi-line/anchor-parsed log format).
 *
 * Requires the operator to grant this plugin `hooks.allowConversationAccess: true` (see
 * README) - without it these hooks are simply never invoked by the host. That is treated as
 * a soft failure: core probe metrics (tokens, time, tool/skill usage, errors) come from the
 * audit ledger and trajectory files, not from this log, so probes still work without it. */
export function registerLlmCapture(
  api: { on: (name: string, handler: (event: any, ctx?: HookAgentContext) => void, opts?: { priority?: number }) => void },
  config: ProbeConfig,
  llmLogDir: string,
  logger: PluginLogger,
): void {
  if (!config.llmLog.enabled) return;

  const inFlight = new Map<string, InFlight>();
  let dirReady: Promise<void> | undefined;

  api.on(
    "llm_input",
    (event: any, _ctx?: HookAgentContext) => {
      const runId = event?.runId;
      if (!runId) return;
      inFlight.set(runId, {
        timestamp: new Date().toISOString(),
        startedAtMs: Date.now(),
        provider: event.provider ?? "unknown",
        model: event.model ?? "unknown",
        agentId: event.agentId,
        sessionId: event.sessionId,
        request: {
          systemPrompt: event.systemPrompt,
          prompt: event.prompt,
          historyMessages: event.historyMessages,
          imagesCount: event.imagesCount,
        },
      });
    },
    { priority: 50 },
  );

  api.on(
    "llm_output",
    (event: any, ctx?: HookAgentContext) => {
      const runId = event?.runId;
      if (!runId) return;
      const started = inFlight.get(runId);
      if (!started) return;
      inFlight.delete(runId);

      const entry: RawLlmLogEntry = {
        timestamp: started.timestamp,
        provider: started.provider,
        model: started.model,
        runId,
        sessionId: event.sessionId ?? started.sessionId ?? ctx?.sessionId,
        agentId: started.agentId ?? ctx?.agentId,
        durationMs: Date.now() - started.startedAtMs,
        status: "success",
        contextTokenBudget: event.contextTokenBudget,
        // usage is numeric token counts only (fields like reasoningTokens would otherwise
        // false-positive on the /token/i key pattern below) - never secret, never redacted.
        usage: event.usage,
        request: redact(started.request, config.llmLog.redactSecrets),
        response: redact(
          { assistantTexts: event.assistantTexts, lastAssistant: event.lastAssistant },
          config.llmLog.redactSecrets,
        ),
      };

      const filePath = dayFilePath(llmLogDir, new Date());
      const line = `${JSON.stringify(entry)}\n`;

      dirReady ??= mkdir(llmLogDir, { recursive: true }).then(() => undefined);
      dirReady
        .then(() => rotateIfNeeded(filePath, llmLogDir, config, logger))
        .then(() => appendFile(filePath, line, "utf-8"))
        .catch((err) => logger.warn(`[probe] failed to write raw LLM log: ${String(err)}`));
    },
    { priority: 50 },
  );

  logger.info(`[probe] raw LLM request/response capture armed -> ${llmLogDir}`);
}

/** Scans every `*.jsonl` file in the raw log directory (day files plus any rotated ones,
 * since rotation can split one UTC day across files) and returns entries whose `timestamp`
 * falls inside [tsStartMs, tsEndMs]. Unlike scraping a foreign plugin's log format, every
 * line here is guaranteed-valid single-line JSON because probe wrote it. */
export async function collectRawLlmEntries(
  llmLogDir: string,
  tsStartMs: number,
  tsEndMs: number,
): Promise<RawLlmLogEntry[]> {
  let files: string[];
  try {
    files = (await readdir(llmLogDir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const matched: RawLlmLogEntry[] = [];
  for (const file of files) {
    const text = await readFile(join(llmLogDir, file), "utf-8").catch(() => "");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: RawLlmLogEntry;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const ms = Date.parse(entry.timestamp);
      if (Number.isFinite(ms) && ms >= tsStartMs && ms <= tsEndMs) matched.push(entry);
    }
  }
  matched.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  return matched;
}

/** Writes matched raw entries next to the probe's result file. Returns null if there was
 * nothing to write (no raw log capture configured, or no calls happened to fall in the
 * window - e.g. a probe that only used cached/no-LLM tool calls). */
export async function writeRawLlmEntriesFile(
  destPath: string,
  entries: RawLlmLogEntry[],
): Promise<string | null> {
  if (entries.length === 0) return null;
  const body = entries.map((e) => JSON.stringify(e)).join("\n");
  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(destPath, `${body}\n`, "utf-8");
  return destPath;
}
