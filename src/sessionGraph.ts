import { findAllRunTraces, type TrajectoryRunTrace } from "./trajectory.js";
import type { AgentIdentity, ExplainRuntimeApi, SessionNode, SessionStoreEntryLike } from "./types.js";

/**
 * Discovers the sessions involved in one `/probe explain` scenario - the given root session
 * plus every sub-agent session spawned from it (transitively), by walking `spawnedBy` chains
 * in each agent's session store. No new capture mechanism needed: `spawnedBy` is already
 * written by the host for every sub-agent run (confirmed live by inspecting a real
 * `agents/<agentId>/sessions/sessions.json` entry - `spawnedBy` holds the parent's
 * `sessionKey` verbatim), and `trajectory.ts`'s `findAllRunTraces` already gives an ordered,
 * human-readable tool-call summary per run without needing to parse `messagesSnapshot`.
 */

export type DiscoveredSession = {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  spawnedBy?: string;
  entry: SessionStoreEntryLike;
};

async function collectAllSessions(api: ExplainRuntimeApi, agentIds: string[]): Promise<DiscoveredSession[]> {
  const out: DiscoveredSession[] = [];
  for (const agentId of agentIds) {
    let entries: Iterable<{ sessionKey: string; entry: SessionStoreEntryLike }>;
    try {
      entries = api.runtime.agent.session.listSessionEntries({ agentId });
    } catch {
      continue; // agent id not configured / no session store yet - not fatal, just nothing to add
    }
    for (const { sessionKey, entry } of entries) {
      const sessionId = typeof entry?.sessionId === "string" ? entry.sessionId : undefined;
      if (!sessionId) continue;
      out.push({
        agentId,
        sessionId,
        sessionKey,
        spawnedBy: typeof entry?.spawnedBy === "string" ? entry.spawnedBy : undefined,
        entry,
      });
    }
  }
  return out;
}

/** Every agent id worth searching for sessions: the implicit `main` agent plus every configured
 * agent id. OpenClaw 2026.10.10 stores configured agents in `agents.entries` (an object keyed
 * by agent id); older hosts use `agents.list[]` with an `id` field on each entry. Both shapes
 * are read loosely (see types.ts's `SessionStoreEntryLike` doc comment for why) - OpenClaw
 * does not export a narrow public config type to plugins. */
export function resolveConfiguredAgentIds(config: unknown): string[] {
  const agents = (
    config as { agents?: { list?: Array<{ id?: unknown }>; entries?: Record<string, unknown> } } | undefined
  )?.agents;
  const ids = new Set<string>(["main"]);
  const entries = agents?.entries;
  if (entries && typeof entries === "object") {
    for (const id of Object.keys(entries)) {
      if (id) ids.add(id);
    }
  }
  const list = agents?.list;
  if (Array.isArray(list)) {
    for (const a of list) {
      if (typeof a?.id === "string" && a.id) ids.add(a.id);
    }
  }
  return [...ids];
}

/** Best-effort display identity (name/emoji) for an agent id, read from
 * `agents.entries[id].identity` (OpenClaw 2026.10.10+), `agents.list[].identity`
 * (older hosts), or `agents.defaults.identity` for `main` (which is usually not itself listed
 * as a configured entry). Returns `{}` rather than throwing when nothing is found - callers
 * fall back to the bare agent id, this is cosmetic only. */
export function resolveAgentIdentity(config: unknown, agentId: string): AgentIdentity {
  const agents = (
    config as {
      agents?: {
        list?: Array<{ id?: unknown; identity?: { name?: unknown; emoji?: unknown } }>;
        entries?: Record<string, { identity?: { name?: unknown; emoji?: unknown } }>;
      };
    } | undefined
  )?.agents;

  const entryIdentity = agents?.entries?.[agentId]?.identity;
  if (entryIdentity) {
    return {
      name: typeof entryIdentity.name === "string" ? entryIdentity.name : undefined,
      emoji: typeof entryIdentity.emoji === "string" ? entryIdentity.emoji : undefined,
    };
  }

  const list = agents?.list;
  const fromList = Array.isArray(list) ? list.find((a) => a?.id === agentId)?.identity : undefined;
  if (fromList) {
    return {
      name: typeof fromList.name === "string" ? fromList.name : undefined,
      emoji: typeof fromList.emoji === "string" ? fromList.emoji : undefined,
    };
  }

  if (agentId === "main") {
    const defaultsIdentity = (config as { agents?: { defaults?: { identity?: { name?: unknown; emoji?: unknown } } } } | undefined)
      ?.agents?.defaults?.identity;
    if (defaultsIdentity) {
      return {
        name: typeof defaultsIdentity.name === "string" ? defaultsIdentity.name : undefined,
        emoji: typeof defaultsIdentity.emoji === "string" ? defaultsIdentity.emoji : undefined,
      };
    }
  }
  return {};
}

export type SessionRefFallback = {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
};

/** Resolves a `/probe explain` argument (a bare sessionId, a full sessionKey, or nothing - use
 * the invoking session) to the session it identifies. Searches every configured agent's
 * session store since the ref alone doesn't say which agent owns it. Returns `null` when
 * nothing matches (including an empty fallback), so the caller can give a clear "not found"
 * error instead of a confusing crash deeper in the pipeline. */
export async function resolveRootSession(
  api: ExplainRuntimeApi,
  agentIds: string[],
  ref: string | undefined,
  fallback: SessionRefFallback,
): Promise<DiscoveredSession | null> {
  const all = await collectAllSessions(api, agentIds);
  const trimmedRef = ref?.trim();

  if (trimmedRef) {
    return all.find((s) => s.sessionKey === trimmedRef) ?? all.find((s) => s.sessionId === trimmedRef) ?? null;
  }

  if (fallback.sessionKey) {
    const match = all.find((s) => s.sessionKey === fallback.sessionKey);
    if (match) return match;
  }
  if (fallback.sessionId) {
    const match = all.find((s) => s.sessionId === fallback.sessionId);
    if (match) return match;
  }
  // Not found in any session store listing yet (e.g. a session still mid-run) - agentId +
  // sessionId are still enough to read its trajectory file directly.
  if (fallback.agentId && fallback.sessionId) {
    return {
      agentId: fallback.agentId,
      sessionId: fallback.sessionId,
      sessionKey: fallback.sessionKey ?? fallback.sessionId,
      entry: {},
    };
  }
  return null;
}

function toSessionRunTraces(
  agentId: string,
  sessionId: string,
  sessionKey: string,
  traces: TrajectoryRunTrace[],
): SessionNode["runs"] {
  return traces.map((t) => ({
    agentId,
    sessionId,
    sessionKey,
    runId: t.runId,
    ts: t.ts,
    provider: t.provider,
    model: t.model,
    finalStatus: t.finalStatus,
    aborted: t.aborted,
    toolCalls: t.toolMetas,
  }));
}

/** Builds the full session graph for a `/probe explain` scenario: the root session plus every
 * descendant discovered by walking `spawnedBy` chains (breadth-first, `maxDepth` deep - no
 * hardcoded assumption about the operator's `maxSpawnDepth`), each with its ordered run
 * traces already extracted from its trajectory file. A session that appears more than once
 * (should not happen, but `spawnedBy` cycles are not structurally impossible) is only
 * included once. */
export async function buildSessionGraph(
  api: ExplainRuntimeApi,
  agentsDir: string,
  agentIds: string[],
  root: DiscoveredSession,
  maxDepth = 6,
): Promise<SessionNode[]> {
  const all = await collectAllSessions(api, agentIds);
  const childrenBySpawnedBy = new Map<string, DiscoveredSession[]>();
  for (const s of all) {
    if (!s.spawnedBy) continue;
    const list = childrenBySpawnedBy.get(s.spawnedBy) ?? [];
    list.push(s);
    childrenBySpawnedBy.set(s.spawnedBy, list);
  }

  const nodes: SessionNode[] = [];
  const seen = new Set<string>();
  const queue: Array<{ session: DiscoveredSession; depth: number }> = [{ session: root, depth: 0 }];

  while (queue.length) {
    const { session, depth } = queue.shift()!;
    if (seen.has(session.sessionKey)) continue;
    seen.add(session.sessionKey);

    const traces = await findAllRunTraces(agentsDir, session.agentId, session.sessionId);
    nodes.push({
      agentId: session.agentId,
      sessionId: session.sessionId,
      sessionKey: session.sessionKey,
      spawnedBy: session.spawnedBy,
      costUsd: typeof session.entry.estimatedCostUsd === "number" ? session.entry.estimatedCostUsd : undefined,
      tokens: {
        input: typeof session.entry.inputTokens === "number" ? session.entry.inputTokens : undefined,
        output: typeof session.entry.outputTokens === "number" ? session.entry.outputTokens : undefined,
        total: typeof session.entry.totalTokens === "number" ? session.entry.totalTokens : undefined,
      },
      runs: toSessionRunTraces(session.agentId, session.sessionId, session.sessionKey, traces),
    });

    if (depth >= maxDepth) continue;
    for (const child of childrenBySpawnedBy.get(session.sessionKey) ?? []) {
      queue.push({ session: child, depth: depth + 1 });
    }
  }

  return nodes;
}
