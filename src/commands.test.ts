import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseProbeArgs, runProbeCommand } from "./commands.js";
import { resolvePaths } from "./paths.js";
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

  it("two ISO timestamps -> range", () => {
    expect(parseProbeArgs("2026-08-01T00:00:00Z 2026-08-02T00:00:00Z")).toEqual({
      type: "range",
      startIso: "2026-08-01T00:00:00Z",
      endIso: "2026-08-02T00:00:00Z",
    });
  });

  it("anything else -> show by name", () => {
    expect(parseProbeArgs("my cool experiment")).toEqual({ type: "show", name: "my cool experiment" });
    expect(parseProbeArgs("baseline")).toEqual({ type: "show", name: "baseline" });
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

  it("range with data is saved and retrievable", async () => {
    mockedBuildReport.mockResolvedValue({
      report: emptyReport({ probe: { name: "2026-08-01T00:00:00Z .. 2026-08-02T00:00:00Z", mode: "range", generated_at: "x" } }),
      hasAnyAuditEvents: true,
    });
    const result = await runProbeCommand("2026-08-01T00:00:00Z 2026-08-02T00:00:00Z", deps);
    expect(result).toMatch(/saved/);

    const shown = await runProbeCommand("2026-08-01T00:00:00Z 2026-08-02T00:00:00Z", deps);
    expect(shown).toContain('"mode": "range"');
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
});
