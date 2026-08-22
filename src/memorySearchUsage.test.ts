import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectMemorySearchEvents,
  registerMemorySearchCapture,
  writeMemorySearchEntriesFile,
  type MemorySearchEventRecord,
} from "./memorySearchUsage.js";

async function waitFor(check: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function readAllEvents(memorySearchLogDir: string): Promise<MemorySearchEventRecord[]> {
  return collectMemorySearchEvents(memorySearchLogDir, 0, Date.now() + 60_000);
}

// Real result shapes, live-confirmed against this host's OpenClaw build (see CLAUDE.md).
function memorySearchResult(results: Array<{ path: string; citation?: string; snippet: string }>) {
  const details = { results, provider: "openai-compatible", model: "paraphrase-multilingual-MiniLM-L12-v2", debug: { hits: results.length } };
  return { content: [{ type: "text", text: JSON.stringify(details) }], details };
}

function memoryGetResult(text: string, path: string) {
  const details = { text, path, from: 1, lines: 25 };
  return { content: [{ type: "text", text: JSON.stringify(details) }], details };
}

describe("registerMemorySearchCapture", () => {
  let memorySearchLogDir: string;
  let handlers: Record<string, (event: any, ctx?: any) => void>;
  const logger = { info: () => {}, warn: () => {}, error: () => {} };

  beforeEach(async () => {
    memorySearchLogDir = join(await mkdtemp(join(tmpdir(), "probe-memlog-")), "memory-search");
    handlers = {};
    const api = {
      on: (name: string, handler: (event: any, ctx?: any) => void) => {
        handlers[name] = handler;
      },
    };
    registerMemorySearchCapture(api, memorySearchLogDir, logger);
  });

  afterEach(async () => {
    await rm(memorySearchLogDir, { recursive: true, force: true });
  });

  it("records a memory_search call with hits, using the structured details object", async () => {
    handlers.after_tool_call(
      {
        toolName: "memory_search",
        params: { query: "minishop" },
        result: memorySearchResult([{ path: "memory/2026-08-07.md", citation: "memory/2026-08-07.md#L1-L25", snippet: "a".repeat(50) }]),
      },
      { sessionKey: "agent:main:telegram:direct:868326324" },
    );

    await waitFor(async () => (await readAllEvents(memorySearchLogDir)).length === 1);
    const [event] = await readAllEvents(memorySearchLogDir);
    expect(event.source).toBe("explicit");
    expect(event.tool).toBe("memory_search");
    expect(event.query).toBe("minishop");
    expect(event.hits).toBe(1);
    expect(event.charsFound).toBe(50);
    expect(event.content).toContain("memory/2026-08-07.md#L1-L25");
  });

  it("records a memory_search call with zero hits", async () => {
    handlers.after_tool_call(
      { toolName: "memory_search", params: { query: "nonexistent" }, result: memorySearchResult([]) },
      { sessionKey: "agent:main:main" },
    );
    await waitFor(async () => (await readAllEvents(memorySearchLogDir)).length === 1);
    const [event] = await readAllEvents(memorySearchLogDir);
    expect(event).toMatchObject({ hits: 0, charsFound: 0, content: "" });
  });

  it("sums chars across multiple results in one search", async () => {
    handlers.after_tool_call(
      {
        toolName: "memory_search",
        params: { query: "x" },
        result: memorySearchResult([
          { path: "a.md", snippet: "1234567890" },
          { path: "b.md", snippet: "abcde" },
        ]),
      },
      { sessionKey: "agent:main:main" },
    );
    await waitFor(async () => (await readAllEvents(memorySearchLogDir)).length === 1);
    const [event] = await readAllEvents(memorySearchLogDir);
    expect(event.hits).toBe(2);
    expect(event.charsFound).toBe(15);
  });

  it("records a memory_get call with text found", async () => {
    handlers.after_tool_call(
      { toolName: "memory_get", params: { path: "memory/2026-08-07.md", from: 1, lines: 25 }, result: memoryGetResult("hello world", "memory/2026-08-07.md") },
      { sessionKey: "agent:main:main" },
    );
    await waitFor(async () => (await readAllEvents(memorySearchLogDir)).length === 1);
    const [event] = await readAllEvents(memorySearchLogDir);
    expect(event.tool).toBe("memory_get");
    expect(event.query).toBe("memory/2026-08-07.md");
    expect(event.hits).toBe(1);
    expect(event.charsFound).toBe(11);
    expect(event.content).toBe("hello world");
  });

  it("records a memory_get call with no text as zero hits", async () => {
    handlers.after_tool_call(
      { toolName: "memory_get", params: { path: "memory/empty.md" }, result: memoryGetResult("", "memory/empty.md") },
      { sessionKey: "agent:main:main" },
    );
    await waitFor(async () => (await readAllEvents(memorySearchLogDir)).length === 1);
    const [event] = await readAllEvents(memorySearchLogDir);
    expect(event).toMatchObject({ hits: 0, charsFound: 0 });
  });

  it("classifies a call as active_memory when sessionKey has the :active-memory: suffix", async () => {
    handlers.after_tool_call(
      { toolName: "memory_search", params: { query: "wings" }, result: memorySearchResult([]) },
      { sessionKey: "agent:main:telegram:direct:868326324:active-memory:845bf794172a", sessionId: "active-memory-mt1dgoit-0802091d" },
    );
    await waitFor(async () => (await readAllEvents(memorySearchLogDir)).length === 1);
    const [event] = await readAllEvents(memorySearchLogDir);
    expect(event.source).toBe("active_memory");
  });

  it("classifies a call as active_memory from sessionId alone when sessionKey is missing", async () => {
    handlers.after_tool_call(
      { toolName: "memory_search", params: { query: "wings" }, result: memorySearchResult([]) },
      { sessionId: "active-memory-mt1dgoit-0802091d" },
    );
    await waitFor(async () => (await readAllEvents(memorySearchLogDir)).length === 1);
    const [event] = await readAllEvents(memorySearchLogDir);
    expect(event.source).toBe("active_memory");
  });

  it("classifies a normal session's call as explicit", async () => {
    handlers.after_tool_call(
      { toolName: "memory_search", params: { query: "wings" }, result: memorySearchResult([]) },
      { sessionKey: "agent:main:probe-test-1", sessionId: "c8075603-a775-481b-9a04-f67391087bfc" },
    );
    await waitFor(async () => (await readAllEvents(memorySearchLogDir)).length === 1);
    const [event] = await readAllEvents(memorySearchLogDir);
    expect(event.source).toBe("explicit");
  });

  it("falls back to parsing content[0].text when result.details is absent", async () => {
    const details = { results: [{ path: "a.md", snippet: "hi" }] };
    handlers.after_tool_call(
      { toolName: "memory_search", params: { query: "x" }, result: { content: [{ type: "text", text: JSON.stringify(details) }] } },
      { sessionKey: "agent:main:main" },
    );
    await waitFor(async () => (await readAllEvents(memorySearchLogDir)).length === 1);
    const [event] = await readAllEvents(memorySearchLogDir);
    expect(event.hits).toBe(1);
    expect(event.charsFound).toBe(2);
  });

  it("does not throw and records a zeroed event when the result cannot be parsed at all", async () => {
    handlers.after_tool_call(
      { toolName: "memory_search", params: { query: "x" }, result: { content: [{ type: "text", text: "not json" }] } },
      { sessionKey: "agent:main:main" },
    );
    await waitFor(async () => (await readAllEvents(memorySearchLogDir)).length === 1);
    const [event] = await readAllEvents(memorySearchLogDir);
    expect(event).toMatchObject({ hits: 0, charsFound: 0, content: "" });
  });

  it("ignores non-memory tool calls", async () => {
    handlers.after_tool_call({ toolName: "read", params: { path: "x" }, result: { content: [{ type: "text", text: "ok" }] } }, {});
    await new Promise((r) => setTimeout(r, 100));
    expect(await readAllEvents(memorySearchLogDir)).toEqual([]);
  });

  it("ignores errored calls", async () => {
    handlers.after_tool_call({ toolName: "memory_search", params: { query: "x" }, error: "timeout" }, {});
    await new Promise((r) => setTimeout(r, 100));
    expect(await readAllEvents(memorySearchLogDir)).toEqual([]);
  });

  it("works with no ctx at all (defaults to explicit, never throws)", async () => {
    handlers.after_tool_call({ toolName: "memory_search", params: { query: "x" }, result: memorySearchResult([]) }, undefined);
    await waitFor(async () => (await readAllEvents(memorySearchLogDir)).length === 1);
    const [event] = await readAllEvents(memorySearchLogDir);
    expect(event.source).toBe("explicit");
  });
});

describe("collectMemorySearchEvents", () => {
  let memorySearchLogDir: string;

  beforeEach(async () => {
    memorySearchLogDir = await mkdtemp(join(tmpdir(), "probe-memcollect-"));
  });

  afterEach(async () => {
    await rm(memorySearchLogDir, { recursive: true, force: true });
  });

  it("returns an empty array when the log directory does not exist", async () => {
    expect(await collectMemorySearchEvents(join(memorySearchLogDir, "missing"), 0, Date.now())).toEqual([]);
  });

  it("filters events by window", async () => {
    await mkdir(memorySearchLogDir, { recursive: true });
    const lines: MemorySearchEventRecord[] = [
      { observedAt: "2026-08-01T00:00:00.000Z", source: "explicit", tool: "memory_search", query: "a", hits: 1, charsFound: 10, content: "x" },
      { observedAt: "2026-07-01T00:00:00.000Z", source: "explicit", tool: "memory_search", query: "b", hits: 1, charsFound: 10, content: "x" },
    ];
    await writeFile(join(memorySearchLogDir, "2026-08-01.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const events = await collectMemorySearchEvents(
      memorySearchLogDir,
      Date.parse("2026-08-01T00:00:00.000Z"),
      Date.parse("2026-08-01T01:00:00.000Z"),
    );
    expect(events).toHaveLength(1);
    expect(events[0].query).toBe("a");
  });

  it("skips unparsable lines instead of throwing", async () => {
    await mkdir(memorySearchLogDir, { recursive: true });
    await writeFile(
      join(memorySearchLogDir, "2026-08-01.jsonl"),
      `not json\n${JSON.stringify({ observedAt: "2026-08-01T00:00:00.000Z", source: "explicit", tool: "memory_search", query: "a", hits: 0, charsFound: 0, content: "" })}\n`,
    );
    const events = await collectMemorySearchEvents(memorySearchLogDir, Date.parse("2026-08-01T00:00:00Z"), Date.parse("2026-08-01T01:00:00Z"));
    expect(events).toHaveLength(1);
  });

  it("sorts events chronologically across multiple day files", async () => {
    await mkdir(memorySearchLogDir, { recursive: true });
    await writeFile(
      join(memorySearchLogDir, "2026-08-02.jsonl"),
      JSON.stringify({ observedAt: "2026-08-02T01:00:00.000Z", source: "explicit", tool: "memory_search", query: "second", hits: 0, charsFound: 0, content: "" }) + "\n",
    );
    await writeFile(
      join(memorySearchLogDir, "2026-08-01.jsonl"),
      JSON.stringify({ observedAt: "2026-08-01T23:00:00.000Z", source: "explicit", tool: "memory_search", query: "first", hits: 0, charsFound: 0, content: "" }) + "\n",
    );
    const events = await collectMemorySearchEvents(memorySearchLogDir, Date.parse("2026-08-01T00:00:00Z"), Date.parse("2026-08-03T00:00:00Z"));
    expect(events.map((e) => e.query)).toEqual(["first", "second"]);
  });
});

describe("writeMemorySearchEntriesFile", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "probe-memwrite-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("returns null and writes nothing for an empty entry list", async () => {
    const dest = join(baseDir, "results", "baseline.memory-search.jsonl");
    expect(await writeMemorySearchEntriesFile(dest, [])).toBeNull();
  });

  it("creates the parent directory and writes one JSON object per line", async () => {
    const dest = join(baseDir, "results", "baseline.memory-search.jsonl");
    const entries: MemorySearchEventRecord[] = [
      { observedAt: "2026-08-01T00:00:00.000Z", source: "active_memory", tool: "memory_search", query: "wings", hits: 1, charsFound: 34, content: "[memory/x.md]\nLemon pepper wings" },
    ];
    const written = await writeMemorySearchEntriesFile(dest, entries);
    expect(written).toBe(dest);
    const text = await readFile(dest, "utf-8");
    expect(JSON.parse(text.trim())).toEqual(entries[0]);
  });
});
