/**
 * Probe
 *
 * Measures agent run cost, speed, and behavior over a time window - wall-clock/LLM/tool
 * time, token usage, tool/skill usage, error counts, and (optionally) a raw LLM
 * request/response archive - via `/probe` chat commands. Built for running the same task
 * before and after a change (a new skill, a prompt tweak, a different model) and comparing
 * the two reports.
 *
 * Numeric metrics come from `openclaw audit --json` (time, tool calls, errors), each run's
 * trajectory file (tokens, LLM call counts, context size), and the skill-usage plugin's own
 * event log (skill invocation counts) - all read-only, all through documented CLI/filesystem
 * surfaces available to any installed plugin. The optional raw request/response archive is
 * captured by this plugin's own llm_input/llm_output hooks, not the llm-api-logger plugin.
 */
import { definePluginEntry, type OpenClawPluginDefinition } from "openclaw/plugin-sdk/plugin-entry";
import { runProbeCommand } from "./commands.js";
import { registerLlmCapture } from "./llmCapture.js";
import { resolveBaseDir, resolvePaths } from "./paths.js";
import { DEFAULT_CONFIG, ProbeUserError, type ProbeConfig } from "./types.js";

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
  };
}

const entry: OpenClawPluginDefinition = definePluginEntry({
  id: "probe",
  name: "Probe",
  description:
    "Measures agent run cost, speed, and behavior over a time window via /probe chat commands.",
  register(api: any) {
    const rawConfig: Partial<ProbeConfig> = api.config?.plugins?.entries?.["probe"]?.config ?? {};
    const config = mergeConfig(rawConfig);
    const baseDir = resolveBaseDir(api);
    const paths = resolvePaths(baseDir);

    api.logger?.info?.(`[probe] armed - base dir: ${baseDir}`);

    registerLlmCapture(api, config, paths.llmLogDir, api.logger);

    api.registerCommand({
      name: "probe",
      description: "Measure agent run cost/speed/behavior: start/stop, a past time range, list, or show a saved report.",
      acceptsArgs: true,
      requireAuth: true,
      agentPromptGuidance: [
        "The /probe command family (start/stop/<range>/<name>/verbose <name>/list) measures " +
          "agent run cost, speed, and tool/skill/token usage over a time window for experiments. " +
          "It bypasses the model - do not try to answer /probe requests yourself; the user runs " +
          "it directly.",
      ],
      async handler(ctx: { args?: string }) {
        try {
          const text = await runProbeCommand(ctx.args ?? "", { config, paths, logger: api.logger });
          return { text };
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
