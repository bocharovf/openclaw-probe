import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractSystemPromptChars, findAllRunTraces, findContextCompiledNear, findModelCompleted } from "./trajectory.js";

describe("trajectory readers", () => {
  let agentsDir: string;

  beforeEach(async () => {
    agentsDir = await mkdtemp(join(tmpdir(), "probe-traj-"));
  });

  afterEach(async () => {
    await rm(agentsDir, { recursive: true, force: true });
  });

  async function writeTrajectory(agentId: string, sessionId: string, lines: unknown[]) {
    const dir = join(agentsDir, agentId, "sessions");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${sessionId}.trajectory.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }

  it("returns undefined for a missing trajectory file", async () => {
    expect(await findModelCompleted(agentsDir, "main", "nope", "run-1")).toBeUndefined();
  });

  it("finds model.completed by runId", async () => {
    await writeTrajectory("main", "sess-1", [
      { type: "model.completed", runId: "run-1", data: { usage: { total: 10 } } },
      { type: "model.completed", runId: "run-2", data: { usage: { total: 99 } } },
    ]);
    const mc = await findModelCompleted(agentsDir, "main", "sess-1", "run-1");
    expect((mc?.data as any).usage.total).toBe(10);
  });

  it("skips torn/unparsable trailing lines", async () => {
    const dir = join(agentsDir, "main", "sessions");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "sess-1.trajectory.jsonl"),
      '{"type":"model.completed","runId":"run-1","data":{"usage":{"total":5}}}\n{"type":"model.comp',
    );
    const mc = await findModelCompleted(agentsDir, "main", "sess-1", "run-1");
    expect((mc?.data as any).usage.total).toBe(5);
  });

  it("finds context.compiled inside the session.started..session.ended block for a run", async () => {
    await writeTrajectory("main", "sess-1", [
      { type: "session.started" },
      { type: "context.compiled", data: { systemPrompt: { originalChars: 1234 } } },
      { type: "session.ended", runId: "run-1" },
      { type: "session.started" },
      { type: "context.compiled", data: { systemPrompt: { originalChars: 999 } } },
      { type: "session.ended", runId: "run-2" },
    ]);
    const cc1 = await findContextCompiledNear(agentsDir, "main", "sess-1", "run-1");
    expect(extractSystemPromptChars(cc1)).toBe(1234);
    const cc2 = await findContextCompiledNear(agentsDir, "main", "sess-1", "run-2");
    expect(extractSystemPromptChars(cc2)).toBe(999);
  });

  it("extractSystemPromptChars falls back to string length for sub-agent runs", () => {
    const cc = { data: { systemPrompt: "12345" } };
    expect(extractSystemPromptChars(cc)).toBe(5);
  });

  it("extractSystemPromptChars returns undefined when there is nothing usable", () => {
    expect(extractSystemPromptChars(undefined)).toBeUndefined();
    expect(extractSystemPromptChars({ data: {} })).toBeUndefined();
  });

  describe("findAllRunTraces", () => {
    it("returns [] for a missing trajectory file", async () => {
      expect(await findAllRunTraces(agentsDir, "main", "nope")).toEqual([]);
    });

    it("extracts toolMetas and status per run, in file order", async () => {
      await writeTrajectory("main", "sess-1", [
        { type: "model.completed", runId: "run-1", provider: "deepseek", modelId: "deepseek-v4-pro" },
        {
          type: "trace.artifacts",
          runId: "run-1",
          ts: "2026-09-24T15:56:05.775Z",
          data: {
            finalStatus: "success",
            aborted: false,
            toolMetas: [
              { toolName: "read", meta: "from ~/.openclaw/workspace/skills/aiops-incident/SKILL.md" },
              { toolName: "sessions_spawn", meta: "task Incident: ..." },
            ],
          },
        },
        { type: "model.completed", runId: "run-2", provider: "deepseek", modelId: "deepseek-v4-pro" },
        {
          type: "trace.artifacts",
          runId: "run-2",
          ts: "2026-09-24T15:57:01.539Z",
          data: { finalStatus: "success", toolMetas: [{ toolName: "subagents", meta: "" }] },
        },
      ]);

      const traces = await findAllRunTraces(agentsDir, "main", "sess-1");
      expect(traces).toHaveLength(2);
      expect(traces[0]).toMatchObject({
        runId: "run-1",
        ts: "2026-09-24T15:56:05.775Z",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        finalStatus: "success",
        aborted: false,
      });
      expect(traces[0].toolMetas).toEqual([
        { toolName: "read", meta: "from ~/.openclaw/workspace/skills/aiops-incident/SKILL.md" },
        { toolName: "sessions_spawn", meta: "task Incident: ..." },
      ]);
      expect(traces[1].toolMetas).toEqual([{ toolName: "subagents", meta: "" }]);
    });

    it("falls back to the same-runId model.completed event for provider/model when trace.artifacts omits them", async () => {
      await writeTrajectory("diag-k8s", "sess-2", [
        { type: "model.completed", runId: "run-1", provider: "deepseek", modelId: "deepseek-v4-pro" },
        { type: "trace.artifacts", runId: "run-1", ts: "2026-09-24T15:56:52.277Z", data: { toolMetas: [] } },
      ]);
      const [trace] = await findAllRunTraces(agentsDir, "diag-k8s", "sess-2");
      expect(trace.provider).toBe("deepseek");
      expect(trace.model).toBe("deepseek-v4-pro");
    });

    it("handles a run with no tool calls (empty toolMetas)", async () => {
      await writeTrajectory("main", "sess-3", [
        { type: "trace.artifacts", runId: "run-1", ts: "2026-09-24T15:56:05.775Z", data: { toolMetas: [] } },
      ]);
      const [trace] = await findAllRunTraces(agentsDir, "main", "sess-3");
      expect(trace.toolMetas).toEqual([]);
    });

    it("skips malformed toolMetas entries instead of throwing", async () => {
      await writeTrajectory("main", "sess-4", [
        {
          type: "trace.artifacts",
          runId: "run-1",
          ts: "2026-09-24T15:56:05.775Z",
          data: { toolMetas: [{ toolName: "read", meta: "ok" }, { meta: "missing toolName" }, "not an object"] },
        },
      ]);
      const [trace] = await findAllRunTraces(agentsDir, "main", "sess-4");
      expect(trace.toolMetas).toEqual([{ toolName: "read", meta: "ok" }]);
    });
  });
});
