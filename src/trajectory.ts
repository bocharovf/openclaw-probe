import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Trajectory event readers.
 *
 * OpenClaw 2026.10.10 (7dc3350) moved agent trajectory data out of the per-session
 * `<base>/agents/<agentId>/sessions/<sessionId>.trajectory.jsonl` sidecar files and into a
 * per-agent SQLite database `<base>/agents/<agentId>/agent/openclaw-agent.sqlite`
 * (table `trajectory_runtime_events`). Each row's `event_json` column is exactly the JSON
 * object that used to occupy one line of the `.trajectory.jsonl` file, so the parsing
 * contract below is unchanged - only the source of those objects differs.
 *
 * The readers here are therefore SQLite-first: they read the per-agent database with a
 * short-lived read-only connection and only fall back to the legacy sidecar file when the
 * database/table/session has no data (a pre-2026.10.10 host, or a unit test that writes
 * sidecar files). This keeps the function signatures (`agentsDir, agentId, sessionId, ...`)
 * and return shapes identical, so `report.ts` / `sessionGraph.ts` / `explainLlm.ts` callers
 * do not change, and it never depends on the temporary `.trajectory.jsonl` files a host
 * might still have lying around from an older build.
 */

const TRAJECTORY_EVENTS_TABLE = "trajectory_runtime_events";

/** Reads and line-splits a legacy trajectory sidecar file, skipping lines that fail to
 * parse (trajectory files are append-only JSONL; a torn last line during an in-flight write
 * is expected and should not fail the whole read). Returns [] if the file does not exist.
 * Only used as a fallback for pre-2026.10.10 hosts; see the module doc comment. */
async function readTrajectoryLines(path: string): Promise<Record<string, unknown>[]> {
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // torn line, skip
    }
  }
  return out;
}

/** Legacy (pre-2026.10.10) per-session trajectory sidecar path. Kept for the file fallback. */
export function trajectoryPath(agentsDir: string, agentId: string, sessionId: string): string {
  return join(agentsDir, agentId, "sessions", `${sessionId}.trajectory.jsonl`);
}

/** Path to the per-agent SQLite database holding trajectory runtime events. `agentsDir` is
 * `join(baseDir, "agents")`, so this resolves to
 * `join(baseDir, "agents", agentId, "agent", "openclaw-agent.sqlite")` - the same database
 * the Gateway writes - without needing `baseDir` itself. */
function trajectoryDbPath(agentsDir: string, agentId: string): string {
  return join(agentsDir, agentId, "agent", "openclaw-agent.sqlite");
}

/** Reads a session's trajectory runtime events from the per-agent SQLite database via a
 * short-lived read-only connection, returning the parsed `event_json` payloads in `seq`
 * order (chronological - the writer is append-only). The database is in WAL mode and held
 * open by the Gateway; a read-only connection is used so probe never writes to or locks it.
 * Returns [] when the database, table, or session is missing or unreadable, so the caller
 * can fall back to the legacy sidecar file. */
function readTrajectoryEventsFromSqlite(
  agentsDir: string,
  agentId: string,
  sessionId: string,
): Record<string, unknown>[] {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(trajectoryDbPath(agentsDir, agentId), { readOnly: true });
  } catch {
    return []; // no database for this agent (e.g. pre-2026.10.10 host) - not an error
  }
  try {
    const rows = db
      .prepare(`SELECT event_json FROM ${TRAJECTORY_EVENTS_TABLE} WHERE session_id = ? ORDER BY seq`)
      .all(sessionId) as Array<{ event_json: string }>;
    const out: Record<string, unknown>[] = [];
    for (const row of rows) {
      try {
        out.push(JSON.parse(row.event_json));
      } catch {
        // a malformed row is skipped, same as a torn file line
      }
    }
    return out;
  } catch {
    return []; // table missing / query failed - treat as "no SQLite data"
  } finally {
    try {
      db.close();
    } catch {
      // close is best-effort on a short-lived read-only connection
    }
  }
}

/** Primary reader: SQLite `trajectory_runtime_events` (OpenClaw 2026.10.10+), falling back
 * to the legacy `.trajectory.jsonl` sidecar only when SQLite has no data for the session. */
async function readTrajectoryEvents(
  agentsDir: string,
  agentId: string,
  sessionId: string,
): Promise<Record<string, unknown>[]> {
  const fromSqlite = readTrajectoryEventsFromSqlite(agentsDir, agentId, sessionId);
  if (fromSqlite.length > 0) return fromSqlite;
  return readTrajectoryLines(trajectoryPath(agentsDir, agentId, sessionId));
}

/** Finds the `model.completed` trajectory event for a given run - carries token usage and
 * the assistant-message snapshot used to count LLM calls / tool-calling rounds / models. */
export async function findModelCompleted(
  agentsDir: string,
  agentId: string,
  sessionId: string,
  runId: string,
): Promise<Record<string, unknown> | undefined> {
  const lines = await readTrajectoryEvents(agentsDir, agentId, sessionId);
  return lines.find((d) => d.type === "model.completed" && d.runId === runId);
}

/** Finds the `context.compiled` event inside the `session.started` .. `session.ended` block
 * for a given run - carries the compiled system prompt size used for context-size stats.
 * Main-agent runs report systemPrompt as an object with `originalChars`; native sub-agent
 * runs (which skip most bootstrap-context machinery) report it as a plain compiled string. */
export async function findContextCompiledNear(
  agentsDir: string,
  agentId: string,
  sessionId: string,
  runId: string,
): Promise<Record<string, unknown> | undefined> {
  const lines = await readTrajectoryEvents(agentsDir, agentId, sessionId);
  let block: Record<string, unknown>[] = [];
  for (const d of lines) {
    block.push(d);
    if (d.type === "session.ended" && d.runId === runId) {
      const found = block.find((e) => e.type === "context.compiled");
      if (found) return found;
      block = [];
    } else if (d.type === "session.started") {
      block = [d];
    }
  }
  return undefined;
}

export type TrajectoryToolMeta = {
  toolName: string;
  meta: string;
};

export type TrajectoryRunTrace = {
  runId: string;
  ts: string;
  provider?: string;
  model?: string;
  finalStatus?: string;
  aborted?: boolean;
  toolMetas: TrajectoryToolMeta[];
};

/** Enumerates every completed run's `trace.artifacts` event in a session's trajectory, in
 * chronological order. This is how `/probe explain` gets an already-ordered,
 * already-human-readable, already-partially-redacted (by OpenClaw itself, e.g. `TOKEN=***`)
 * summary of every tool call in a run, without needing any new capture hook or relying on
 * `messagesSnapshot` (whose per-message timestamps have been observed stale on long
 * sessions - see report.ts's `matchedInWindow` fallback). Provider/model come from the
 * same-`runId` `model.completed` event when `trace.artifacts` itself doesn't carry them
 * (defensive - not yet observed missing, but cheap to guard). */
export async function findAllRunTraces(
  agentsDir: string,
  agentId: string,
  sessionId: string,
): Promise<TrajectoryRunTrace[]> {
  const lines = await readTrajectoryEvents(agentsDir, agentId, sessionId);
  const modelByRunId = new Map<string, { provider?: string; model?: string }>();
  for (const d of lines) {
    if (d.type !== "model.completed" || typeof d.runId !== "string") continue;
    modelByRunId.set(d.runId, {
      provider: typeof d.provider === "string" ? d.provider : undefined,
      model: typeof d.modelId === "string" ? d.modelId : undefined,
    });
  }

  const traces: TrajectoryRunTrace[] = [];
  for (const d of lines) {
    if (d.type !== "trace.artifacts" || typeof d.runId !== "string" || typeof d.ts !== "string") continue;
    const data = (d.data ?? {}) as Record<string, unknown>;
    const rawToolMetas = Array.isArray(data.toolMetas) ? (data.toolMetas as Array<Record<string, unknown>>) : [];
    const toolMetas: TrajectoryToolMeta[] = rawToolMetas
      .filter((t) => typeof t.toolName === "string")
      .map((t) => ({ toolName: t.toolName as string, meta: typeof t.meta === "string" ? t.meta : "" }));
    const fromModel = modelByRunId.get(d.runId);
    traces.push({
      runId: d.runId,
      ts: d.ts,
      provider: (typeof d.provider === "string" ? d.provider : undefined) ?? fromModel?.provider,
      model: (typeof d.modelId === "string" ? d.modelId : undefined) ?? fromModel?.model,
      finalStatus: typeof data.finalStatus === "string" ? data.finalStatus : undefined,
      aborted: typeof data.aborted === "boolean" ? data.aborted : undefined,
      toolMetas,
    });
  }
  return traces;
}

export function extractSystemPromptChars(contextCompiled: Record<string, unknown> | undefined): number | undefined {
  if (!contextCompiled) return undefined;
  const data = contextCompiled.data as { systemPrompt?: unknown } | undefined;
  const sp = data?.systemPrompt;
  if (sp && typeof sp === "object") {
    const chars = (sp as { originalChars?: number }).originalChars;
    return typeof chars === "number" ? chars : undefined;
  }
  if (typeof sp === "string") return sp.length;
  return undefined;
}
