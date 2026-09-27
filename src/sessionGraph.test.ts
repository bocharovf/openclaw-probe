import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSessionGraph,
  resolveAgentIdentity,
  resolveConfiguredAgentIds,
  resolveRootSession,
} from "./sessionGraph.js";
import type { ExplainRuntimeApi, SessionStoreEntryLike } from "./types.js";

function fakeApi(storesByAgent: Record<string, Record<string, SessionStoreEntryLike>>): ExplainRuntimeApi {
  return {
    runtime: {
      agent: {
        session: {
          listSessionEntries: ({ agentId }: { agentId: string }) => {
            const store = storesByAgent[agentId];
            if (!store) throw new Error(`no store for ${agentId}`);
            return Object.entries(store).map(([sessionKey, entry]) => ({ sessionKey, entry }));
          },
        },
      },
      llm: { complete: async () => ({ text: "", provider: "x", model: "y", usage: {} }) },
    },
  };
}

describe("resolveConfiguredAgentIds", () => {
  it("always includes main and adds agents.list[].id", () => {
    const ids = resolveConfiguredAgentIds({ agents: { list: [{ id: "diag-k8s" }, { id: "diag-db" }] } });
    expect(ids.sort()).toEqual(["diag-db", "diag-k8s", "main"]);
  });

  it("dedupes and tolerates missing/malformed config", () => {
    expect(resolveConfiguredAgentIds({ agents: { list: [{ id: "main" }] } })).toEqual(["main"]);
    expect(resolveConfiguredAgentIds({})).toEqual(["main"]);
    expect(resolveConfiguredAgentIds(undefined)).toEqual(["main"]);
    expect(resolveConfiguredAgentIds({ agents: { list: "not an array" } })).toEqual(["main"]);
  });
});

describe("resolveAgentIdentity", () => {
  it("finds identity from agents.list[]", () => {
    const config = { agents: { list: [{ id: "diag-k8s", identity: { name: "Kubectl", emoji: "☸️" } }] } };
    expect(resolveAgentIdentity(config, "diag-k8s")).toEqual({ name: "Kubectl", emoji: "☸️" });
  });

  it("falls back to agents.defaults.identity for main", () => {
    const config = { agents: { defaults: { identity: { name: "AIOps", emoji: "⚙️" } } } };
    expect(resolveAgentIdentity(config, "main")).toEqual({ name: "AIOps", emoji: "⚙️" });
  });

  it("returns {} when nothing is found, without throwing", () => {
    expect(resolveAgentIdentity({}, "diag-k8s")).toEqual({});
    expect(resolveAgentIdentity(undefined, "main")).toEqual({});
  });
});

describe("resolveRootSession", () => {
  const api = fakeApi({
    main: {
      "agent:main:hook:alertmanager:x": { sessionId: "root-session-id" },
    },
    "diag-k8s": {
      "agent:diag-k8s:subagent:abc": { sessionId: "child-session-id", spawnedBy: "agent:main:hook:alertmanager:x" },
    },
  });

  it("resolves by exact sessionKey", async () => {
    const found = await resolveRootSession(api, ["main", "diag-k8s"], "agent:main:hook:alertmanager:x", {});
    expect(found).toMatchObject({ agentId: "main", sessionId: "root-session-id" });
  });

  it("resolves by bare sessionId", async () => {
    const found = await resolveRootSession(api, ["main", "diag-k8s"], "child-session-id", {});
    expect(found).toMatchObject({ agentId: "diag-k8s", sessionId: "child-session-id" });
  });

  it("returns null when the ref matches nothing", async () => {
    expect(await resolveRootSession(api, ["main", "diag-k8s"], "does-not-exist", {})).toBeNull();
  });

  it("uses the fallback (invoking session) when no ref is given", async () => {
    const found = await resolveRootSession(api, ["main", "diag-k8s"], undefined, {
      sessionKey: "agent:main:hook:alertmanager:x",
    });
    expect(found).toMatchObject({ sessionId: "root-session-id" });
  });

  it("falls back to raw agentId+sessionId when the session isn't in any store listing yet", async () => {
    const found = await resolveRootSession(api, ["main", "diag-k8s"], undefined, {
      agentId: "main",
      sessionId: "brand-new-session",
    });
    expect(found).toEqual({ agentId: "main", sessionId: "brand-new-session", sessionKey: "brand-new-session", entry: {} });
  });

  it("returns null when neither ref nor a usable fallback is given", async () => {
    expect(await resolveRootSession(api, ["main", "diag-k8s"], undefined, {})).toBeNull();
  });
});

describe("buildSessionGraph", () => {
  let agentsDir: string;

  beforeEach(async () => {
    agentsDir = await mkdtemp(join(tmpdir(), "probe-sessiongraph-"));
  });

  afterEach(async () => {
    await rm(agentsDir, { recursive: true, force: true });
  });

  async function writeTrajectory(agentId: string, sessionId: string, runTs: string, toolMetas: unknown[]) {
    const dir = join(agentsDir, agentId, "sessions");
    await mkdir(dir, { recursive: true });
    const lines = [{ type: "trace.artifacts", runId: "run-1", ts: runTs, data: { finalStatus: "success", toolMetas } }];
    await writeFile(join(dir, `${sessionId}.trajectory.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }

  it("returns a single node with its run traces when the root has no children", async () => {
    await writeTrajectory("main", "root-id", "2026-09-24T15:56:05.775Z", [{ toolName: "read", meta: "SKILL.md" }]);
    const api = fakeApi({ main: { "agent:main:x": { sessionId: "root-id" } } });

    const nodes = await buildSessionGraph(api, agentsDir, ["main"], {
      agentId: "main",
      sessionId: "root-id",
      sessionKey: "agent:main:x",
      entry: {},
    });

    expect(nodes).toHaveLength(1);
    expect(nodes[0].runs).toHaveLength(1);
    expect(nodes[0].runs[0].toolCalls).toEqual([{ toolName: "read", meta: "SKILL.md" }]);
  });

  it("discovers a child session spawned from the root, across a different agent id", async () => {
    await writeTrajectory("main", "root-id", "2026-09-24T15:56:05.775Z", [{ toolName: "sessions_spawn", meta: "task ..." }]);
    await writeTrajectory("diag-k8s", "child-id", "2026-09-24T15:56:52.277Z", [{ toolName: "k8s_get_pods", meta: "" }]);

    const api = fakeApi({
      main: { "agent:main:x": { sessionId: "root-id" } },
      "diag-k8s": { "agent:diag-k8s:subagent:abc": { sessionId: "child-id", spawnedBy: "agent:main:x", estimatedCostUsd: 0.08 } },
    });

    const nodes = await buildSessionGraph(api, agentsDir, ["main", "diag-k8s"], {
      agentId: "main",
      sessionId: "root-id",
      sessionKey: "agent:main:x",
      entry: {},
    });

    expect(nodes).toHaveLength(2);
    const child = nodes.find((n) => n.agentId === "diag-k8s");
    expect(child?.spawnedBy).toBe("agent:main:x");
    expect(child?.costUsd).toBe(0.08);
    expect(child?.runs[0].toolCalls).toEqual([{ toolName: "k8s_get_pods", meta: "" }]);
  });

  it("discovers grandchildren transitively (multi-level spawn chain)", async () => {
    await writeTrajectory("main", "root-id", "2026-09-24T15:56:05.775Z", []);
    await writeTrajectory("diag-k8s", "child-id", "2026-09-24T15:56:52.277Z", []);
    await writeTrajectory("diag-verifier", "grandchild-id", "2026-09-24T15:58:00.000Z", []);

    const api = fakeApi({
      main: { "agent:main:x": { sessionId: "root-id" } },
      "diag-k8s": { "agent:diag-k8s:subagent:abc": { sessionId: "child-id", spawnedBy: "agent:main:x" } },
      "diag-verifier": {
        "agent:diag-verifier:subagent:def": { sessionId: "grandchild-id", spawnedBy: "agent:diag-k8s:subagent:abc" },
      },
    });

    const nodes = await buildSessionGraph(api, agentsDir, ["main", "diag-k8s", "diag-verifier"], {
      agentId: "main",
      sessionId: "root-id",
      sessionKey: "agent:main:x",
      entry: {},
    });

    expect(nodes.map((n) => n.agentId).sort()).toEqual(["diag-k8s", "diag-verifier", "main"]);
  });

  it("does not include unrelated sessions spawned by something else", async () => {
    await writeTrajectory("main", "root-id", "2026-09-24T15:56:05.775Z", []);
    await writeTrajectory("diag-k8s", "unrelated-id", "2026-01-01T00:00:00.000Z", []);

    const api = fakeApi({
      main: { "agent:main:x": { sessionId: "root-id" } },
      "diag-k8s": { "agent:diag-k8s:subagent:other": { sessionId: "unrelated-id", spawnedBy: "agent:main:some-other-session" } },
    });

    const nodes = await buildSessionGraph(api, agentsDir, ["main", "diag-k8s"], {
      agentId: "main",
      sessionId: "root-id",
      sessionKey: "agent:main:x",
      entry: {},
    });

    expect(nodes).toHaveLength(1);
  });

  it("respects maxDepth", async () => {
    await writeTrajectory("main", "root-id", "2026-09-24T15:56:05.775Z", []);
    await writeTrajectory("diag-k8s", "child-id", "2026-09-24T15:56:52.277Z", []);

    const api = fakeApi({
      main: { "agent:main:x": { sessionId: "root-id" } },
      "diag-k8s": { "agent:diag-k8s:subagent:abc": { sessionId: "child-id", spawnedBy: "agent:main:x" } },
    });

    const nodes = await buildSessionGraph(
      api,
      agentsDir,
      ["main", "diag-k8s"],
      { agentId: "main", sessionId: "root-id", sessionKey: "agent:main:x", entry: {} },
      0,
    );

    expect(nodes).toHaveLength(1);
  });
});
