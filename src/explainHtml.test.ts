import { describe, expect, it } from "vitest";
import { renderExplainHtml } from "./explainHtml.js";
import type { ExplainedRun } from "./types.js";

function run(overrides: Partial<ExplainedRun> = {}): ExplainedRun {
  return {
    agentId: "main",
    sessionId: "sess-1",
    sessionKey: "agent:main:x",
    runId: "run-1",
    ts: "2026-09-24T15:56:05.775Z",
    finalStatus: "success",
    summary: "Read the incident skill and spawned diagnostics.",
    toolCalls: [{ toolName: "read", meta: "SKILL.md", explanation: "Reads the incident skill." }],
    ...overrides,
  };
}

function baseParams(overrides: Partial<Parameters<typeof renderExplainHtml>[0]> = {}) {
  return {
    rootSessionKey: "agent:main:hook:alertmanager:x",
    generatedAt: "2026-09-27T00:00:00.000Z",
    language: "en",
    sessionsIncluded: 1,
    runs: [run()],
    agentIdentities: {},
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.05 },
    warnings: [] as string[],
    ...overrides,
  };
}

describe("renderExplainHtml", () => {
  it("is well-formed, self-contained HTML with the run's content", () => {
    const html = renderExplainHtml(baseParams());
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("agent:main:hook:alertmanager:x");
    expect(html).toContain("Read the incident skill and spawned diagnostics.");
    expect(html).toContain("Reads the incident skill.");
    expect(html).toContain("SKILL.md");
    expect(html).not.toMatch(/<script/i);
  });

  it("escapes HTML-special characters in summaries/explanations/meta", () => {
    const html = renderExplainHtml(
      baseParams({
        runs: [
          run({
            summary: '<img src=x onerror=alert(1)>',
            toolCalls: [{ toolName: "exec", meta: "echo <script>bad()</script>", explanation: "Runs a <b>command</b>." }],
          }),
        ],
      }),
    );
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>bad()</script>");
    expect(html).not.toContain("<b>command</b>");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;script&gt;bad()&lt;/script&gt;");
  });

  it("shows the agent's emoji+name and id when identity is known", () => {
    const html = renderExplainHtml(
      baseParams({
        runs: [run({ agentId: "diag-k8s" })],
        agentIdentities: { "diag-k8s": { name: "Kubectl", emoji: "☸️" } },
      }),
    );
    expect(html).toContain("☸️ Kubectl");
    expect(html).toContain("(diag-k8s)");
  });

  it("falls back to the bare agent id when identity is unknown", () => {
    const html = renderExplainHtml(baseParams({ runs: [run({ agentId: "diag-db" })], agentIdentities: {} }));
    expect(html).toContain("diag-db");
  });

  it("shows a status badge for a non-success run", () => {
    const html = renderExplainHtml(baseParams({ runs: [run({ finalStatus: "failed" })] }));
    expect(html).toContain("badge-warn");
    expect(html).toContain("failed");
  });

  it("shows an aborted badge instead of the raw status when aborted", () => {
    const html = renderExplainHtml(baseParams({ runs: [run({ finalStatus: "failed", aborted: true })] }));
    expect(html).toContain(">aborted<");
  });

  it("omits the warnings section when there are none, includes it when there are", () => {
    const clean = renderExplainHtml(baseParams({ warnings: [] }));
    expect(clean).not.toContain("Warnings");

    const withWarnings = renderExplainHtml(baseParams({ warnings: ["could not parse explanation response for chunk 1/1"] }));
    expect(withWarnings).toContain("Warnings");
    expect(withWarnings).toContain("could not parse explanation response");
  });

  it("shows a placeholder message when there are no runs", () => {
    const html = renderExplainHtml(baseParams({ runs: [] }));
    expect(html).toContain("No runs found");
  });

  it("formats very small costs as 'under $0.01' rather than $0.00", () => {
    const html = renderExplainHtml(baseParams({ usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0.0003 } }));
    expect(html).toContain("under $0.01");
  });

  it("formats zero cost as $0.00", () => {
    const html = renderExplainHtml(baseParams({ usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 } }));
    expect(html).toContain("$0.00");
  });
});
