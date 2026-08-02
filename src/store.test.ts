import { access, mkdtemp, rm, writeFile as writeFileRaw } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePaths } from "./paths.js";
import { deleteResult, listResults, rawRequestsPath, readResult, writeResult } from "./store.js";
import type { ProbeReport } from "./types.js";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function report(name: string, mode: ProbeReport["probe"]["mode"], generatedAt: string): ProbeReport {
  return {
    probe: { name, mode, generated_at: generatedAt },
    window: { ts_start: generatedAt, ts_end: generatedAt, wall_clock_sec: 0 },
    sessions: { session_ids: [], agents_used: {} },
    time: { agent_active_sec: 0, llm_latency_sec: 0, tool_exec_sec: 0 },
    iterations: { agent_runs: 0, llm_calls: 0, tool_calling_rounds: 0, tool_calls_total: 0 },
    models_used: {},
    tokens: {},
    context: { system_prompt_chars_samples: [], system_prompt_chars_avg: null },
    tools_used: {},
    plugins_used: [],
    skills_used: {},
    errors: {
      tool_call_errors: { count: 0, by_tool: {}, by_status: {}, by_code: {} },
      agent_run_errors: { count: 0, by_status: {}, by_code: {} },
    },
    llm_api_log: { entries_captured: 0, file: null },
    events: [],
    warnings: [],
  };
}

describe("listResults", () => {
  let baseDir: string;
  let paths: ReturnType<typeof resolvePaths>;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "probe-list-"));
    paths = resolvePaths(baseDir);
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("returns an empty list when nothing has been saved yet", async () => {
    const { summaries, total } = await listResults(paths, 50);
    expect(summaries).toEqual([]);
    expect(total).toBe(0);
  });

  it("sorts by generated_at, newest first", async () => {
    await writeResult(paths, "oldest", report("oldest", "start-stop", "2026-08-01T00:00:00.000Z"));
    await writeResult(paths, "newest", report("newest", "start-stop", "2026-08-03T00:00:00.000Z"));
    await writeResult(paths, "middle", report("middle", "range", "2026-08-02T00:00:00.000Z"));

    const { summaries, total } = await listResults(paths, 50);
    expect(total).toBe(3);
    expect(summaries.map((s) => s.name)).toEqual(["newest", "middle", "oldest"]);
    expect(summaries[1].mode).toBe("range");
  });

  it("caps at the given limit but reports the true total", async () => {
    for (let i = 0; i < 5; i++) {
      await writeResult(paths, `probe-${i}`, report(`probe-${i}`, "start-stop", `2026-08-01T00:00:0${i}.000Z`));
    }
    const { summaries, total } = await listResults(paths, 3);
    expect(total).toBe(5);
    expect(summaries).toHaveLength(3);
    // newest first: probe-4, probe-3, probe-2
    expect(summaries.map((s) => s.name)).toEqual(["probe-4", "probe-3", "probe-2"]);
  });

  it("ignores .rawrequests.jsonl sidecar files", async () => {
    await writeResult(paths, "baseline", report("baseline", "start-stop", "2026-08-01T00:00:00.000Z"));
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(paths.probeResultsDir, { recursive: true });
    await writeFile(join(paths.probeResultsDir, "baseline.rawrequests.jsonl"), '{"not":"a report"}\n');

    const { summaries, total } = await listResults(paths, 50);
    expect(total).toBe(1);
    expect(summaries[0].name).toBe("baseline");
  });

  it("skips corrupt/unreadable result files instead of throwing", async () => {
    await writeResult(paths, "good", report("good", "start-stop", "2026-08-01T00:00:00.000Z"));
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(paths.probeResultsDir, { recursive: true });
    await writeFile(join(paths.probeResultsDir, "corrupt.json"), "{not valid json");

    const { summaries, total } = await listResults(paths, 50);
    expect(total).toBe(1);
    expect(summaries[0].name).toBe("good");
  });
});

describe("deleteResult", () => {
  let baseDir: string;
  let paths: ReturnType<typeof resolvePaths>;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "probe-delete-"));
    paths = resolvePaths(baseDir);
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("returns false and deletes nothing when the name does not exist", async () => {
    const deleted = await deleteResult(paths, "does-not-exist");
    expect(deleted).toBe(false);
  });

  it("deletes the report file and returns true", async () => {
    await writeResult(paths, "baseline", report("baseline", "start-stop", "2026-08-01T00:00:00.000Z"));
    const deleted = await deleteResult(paths, "baseline");
    expect(deleted).toBe(true);
    expect(await readResult(paths, "baseline")).toBeNull();
  });

  it("also deletes the raw-requests sidecar file if present", async () => {
    await writeResult(paths, "baseline", report("baseline", "start-stop", "2026-08-01T00:00:00.000Z"));
    const rawPath = rawRequestsPath(paths, "baseline");
    await writeFileRaw(rawPath, '{"some":"entry"}\n');
    expect(await exists(rawPath)).toBe(true);

    await deleteResult(paths, "baseline");
    expect(await exists(rawPath)).toBe(false);
  });

  it("does not throw when the report exists but the sidecar file does not", async () => {
    await writeResult(paths, "baseline", report("baseline", "start-stop", "2026-08-01T00:00:00.000Z"));
    await expect(deleteResult(paths, "baseline")).resolves.toBe(true);
  });

  it("does not affect other saved measurements", async () => {
    await writeResult(paths, "keep-me", report("keep-me", "start-stop", "2026-08-01T00:00:00.000Z"));
    await writeResult(paths, "delete-me", report("delete-me", "start-stop", "2026-08-02T00:00:00.000Z"));

    await deleteResult(paths, "delete-me");

    expect(await readResult(paths, "delete-me")).toBeNull();
    expect(await readResult(paths, "keep-me")).not.toBeNull();
  });
});
