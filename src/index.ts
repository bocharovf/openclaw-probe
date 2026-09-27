/**
 * Probe
 *
 * Measures agent run cost, speed, and behavior over a time window - wall-clock/LLM/tool
 * time, token usage, tool/skill usage, error counts, and (optionally) a raw LLM
 * request/response archive - via `/probe` chat commands. Built for running the same task
 * before and after a change (a new skill, a prompt tweak, a different model) and comparing
 * the two reports. Also explains a session in natural language via `/probe explain`.
 *
 * Numeric metrics come from `openclaw audit --json` (time, tool calls, errors), each run's
 * trajectory file (tokens, LLM call counts, context size), and this plugin's own
 * after_tool_call-based skill/memory-search detection - all through documented
 * CLI/filesystem/hook surfaces, no dependency on the skill-usage plugin being installed. The
 * optional raw request/response archive is captured by this plugin's own llm_input/llm_output
 * hooks, not the llm-api-logger plugin. `/probe explain` reads each involved session's own
 * trajectory file directly (no new capture hook) and calls `api.runtime.llm.complete` (see
 * docs/plugins/sdk-runtime.md) to generate the natural-language explanations.
 */
import { definePluginEntry, type OpenClawPluginDefinition } from "openclaw/plugin-sdk/plugin-entry";
import { runProbeCommand, type ExplainDeps } from "./commands.js";
import { registerLlmCapture } from "./llmCapture.js";
import { registerMemorySearchCapture } from "./memorySearchUsage.js";
import { resolveBaseDir, resolvePaths } from "./paths.js";
import { registerSkillCapture } from "./skillUsage.js";
import { DEFAULT_CONFIG, ProbeUserError, type ExplainRuntimeApi, type ProbeConfig } from "./types.js";

function mergeConfig(raw: Partial<ProbeConfig> | undefined): ProbeConfig {
  return {
    openclawBin: raw?.openclawBin ?? DEFAULT_CONFIG.openclawBin,
    cliTimeoutMs: raw?.cliTimeoutMs ?? DEFAULT_CONFIG.cliTimeoutMs,
    llmLog: {
      enabled: raw?.llmLog?.enabled ?? DEFAULT_CONFIG.llmLog.enabled,
      maxFileSizeMb: raw?.llmLog?.maxFileSizeMb ?? DEFAULT_CONFIG.llmLog.maxFileSizeMb,
      maxFiles: raw?.llmLog?.maxFiles ?? DEFAULT_CONFIG.llmLog.maxFiles,
      redactSecrets: raw?.llmLog?.redactSecrets ?? DEFAULT_CONFIG.llmLog.redactSecrets,
    },
    explain: {
      model: raw?.explain?.model,
      modelFallback: raw?.explain?.modelFallback,
      language: raw?.explain?.language ?? DEFAULT_CONFIG.explain.language,
    },
  };
}

/** Builds the /probe explain runtime dependency bundle, or undefined if this host's plugin
 * runtime doesn't expose the two capabilities it needs (older OpenClaw build, or a test
 * harness that doesn't stub them) - `/probe explain` then reports itself unavailable instead
 * of crashing on a missing method. */
function buildExplainApi(api: any): ExplainRuntimeApi | undefined {
  const listSessionEntries = api.runtime?.agent?.session?.listSessionEntries;
  const complete = api.runtime?.llm?.complete;
  if (typeof listSessionEntries !== "function" || typeof complete !== "function") return undefined;
  return {
    runtime: {
      agent: { session: { listSessionEntries: listSessionEntries.bind(api.runtime.agent.session) } },
      llm: { complete: complete.bind(api.runtime.llm) },
    },
  };
}

const entry: OpenClawPluginDefinition = definePluginEntry({
  id: "probe",
  name: "Probe",
  description:
    "Measures agent run cost, speed, and behavior over a time window, and explains a session in natural language, via /probe chat commands.",
  register(api: any) {
    const rawProbeConfig: Partial<ProbeConfig> = api.config?.plugins?.entries?.["probe"]?.config ?? {};
    const config = mergeConfig(rawProbeConfig);
    const baseDir = resolveBaseDir(api);
    const paths = resolvePaths(baseDir);
    const explainApi = buildExplainApi(api);

    api.logger?.info?.(`[probe] armed - base dir: ${baseDir}`);
    if (!explainApi) {
      api.logger?.warn?.("[probe] /probe explain unavailable - api.runtime.agent.session.listSessionEntries/api.runtime.llm.complete not found on this host");
    }

    registerLlmCapture(api, config, paths.llmLogDir, api.logger);
    registerSkillCapture(api, paths.skillLogDir, api.logger);
    registerMemorySearchCapture(api, paths.memorySearchLogDir, api.logger);

    api.registerCommand({
      name: "probe",
      description:
        "Measure agent run cost/speed/behavior (start/stop/range/list/delete/diff), or explain a session in natural language.",
      acceptsArgs: true,
      requireAuth: true,
      agentPromptGuidance: [
        "The /probe command family (start/stop/<range>/<name>/verbose <name>/list/delete " +
          "<name>/diff <name1>, <name2>/diff verbose <name1>, <name2>/explain [session]) " +
          "measures agent run cost, speed, and tool/skill/token usage over a time window for " +
          "experiments, compares two saved measurements field by field, and explains a " +
          "session's actions (including any spawned sub-agent sessions) in natural language " +
          "as an HTML report. It bypasses the model - do not try to answer /probe requests " +
          "yourself; the user runs it directly.",
      ],
      async handler(ctx: { args?: string; agentId?: string; sessionId?: string; sessionKey?: string }) {
        const explain: ExplainDeps | undefined = explainApi
          ? {
              api: explainApi,
              rawConfig: api.config,
              invokingSession: { agentId: ctx.agentId, sessionId: ctx.sessionId, sessionKey: ctx.sessionKey },
            }
          : undefined;
        try {
          const { text, mediaUrl } = await runProbeCommand(ctx.args ?? "", { config, paths, logger: api.logger, explain });
          return mediaUrl ? { text, mediaUrl } : { text };
        } catch (err) {
          if (err instanceof ProbeUserError) {
            return { text: err.message, isError: true };
          }
          api.logger?.error?.(`[probe] command failed: ${String((err as Error)?.stack ?? err)}`);
          return {
            text: `Probe command failed: ${(err as Error)?.message ?? String(err)}`,
            isError: true,
          };
        }
      },
    });
  },
});

export default entry;
