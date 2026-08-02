import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractSystemPromptChars, findContextCompiledNear, findModelCompleted } from "./trajectory.js";

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
});
