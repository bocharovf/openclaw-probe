import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectRawLlmEntries, registerLlmCapture, writeRawLlmEntriesFile } from "./llmCapture.js";
import { DEFAULT_CONFIG } from "./types.js";

async function waitFor(check: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("llm capture", () => {
  let llmLogDir: string;
  let handlers: Record<string, (event: any, ctx?: any) => void>;
  const logger = { info: () => {}, warn: () => {}, error: () => {} };

  beforeEach(async () => {
    llmLogDir = join(await mkdtemp(join(tmpdir(), "probe-llmlog-")), "llm-api");
    handlers = {};
  });

  afterEach(async () => {
    await rm(llmLogDir, { recursive: true, force: true });
  });

  function register(config = DEFAULT_CONFIG) {
    const api = {
      on: (name: string, handler: (event: any, ctx?: any) => void) => {
        handlers[name] = handler;
      },
    };
    registerLlmCapture(api, config, llmLogDir, logger);
  }

  /** Registers a fresh, independent instance (own handlers, own closures - registerLlmCapture
   * is called again just as OpenClaw does live). Used to prove correlation survives across
   * separate registerLlmCapture() calls via the module-level Map, not any one call's closure
   * state - see the regression test below. */
  function registerInstance(config = DEFAULT_CONFIG) {
    const instanceHandlers: Record<string, (event: any, ctx?: any) => void> = {};
    const api = {
      on: (name: string, handler: (event: any, ctx?: any) => void) => {
        instanceHandlers[name] = handler;
      },
    };
    registerLlmCapture(api, config, llmLogDir, logger);
    return instanceHandlers;
  }

  it("does nothing when llmLog.enabled is false", async () => {
    register({ ...DEFAULT_CONFIG, llmLog: { ...DEFAULT_CONFIG.llmLog, enabled: false } });
    expect(handlers.llm_input).toBeUndefined();
    expect(handlers.llm_output).toBeUndefined();
  });

  it("pairs llm_input/llm_output by runId and writes one JSON line", async () => {
    register();
    handlers.llm_input({
      runId: "run-1",
      provider: "anthropic",
      model: "claude-x",
      systemPrompt: "you are helpful",
      prompt: "hi",
    });
    handlers.llm_output({ runId: "run-1", sessionId: "sess-1", usage: { total: 42 } }, { agentId: "main" });

    const tsStart = Date.now() - 60_000;
    const tsEnd = Date.now() + 60_000;
    await waitFor(async () => (await collectRawLlmEntries(llmLogDir, tsStart, tsEnd)).length === 1);

    const entries = await collectRawLlmEntries(llmLogDir, tsStart, tsEnd);
    expect(entries[0].runId).toBe("run-1");
    expect(entries[0].provider).toBe("anthropic");
    expect((entries[0].usage as any).total).toBe(42);
    expect((entries[0].request as any).prompt).toBe("hi");
  });

  it("does not redact token-count fields in usage (regression: /token/i key pattern false-positive)", async () => {
    register();
    handlers.llm_input({ runId: "run-tokens", provider: "p", model: "m" });
    handlers.llm_output({
      runId: "run-tokens",
      usage: { input: 100, output: 20, reasoningTokens: 15, cacheReadInputTokens: 50, total: 120 },
    });

    const tsStart = Date.now() - 60_000;
    const tsEnd = Date.now() + 60_000;
    await waitFor(async () => (await collectRawLlmEntries(llmLogDir, tsStart, tsEnd)).length === 1);

    const entries = await collectRawLlmEntries(llmLogDir, tsStart, tsEnd);
    expect(entries[0].usage).toEqual({ input: 100, output: 20, reasoningTokens: 15, cacheReadInputTokens: 50, total: 120 });
  });

  it("ignores llm_output with no matching llm_input", async () => {
    register();
    handlers.llm_output({ runId: "orphan" });
    await new Promise((r) => setTimeout(r, 100));
    const entries = await collectRawLlmEntries(llmLogDir, 0, Date.now() + 1000);
    expect(entries).toEqual([]);
  });

  it("redacts secret-shaped values in the captured payload", async () => {
    register();
    handlers.llm_input({
      runId: "run-2",
      provider: "openai",
      model: "gpt-x",
      systemPrompt: "sk-abcdefghijklmnopqrstuvwxyz123456",
    });
    handlers.llm_output({ runId: "run-2" });

    const tsStart = Date.now() - 60_000;
    const tsEnd = Date.now() + 60_000;
    await waitFor(async () => (await collectRawLlmEntries(llmLogDir, tsStart, tsEnd)).length === 1);

    const entries = await collectRawLlmEntries(llmLogDir, tsStart, tsEnd);
    expect((entries[0].request as any).systemPrompt).toBe("[REDACTED]");
  });

  it("collectRawLlmEntries filters by window", async () => {
    register();
    handlers.llm_input({ runId: "run-3", provider: "p", model: "m" });
    handlers.llm_output({ runId: "run-3" });
    await waitFor(async () => (await collectRawLlmEntries(llmLogDir, 0, Date.now() + 60_000)).length === 1);

    const before = await collectRawLlmEntries(llmLogDir, 0, Date.now() - 10_000);
    expect(before).toEqual([]);
  });

  it(
    "regression: correlates llm_input and llm_output across separate registerLlmCapture() " +
      "calls (root cause of live undercounting - only 1/15 llm_calls captured for a run with " +
      "parallel sub-agents, because OpenClaw calls register() on this plugin multiple times " +
      "within one still-running Gateway process - observed live as repeated '[probe] armed' " +
      "log lines with a constant PID - and a Map created inside registerLlmCapture() was only " +
      "visible to listeners added by that one call)",
    async () => {
      // Instance A's listeners see llm_input for this call; instance B's listeners (from a
      // separate registerLlmCapture() call, as OpenClaw does live around sub-agent spawns) see
      // the matching llm_output. Only the module-level Map, not either call's own closure
      // state, can bridge that gap.
      const instanceA = registerInstance();
      instanceA.llm_input({ runId: "run-cross-instance", provider: "deepseek", model: "deepseek-v4-pro", prompt: "diagnose the pods" });

      const instanceB = registerInstance();
      instanceB.llm_output({ runId: "run-cross-instance", sessionId: "diag-state-session", usage: { total: 500 } });

      const tsStart = Date.now() - 60_000;
      const tsEnd = Date.now() + 60_000;
      await waitFor(async () => (await collectRawLlmEntries(llmLogDir, tsStart, tsEnd)).length === 1);

      const entries = await collectRawLlmEntries(llmLogDir, tsStart, tsEnd);
      expect(entries[0].runId).toBe("run-cross-instance");
      expect((entries[0].request as any).prompt).toBe("diagnose the pods");
      expect((entries[0].usage as any).total).toBe(500);
    },
  );

  it("does not double-capture a duplicate llm_output for the same runId", async () => {
    register();
    handlers.llm_input({ runId: "run-dup", provider: "p", model: "m" });
    handlers.llm_output({ runId: "run-dup" });
    handlers.llm_output({ runId: "run-dup" }); // duplicate - should be ignored, not double-written

    const tsStart = Date.now() - 60_000;
    const tsEnd = Date.now() + 60_000;
    await waitFor(async () => (await collectRawLlmEntries(llmLogDir, tsStart, tsEnd)).length >= 1);
    await new Promise((r) => setTimeout(r, 100)); // let any (unwanted) second write land

    const entries = await collectRawLlmEntries(llmLogDir, tsStart, tsEnd);
    expect(entries).toHaveLength(1);
  });

  it("multiple registrations for the same event still write exactly one entry (delete-on-read dedupe)", async () => {
    // If OpenClaw calls register() N times for the process, each call adds its own pair of
    // listeners, so one real llm_output fires N handler invocations. The first to see the
    // module-level Map entry consumes it (delete-on-read); the rest must no-op, not throw and
    // not write duplicate lines.
    const instanceA = registerInstance();
    const instanceB = registerInstance();
    const instanceC = registerInstance();

    instanceA.llm_input({ runId: "run-triple", provider: "p", model: "m" });
    // Simulate the host fanning the same llm_output event out to every registered listener.
    for (const instance of [instanceA, instanceB, instanceC]) {
      instance.llm_output({ runId: "run-triple" });
    }

    const tsStart = Date.now() - 60_000;
    const tsEnd = Date.now() + 60_000;
    await waitFor(async () => (await collectRawLlmEntries(llmLogDir, tsStart, tsEnd)).length >= 1);
    await new Promise((r) => setTimeout(r, 100));

    const entries = await collectRawLlmEntries(llmLogDir, tsStart, tsEnd);
    expect(entries).toHaveLength(1);
  });
});

describe("writeRawLlmEntriesFile", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "probe-rawwrite-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns null and writes nothing when there are no entries", async () => {
    const path = join(dir, "out.jsonl");
    const result = await writeRawLlmEntriesFile(path, []);
    expect(result).toBeNull();
  });

  it("writes one JSON line per entry", async () => {
    const path = join(dir, "out.jsonl");
    const entries = [
      { timestamp: "t1", provider: "p", model: "m", runId: "r1", durationMs: 1, status: "success" as const, request: {}, response: {} },
      { timestamp: "t2", provider: "p", model: "m", runId: "r2", durationMs: 1, status: "success" as const, request: {}, response: {} },
    ];
    const result = await writeRawLlmEntriesFile(path, entries);
    expect(result).toBe(path);

    const text = await readFile(path, "utf-8");
    expect(text.trim().split("\n")).toHaveLength(2);
  });

  it("creates the destination directory if it does not exist yet", async () => {
    // Regression test: buildReport() writes the raw entries file before the caller has a
    // chance to mkdir the results directory (that happens in store.writeResult, which runs
    // afterward) - found live when /probe stop threw ENOENT on a fresh install.
    const path = join(dir, "nested", "results", "out.jsonl");
    const entries = [
      { timestamp: "t1", provider: "p", model: "m", runId: "r1", durationMs: 1, status: "success" as const, request: {}, response: {} },
    ];
    const result = await writeRawLlmEntriesFile(path, entries);
    expect(result).toBe(path);
    const text = await readFile(path, "utf-8");
    expect(text.trim().split("\n")).toHaveLength(1);
  });
});
