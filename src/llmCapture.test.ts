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
