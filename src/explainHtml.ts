import type { AgentIdentity, ExplainedRun, ExplainUsage } from "./types.js";

/** Renders a `/probe explain` result as a single self-contained HTML file (inline CSS, no
 * external requests) - chronological list of runs across every session in the scenario, each
 * showing its agent, a one-sentence summary, and its tool calls with a natural-language
 * explanation plus a collapsible `<details>` for the original (OpenClaw-truncated,
 * redacted) command - no JavaScript needed for the expand/collapse the user asked for. */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function agentLabel(agentId: string, identity: AgentIdentity | undefined): string {
  const parts = [identity?.emoji, identity?.name].filter((v): v is string => Boolean(v));
  const display = parts.length ? parts.join(" ") : agentId;
  return identity?.name && display !== agentId ? `${escapeHtml(display)} <span class="agent-id">(${escapeHtml(agentId)})</span>` : escapeHtml(display);
}

function fmtCost(usd: number): string {
  return usd > 0 && usd < 0.01 ? "under $0.01" : `$${usd.toFixed(2)}`;
}

export type ExplainHtmlParams = {
  rootSessionKey: string;
  generatedAt: string;
  language: string;
  sessionsIncluded: number;
  runs: ExplainedRun[];
  agentIdentities: Record<string, AgentIdentity>;
  usage: ExplainUsage;
  warnings: string[];
};

export function renderExplainHtml(params: ExplainHtmlParams): string {
  const { rootSessionKey, generatedAt, language, sessionsIncluded, runs, agentIdentities, usage, warnings } = params;

  const runCards = runs
    .map((run) => {
      const toolCards = run.toolCalls
        .map(
          (t) => `
        <li class="tool-call">
          <div class="tool-explanation">${escapeHtml(t.explanation)}</div>
          <details>
            <summary>${escapeHtml(t.toolName)}</summary>
            <pre>${escapeHtml(t.meta || "(no arguments captured)")}</pre>
          </details>
        </li>`,
        )
        .join("");

      const statusBadge =
        run.finalStatus && run.finalStatus !== "success"
          ? `<span class="badge badge-warn">${escapeHtml(run.aborted ? "aborted" : run.finalStatus)}</span>`
          : "";

      return `
      <section class="run">
        <div class="run-header">
          <span class="agent">${agentLabel(run.agentId, agentIdentities[run.agentId])}</span>
          <span class="ts">${escapeHtml(run.ts)}</span>
          ${statusBadge}
        </div>
        <div class="run-summary">${escapeHtml(run.summary)}</div>
        ${run.toolCalls.length ? `<ul class="tool-calls">${toolCards}</ul>` : ""}
      </section>`;
    })
    .join("");

  const warningsBlock = warnings.length
    ? `<section class="warnings"><h2>Warnings</h2><ul>${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul></section>`
    : "";

  return `<!DOCTYPE html>
<html lang="${escapeHtml(language)}">
<head>
<meta charset="utf-8">
<title>Probe explain: ${escapeHtml(rootSessionKey)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 860px; margin: 0 auto; padding: 24px 16px 64px; line-height: 1.5; }
  h1 { font-size: 1.25rem; word-break: break-all; }
  .meta { color: #666; font-size: 0.9rem; margin-bottom: 24px; }
  .meta div { margin: 2px 0; }
  .run { border-left: 3px solid #7c8fa8; padding: 8px 0 8px 16px; margin-bottom: 20px; }
  .run-header { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; font-size: 0.85rem; color: #555; }
  .agent { font-weight: 600; color: #24313f; }
  .agent-id { font-weight: 400; color: #888; }
  .ts { font-variant-numeric: tabular-nums; }
  .badge { border-radius: 4px; padding: 1px 6px; font-size: 0.75rem; }
  .badge-warn { background: #fde8e8; color: #a33; }
  .run-summary { margin: 6px 0 8px; font-size: 1rem; }
  ul.tool-calls { list-style: none; margin: 0; padding: 0; }
  li.tool-call { margin: 6px 0; padding: 6px 10px; background: rgba(124,143,168,0.08); border-radius: 6px; }
  .tool-explanation { font-size: 0.95rem; }
  details { margin-top: 4px; }
  summary { cursor: pointer; font-size: 0.8rem; color: #567; font-family: ui-monospace, monospace; }
  pre { white-space: pre-wrap; word-break: break-word; font-size: 0.8rem; background: rgba(0,0,0,0.05); padding: 8px; border-radius: 4px; margin: 6px 0 0; }
  .warnings { margin-top: 32px; font-size: 0.85rem; color: #a33; }
  @media (prefers-color-scheme: dark) {
    body { background: #14181d; color: #dfe6ee; }
    .meta { color: #9aa7b4; }
    .agent { color: #dfe6ee; }
    .run { border-left-color: #4a6a90; }
    li.tool-call { background: rgba(124,143,168,0.15); }
    pre { background: rgba(255,255,255,0.06); }
    .badge-warn { background: #4a2424; color: #f2a; }
  }
</style>
</head>
<body>
  <h1>Probe explain</h1>
  <div class="meta">
    <div>Root session: <code>${escapeHtml(rootSessionKey)}</code></div>
    <div>Sessions included: ${sessionsIncluded} · Runs: ${runs.length}</div>
    <div>Generated: ${escapeHtml(generatedAt)} · Language: ${escapeHtml(language)}</div>
    <div>Explanation cost: ${fmtCost(usage.costUsd)} (${usage.totalTokens} tokens)</div>
  </div>
  ${runCards || '<p>No runs found for this session.</p>'}
  ${warningsBlock}
</body>
</html>
`;
}
