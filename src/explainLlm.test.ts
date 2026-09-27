import { describe, expect, it, vi } from "vitest";
import { generateExplanations, redactCommandText } from "./explainLlm.js";
import type { ExplainRuntimeApi, SessionRunTrace } from "./types.js";

const logger = { info: () => {}, warn: () => {}, error: () => {} };

function run(runId: string, agentId: string, toolCalls: Array<{ toolName: string; meta: string }>): SessionRunTrace {
  return {
    agentId,
    sessionId: `${agentId}-session`,
    sessionKey: `agent:${agentId}:x`,
    runId,
    ts: "2026-09-24T15:56:05.775Z",
    finalStatus: "success",
    toolCalls,
  };
}

function fakeApi(completeImpl: ExplainRuntimeApi["runtime"]["llm"]["complete"]): ExplainRuntimeApi {
  return {
    runtime: {
      agent: { session: { listSessionEntries: () => [] } },
      llm: { complete: completeImpl },
    },
  };
}

describe("redactCommandText", () => {
  it("redacts VAR=value assignments for token/secret/password-shaped names", () => {
    expect(redactCommandText("TOKEN=abc123xyz curl ...")).toBe("TOKEN=[REDACTED] curl ...");
    expect(redactCommandText("export API_KEY=sk-live-abcdef")).toBe("export API_KEY=[REDACTED]");
    expect(redactCommandText('PASSWORD="hunter2"')).toBe('PASSWORD="[REDACTED]"');
  });

  it("redacts Authorization: Bearer tokens", () => {
    expect(redactCommandText('curl -H "Authorization: Bearer abcdef123456"')).toBe(
      'curl -H "Authorization: Bearer [REDACTED]"',
    );
  });

  it("redacts bare secret-shaped tokens (sk-, ghp_, JWT)", () => {
    expect(redactCommandText("key is sk-abcdefghijklmnopqrst1234")).toContain("[REDACTED]");
    expect(redactCommandText("pat is ghp_abcdefghijklmnopqrst1234")).toContain("[REDACTED]");
  });

  it("leaves ordinary command text untouched", () => {
    const text = "kubectl get pods -n minishop | grep order";
    expect(redactCommandText(text)).toBe(text);
  });

  it("already-masked text from OpenClaw itself passes through unchanged", () => {
    expect(redactCommandText("TOKEN=*** -oP 'X=\\K.*'")).toBe("TOKEN=*** -oP 'X=\\K.*'");
  });
});

describe("generateExplanations", () => {
  it("maps summaries and per-tool-call explanations back onto the runs, and accumulates usage", async () => {
    const runs = [run("run-1", "main", [{ toolName: "read", meta: "SKILL.md" }, { toolName: "exec", meta: "kubectl get pods" }])];
    const complete = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        runs: [
          {
            runId: "run-1",
            summary: "Reads the incident skill and checks pod status.",
            toolCalls: [{ index: 0, explanation: "Reads the incident skill file." }, { index: 1, explanation: "Lists pods." }],
          },
        ],
      }),
      provider: "deepseek",
      model: "deepseek-v4-pro",
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.002 },
    });

    const result = await generateExplanations(fakeApi(complete), runs, {}, { language: "en" }, logger);

    expect(result.warnings).toEqual([]);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.002 });
    expect(result.explainedRuns).toHaveLength(1);
    expect(result.explainedRuns[0].summary).toBe("Reads the incident skill and checks pod status.");
    expect(result.explainedRuns[0].toolCalls[0].explanation).toBe("Reads the incident skill file.");
    expect(result.explainedRuns[0].toolCalls[1].explanation).toBe("Lists pods.");
  });

  it("passes the configured language and model through to llm.complete", async () => {
    const runs = [run("run-1", "main", [])];
    const complete = vi.fn().mockResolvedValue({
      text: JSON.stringify({ runs: [{ runId: "run-1", summary: "x", toolCalls: [] }] }),
      provider: "p",
      model: "m",
      usage: {},
    });

    await generateExplanations(fakeApi(complete), runs, {}, { language: "ru", model: "openai/gpt-5.5" }, logger);

    const callArgs = complete.mock.calls[0][0];
    expect(callArgs.model).toBe("openai/gpt-5.5");
    expect(callArgs.systemPrompt).toContain("ru");
  });

  it("scales maxTokens with the chunk's tool-call count instead of using one flat budget", async () => {
    // Regression: a flat 2000-token budget silently truncated a real 9-run/~50-tool-call
    // response mid-JSON, which then failed to parse - the content itself was fine, the budget
    // was too small. maxTokens must grow with what's actually being asked for.
    const complete = vi.fn().mockResolvedValue({
      text: JSON.stringify({ runs: [{ runId: "run-1", summary: "x", toolCalls: [] }] }),
      provider: "p",
      model: "m",
      usage: {},
    });

    const smallRun = [run("run-1", "main", [{ toolName: "read", meta: "x" }])];
    await generateExplanations(fakeApi(complete), smallRun, {}, { language: "en" }, logger);
    const smallMaxTokens = complete.mock.calls[0][0].maxTokens;

    complete.mockClear();
    const manyToolCalls = Array.from({ length: 20 }, (_, i) => ({ toolName: "exec", meta: `cmd ${i}` }));
    const busyRun = [run("run-1", "main", manyToolCalls)];
    await generateExplanations(fakeApi(complete), busyRun, {}, { language: "en" }, logger);
    const busyMaxTokens = complete.mock.calls[0][0].maxTokens;

    expect(busyMaxTokens).toBeGreaterThan(smallMaxTokens);
    expect(smallMaxTokens).toBeGreaterThanOrEqual(1500); // minimum floor, even for a tiny chunk
  });

  it("caps maxTokens instead of growing unbounded on a pathologically large chunk", async () => {
    const complete = vi.fn().mockResolvedValue({
      text: JSON.stringify({ runs: [{ runId: "run-1", summary: "x", toolCalls: [] }] }),
      provider: "p",
      model: "m",
      usage: {},
    });
    const hugeRun = [run("run-1", "main", Array.from({ length: 500 }, (_, i) => ({ toolName: "exec", meta: `cmd ${i}` })))];

    await generateExplanations(fakeApi(complete), hugeRun, {}, { language: "en" }, logger);

    expect(complete.mock.calls[0][0].maxTokens).toBe(8000);
  });

  it("splits runs into multiple chunks and merges results", async () => {
    const runs = [run("run-1", "main", []), run("run-2", "main", []), run("run-3", "main", [])];
    const complete = vi.fn().mockImplementation(async ({ messages }: { messages: Array<{ content: string }> }) => {
      const body = JSON.parse(messages[0].content);
      const ids: string[] = body.runs.map((r: { runId: string }) => r.runId);
      return {
        text: JSON.stringify({ runs: ids.map((runId) => ({ runId, summary: `summary for ${runId}`, toolCalls: [] })) }),
        provider: "p",
        model: "m",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0.0001 },
      };
    });

    const result = await generateExplanations(fakeApi(complete), runs, {}, { language: "en", chunkSize: 2 }, logger);

    expect(complete).toHaveBeenCalledTimes(2); // 3 runs, chunk size 2 -> 2 calls
    expect(result.explainedRuns.map((r) => r.summary)).toEqual([
      "summary for run-1",
      "summary for run-2",
      "summary for run-3",
    ]);
    expect(result.usage.totalTokens).toBe(4);
  });

  it("strips a fenced ```json code block before parsing", async () => {
    const runs = [run("run-1", "main", [])];
    const complete = vi.fn().mockResolvedValue({
      text: '```json\n{"runs":[{"runId":"run-1","summary":"ok","toolCalls":[]}]}\n```',
      provider: "p",
      model: "m",
      usage: {},
    });

    const result = await generateExplanations(fakeApi(complete), runs, {}, { language: "en" }, logger);
    expect(result.explainedRuns[0].summary).toBe("ok");
  });

  it("falls back to placeholder explanations and adds a warning when the response is not valid JSON", async () => {
    const runs = [run("run-1", "main", [{ toolName: "read", meta: "x" }])];
    const complete = vi.fn().mockResolvedValue({ text: "not json at all", provider: "p", model: "m", usage: {} });

    const result = await generateExplanations(fakeApi(complete), runs, {}, { language: "en" }, logger);

    expect(result.explainedRuns[0].summary).toBe("(explanation unavailable)");
    expect(result.explainedRuns[0].toolCalls[0].explanation).toBe("(no explanation)");
    expect(result.warnings).toHaveLength(1);
  });

  it("falls back gracefully when llm.complete throws, without failing the whole report", async () => {
    const runs = [run("run-1", "main", [])];
    const complete = vi.fn().mockRejectedValue(new Error("model unavailable"));

    const result = await generateExplanations(fakeApi(complete), runs, {}, { language: "en" }, logger);

    expect(result.explainedRuns[0].summary).toBe("(explanation unavailable)");
    expect(result.warnings[0]).toContain("model unavailable");
  });

  it("falls back only for a run missing from an otherwise-valid response", async () => {
    const runs = [run("run-1", "main", []), run("run-2", "main", [])];
    const complete = vi.fn().mockResolvedValue({
      text: JSON.stringify({ runs: [{ runId: "run-1", summary: "got it", toolCalls: [] }] }),
      provider: "p",
      model: "m",
      usage: {},
    });

    const result = await generateExplanations(fakeApi(complete), runs, {}, { language: "en" }, logger);

    expect(result.explainedRuns[0].summary).toBe("got it");
    expect(result.explainedRuns[1].summary).toBe("(explanation unavailable)");
    expect(result.warnings.some((w) => w.includes("run-2"))).toBe(true);
  });

  it("truncates and redacts very long/sensitive meta text before it reaches the prompt", async () => {
    const longMeta = `TOKEN=supersecretvalue ${"x".repeat(400)}`;
    const runs = [run("run-1", "main", [{ toolName: "exec", meta: longMeta }])];
    const complete = vi.fn().mockResolvedValue({
      text: JSON.stringify({ runs: [{ runId: "run-1", summary: "s", toolCalls: [{ index: 0, explanation: "e" }] }] }),
      provider: "p",
      model: "m",
      usage: {},
    });

    await generateExplanations(fakeApi(complete), runs, {}, { language: "en" }, logger);

    const sentMeta = JSON.parse(complete.mock.calls[0][0].messages[0].content).runs[0].toolCalls[0].meta;
    expect(sentMeta).not.toContain("supersecretvalue");
    expect(sentMeta.length).toBeLessThan(longMeta.length);
  });
});
