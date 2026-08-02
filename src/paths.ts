import { homedir } from "node:os";
import { join } from "node:path";

/** Resolve the OpenClaw base directory (parent of `state/`, `logs/`, `agents/`) the same
 * way the running Gateway does, so probe respects --profile/--dev/env overrides. Falls back
 * to `~/.openclaw` if the runtime helper is unavailable (older host, or running under test).
 *
 * Despite its name, `api.runtime.state.resolveStateDir(...)` returns the whole `~/.openclaw`
 * root (default: `~/.openclaw`, or `$OPENCLAW_STATE_DIR` when set) - "state" here means
 * "mutable data root", not the `state/` subdirectory inside it. Do not `dirname()` it. */
export function resolveBaseDir(api: {
  runtime?: { state?: { resolveStateDir?: (env: NodeJS.ProcessEnv) => string } };
}): string {
  try {
    const stateDir = api.runtime?.state?.resolveStateDir?.(process.env);
    if (stateDir) return stateDir;
  } catch {
    // fall through to the default below
  }
  return join(homedir(), ".openclaw");
}

export type ProbePaths = {
  baseDir: string;
  agentsDir: string;
  probeStateDir: string;
  probeResultsDir: string;
  probeActiveMarkerPath: string;
  llmLogDir: string;
  skillLogDir: string;
};

export function resolvePaths(baseDir: string): ProbePaths {
  const probeStateDir = join(baseDir, "state", "plugins", "probe");
  return {
    baseDir,
    agentsDir: join(baseDir, "agents"),
    probeStateDir,
    probeResultsDir: join(probeStateDir, "results"),
    probeActiveMarkerPath: join(probeStateDir, "active.json"),
    llmLogDir: join(baseDir, "logs", "probe", "llm-api"),
    skillLogDir: join(baseDir, "logs", "probe", "skill-usage"),
  };
}

/** Filesystem-safe identifier for a probe name, used for the result file name. The
 * original user-provided name is preserved verbatim inside the stored report. */
export function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "probe";
}
