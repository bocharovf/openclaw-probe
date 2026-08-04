import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseProbeArgs, runProbeCommand } from "./commands.js";
import { resolvePaths } from "./paths.js";
import { diffResultPath } from "./store.js";
import { DEFAULT_CONFIG } from "./types.js";

vi.mock("./report.js", () => ({
  buildReport: vi.fn(),
}));

import { buildReport } from "./report.js";

const mockedBuildReport = vi.mocked(buildReport);

function emptyReport(overrides: Partial<Awaited<ReturnType<typeof buildReport>>["report"]> = {}) {
  return {
    probe: { name: "x", mode: "start-stop" as const, generated_at: "2026-01-01T00:00:00.000Z" },
    window: { ts_start: "2026-01-01T00:00:00.000Z", ts_end: "2026-01-01T00:01:00.000Z", wall_clock_sec: 60 },
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
    ...overrides,
  };
}

describe("parseProbeArgs", () => {
  it("empty args -> help", () => {
    expect(parseProbeArgs("")).toEqual({ type: "help" });
    expect(parseProbeArgs("   ")).toEqual({ type: "help" });
  });

  it("start requires a name", () => {
    expect(parseProbeArgs("start")).toMatchObject({ type: "error" });
    expect(parseProbeArgs("start my experiment")).toEqual({ type: "start", name: "my experiment" });
  });

  it("start rejects reserved words as the name", () => {
    expect(parseProbeArgs("start start")).toMatchObject({ type: "error" });
    expect(parseProbeArgs("start stop")).toMatchObject({ type: "error" });
    expect(parseProbeArgs("start verbose")).toMatchObject({ type: "error" });
    expect(parseProbeArgs("start list")).toMatchObject({ type: "error" });
    expect(parseProbeArgs("start delete")).toMatchObject({ type: "error" });
  });

  it("start rejects a name that looks like a time range", () => {
    expect(parseProbeArgs("start 2026-08-01T00:00:00Z 2026-08-02T00:00:00Z")).toMatchObject({ type: "error" });
  });

  it("stop with no args", () => {
    expect(parseProbeArgs("stop")).toEqual({ type: "stop" });
  });

  it("stop rejects extra args", () => {
    expect(parseProbeArgs("stop now")).toMatchObject({ type: "error" });
  });

  it("verbose requires a name", () => {
    expect(parseProbeArgs("verbose")).toMatchObject({ type: "error" });
    expect(parseProbeArgs("verbose my run")).toEqual({ type: "verbose", name: "my run" });
  });

  it("list with no args", () => {
    expect(parseProbeArgs("list")).toEqual({ type: "list" });
  });

  it("list rejects extra args", () => {
    expect(parseProbeArgs("list now")).toMatchObject({ type: "error" });
  });

  it("delete requires a name", () => {
    expect(parseProbeArgs("delete")).toMatchObject({ type: "error" });
    expect(parseProbeArgs("delete old baseline")).toEqual({ type: "delete", name: "old baseline" });
  });

  it("two ISO timestamps -> range with no name", () => {
    expect(parseProbeArgs("2026-08-01T00:00:00Z 2026-08-02T00:00:00Z")).toEqual({
      type: "range",
      startIso: "2026-08-01T00:00:00Z",
      endIso: "2026-08-02T00:00:00Z",
    });
  });

  it("two ISO timestamps plus a trailing name -> range with that name", () => {
    expect(parseProbeArgs("2026-08-01T00:00:00Z 2026-08-02T00:00:00Z baseline")).toEqual({
      type: "range",
      startIso: "2026-08-01T00:00:00Z",
      endIso: "2026-08-02T00:00:00Z",
      name: "baseline",
    });
    expect(parseProbeArgs("2026-08-01T00:00:00Z 2026-08-02T00:00:00Z before cache change")).toEqual({
      type: "range",
      startIso: "2026-08-01T00:00:00Z",
      endIso: "2026-08-02T00:00:00Z",
      name: "before cache change",
    });
  });

  it("range rejects a reserved word as the trailing name", () => {
    expect(parseProbeArgs("2026-08-01T00:00:00Z 2026-08-02T00:00:00Z stop")).toMatchObject({ type: "error" });
  });

  it("anything else -> show by name", () => {
    expect(parseProbeArgs("my cool experiment")).toEqual({ type: "show", name: "my cool experiment" });
    expect(parseProbeArgs("baseline")).toEqual({ type: "show", name: "baseline" });
  });

  it("diff requires two comma-separated names", () => {
    expect(parseProbeArgs("diff")).toMatchObject({ type: "error" });
    expect(parseProbeArgs("diff baseline")).toMatchObject({ type: "error" });
    expect(parseProbeArgs("diff baseline after")).toMatchObject({ type: "error" });
  });

  it("diff <name1>, <name2>", () => {
    expect(parseProbeArgs("diff baseline, after")).toEqual({
      type: "diff",
      name1: "baseline",
      name2: "after",
      verbose: false,
    });
  });

  it("diff names may contain spaces on either side of the comma", () => {
    expect(parseProbeArgs("diff before cache change, after cache change")).toEqual({
      type: "diff",
      name1: "before cache change",
      name2: "after cache change",
      verbose: false,
    });
  });

  it("diff rejects an empty name on either side of the comma", () => {
    expect(parseProbeArgs("diff , after")).toMatchObject({ type: "error" });
    expect(parseProbeArgs("diff baseline ,")).toMatchObject({ type: "error" });
  });

  it("diff verbose <name1>, <name2>", () => {
    expect(parseProbeArgs("diff verbose baseline, after")).toEqual({
      type: "diff",
      name1: "baseline",
      name2: "after",
      verbose: true,
    });
  });

  it("diff verbose requires two comma-separated names", () => {
    expect(parseProbeArgs("diff verbose")).toMatchObject({ type: "error" });
    expect(parseProbeArgs("diff verbose baseline after")).toMatchObject({ type: "error" });
  });
});

describe("runProbeCommand", () => {
  let baseDir: string;
  let deps: { config: typeof DEFAULT_CONFIG; paths: ReturnType<typeof resolvePaths>; logger: any };

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "probe-test-"));
    deps = {
      config: DEFAULT_CONFIG,
      paths: resolvePaths(baseDir),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
    mockedBuildReport.mockReset();
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("start then start again is rejected while active", async () => {
    const first = await runProbeCommand("start baseline", deps);
    expect(first).toMatch(/Started measurement "baseline"/);

    await expect(runProbeCommand("start another", deps)).rejects.toThrow(/already active/);
  });

  it("stop with nothing active is rejected", async () => {
    await expect(runProbeCommand("stop", deps)).rejects.toThrow(/No active measurement/);
  });

  it("start then stop builds and saves a report", async () => {
    mockedBuildReport.mockResolvedValue({ report: emptyReport({ probe: { name: "baseline", mode: "start-stop", generated_at: "x" } }), hasAnyAuditEvents: true });

    await runProbeCommand("start baseline", deps);
    const stopped = await runProbeCommand("stop", deps);
    expect(stopped).toMatch(/Stopped measurement "baseline"/);

    const shown = await runProbeCommand("baseline", deps);
    expect(shown).toContain('"name": "baseline"');
  });

  it("range with start >= end is rejected", async () => {
    await expect(
      runProbeCommand("2026-08-02T00:00:00Z 2026-08-01T00:00:00Z", deps),
    ).rejects.toThrow(/must be strictly before/);
    await expect(
      runProbeCommand("2026-08-01T00:00:00Z 2026-08-01T00:00:00Z", deps),
    ).rejects.toThrow(/must be strictly before/);
  });

  it("range with no data in the window is rejected", async () => {
    mockedBuildReport.mockResolvedValue({ report: emptyReport(), hasAnyAuditEvents: false });
    await expect(
      runProbeCommand("2026-08-01T00:00:00Z 2026-08-02T00:00:00Z", deps),
    ).rejects.toThrow(/No data found/);
  });

  it("range without a name is saved and retrievable by its auto-generated name (regression: save/lookup slug mismatch)", async () => {
    // Regression test: handleRange used to slug the saved file with a timestamp-derived
    // scheme different from the slugify(name) that handleShow/handleVerbose look up with, so
    // a range report existed on disk but "/probe <name>" could never find it. Exercising the
    // actual show path (not calling the range command a second time) is the point here.
    const autoName = "2026-08-01T00:00:00Z .. 2026-08-02T00:00:00Z";
    mockedBuildReport.mockResolvedValue({
      report: emptyReport({ probe: { name: autoName, mode: "range", generated_at: "x" } }),
      hasAnyAuditEvents: true,
    });
    const result = await runProbeCommand("2026-08-01T00:00:00Z 2026-08-02T00:00:00Z", deps);
    expect(result).toMatch(/saved/);
    expect(result).toContain(autoName);

    const shown = await runProbeCommand(autoName, deps);
    expect(shown).toContain('"mode": "range"');
    expect(shown).toContain(`"name": "${autoName}"`);

    const verbose = await runProbeCommand(`verbose ${autoName}`, deps);
    expect(verbose).toContain(`PROBE REPORT: "${autoName}"`);
  });

  it("range with an explicit trailing name is saved and retrievable by that name", async () => {
    mockedBuildReport.mockResolvedValue({
      report: emptyReport({ probe: { name: "baseline", mode: "range", generated_at: "x" } }),
      hasAnyAuditEvents: true,
    });
    const result = await runProbeCommand("2026-08-01T00:00:00Z 2026-08-02T00:00:00Z baseline", deps);
    expect(result).toMatch(/Measurement "baseline" saved/);

    const shown = await runProbeCommand("baseline", deps);
    expect(shown).toContain('"name": "baseline"');

    const verbose = await runProbeCommand("verbose baseline", deps);
    expect(verbose).toContain('PROBE REPORT: "baseline"');
  });

  it("show of an unknown name is rejected", async () => {
    await expect(runProbeCommand("does-not-exist", deps)).rejects.toThrow(/No measurement named/);
  });

  it("verbose of an unknown name is rejected", async () => {
    await expect(runProbeCommand("verbose does-not-exist", deps)).rejects.toThrow(/No measurement named/);
  });

  it("verbose of a known name renders an annotated report", async () => {
    mockedBuildReport.mockResolvedValue({ report: emptyReport({ probe: { name: "baseline", mode: "start-stop", generated_at: "x" } }), hasAnyAuditEvents: true });
    await runProbeCommand("start baseline", deps);
    await runProbeCommand("stop", deps);

    const verbose = await runProbeCommand("verbose baseline", deps);
    expect(verbose).toContain('PROBE REPORT: "baseline"');
    expect(verbose).toContain("## Tokens");
  });

  it("list says so when nothing has been saved yet", async () => {
    const result = await runProbeCommand("list", deps);
    expect(result).toMatch(/No saved measurements yet/);
  });

  it("list rejects extra arguments", async () => {
    const result = await runProbeCommand("list now", deps);
    expect(result).toMatch(/takes no arguments/);
  });

  it("list shows saved measurements newest first", async () => {
    mockedBuildReport.mockResolvedValueOnce({
      report: emptyReport({ probe: { name: "first", mode: "start-stop", generated_at: "2026-08-01T00:00:00.000Z" } }),
      hasAnyAuditEvents: true,
    });
    await runProbeCommand("start first", deps);
    await runProbeCommand("stop", deps);

    mockedBuildReport.mockResolvedValueOnce({
      report: emptyReport({ probe: { name: "second", mode: "range", generated_at: "2026-08-02T00:00:00.000Z" } }),
      hasAnyAuditEvents: true,
    });
    await runProbeCommand("start second", deps);
    await runProbeCommand("stop", deps);

    const list = await runProbeCommand("list", deps);
    const lines = list.split("\n");
    expect(lines[0]).toMatch(/2 saved measurements, newest first/);
    expect(lines[1]).toContain('"second"');
    expect(lines[1]).toContain("(range)");
    expect(lines[2]).toContain('"first"');
    expect(lines[2]).toContain("(start-stop)");
  });

  it("delete of an unknown name is rejected", async () => {
    await expect(runProbeCommand("delete does-not-exist", deps)).rejects.toThrow(/No measurement named/);
  });

  it("deletes a saved measurement so it no longer shows up or resolves by name", async () => {
    mockedBuildReport.mockResolvedValueOnce({
      report: emptyReport({ probe: { name: "baseline", mode: "start-stop", generated_at: "2026-08-01T00:00:00.000Z" } }),
      hasAnyAuditEvents: true,
    });
    await runProbeCommand("start baseline", deps);
    await runProbeCommand("stop", deps);
    expect(await runProbeCommand("baseline", deps)).toContain('"name": "baseline"');

    const result = await runProbeCommand("delete baseline", deps);
    expect(result).toBe('Deleted measurement "baseline".');

    await expect(runProbeCommand("baseline", deps)).rejects.toThrow(/No measurement named/);
    await expect(runProbeCommand("verbose baseline", deps)).rejects.toThrow(/No measurement named/);
    expect(await runProbeCommand("list", deps)).toMatch(/No saved measurements yet/);
  });

  it("deleting one measurement does not affect another", async () => {
    mockedBuildReport.mockResolvedValueOnce({
      report: emptyReport({ probe: { name: "keep-me", mode: "start-stop", generated_at: "2026-08-01T00:00:00.000Z" } }),
      hasAnyAuditEvents: true,
    });
    await runProbeCommand("start keep-me", deps);
    await runProbeCommand("stop", deps);

    mockedBuildReport.mockResolvedValueOnce({
      report: emptyReport({ probe: { name: "delete-me", mode: "start-stop", generated_at: "2026-08-02T00:00:00.000Z" } }),
      hasAnyAuditEvents: true,
    });
    await runProbeCommand("start delete-me", deps);
    await runProbeCommand("stop", deps);

    await runProbeCommand("delete delete-me", deps);

    await expect(runProbeCommand("delete-me", deps)).rejects.toThrow(/No measurement named/);
    expect(await runProbeCommand("keep-me", deps)).toContain('"name": "keep-me"');
  });

  describe("diff", () => {
    async function saveMeasurement(name: string, overrides: Partial<ReturnType<typeof emptyReport>> = {}) {
      mockedBuildReport.mockResolvedValueOnce({
        report: emptyReport({ probe: { name, mode: "start-stop", generated_at: "2026-08-01T00:00:00.000Z" }, ...overrides }),
        hasAnyAuditEvents: true,
      });
      await runProbeCommand(`start ${name}`, deps);
      await runProbeCommand("stop", deps);
    }

    it("rejects when name1 does not exist", async () => {
      await saveMeasurement("after");
      await expect(runProbeCommand("diff before, after", deps)).rejects.toThrow(/No measurement named "before"/);
    });

    it("rejects when name2 does not exist", async () => {
      await saveMeasurement("before");
      await expect(runProbeCommand("diff before, after", deps)).rejects.toThrow(/No measurement named "after"/);
    });

    it("rejects a saved file that is not valid JSON", async () => {
      await saveMeasurement("good");
      await mkdir(deps.paths.probeResultsDir, { recursive: true });
      await writeFile(join(deps.paths.probeResultsDir, "broken.json"), "{not valid json");

      await expect(runProbeCommand("diff broken, good", deps)).rejects.toThrow(/could not be read as JSON/);
    });

    it("rejects a saved file with valid JSON but a missing required field", async () => {
      await saveMeasurement("good");
      await mkdir(deps.paths.probeResultsDir, { recursive: true });
      await writeFile(
        join(deps.paths.probeResultsDir, "incomplete.json"),
        JSON.stringify({ probe: { name: "incomplete", mode: "start-stop", generated_at: "x" } }),
      );

      await expect(runProbeCommand("diff incomplete, good", deps)).rejects.toThrow(/missing the expected field/);
    });

    it("computes and saves a diff, printed as JSON", async () => {
      await saveMeasurement("before", { tools_used: { read: 1 }, tokens: { total: 100 } });
      await saveMeasurement("after", { tools_used: { k8s_get_pods: 1 }, tokens: { total: 150 } });

      const result = await runProbeCommand("diff before, after", deps);
      expect(result).toContain("Diff \"before\" -> \"after\" saved to");
      expect(result).toContain('"added": [\n      "k8s_get_pods"\n    ]');

      const savedPath = diffResultPath(deps.paths, "before", "after");
      const saved = JSON.parse(await readFile(savedPath, "utf-8"));
      expect(saved.tools_used).toEqual({ added: ["k8s_get_pods"], removed: ["read"] });
      expect(saved.tokens.total).toEqual({ name1: 100, name2: 150, diff: 50 });
      expect(saved.compared.name1.name).toBe("before");
      expect(saved.compared.name2.name).toBe("after");
    });

    it("diff verbose renders an annotated text report instead of JSON", async () => {
      await saveMeasurement("before");
      await saveMeasurement("after");

      const result = await runProbeCommand("diff verbose before, after", deps);
      expect(result).toContain('PROBE DIFF: "before" (name1) -> "after" (name2)');
      expect(result).not.toContain("```json");
    });

    it("diff result files are excluded from /probe list", async () => {
      await saveMeasurement("before");
      await saveMeasurement("after");
      await runProbeCommand("diff before, after", deps);

      const list = await runProbeCommand("list", deps);
      expect(list).toMatch(/2 saved measurements, newest first/);
      expect(list).not.toContain("before.after.diff");
    });
  });
});
