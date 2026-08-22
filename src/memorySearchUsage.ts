import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HookAgentContext, MemorySearchSource, PluginLogger } from "./types.js";

/**
 * Memory-search usage detection, mirroring `skillUsage.ts`'s approach: watch `after_tool_call`
 * for `memory_search`/`memory_get` (the two tools OpenClaw's built-in `memory-core` backend
 * registers - see docs/concepts/active-memory.md's `toolsAllow` table) and log what each call
 * found. No config or operator opt-in needed - `after_tool_call` isn't gated by
 * `hooks.allowConversationAccess`, and this simply logs zero events (so the report's
 * `memory_search` section reads all-zero, never errors) when memory search isn't configured
 * on the host at all, or when the Active Memory plugin isn't installed/enabled.
 *
 * The interesting part is telling apart *why* a call happened, since both paths call the
 * exact same tools:
 *
 * - The Active Memory plugin runs a blocking recall sub-agent before the main reply, for
 *   eligible interactive sessions (see docs/concepts/active-memory.md). Confirmed live via
 *   `openclaw audit --json`: its `memory_search`/`memory_get` calls carry a distinct
 *   `sessionKey` (the main session's key with a `:active-memory:<hash>` suffix appended) and
 *   `sessionId` (`active-memory-<...>`) - not the main session's own id/key.
 * - Everything else is the agent's own explicit call inside its normal session (for example
 *   following AGENTS.md's "run memory_search before answering about prior work" guidance).
 *
 * `after_tool_call`'s `ctx` (agentId/sessionId/sessionKey) is exactly what's needed to tell
 * these apart, and was already available (just unused) on the same hook `skillUsage.ts` uses.
 */

const MEMORY_TOOL_NAMES = new Set(["memory_search", "memory_get"]);

export type MemorySearchEventRecord = {
  observedAt: string;
  source: MemorySearchSource;
  tool: "memory_search" | "memory_get";
  /** The search query (memory_search) or the path read (memory_get). */
  query: string;
  /** Result count: matched chunks for memory_search, 1/0 for memory_get depending on whether
   * it returned any text. */
  hits: number;
  /** Total characters of content found - see `content` for the text itself. */
  charsFound: number;
  /** Full found content (joined snippets for memory_search, the raw text for memory_get) -
   * kept only for the sidecar file; report aggregation uses charsFound/hits, not this. */
  content: string;
};

function classifySource(ctx: HookAgentContext | undefined): MemorySearchSource {
  if (ctx?.sessionKey?.includes(":active-memory:")) return "active_memory";
  if (ctx?.sessionId?.startsWith("active-memory-")) return "active_memory";
  return "explicit";
}

/** Same generic tool-result text extraction as `skillUsage.ts` (kept as a local copy - both
 * files are meant to stay self-contained hook handlers, and the helper is a few lines). */
function extractResultText(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === "object" && (block as { type?: unknown }).type === "text"
          ? String((block as { text?: unknown }).text ?? "")
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  const text = (result as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

/** Both memory_search and memory_get results carry their structured data twice: as a
 * JSON-stringified blob in `content[0].text` (what the model reads) and, live-confirmed on
 * this host's OpenClaw build, as an already-parsed `details` object alongside it. Prefer
 * `details` (no parsing needed); fall back to parsing `content[0].text` in case a future/older
 * build omits `details` - either way this must never throw on an unexpected shape, since a
 * parsing surprise here must not break the hook for every other tool call. */
function extractDetails(result: unknown): Record<string, unknown> | undefined {
  const details = (result as { details?: unknown } | undefined)?.details;
  if (details && typeof details === "object") return details as Record<string, unknown>;
  const text = extractResultText(result);
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function summarizeMemorySearch(details: Record<string, unknown> | undefined): { hits: number; charsFound: number; content: string } {
  const results = Array.isArray(details?.results) ? (details!.results as Array<Record<string, unknown>>) : [];
  let charsFound = 0;
  const parts: string[] = [];
  for (const r of results) {
    const snippet = typeof r.snippet === "string" ? r.snippet : "";
    charsFound += snippet.length;
    const label = typeof r.citation === "string" ? r.citation : typeof r.path === "string" ? r.path : "unknown";
    parts.push(`[${label}]\n${snippet}`);
  }
  return { hits: results.length, charsFound, content: parts.join("\n\n---\n\n") };
}

function summarizeMemoryGet(details: Record<string, unknown> | undefined): { hits: number; charsFound: number; content: string } {
  const text = typeof details?.text === "string" ? details.text : "";
  return { hits: text ? 1 : 0, charsFound: text.length, content: text };
}

function dayFilePath(memorySearchLogDir: string, date: Date): string {
  return join(memorySearchLogDir, `${date.toISOString().slice(0, 10)}.jsonl`);
}

/** Registers the after_tool_call detector and appends one JSONL line per memory_search/
 * memory_get call to `<memorySearchLogDir>/<date>.jsonl`. Same footing as skill detection: no
 * config toggle, no `hooks.allowConversationAccess` requirement. */
export function registerMemorySearchCapture(
  api: { on: (name: string, handler: (event: any, ctx?: HookAgentContext) => void, opts?: { priority?: number }) => void },
  memorySearchLogDir: string,
  logger: PluginLogger,
): void {
  api.on(
    "after_tool_call",
    (event: any, ctx?: HookAgentContext) => {
      const toolName = event?.toolName;
      if (!toolName || !MEMORY_TOOL_NAMES.has(toolName) || event?.error) return;

      const params = (event?.params ?? {}) as Record<string, unknown>;
      const details = extractDetails(event?.result);
      const source = classifySource(ctx);

      let query: string;
      let summary: { hits: number; charsFound: number; content: string };
      if (toolName === "memory_search") {
        query = typeof params.query === "string" ? params.query : "";
        summary = summarizeMemorySearch(details);
      } else {
        const path = typeof params.path === "string" ? params.path : typeof details?.path === "string" ? (details.path as string) : "";
        query = path;
        summary = summarizeMemoryGet(details);
      }

      const record: MemorySearchEventRecord = {
        observedAt: new Date().toISOString(),
        source,
        tool: toolName as "memory_search" | "memory_get",
        query,
        hits: summary.hits,
        charsFound: summary.charsFound,
        content: summary.content,
      };
      const filePath = dayFilePath(memorySearchLogDir, new Date());
      const line = `${JSON.stringify(record)}\n`;

      mkdir(memorySearchLogDir, { recursive: true })
        .then(() => appendFile(filePath, line, "utf-8"))
        .catch((err) => logger.warn(`[probe] failed to write memory search log: ${String(err)}`));
    },
    { priority: 50 },
  );

  logger.info(`[probe] memory search usage detection armed -> ${memorySearchLogDir}`);
}

/** Windowed, individual memory-search events from probe's own log, filtered by `observedAt`.
 * Returns `[]` for a missing/empty log directory - that just means no memory_search/memory_get
 * call has been observed yet (expected when memory search isn't configured at all). */
export async function collectMemorySearchEvents(
  memorySearchLogDir: string,
  tsStartMs: number,
  tsEndMs: number,
): Promise<MemorySearchEventRecord[]> {
  let files: string[];
  try {
    files = (await readdir(memorySearchLogDir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }

  const events: MemorySearchEventRecord[] = [];
  for (const file of files) {
    const text = await readFile(join(memorySearchLogDir, file), "utf-8").catch(() => "");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event: MemorySearchEventRecord;
      try {
        event = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const observedMs = Date.parse(event.observedAt);
      if (!Number.isFinite(observedMs) || observedMs < tsStartMs || observedMs > tsEndMs) continue;
      events.push(event);
    }
  }
  events.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  return events;
}

/** Writes matched memory-search entries (full content included) next to the probe's result
 * file, same pattern as `llmCapture.ts`'s `writeRawLlmEntriesFile`. Returns null if there was
 * nothing to write. */
export async function writeMemorySearchEntriesFile(
  destPath: string,
  entries: MemorySearchEventRecord[],
): Promise<string | null> {
  if (entries.length === 0) return null;
  const body = entries.map((e) => JSON.stringify(e)).join("\n");
  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(destPath, `${body}\n`, "utf-8");
  return destPath;
}
