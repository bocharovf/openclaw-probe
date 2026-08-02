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

function trajectoryPath(agentsDir: string, agentId: string, sessionId: string): string {
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
