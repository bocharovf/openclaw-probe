import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Reads and line-splits a trajectory file, skipping lines that fail to parse (trajectory
 * files are append-only JSONL; a torn last line during an in-flight write is expected and
 * should not fail the whole read). Returns [] if the file does not exist. */
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

export function trajectoryPath(agentsDir: string, agentId: string, sessionId: string): string {
  return join(agentsDir, agentId, "sessions", `${sessionId}.trajectory.jsonl`);
}

/** Finds the `model.completed` trajectory event for a given run - carries token usage and
 * the assistant-message snapshot used to count LLM calls / tool-calling rounds / models. */
export async function findModelCompleted(
  agentsDir: string,
  agentId: string,
  sessionId: string,
  runId: string,
): Promise<Record<string, unknown> | undefined> {
  const lines = await readTrajectoryLines(trajectoryPath(agentsDir, agentId, sessionId));
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
  const lines = await readTrajectoryLines(trajectoryPath(agentsDir, agentId, sessionId));
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

/** Enumerates every completed run's `trace.artifacts` event in a session's trajectory file, in
 * file order (which is chronological - the writer is append-only). This is how `/probe
 * explain` gets an already-ordered, already-human-readable, already-partially-redacted (by
 * OpenClaw itself, e.g. `TOKEN=***`) summary of every tool call in a run, without needing any
 * new capture hook or relying on `messagesSnapshot` (whose per-message timestamps have been
 * observed stale on long sessions - see report.ts's `matchedInWindow` fallback). Provider/model
 * come from the same-`runId` `model.completed` event when `trace.artifacts` itself doesn't
 * carry them (defensive - not yet observed missing, but cheap to guard). */
export async function findAllRunTraces(
  agentsDir: string,
  agentId: string,
  sessionId: string,
): Promise<TrajectoryRunTrace[]> {
  const lines = await readTrajectoryLines(trajectoryPath(agentsDir, agentId, sessionId));
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
